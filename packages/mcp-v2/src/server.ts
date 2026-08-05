/**
 * @rivetos/mcp-v2 server mount — the 2026-07-28 final world (stateless: no
 * protocol sessions, no initialize; a fresh McpServer instance serves every
 * request). Mirrors the v1 mount's operational surface (TCP/unix bind,
 * bearer auth in front, /health/live) over the v2 SDK so the transport
 * plugin cuts over without changing its manifest contract.
 *
 * session_attach is deliberately GONE here: v2 identity is the bearer token
 * plus per-request _meta — state, when a tool needs it, travels as explicit
 * tool arguments.
 *
 * Spec features wired here:
 *   - list cache hints (SEP-2549) on tools/list
 *   - tool annotations + titles
 *   - structured tool results (content arrays, not string-only)
 *   - MRTR input_required via isInputRequiredResult → inputRequired()
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { chmodSync, existsSync, mkdirSync, unlinkSync } from 'node:fs'
import { dirname } from 'node:path'
import { timingSafeEqual } from 'node:crypto'
import {
  createMcpHandler,
  McpServer,
  inputRequired,
  type CacheHint,
} from '@modelcontextprotocol/server'
import { toNodeHandler } from '@modelcontextprotocol/node'
import * as z from 'zod'
import {
  isInputRequiredResult,
  isStructuredToolResult,
  normalizeToolResult,
  type ToolRegistration,
  type ToolExecuteContext,
} from '@rivetos/mcp'

export const RIVETOS_MCP_V2_SERVER_NAME = 'rivetos-mcp-server'
export const RIVETOS_MCP_V2_SERVER_VERSION = '2.0.0'

/** Default: cache tools/list for 60s, private to the requesting client. */
export const DEFAULT_TOOLS_LIST_CACHE: CacheHint = {
  ttlMs: 60_000,
  cacheScope: 'private',
}

export interface V2McpServerOptions {
  host?: string
  port?: number
  /** Unix socket path — mutually exclusive with host/port. */
  socketPath?: string
  /** Bearer token; empty = unauthenticated (loopback/socket trust). */
  authToken?: string
  tools?: ToolRegistration[]
  /**
   * Cache hint for tools/list (and optionally other list methods).
   * Pass `null` to use SDK defaults (ttlMs: 0). Default: 60s private.
   */
  toolsListCache?: CacheHint | null
  /** Server name advertised via Implementation. Default: rivetos-mcp-server. */
  serverName?: string
  /** Server version advertised via Implementation. */
  serverVersion?: string
  /** Optional human-readable Implementation.description. */
  serverDescription?: string
}

export interface V2McpServer {
  server: Server
  /** Bound address once listening. */
  port: number
  start(): Promise<void>
  close(): Promise<void>
}

function tokenMatches(expected: string, header: string | undefined): boolean {
  if (!header?.startsWith('Bearer ')) return false
  const got = Buffer.from(header.slice('Bearer '.length))
  const want = Buffer.from(expected)
  // Constant-time even on length mismatch (v1 parity): compare against a
  // same-length dummy so the comparison cost never leaks the token length.
  if (got.length !== want.length) {
    timingSafeEqual(want, Buffer.from(want))
    return false
  }
  return timingSafeEqual(got, want)
}

function extractExecuteContext(extra: unknown): ToolExecuteContext {
  const ctx: ToolExecuteContext = {}
  if (extra && typeof extra === 'object') {
    const e = extra as Record<string, unknown>
    // SDK surfaces MRTR responses on the request envelope; probe common paths.
    const mcpReq = e.mcpReq as Record<string, unknown> | undefined
    if (mcpReq?.inputResponses && typeof mcpReq.inputResponses === 'object') {
      ctx.inputResponses = mcpReq.inputResponses as Record<string, unknown>
    } else if (e.inputResponses && typeof e.inputResponses === 'object') {
      ctx.inputResponses = e.inputResponses as Record<string, unknown>
    }
    if (e.signal instanceof AbortSignal) ctx.signal = e.signal
  }
  return ctx
}

/** Build a fresh per-request McpServer over the shared tool registrations. */
function buildServer(
  tools: ToolRegistration[],
  options: {
    name: string
    version: string
    description?: string
    toolsListCache?: CacheHint | null
  },
): McpServer {
  const cacheHints =
    options.toolsListCache === null
      ? undefined
      : {
          'tools/list': options.toolsListCache ?? DEFAULT_TOOLS_LIST_CACHE,
        }

  const server = new McpServer(
    {
      name: options.name,
      version: options.version,
      ...(options.description ? { description: options.description } : {}),
    },
    cacheHints ? { cacheHints } : undefined,
  )

  for (const tool of tools) {
    const annotations = tool.annotations
      ? {
          ...(tool.annotations.title || tool.title
            ? { title: tool.annotations.title ?? tool.title }
            : {}),
          ...(tool.annotations.readOnlyHint !== undefined
            ? { readOnlyHint: tool.annotations.readOnlyHint }
            : {}),
          ...(tool.annotations.destructiveHint !== undefined
            ? { destructiveHint: tool.annotations.destructiveHint }
            : {}),
          ...(tool.annotations.idempotentHint !== undefined
            ? { idempotentHint: tool.annotations.idempotentHint }
            : {}),
          ...(tool.annotations.openWorldHint !== undefined
            ? { openWorldHint: tool.annotations.openWorldHint }
            : {}),
        }
      : tool.title
        ? { title: tool.title }
        : undefined

    server.registerTool(
      tool.name,
      {
        description: tool.description,
        ...(tool.title ? { title: tool.title } : {}),
        inputSchema: z.object(tool.inputSchema),
        ...(annotations && Object.keys(annotations).length > 0 ? { annotations } : {}),
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- SDK callback arity varies by schema
      async (args: Record<string, unknown>, extra?: unknown): Promise<any> => {
        try {
          const execCtx = extractExecuteContext(extra)
          const result = await tool.execute(args ?? {}, execCtx)

          if (isInputRequiredResult(result)) {
            const inputRequests: Record<string, ReturnType<typeof inputRequired.elicit>> = {}
            for (const [id, req] of Object.entries(result.inputRequests)) {
              // ElicitInputParams requires requestedSchema; default to a
              // boolean confirm when the tool did not supply one.
              const requestedSchema = (req.requestedSchema ?? {
                type: 'object',
                properties: { confirm: { type: 'boolean' } },
                required: ['confirm'],
              }) as never
              inputRequests[id] = inputRequired.elicit({
                message: req.message,
                requestedSchema,
              })
            }
            return inputRequired({ inputRequests })
          }

          const structured = isStructuredToolResult(result) ? result : normalizeToolResult(result)

          return {
            content: structured.content,
            ...(structured.isError ? { isError: true } : {}),
            ...(structured.structuredContent
              ? { structuredContent: structured.structuredContent }
              : {}),
          }
        } catch (err: unknown) {
          return {
            content: [
              {
                type: 'text' as const,
                text: err instanceof Error ? err.message : String(err),
              },
            ],
            isError: true,
          }
        }
      },
    )
  }
  return server
}

export function createV2McpServer(options: V2McpServerOptions = {}): V2McpServer {
  const tools = options.tools ?? []
  const serverName = options.serverName ?? RIVETOS_MCP_V2_SERVER_NAME
  const serverVersion = options.serverVersion ?? RIVETOS_MCP_V2_SERVER_VERSION
  const handler = createMcpHandler(() =>
    buildServer(tools, {
      name: serverName,
      version: serverVersion,
      description: options.serverDescription,
      toolsListCache: options.toolsListCache,
    }),
  )
  const nodeHandler = toNodeHandler(handler)

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (url.pathname === '/health/live') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(
        JSON.stringify({
          ok: true,
          protocol: 'mcp-v2',
          protocolVersion: '2026-07-28',
        }),
      )
      return
    }
    if (options.authToken && !tokenMatches(options.authToken, req.headers.authorization)) {
      res.writeHead(401, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'unauthorized' }))
      return
    }
    void nodeHandler(req, res)
  })

  const handle: V2McpServer = {
    server,
    port: 0,
    async start(): Promise<void> {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        if (options.socketPath) {
          // v1 parity: stale-socket unlink, parent mkdir, then 0600 after
          // bind — filesystem perms ARE the auth boundary on a socket.
          mkdirSync(dirname(options.socketPath), { recursive: true })
          if (existsSync(options.socketPath)) unlinkSync(options.socketPath)
          server.listen(options.socketPath, () => {
            try {
              chmodSync(options.socketPath as string, 0o600)
            } catch {
              /* surfaced by connect failures; never crash startup */
            }
            resolve()
          })
        } else {
          server.listen(options.port ?? 5700, options.host ?? '127.0.0.1', resolve)
        }
      })
      const addr = server.address()
      if (addr && typeof addr === 'object') handle.port = addr.port
    },
    async close(): Promise<void> {
      await handler.close()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
  return handle
}
