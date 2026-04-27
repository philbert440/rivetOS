/**
 * RivetMcpServer — composition root for the MCP server.
 *
 * Wraps the MCP SDK's `McpServer` with a Node `http.Server` that handles:
 *   - `GET  /health/live`  — liveness probe (no auth, no MCP)
 *   - `POST /mcp`          — MCP requests over StreamableHTTP transport
 *   - `GET  /mcp`          — MCP server-to-client notifications (SSE)
 *   - `DELETE /mcp`        — terminate MCP session
 *
 * Phase 1.A — Slice 7' adds:
 *   - **Bearer-token auth** when bound to TCP. Liveness probe stays open;
 *     every other route requires `Authorization: Bearer <token>`.
 *   - **Unix-socket binding** (alternative to TCP). On a unix socket the
 *     filesystem permissions ARE the auth boundary — the socket is created
 *     mode 0600 and owned by the spawning process, so any peer that can
 *     connect is already trusted by the OS. Bearer is skipped on the socket
 *     unless explicitly configured.
 *   - **`session_attach` handshake tool**, registered per-session
 *     with a closure over the live session id. Records
 *     `{agent, runtimePid, clientName}` for observability.
 *
 * The simplifications match the "MCP server just for claude-cli for now"
 * scope: claude-cli is a child process of the runtime on the same host, so
 * we don't need mTLS or runtime-RPC — bearer-or-unix is enough.
 */

import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID, timingSafeEqual } from 'node:crypto'

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js'
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'

import { createSessionAttachTool, type SessionState } from './tools/session-attach.js'

export const RIVETOS_MCP_SERVER_NAME = 'rivetos-mcp-server'
export const RIVETOS_MCP_SERVER_VERSION = '0.4.0-beta.6'

// Internal aliases — keep short names for the rest of the file.
const SERVER_NAME = RIVETOS_MCP_SERVER_NAME
const SERVER_VERSION = RIVETOS_MCP_SERVER_VERSION

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
  /** TCP host to bind. Default: `127.0.0.1`. Ignored if `socketPath` is set. */
  host?: string
  /** TCP port to bind. Default: `5700`. Ignored if `socketPath` is set. */
  port?: number
  /**
   * Bind to a unix socket at this path instead of TCP. When set, `host` and
   * `port` are ignored. Filesystem perms (0600) are the auth boundary; the
   * bearer token is skipped unless `requireBearerOnSocket: true`.
   */
  socketPath?: string
  /** Force bearer-token auth even when bound to a unix socket. Default: false. */
  requireBearerOnSocket?: boolean
  /**
   * Bearer token. When set on TCP, every request other than `/health/live`
   * must present `Authorization: Bearer <token>`. Compared in constant time.
   * When unset on TCP, the server logs a warning at startup — fine for
   * localhost dev, never deploy this way.
   */
  authToken?: string
  /** Tools to expose. Slice 1 ships an `echo` smoke-test tool by default. */
  tools?: ToolRegistration[]
  /**
   * Optional logger. Defaults to `console.log`. Tests pass a no-op.
   */
  log?: (msg: string, meta?: Record<string, unknown>) => void
}

export interface RivetMcpServer {
  /**
   * Resolved bind address. For TCP: `{host, port}`. For unix sockets:
   * `{socketPath}`. Tests use this to know what to dial.
   */
  readonly address: { host?: string; port?: number; socketPath?: string }
  /** Snapshot of currently-attached sessions (read-only). */
  readonly sessions: ReadonlyMap<string, SessionState>
  /** Start listening. Resolves once the socket is bound. */
  start: () => Promise<void>
  /** Close all sessions and stop listening. */
  stop: () => Promise<void>
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createMcpServer(options: RivetMcpServerOptions = {}): RivetMcpServer {
  const log = options.log ?? defaultLog
  const tools = options.tools ?? [defaultEchoTool()]
  const socketPath = options.socketPath
  const useSocket = typeof socketPath === 'string' && socketPath.length > 0
  const host = options.host ?? '127.0.0.1'
  const port = options.port ?? 5700

  const requireBearer = useSocket
    ? Boolean(options.requireBearerOnSocket && options.authToken)
    : Boolean(options.authToken)
  const expectedTokenBuf = options.authToken ? Buffer.from(options.authToken, 'utf8') : undefined

  if (!useSocket && !requireBearer) {
    log('mcp.server.auth.unauthenticated', {
      reason: 'no RIVETOS_MCP_TOKEN — TCP bind is unauthenticated; localhost-only OK for dev',
    })
  }

  // One transport per session. Stateful mode: SDK validates session IDs and
  // routes follow-up requests to the right transport. Stateless would also
  // work, but we want session-scoped state once `session.attach` lands.
  const transports = new Map<string, StreamableHTTPServerTransport>()
  const sessions = new Map<string, SessionState>()

  const httpServer = http.createServer((req, res) => {
    handleRequest(req, res, {
      transports,
      sessions,
      tools,
      log,
      requireBearer,
      expectedTokenBuf,
    }).catch((err: unknown) => {
      log('http.handler.error', { error: errorToObject(err) })
      if (!res.headersSent) {
        res.statusCode = 500
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ error: 'internal_error' }))
      }
    })
  })

  // Address resolved after `listen`. For TCP the OS may pick an ephemeral
  // port (port: 0). For unix sockets the path is the address.
  const boundAddress: { host?: string; port?: number; socketPath?: string } = useSocket
    ? { socketPath }
    : { host, port }

  return {
    get address() {
      return boundAddress
    },
    get sessions() {
      return sessions
    },
    async start() {
      if (useSocket) {
        // Best-effort cleanup of a stale socket from a previous run.
        try {
          const stat = fs.statSync(socketPath)
          if (stat.isSocket()) fs.unlinkSync(socketPath)
        } catch (err: unknown) {
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
            throw err
          }
        }
        // Make sure the parent directory exists.
        fs.mkdirSync(path.dirname(socketPath), { recursive: true })
      }

      await new Promise<void>((resolve, reject) => {
        const onError = (err: Error) => {
          httpServer.removeListener('listening', onListening)
          reject(err)
        }
        const onListening = () => {
          httpServer.removeListener('error', onError)
          if (useSocket) {
            // Lock the socket down — only the owning user can connect.
            try {
              fs.chmodSync(socketPath, 0o600)
            } catch (err: unknown) {
              log('mcp.server.socket.chmod.error', { error: errorToObject(err) })
            }
            log('mcp.server.listening', { socketPath })
          } else {
            const addr = httpServer.address()
            if (addr && typeof addr === 'object') {
              boundAddress.host = addr.address
              boundAddress.port = addr.port
            }
            log('mcp.server.listening', { host: boundAddress.host, port: boundAddress.port })
          }
          resolve()
        }
        httpServer.once('error', onError)
        httpServer.once('listening', onListening)
        if (useSocket) {
          httpServer.listen(socketPath)
        } else {
          httpServer.listen(port, host)
        }
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
      sessions.clear()

      await new Promise<void>((resolve, reject) => {
        httpServer.close((err) => {
          if (err) reject(err)
          else resolve()
        })
      })

      // Remove the unix socket file we created.
      if (useSocket) {
        try {
          fs.unlinkSync(socketPath)
        } catch (err: unknown) {
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
            log('mcp.server.socket.unlink.error', { error: errorToObject(err) })
          }
        }
      }
      log('mcp.server.stopped')
    },
  }
}

// ---------------------------------------------------------------------------
// HTTP request handling
// ---------------------------------------------------------------------------

interface HandlerCtx {
  transports: Map<string, StreamableHTTPServerTransport>
  sessions: Map<string, SessionState>
  tools: ToolRegistration[]
  log: (msg: string, meta?: Record<string, unknown>) => void
  requireBearer: boolean
  expectedTokenBuf: Buffer | undefined
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

  // Bearer auth gate for everything below the liveness probe.
  if (ctx.requireBearer) {
    if (!checkBearer(req, ctx.expectedTokenBuf)) {
      res.statusCode = 401
      res.setHeader('content-type', 'application/json')
      res.setHeader('www-authenticate', 'Bearer realm="rivetos-mcp"')
      res.end(JSON.stringify({ error: 'unauthorized' }))
      return
    }
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

  // We need the session id BEFORE building the McpServer so the per-session
  // `session_attach` tool can close over it. The SDK calls
  // `sessionIdGenerator()` exactly once during initialize, then reports it
  // via `onsessioninitialized`. Generate eagerly here so we can wire the
  // closure first.
  const sessionId = randomUUID()
  ctx.sessions.set(sessionId, { sessionId })

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => sessionId,
    onsessioninitialized: (sid: string) => {
      ctx.transports.set(sid, transport)
      ctx.log('mcp.session.initialized', { sessionId: sid })
    },
  })

  transport.onclose = () => {
    const sid = transport.sessionId
    if (sid !== undefined) {
      ctx.transports.delete(sid)
      ctx.sessions.delete(sid)
      ctx.log('mcp.session.closed', { sessionId: sid })
    }
  }

  // Build per-session tool list: shared tools + a session.attach bound to
  // this session id.
  const sessionTools: ToolRegistration[] = [
    ...ctx.tools,
    createSessionAttachTool({
      sessionId,
      serverName: SERVER_NAME,
      serverVersion: SERVER_VERSION,
      toolNames: () => [...ctx.tools.map((t) => t.name), 'session_attach'],
      onAttach: (state) => {
        ctx.sessions.set(state.sessionId, state)
        ctx.log('mcp.session.attached', {
          sessionId: state.sessionId,
          agent: state.agent,
          runtimePid: state.runtimePid,
          clientName: state.clientName,
        })
      },
    }),
  ]

  const mcp = buildMcpServer(sessionTools)
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
    name: 'echo',
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

function checkBearer(req: http.IncomingMessage, expected: Buffer | undefined): boolean {
  if (expected === undefined) return false
  const header = headerValue(req.headers.authorization)
  if (!header) return false
  const match = /^Bearer\s+(.+)$/i.exec(header)
  if (!match) return false
  const presented = Buffer.from(match[1], 'utf8')
  if (presented.length !== expected.length) {
    // timingSafeEqual requires equal lengths — do a constant-time dummy
    // compare to avoid leaking length info via timing.
    const filler = Buffer.alloc(expected.length)
    timingSafeEqual(filler, expected)
    return false
  }
  return timingSafeEqual(presented, expected)
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
