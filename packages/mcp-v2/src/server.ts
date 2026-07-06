/**
 * @rivetos/mcp-v2 server mount — the 2026-07-28 RC world (stateless: no
 * protocol sessions, no initialize; a fresh McpServer instance serves every
 * request). Mirrors the v1 mount's operational surface (TCP/unix bind,
 * bearer auth in front, /health/live) over the v2 SDK so the transport
 * plugin cuts over without changing its manifest contract.
 *
 * session_attach is deliberately GONE here: v2 identity is the bearer token
 * plus per-request _meta — state, when a tool needs it, travels as explicit
 * tool arguments (design consult, question 3).
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { chmodSync, existsSync, mkdirSync, unlinkSync } from 'node:fs'
import { dirname } from 'node:path'
import { timingSafeEqual } from 'node:crypto'
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server'
import { toNodeHandler } from '@modelcontextprotocol/node'
import * as z from 'zod'
import type { ToolRegistration } from '@rivetos/mcp'

export const RIVETOS_MCP_V2_SERVER_NAME = 'rivetos-mcp-server'
export const RIVETOS_MCP_V2_SERVER_VERSION = '2.0.0'

export interface V2McpServerOptions {
  host?: string
  port?: number
  /** Unix socket path — mutually exclusive with host/port. */
  socketPath?: string
  /** Bearer token; empty = unauthenticated (loopback/socket trust). */
  authToken?: string
  tools?: ToolRegistration[]
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

/** Build a fresh per-request McpServer over the shared tool registrations. */
function buildServer(tools: ToolRegistration[]): McpServer {
  const server = new McpServer({
    name: RIVETOS_MCP_V2_SERVER_NAME,
    version: RIVETOS_MCP_V2_SERVER_VERSION,
  })
  for (const tool of tools) {
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: z.object(tool.inputSchema) },
      async (args: Record<string, unknown>) => {
        try {
          const text = await tool.execute(args)
          return { content: [{ type: 'text' as const, text }] }
        } catch (err: unknown) {
          return {
            content: [
              { type: 'text' as const, text: err instanceof Error ? err.message : String(err) },
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
  const handler = createMcpHandler(() => buildServer(tools))
  const nodeHandler = toNodeHandler(handler)

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (url.pathname === '/health/live') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, protocol: 'mcp-v2' }))
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
