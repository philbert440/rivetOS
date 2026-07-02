// den-server: protocol event ingest + WS fanout + snapshots + layout store.
//
// Adapters POST validated protocol events to /event; viewers connect to
// WS /ws (optionally ?session=<id>) and receive a full state snapshot
// followed by the live event stream. Late joiners never replay event soup —
// the reducer state IS the replay.
//
//   POST /event                 one AgentEvent (JSON) per request
//   GET  /sessions              recency-ordered session list
//   GET  /state?session=<id>    RoomState snapshot for one session
//   GET  /layout?viewer=<key>   per-viewer layout (server copy is canonical)
//   POST /layout?viewer=<key>   persist a viewer layout
//   WS   /ws?session=<id>       snapshot + live events (no filter = all)
//   GET  /healthz               liveness (never auth-gated)
//   GET  /packs/*, /*           static packs + built viewer, when configured
//
// Auth: when config.token is set, every endpoint except /healthz requires
// `Authorization: Bearer <token>` (WS: same header, or ?token= for browsers).

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from 'node:fs'
import { join, normalize, extname } from 'node:path'
import { WebSocketServer, type WebSocket } from 'ws'
import {
  initialDenState,
  initialRoomState,
  listSessions,
  parseEvent,
  reduceDen,
  type DenState,
} from '@rivetos/den-protocol'
import type { DenConfig } from './config.js'

const MIME: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.zip': 'application/zip',
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'content-type, authorization',
}

interface Client {
  ws: WebSocket
  session?: string
}

export interface DenServer {
  server: Server
  /** Current reducer state (exposed for tests/inspection). */
  state(): DenState
  close(): Promise<void>
}

const json = (res: ServerResponse, code: number, body: unknown): void => {
  res.writeHead(code, { 'Content-Type': 'application/json', ...CORS })
  res.end(JSON.stringify(body))
}

const readBody = (req: IncomingMessage, limit = 256 * 1024): Promise<string> =>
  new Promise((resolve, reject) => {
    let body = ''
    req.on('data', (d: Buffer) => {
      body += d.toString('utf8')
      if (body.length > limit) {
        reject(new Error('body too large'))
        req.destroy()
      }
    })
    req.on('end', () => resolve(body))
    req.on('error', reject)
  })

// viewer keys become filenames — keep them boring
const safeKey = (k: string): string => (/^[\w.-]{1,64}$/.test(k) ? k : '')

export function createDenServer(config: DenConfig): DenServer {
  let state = initialDenState
  const clients = new Set<Client>()

  mkdirSync(join(config.stateDir, 'layouts'), { recursive: true })

  const authorized = (req: IncomingMessage, url: URL): boolean => {
    if (!config.token) return true
    const header = req.headers.authorization ?? ''
    return header === `Bearer ${config.token}` || url.searchParams.get('token') === config.token
  }

  const serveStatic = (res: ServerResponse, root: string, rel: string): boolean => {
    const norm = normalize(rel).replace(/^([/\\])+/, '')
    if (norm.startsWith('..')) return false
    let file = join(root, norm)
    if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html')
    if (!existsSync(file) || !statSync(file).isFile()) return false
    res.writeHead(200, {
      'Content-Type': MIME[extname(file)] ?? 'application/octet-stream',
      ...CORS,
    })
    res.end(readFileSync(file))
    return true
  }

  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      if (req.method === 'OPTIONS') {
        res.writeHead(204, CORS)
        res.end()
        return
      }
      if (url.pathname === '/healthz') {
        json(res, 200, { ok: true, sessions: Object.keys(state.rooms).length })
        return
      }
      if (!authorized(req, url)) {
        json(res, 401, { error: 'unauthorized' })
        return
      }

      if (req.method === 'POST' && url.pathname === '/event') {
        const body = await readBody(req).catch(() => null)
        if (body === null) return json(res, 413, { error: 'body too large' })
        let raw: unknown
        try {
          raw = JSON.parse(body)
        } catch {
          return json(res, 400, { error: 'invalid JSON' })
        }
        const ev = parseEvent(raw)
        if (!ev) return json(res, 422, { error: 'not a valid v1 AgentEvent' })
        state = reduceDen(state, ev)
        const s = JSON.stringify(ev)
        for (const c of clients) {
          if (c.ws.readyState === 1 && (!c.session || c.session === ev.session)) c.ws.send(s)
        }
        return json(res, 200, { ok: true })
      }

      if (req.method === 'GET' && url.pathname === '/sessions') {
        return json(res, 200, { sessions: listSessions(state) })
      }

      if (req.method === 'GET' && url.pathname === '/state') {
        const id = url.searchParams.get('session')
        const room = id ? (state.rooms[id] as typeof initialRoomState | undefined) : undefined
        if (!id || !room) return json(res, 404, { error: 'unknown session' })
        return json(res, 200, { session: id, state: room })
      }

      if (url.pathname === '/layout') {
        const key = safeKey(url.searchParams.get('viewer') ?? 'default')
        if (!key) return json(res, 400, { error: 'bad viewer key' })
        const file = join(config.stateDir, 'layouts', `${key}.json`)
        if (req.method === 'GET') {
          // fall back to the shared default so a fresh browser adopts the room
          const fallback = join(config.stateDir, 'layouts', 'default.json')
          const src = existsSync(file) ? file : fallback
          if (!existsSync(src)) return json(res, 404, { error: 'no layout' })
          res.writeHead(200, { 'Content-Type': 'application/json', ...CORS })
          return res.end(readFileSync(src))
        }
        if (req.method === 'POST') {
          const body = await readBody(req).catch(() => null)
          if (body === null) return json(res, 413, { error: 'body too large' })
          try {
            JSON.parse(body)
          } catch {
            return json(res, 400, { error: 'invalid JSON' })
          }
          writeFileSync(file, body)
          return json(res, 200, { ok: true })
        }
      }

      if (req.method === 'GET' && config.packsDir && url.pathname.startsWith('/packs/')) {
        if (serveStatic(res, config.packsDir, url.pathname.slice('/packs/'.length))) return
      }
      if (req.method === 'GET' && config.staticDir) {
        if (serveStatic(res, config.staticDir, url.pathname)) return
      }
      json(res, 404, { error: 'not found' })
    })().catch((e: unknown) => {
      console.error('request failed:', e)
      if (!res.headersSent) json(res, 500, { error: 'internal error' })
    })
  })

  // noServer + manual upgrade so auth runs before the WS handshake completes
  const wss = new WebSocketServer({ noServer: true })
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (url.pathname !== '/ws' || !authorized(req, url)) {
      socket.destroy()
      return
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req))
  })
  wss.on('connection', (ws, req) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const session = url.searchParams.get('session') ?? undefined
    const client: Client = { ws, session }
    clients.add(client)
    ws.on('close', () => clients.delete(client))
    // catch the viewer up with a single snapshot instead of replayed events
    ws.send(
      JSON.stringify({
        type: 'snapshot',
        v: 1,
        sessions: listSessions(state),
        rooms: session ? { [session]: state.rooms[session] ?? initialRoomState } : state.rooms,
      }),
    )
  })

  return {
    server,
    state: () => state,
    close: () =>
      new Promise((resolve) => {
        for (const c of clients) c.ws.close()
        wss.close(() => server.close(() => resolve()))
      }),
  }
}
