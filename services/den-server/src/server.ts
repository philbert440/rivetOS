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
//   GET  /mesh.json             den-enabled mesh roster + per-node den health
//   GET  /term/config           terminal roster (keys + labels — never argv)
//   POST /term                  spawn a roster command in a PTY (opt-in)
//   GET  /term/list             live + recently-exited PTYs
//   DELETE /term?id=<id>        kill a PTY (SIGHUP → SIGKILL)
//   WS   /term?id=<pty>         terminal attach: hello + scrollback replay +
//        | ?session=<den>       live bytes (see term/ws.ts for the framing)
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
import { hostname } from 'node:os'
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
import { createMeshView } from './mesh.js'
import { createRosterProvider } from './term/roster.js'
import { loadRealPtySpawn, type PtySpawn } from './term/pty.js'
import { createTermManager, TermSpawnError, type TermManager } from './term/manager.js'
import { createTermWs } from './term/ws.js'
import { listHarnessSessions, harnessSessionExists } from './term/harness-sessions.js'

const MIME: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.zip': 'application/zip',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
}

// Routed API paths — never shadowed by static files or the SPA fallback,
// and always behind the auth gate (the unauthenticated static block above
// the gate skips them explicitly).
const API_PATHS = new Set([
  '/event',
  '/events',
  '/sessions',
  '/state',
  '/session',
  '/layout',
  '/mesh.json',
  '/term',
  '/term/config',
  '/term/list',
  '/term/inject',
  '/term/harness-sessions',
])

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
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

export interface DenServerOptions {
  /** PTY backend override for tests: a fake spawn, or null to simulate a
   *  failed node-pty import. Omitted = lazy real node-pty. */
  ptySpawn?: PtySpawn | null
  /**
   * Gateway route mounts (G0, Appendix F): matched by longest prefix AFTER
   * the bearer gate and BEFORE den's own API routes and static serving —
   * /api/* families (tasks, catalog, sessions, …) plug in here without
   * touching this router.
   */
  extraRoutes?: Array<{
    prefix: string
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  }>
  /**
   * Gateway WS mounts (G5): exact-path upgrade handlers under /api/*,
   * checked AFTER the bearer gate — same trust model as extraRoutes. The
   * handler owns the ws handshake (its own WebSocketServer in noServer mode).
   */
  extraUpgrades?: Array<{
    path: string
    handle: (
      req: IncomingMessage,
      socket: import('node:stream').Duplex,
      head: Buffer,
      url: URL,
    ) => void
  }>
  /**
   * Seamless modes (5d): a tap on every ingested AgentEvent, after it has
   * updated den state and fanned to den viewers. The gateway bridges these
   * into /api/sessions/ws so the chat view of a live-harness conversation
   * streams. Fire-and-forget — must never throw into the ingest path.
   */
  onAgentEvent?: (ev: { session: string; type: string; [k: string]: unknown }) => void
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

export function createDenServer(config: DenConfig, opts: DenServerOptions = {}): DenServer {
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

  const meshView = createMeshView({
    meshFile: config.meshFile,
    cacheMs: config.meshCacheMs,
    // `latest` is only answerable for our own sessions; peers just get probed
    getLocalLatest: () => {
      const sessions = listSessions(state)
      if (sessions.length === 0) return null
      const room = state.rooms[sessions[0].id] as typeof initialRoomState | undefined
      return room ? { activity: room.activity, title: room.title } : null
    },
  })

  // Ingestion is serialized by construction: everything from parse to
  // broadcast is synchronous, so Node's event loop applies each caller's
  // events atomically and in arrival order — there is no await between
  // reading `state` and writing it back. Cross-request ORDER is the client's
  // job: send one batch, or sequential single POSTs.
  const ingest = (ev: NonNullable<ReturnType<typeof parseEvent>>): void => {
    state = reduceDen(state, ev)
    // ended sessions linger for the TTL so the room is still visible
    // asleep, then get evicted; any newer event cancels the eviction
    clearEviction(ev.session)
    if (ev.type === 'session.end') scheduleEviction(ev.session)
    broadcast(JSON.stringify(ev), ev.session)
    // Seamless-modes tap: bridge to the chat view (5d). Never let it throw
    // into ingest.
    if (opts.onAgentEvent) {
      try {
        opts.onAgentEvent(ev as unknown as { session: string; type: string })
      } catch {
        /* bridge errors must not break den ingest */
      }
    }
  }

  // ── terminals (opt-in) ─────────────────────────────────────────────────
  // SECURITY GATE: RIVETOS_DEN_TERM=1 with no auth token on a non-loopback
  // host would hang an unauthenticated shell (running as the service user)
  // on the network. Force terminals off and say so loudly — but never crash:
  // Restart=on-failure would loop the whole den over a config mistake.
  // RIVETOS_DEN_TERM_OPEN=1 is the explicit operator opt-out for trusted
  // private networks — the gate stands down, the log line stays.
  const LOOPBACK_HOSTS = ['127.0.0.1', '::1', 'localhost']
  const termGateError =
    config.term.enabled &&
    !config.term.open &&
    !config.token &&
    !LOOPBACK_HOSTS.includes(config.host)
      ? 'terminal disabled: RIVETOS_DEN_TOKEN required when host is not loopback'
      : ''
  const termEnabled = config.term.enabled && !termGateError
  if (termGateError)
    console.error(
      `[den-server] SECURITY: refusing to enable terminals — RIVETOS_DEN_TERM is set but ` +
        `RIVETOS_DEN_TOKEN is empty and host ${config.host} is not loopback. ` +
        `Set RIVETOS_DEN_TOKEN, bind to 127.0.0.1, or opt out with RIVETOS_DEN_TERM_OPEN=1 ` +
        `on a trusted network.`,
    )
  if (termEnabled && config.term.open && !config.token && !LOOPBACK_HOSTS.includes(config.host))
    console.warn(
      `[den-server] terminals are OPEN (tokenless on ${config.host}) by explicit ` +
        `RIVETOS_DEN_TERM_OPEN — anything that can reach this port can spawn a shell ` +
        `as this user.`,
    )

  const rosterProvider = createRosterProvider(config.term.configFile)
  let termManager: TermManager | null = null
  // memoized as a promise: concurrent first requests must share ONE backend
  // load + manager, and a failed node-pty import stays failed (503) for the
  // life of the process — it logs once inside loadRealPtySpawn
  let termManagerPromise: Promise<TermManager | null> | null = null
  const ensureManager = (): Promise<TermManager | null> =>
    (termManagerPromise ??= (async () => {
      const spawnBackend = opts.ptySpawn !== undefined ? opts.ptySpawn : await loadRealPtySpawn()
      if (!spawnBackend) return null
      termManager = createTermManager(config, {
        spawn: spawnBackend,
        roster: () => rosterProvider.get(),
        ingest: (raw) => {
          const ev = parseEvent(raw)
          if (ev) ingest(ev)
        },
        roomOpen: (s) => {
          const room = state.rooms[s] as typeof initialRoomState | undefined
          return !!room && !room.ended
        },
        sessionExists: harnessSessionExists,
        log: console.error,
      })
      return termManager
    })())

  // WS /term attach channel — shares the memoized manager (and its 503/gate
  // semantics: gated or disabled terminals destroy the upgrade)
  const termWs = createTermWs({ manager: ensureManager, enabled: () => termEnabled })

  // sessions gain a `pty: '<id>'` marker while a local PTY is linked to them
  // (extra field — viewers that don't know it ignore it)
  const decorateSessions = (
    sessions: ReturnType<typeof listSessions>,
  ): (ReturnType<typeof listSessions>[number] & { pty?: string })[] =>
    sessions.map((s) => {
      const pty = termManager?.ptyForSession(s.id)
      return pty ? { ...s, pty } : s
    })

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
      // hashed bundles cache forever; everything else (index.html, packs)
      // revalidates so deploys don't depend on the user hard-refreshing
      'Cache-Control': /-[\w]{8}\.\w+$/.test(file)
        ? 'public, max-age=31536000, immutable'
        : 'no-cache',
      ...CORS,
    })
    res.end(readFileSync(file))
    return true
  }

  // Gateway API aliases (G2/G3/G6, Appendix F): stable /api/* names for
  // den's existing surfaces. Legacy paths stay — adapters/viewers migrate
  // at leisure; RivetHub clients use only the /api/* names.
  //
  // FOOTGUN: canonicalize() runs before extraRoutes matching, so a gateway
  // mount at an aliased prefix (e.g. '/api/events') would NEVER match —
  // aliased prefixes belong to den; new route families must use fresh
  // prefixes (/api/tasks, /api/catalog, ...).
  const API_ALIASES: Record<string, string> = {
    '/api/events': '/events',
    '/api/events/event': '/event',
    '/api/events/sessions': '/sessions',
    '/api/events/state': '/state',
    '/api/events/ws': '/ws',
    '/api/mesh': '/mesh.json',
    '/api/terminal': '/term',
    '/api/terminal/config': '/term/config',
    '/api/terminal/list': '/term/list',
    '/api/terminal/inject': '/term/inject',
    '/api/terminal/harness-sessions': '/term/harness-sessions',
    '/api/terminal/ws': '/term',
  }
  const canonicalize = (url: URL): void => {
    const alias = API_ALIASES[url.pathname]
    if (alias) url.pathname = alias
  }

  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      canonicalize(url)
      if (req.method === 'OPTIONS') {
        res.writeHead(204, CORS)
        res.end()
        return
      }
      if (url.pathname === '/healthz') {
        // `name` = the node's hostname (e.g. rivet-grok) so the UI can show a
        // human-readable node label instead of host:port. Unauthed, like the
        // rest of /healthz.
        json(res, 200, { ok: true, sessions: Object.keys(state.rooms).length, name: hostname() })
        return
      }
      // Static viewer + pack art are served WITHOUT auth: the SPA's own
      // <script>/<link>/sprite subresources can't carry a bearer token, so
      // gating them just breaks the app shell (blank page) without protecting
      // anything sensitive. Session data, events, layouts, mesh, and
      // terminals all stay behind the gate below.
      // Landing redirect (3e): '/' → config.rootRedirect (e.g. /wiki on the
      // datahub node) — before static so the SPA shell doesn't swallow it.
      if (config.rootRedirect && url.pathname === '/' && req.method === 'GET') {
        res.writeHead(302, { Location: config.rootRedirect })
        res.end()
        return
      }
      if (req.method === 'GET' || req.method === 'HEAD') {
        if (config.packsDir && url.pathname.startsWith('/packs/')) {
          if (serveStatic(res, config.packsDir, url.pathname.slice('/packs/'.length))) return
        }
        // /api/* belongs to gateway route mounts and aliases — never the
        // static viewer. Without this carve-out the SPA fallback hijacks
        // extensionless GETs like /api/tasks (G1 regression, fixed in G2).
        // Gateway mounts own their prefixes even outside /api/ (e.g. /wiki)
        // — without this the SPA fallback hijacks them (G1-regression class).
        const gatewayOwned = (opts.extraRoutes ?? []).some(
          (r) => url.pathname === r.prefix || url.pathname.startsWith(r.prefix + '/'),
        )
        if (
          config.staticDir &&
          !API_PATHS.has(url.pathname) &&
          !url.pathname.startsWith('/api/') &&
          !gatewayOwned
        ) {
          if (serveStatic(res, config.staticDir, url.pathname)) return
          // SPA fallback: extensionless paths (e.g. /mesh, /demo) get the
          // shell. A nested app bundled under the static root (the den
          // viewer at /den/ inside a rivethub deploy) gets ITS index for
          // paths under its prefix — /den/mesh must boot den, not rivethub.
          if (!extname(url.pathname)) {
            const seg = url.pathname.split('/')[1]
            if (seg && serveStatic(res, config.staticDir, `/${seg}/index.html`)) return
            if (serveStatic(res, config.staticDir, '/index.html')) return
          }
        }
      }
      if (!authorized(req, url)) {
        json(res, 401, { error: 'unauthorized' })
        return
      }

      // Gateway route mounts (G0): longest prefix wins; behind the bearer
      // gate, ahead of den's own API routes.
      if (opts.extraRoutes?.length) {
        const route = opts.extraRoutes
          .filter((r) => url.pathname === r.prefix || url.pathname.startsWith(r.prefix + '/'))
          .sort((a, b) => b.prefix.length - a.prefix.length)[0]
        if (route) {
          // Gateway handlers use writeHead directly and know nothing about
          // CORS; set the same headers den's own routes send so cross-node
          // browser clients (RivetHub settings probe, 4h node switcher)
          // aren't blocked. setHeader survives the handler's writeHead.
          for (const [k, v] of Object.entries(CORS)) res.setHeader(k, v)
          await route.handler(req, res)
          return
        }
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
        return json(res, 200, { sessions: decorateSessions(listSessions(state)) })
      }

      // `.json` deliberately: the extensionless /mesh belongs to the viewer
      // SPA and falls through to the static index.html fallback below
      if (req.method === 'GET' && url.pathname === '/mesh.json') {
        const overview = await meshView.overview()
        if (!overview) return json(res, 404, { error: 'no mesh file' })
        return json(res, 200, overview)
      }

      if (req.method === 'DELETE' && url.pathname === '/session') {
        const id = url.searchParams.get('session')
        if (!id) return json(res, 404, { error: 'unknown session' })
        // a PTY linked to the session dies with the room — removing the room
        // while its terminal keeps running would leak an invisible shell
        const ptyId = termManager?.ptyForSession(id)
        if (ptyId) termManager?.kill(ptyId)
        if (!(id in state.rooms)) {
          // PTY existed but its harness never emitted events → still a kill
          return ptyId ? json(res, 200, { ok: true }) : json(res, 404, { error: 'unknown session' })
        }
        const { [id]: _room, ...rooms } = state.rooms
        const { [id]: _info, ...sessions } = state.sessions
        state = { rooms, sessions }
        clearEviction(id)
        // every OTHER viewer must drop the room too, not just the deleter
        broadcast(JSON.stringify({ type: 'session.removed', v: 1, session: id }), id)
        return json(res, 200, { ok: true })
      }

      // ── terminals (opt-in) ──────────────────────────────────────────────
      if (url.pathname === '/term' || url.pathname.startsWith('/term/')) {
        // misconfiguration answers loudly on EVERY term endpoint so the
        // operator finds out from the first click, not from a silent absence
        if (termGateError) return json(res, 503, { error: termGateError })

        if (req.method === 'GET' && url.pathname === '/term/config') {
          const roster = rosterProvider.get()
          return json(res, 200, {
            enabled: termEnabled,
            default: roster.default,
            maxPtys: config.term.maxPtys,
            active: termManager?.active() ?? 0,
            // keys + labels only — argv/cwd/env are operator-private
            commands: Object.entries(roster.commands).map(([cmdId, c]) => ({
              id: cmdId,
              label: c.label,
              room: c.room,
            })),
          })
        }

        if (!termEnabled) return json(res, 503, { error: 'terminal disabled' })
        const manager = await ensureManager()
        if (!manager) return json(res, 503, { error: 'node-pty unavailable' })

        if (req.method === 'POST' && url.pathname === '/term') {
          const body = await readBody(req).catch(() => null)
          if (body === null) return tooLarge(req, res)
          let raw: unknown = {}
          if (body.trim() !== '') {
            try {
              raw = JSON.parse(body)
            } catch {
              return json(res, 400, { error: 'invalid JSON' })
            }
          }
          if (typeof raw !== 'object' || raw === null)
            return json(res, 400, { error: 'expected an object' })
          const p = raw as {
            command?: unknown
            cols?: unknown
            rows?: unknown
            session?: unknown
            resume?: unknown
          }
          if (p.command !== undefined && typeof p.command !== 'string')
            return json(res, 400, { error: 'command must be a roster key' })
          if (p.session !== undefined && typeof p.session !== 'string')
            return json(res, 400, { error: 'session must be a string' })
          if (p.resume !== undefined && typeof p.resume !== 'string')
            return json(res, 400, { error: 'resume must be a string' })
          const clamp = (v: unknown, lo: number, hi: number, dflt: number): number =>
            typeof v === 'number' && Number.isFinite(v)
              ? Math.min(hi, Math.max(lo, Math.floor(v)))
              : dflt
          try {
            const pty = manager.spawn(
              p.command,
              clamp(p.cols, 20, 500, 80),
              clamp(p.rows, 5, 200, 24),
              req.socket.remoteAddress ?? '',
              p.session,
              p.resume,
            )
            return json(res, 201, {
              id: pty.id,
              denSession: pty.denSession,
              command: pty.command,
              pid: pty.pid,
              createdAt: pty.createdAt,
            })
          } catch (e) {
            if (e instanceof TermSpawnError)
              return json(res, e.code === 'cap' ? 409 : 404, { error: e.message })
            throw e
          }
        }

        if (req.method === 'GET' && url.pathname === '/term/list') {
          return json(res, 200, { ptys: manager.list() })
        }

        // GET /term/harness-sessions — list the node's harness sessions
        // straight from their on-disk stores (node-local by construction, so
        // no cross-node bleed). The drawer opens one via spawn { session, resume }.
        if (req.method === 'GET' && url.pathname === '/term/harness-sessions') {
          const roster = rosterProvider.get()
          const limRaw = url.searchParams.get('limit')
          const limN = limRaw ? Number.parseInt(limRaw, 10) : NaN
          const limit = Number.isFinite(limN) && limN > 0 ? Math.min(limN, 500) : 100
          const sessions = await listHarnessSessions(Object.keys(roster.commands), limit)
          return json(res, 200, { sessions })
        }

        if (req.method === 'DELETE' && url.pathname === '/term') {
          const id = url.searchParams.get('id') ?? ''
          if (!manager.kill(id)) return json(res, 404, { error: 'unknown pty' })
          return json(res, 200, { ok: true })
        }

        // POST /term/inject — write a chat turn into the session's harness
        // stdin (seamless modes 5c). Chat sends go through THIS path rather
        // than raw client keystrokes, so the composer isn't fighting the TUI;
        // a terminal attach can still write too (it's the same PTY), so this
        // isn't a hard single-writer lock — just the sanctioned chat path.
        if (req.method === 'POST' && url.pathname === '/term/inject') {
          const body = await readBody(req).catch(() => null)
          if (body === null) return tooLarge(req, res)
          let raw: unknown
          try {
            raw = JSON.parse(body || '{}')
          } catch {
            return json(res, 400, { error: 'invalid JSON' })
          }
          const p = raw as { session?: unknown; text?: unknown; submit?: unknown }
          if (typeof p.session !== 'string' || p.session === '')
            return json(res, 400, { error: 'session (string) is required' })
          if (typeof p.text !== 'string')
            return json(res, 400, { error: 'text (string) is required' })
          const ptyId = manager.ptyForSession(p.session)
          if (!ptyId) return json(res, 409, { error: 'no live harness for session' })
          const submit = p.submit !== false // default true
          if (!manager.inject(ptyId, p.text, submit))
            return json(res, 409, { error: 'harness not writable' })
          return json(res, 202, { ok: true, ptyId })
        }
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
    canonicalize(url)
    if (!authorized(req, url)) {
      socket.destroy()
      return
    }
    if (url.pathname === '/ws') {
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req))
      return
    }
    if (url.pathname === '/term') {
      // auth is decided out here; enabled/known-id checks live inside
      termWs.handleUpgrade(req, socket, head, url)
      return
    }
    const up = opts.extraUpgrades?.find((u) => u.path === url.pathname)
    if (up) {
      up.handle(req, socket, head, url)
      return
    }
    socket.destroy()
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
        sessions: decorateSessions(listSessions(state)),
        rooms: session ? { [session]: state.rooms[session] ?? initialRoomState } : state.rooms,
      }),
    )
  })

  // heartbeat: half-open sockets (peer gone without a FIN) never fire
  // 'close' on their own — ping them and terminate non-responders. Term
  // clients ride the same sweep.
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
    termWs.heartbeat()
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
        termWs.close()
        termManager?.close()
        for (const c of clients) c.ws.close()
        wss.close(() => server.close(() => resolve()))
      }),
  }
}
