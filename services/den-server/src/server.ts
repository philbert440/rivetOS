// den-server: protocol event ingest + WS fanout + snapshots + layout store.
//
// Adapters POST validated protocol events to /event; viewers connect to
// WS /ws (optionally ?session=<id>) and receive a full state snapshot
// followed by the live event stream. Late joiners never replay event soup —
// the reducer state IS the replay.
//
//   POST /event                 one AgentEvent (JSON) per request
//   POST /events                ordered batch (JSON array, max 100) — reduced
//                               atomically; preferred for multi-event hooks
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
//
// Stream messages that are NOT protocol AgentEvents (viewers must handle
// them before reducing): `{type:'snapshot',...}` on connect, and
// `{type:'session.removed', session}` when an ended session is evicted
// (evictTtlMs after session.end).

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, statSync } from 'node:fs'
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
  /** Heartbeat flag — set on pong, cleared on ping; dead = terminate. */
  alive: boolean
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

// Buffer.concat before decoding: per-chunk toString would corrupt a
// multi-byte UTF-8 char split across TCP chunks. On oversize we pause (not
// destroy) so the caller can still deliver its 413 before hanging up.
const readBody = (req: IncomingMessage, limit = 256 * 1024): Promise<string> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (d: Buffer) => {
      size += d.length
      if (size > limit) {
        req.pause()
        reject(new Error('body too large'))
        return
      }
      chunks.push(d)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })

// 413 that the client actually sees: respond first, then drop the socket
// (the request stream is paused mid-upload, so it must not be reused)
const tooLarge = (req: IncomingMessage, res: ServerResponse): void => {
  res.on('finish', () => req.destroy())
  json(res, 413, { error: 'body too large' })
}

// viewer keys become filenames — keep them boring
const safeKey = (k: string): string => (/^[\w.-]{1,64}$/.test(k) ? k : '')

export function createDenServer(config: DenConfig): DenServer {
  let state = initialDenState
  const clients = new Set<Client>()

  mkdirSync(join(config.stateDir, 'layouts'), { recursive: true })

  // skip half-dead sockets: readyState alone misses peers that vanished
  // without a FIN, and an unbounded bufferedAmount is a slow memory leak
  const MAX_BUFFERED = 1024 * 1024
  const broadcast = (s: string, session?: string): void => {
    for (const c of clients) {
      if (c.ws.readyState !== 1 || (session && c.session && c.session !== session)) continue
      if (c.ws.bufferedAmount > MAX_BUFFERED) {
        c.ws.terminate()
        clients.delete(c)
        continue
      }
      c.ws.send(s)
    }
  }

  const evictTimers = new Map<string, NodeJS.Timeout>()
  const clearEviction = (session: string): void => {
    const t = evictTimers.get(session)
    if (t) clearTimeout(t)
    evictTimers.delete(session)
  }
  const scheduleEviction = (session: string): void => {
    const t = setTimeout(() => {
      evictTimers.delete(session)
      const { [session]: _room, ...rooms } = state.rooms
      const { [session]: _info, ...sessions } = state.sessions
      state = { rooms, sessions }
      broadcast(JSON.stringify({ type: 'session.removed', v: 1, session }), session)
    }, config.evictTtlMs)
    t.unref?.()
    evictTimers.set(session, t)
  }

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

      // Ingestion is serialized by construction: everything from parse to
      // broadcast below is synchronous, so Node's event loop applies each
      // request's events atomically and in arrival order — there is no await
      // between reading `state` and writing it back. Cross-request ORDER is
      // the client's job: send one batch, or sequential single POSTs.
      const ingest = (ev: NonNullable<ReturnType<typeof parseEvent>>): void => {
        state = reduceDen(state, ev)
        // ended sessions linger for the TTL so the room is still visible
        // asleep, then get evicted; any newer event cancels the eviction
        clearEviction(ev.session)
        if (ev.type === 'session.end') scheduleEviction(ev.session)
        broadcast(JSON.stringify(ev), ev.session)
      }

      if (req.method === 'POST' && (url.pathname === '/event' || url.pathname === '/events')) {
        const body = await readBody(req).catch(() => null)
        if (body === null) return tooLarge(req, res)
        let raw: unknown
        try {
          raw = JSON.parse(body)
        } catch {
          return json(res, 400, { error: 'invalid JSON' })
        }
        // /events: ordered batch — the whole array reduces in one synchronous
        // pass, so in-batch order can never be scrambled by transport
        if (url.pathname === '/events') {
          if (!Array.isArray(raw) || raw.length === 0 || raw.length > 100)
            return json(res, 400, { error: 'expected an array of 1-100 events' })
          const evs = raw.map(parseEvent)
          const bad = evs.findIndex((e) => !e)
          if (bad !== -1)
            return json(res, 422, { error: `event[${bad}] is not a valid v1 AgentEvent` })
          for (const ev of evs) ingest(ev!)
          return json(res, 200, { ok: true, ingested: evs.length })
        }
        const ev = parseEvent(raw)
        if (!ev) return json(res, 422, { error: 'not a valid v1 AgentEvent' })
        ingest(ev)
        return json(res, 200, { ok: true })
      }

      if (req.method === 'GET' && url.pathname === '/sessions') {
        return json(res, 200, { sessions: listSessions(state) })
      }

      if (req.method === 'DELETE' && url.pathname === '/session') {
        const id = url.searchParams.get('session')
        if (!id || !(id in state.rooms)) return json(res, 404, { error: 'unknown session' })
        const rooms = { ...state.rooms }
        const sessions = { ...state.sessions }
        delete rooms[id]
        delete sessions[id]
        state = { rooms, sessions }
        clearEviction(id)
        // every OTHER viewer must drop the room too, not just the deleter
        broadcast(JSON.stringify({ type: 'session.removed', v: 1, session: id }), id)
        return json(res, 200, { ok: true })
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
          if (body === null) return tooLarge(req, res)
          try {
            JSON.parse(body)
          } catch {
            return json(res, 400, { error: 'invalid JSON' })
          }
          // temp + rename: a crash mid-write must not leave truncated JSON
          // that GET then serves verbatim
          const tmp = `${file}.tmp`
          writeFileSync(tmp, body)
          renameSync(tmp, file)
          return json(res, 200, { ok: true })
        }
      }

      if (req.method === 'GET' && config.packsDir && url.pathname.startsWith('/packs/')) {
        if (serveStatic(res, config.packsDir, url.pathname.slice('/packs/'.length))) return
      }
      if (req.method === 'GET' && config.staticDir) {
        if (serveStatic(res, config.staticDir, url.pathname)) return
        // SPA fallback: extensionless paths (e.g. /demo) get the viewer shell
        if (!extname(url.pathname) && serveStatic(res, config.staticDir, '/index.html')) return
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
    socket.on('error', () => socket.destroy())
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
    const client: Client = { ws, session, alive: true }
    clients.add(client)
    // without an error listener one ECONNRESET from a dropped viewer is an
    // uncaught exception that kills the whole server
    ws.on('error', () => {
      clients.delete(client)
      ws.terminate()
    })
    ws.on('close', () => clients.delete(client))
    ws.on('pong', () => (client.alive = true))
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

  // heartbeat: half-open sockets (peer gone without a FIN) never fire
  // 'close' on their own — ping them and terminate non-responders
  const heartbeat = setInterval(() => {
    for (const c of clients) {
      if (!c.alive) {
        c.ws.terminate()
        clients.delete(c)
        continue
      }
      c.alive = false
      c.ws.ping()
    }
  }, 30_000)
  heartbeat.unref?.()

  return {
    server,
    state: () => state,
    close: () =>
      new Promise((resolve) => {
        clearInterval(heartbeat)
        for (const t of evictTimers.values()) clearTimeout(t)
        evictTimers.clear()
        for (const c of clients) c.ws.close()
        wss.close(() => server.close(() => resolve()))
      }),
  }
}
