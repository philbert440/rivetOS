/**
 * RivetMcpServer — composition root for the MCP server.
 *
 * Wraps the MCP SDK's `McpServer` with a Node `http.Server` that handles:
 *   - `GET  /health/live`  — liveness probe (no auth, no MCP)
 *   - `POST /mcp`          — MCP requests over StreamableHTTP transport
 *   - `GET  /mcp`          — MCP server-to-client notifications (SSE)
 *   - `DELETE /mcp`        — terminate MCP session
 *
 * Slice 1 is intentionally stateless and unauthenticated — the goal is
 * "it boots, it answers a tool call." Auth (mTLS), session.attach, and
 * the real tool surface land in subsequent slices.
 */

import http from 'node:http'
import { randomUUID } from 'node:crypto'

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js'
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'

const SERVER_NAME = 'rivetos-mcp-server'
const SERVER_VERSION = '0.4.0-beta.5'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * A tool registration accepted by `createMcpServer`.
 *
 * Slice 1 intentionally keeps the registration shape narrow — input schema
 * is a flat zod raw shape (matching the MCP SDK), and `execute` returns
 * a string. This will widen in slice 3 once real RivetOS tools land.
 */
export interface ToolRegistration {
  name: string
  description: string
  inputSchema: z.ZodRawShape
  execute: (args: Record<string, unknown>) => Promise<string>
}

export interface RivetMcpServerOptions {
  /** TCP host to bind. Default: `127.0.0.1`. */
  host?: string
  /** TCP port to bind. Default: `5700`. */
  port?: number
  /** Tools to expose. Slice 1 ships an `rivetos.echo` smoke-test tool by default. */
  tools?: ToolRegistration[]
  /**
   * Optional logger. Defaults to `console.log`. Tests pass a no-op.
   */
  log?: (msg: string, meta?: Record<string, unknown>) => void
}

export interface RivetMcpServer {
  /** The bound address (resolved after `start()`). */
  readonly address: { host: string; port: number }
  /** Start listening. Resolves once the socket is bound. */
  start: () => Promise<void>
  /** Close all sessions and stop listening. */
  stop: () => Promise<void>
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createMcpServer(options: RivetMcpServerOptions = {}): RivetMcpServer {
  const host = options.host ?? '127.0.0.1'
  const port = options.port ?? 5700
  const log = options.log ?? defaultLog
  const tools = options.tools ?? [defaultEchoTool()]

  // One transport per session. Stateful mode: SDK validates session IDs and
  // routes follow-up requests to the right transport. Stateless would also
  // work, but we want session-scoped state once `session.attach` lands.
  const transports = new Map<string, StreamableHTTPServerTransport>()

  const httpServer = http.createServer((req, res) => {
    handleRequest(req, res, { transports, tools, log }).catch((err: unknown) => {
      log('http.handler.error', { error: errorToObject(err) })
      if (!res.headersSent) {
        res.statusCode = 500
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ error: 'internal_error' }))
      }
    })
  })

  // We resolve the bound address after `listen` because the OS may choose
  // an ephemeral port (port: 0) — useful for tests.
  const boundAddress = { host, port }

  return {
    get address() {
      return boundAddress
    },
    async start() {
      await new Promise<void>((resolve, reject) => {
        const onError = (err: Error) => {
          httpServer.removeListener('listening', onListening)
          reject(err)
        }
        const onListening = () => {
          httpServer.removeListener('error', onError)
          const addr = httpServer.address()
          if (addr && typeof addr === 'object') {
            boundAddress.host = addr.address
            boundAddress.port = addr.port
          }
          log('mcp.server.listening', boundAddress)
          resolve()
        }
        httpServer.once('error', onError)
        httpServer.once('listening', onListening)
        httpServer.listen(port, host)
      })
    },
    async stop() {
      // Close all open transports first so in-flight requests drain.
      for (const transport of transports.values()) {
        try {
          await transport.close()
        } catch (err: unknown) {
          log('mcp.transport.close.error', { error: errorToObject(err) })
        }
      }
      transports.clear()

      await new Promise<void>((resolve, reject) => {
        httpServer.close((err) => {
          if (err) reject(err)
          else resolve()
        })
      })
      log('mcp.server.stopped')
    },
  }
}

// ---------------------------------------------------------------------------
// HTTP request handling
// ---------------------------------------------------------------------------

interface HandlerCtx {
  transports: Map<string, StreamableHTTPServerTransport>
  tools: ToolRegistration[]
  log: (msg: string, meta?: Record<string, unknown>) => void
}

async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: HandlerCtx,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost')

  // Liveness probe — unauthenticated, never touches MCP.
  if (req.method === 'GET' && url.pathname === '/health/live') {
    res.statusCode = 200
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ status: 'ok', name: SERVER_NAME, version: SERVER_VERSION }))
    return
  }

  // MCP endpoint.
  if (url.pathname === '/mcp') {
    await handleMcp(req, res, ctx)
    return
  }

  res.statusCode = 404
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify({ error: 'not_found' }))
}

async function handleMcp(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: HandlerCtx,
): Promise<void> {
  const sessionIdHeader = headerValue(req.headers['mcp-session-id'])

  // Existing session — route to its transport.
  if (sessionIdHeader && ctx.transports.has(sessionIdHeader)) {
    const transport = ctx.transports.get(sessionIdHeader)
    if (transport === undefined) {
      // Concurrent removal — fall through to "unknown session".
      sendError(res, 404, 'session_not_found')
      return
    }

    if (req.method === 'POST') {
      const body = await readJsonBody(req)
      await transport.handleRequest(req, res, body)
    } else {
      // GET (SSE) and DELETE (terminate) don't carry a body.
      await transport.handleRequest(req, res)
    }
    return
  }

  // New session — only POST + initialize is allowed.
  if (req.method !== 'POST') {
    sendError(res, 400, 'session_required')
    return
  }

  const body = await readJsonBody(req)
  if (!isInitializeRequest(body)) {
    sendError(res, 400, 'session_required')
    return
  }

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (sid: string) => {
      ctx.transports.set(sid, transport)
      ctx.log('mcp.session.initialized', { sessionId: sid })
    },
  })

  transport.onclose = () => {
    const sid = transport.sessionId
    if (sid !== undefined) {
      ctx.transports.delete(sid)
      ctx.log('mcp.session.closed', { sessionId: sid })
    }
  }

  const mcp = buildMcpServer(ctx.tools)
  await mcp.connect(transport)
  await transport.handleRequest(req, res, body)
}

// ---------------------------------------------------------------------------
// MCP wiring
// ---------------------------------------------------------------------------

function buildMcpServer(tools: ToolRegistration[]): McpServer {
  const mcp = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} } },
  )

  for (const tool of tools) {
    mcp.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: tool.inputSchema,
      },
      (args: Record<string, unknown>) =>
        tool.execute(args).then((result) => ({
          content: [{ type: 'text', text: result }],
        })),
    )
  }

  return mcp
}

// ---------------------------------------------------------------------------
// Default smoke-test tool — replaced by real tools in slice 3.
// ---------------------------------------------------------------------------

export function defaultEchoTool(): ToolRegistration {
  return {
    name: 'rivetos.echo',
    description:
      'Smoke-test tool. Echoes its input back, prefixed with "echo:". ' +
      'Used by the Phase 1.A scaffold to verify end-to-end tool wiring; ' +
      'will be removed once real tools land.',
    inputSchema: {
      message: z.string().describe('Text to echo back'),
    },
    execute(args) {
      const message = typeof args.message === 'string' ? args.message : ''
      return Promise.resolve(`echo: ${message}`)
    },
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    chunks.push(chunk as Buffer)
  }
  if (chunks.length === 0) return undefined
  const raw = Buffer.concat(chunks).toString('utf8')
  if (raw.length === 0) return undefined
  return JSON.parse(raw) as JSONRPCMessage
}

function headerValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0]
  return value
}

function sendError(res: http.ServerResponse, status: number, code: string): void {
  res.statusCode = status
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify({ error: code }))
}

function errorToObject(err: unknown): Record<string, unknown> {
  if (err instanceof Error) {
    return { name: err.name, message: err.message, stack: err.stack }
  }
  return { value: String(err) }
}

function defaultLog(msg: string, meta?: Record<string, unknown>): void {
  if (meta === undefined) {
    console.log(`[${SERVER_NAME}] ${msg}`)
  } else {
    console.log(`[${SERVER_NAME}] ${msg}`, meta)
  }
}
