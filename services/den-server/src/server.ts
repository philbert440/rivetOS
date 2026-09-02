// den-server: protocol event ingest + WS fanout + snapshots + layout store.
//
// Adapters POST validated protocol events to /event; clients connect to
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
//   GET  /term/list             live + recently-exited PTYs, plus tmux
//                               sessions with no den client (persisted:true)
//   DELETE /term?id=<id>        kill a PTY (tmux: kill-session, then
//                               SIGHUP → SIGKILL on den's client as backstop)
//   WS   /term?id=<pty>         terminal attach: hello + scrollback replay +
//        | ?session=<den>       live bytes (see term/ws.ts for the framing)
//   WS   /ws?session=<id>       snapshot + live events (no filter = all)
//   GET  /healthz               liveness (never auth-gated)
//   GET  /*                     built hub app, when staticDir is configured
//   GET  /v1/models             OpenAI list (agent id = model id; gateway mount)
//   POST /v1/chat/completions   OpenAI chat (SSE or JSON; gateway mount)
//
// Auth: Rivet CA device client certificates (mTLS). Bearer tokens and
// `?token=` are not accepted. Loopback plain HTTP is allowed for the local
// node process; off-loopback requires TLS + a device leaf (OU=client /
// CN=device:*). See auth.ts and scripts/rivet-ca.sh issue-client.
//
// Stream messages that are NOT protocol AgentEvents (viewers must handle
// them before reducing): `{type:'snapshot',...}` on connect, and
// `{type:'session.removed', session}` when an ended session is evicted
// (evictTtlMs after session.end).

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
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
import { MeshParseError, type HarnessDriver, type UserContext } from '@rivetos/types'
import type { DenConfig } from './config.js'
import {
  bindRequestUser,
  boundRequestUser,
  captureEnvFor,
  resolveRequestUser,
  stampUserHeader,
} from './identity.js'
import { auditTenancyDeny, createSessionOwners, sessionForbidden } from './session-owners.js'
import { createMeshView } from './mesh.js'
import { composeTermAttach, wirePtyInfo } from './term/attach.js'
import { createRosterProvider } from './term/roster.js'
import { loadRealPtySpawn, type PtySpawn } from './term/pty.js'
import { createTermManager, TermSpawnError, type TermManager } from './term/manager.js'
import { TmuxUnavailableError, type TmuxCtl } from './term/tmux.js'
import { createTermWs } from './term/ws.js'
import { MicBridge } from './audio/bridge.js'
import { createAudioWs } from './audio/ws.js'
import { handleAudioHttp } from './audio/http.js'
import {
  listHarnessSessions,
  harnessSessionExists,
  readHarnessTranscript,
} from './term/harness-sessions.js'
import { createFilesRoutes } from './files.js'
import { createDevicesRoutes } from './devices.js'
import { createAgentsRoutes } from './agents.js'
import { createHarnessRegistry, type HarnessRegistry } from './harness/registry.js'
import { ClaudeCodeDriver, type DenAgentEventLike } from './harness/claude-driver.js'
import { GrokBuildDriver } from './harness/grok-driver.js'
import { HermesDriver } from './harness/hermes-driver.js'
import { KimiCodeDriver } from './harness/kimi-driver.js'
import { DeepseekHarnessDriver } from './harness/deepseek-driver.js'
import { createHarnessStore } from './harness/harness-store.js'
import { createHarnessRoutes } from './harness/routes.js'
import { denJoinKey } from './harness/session-key.js'
import { createUploadRoutes } from './harness/uploads.js'
import { createVoiceRoutes } from './voice-proxy.js'
import {
  startAliasRestore,
  type AliasRestoreResult,
  type RotationBreadcrumbSource,
} from './harness/alias-restore.js'
import {
  isGatewayAuthorized,
  isLoopbackHost,
  isLoopbackRemote,
  wantsHtmlUnauthorized,
  UNAUTHORIZED_HTML,
} from './auth.js'

// Push-based transcript sync (seamless modes v2) — constructed by the boot
// registrar and handed to the gateway channel, so it rides this export path.
export { createTranscriptWatcher, type TranscriptWatcher } from './term/transcript-watch.js'

// Harness control plane (docs/ARCHITECTURE.md) — the registry,
// the `claude-code` reference driver, the `grok-build`, `hermes`,
// `kimi-code` and `deepseek-harness` drivers, the `PtyHarnessDriver` base
// they share, and the alias/codec helpers around them. Re-exported here so
// consumers have one entry point.
export {
  createAliasStore,
  normalizeSessionId,
  collapsePathFallback,
  isBareNativeUuid,
  MAX_ALIAS_CHAIN_DEPTH,
  type AliasStore,
} from './harness/alias.js'
export {
  createHarnessRegistry,
  isHarnessId,
  type HarnessRegistry,
  type HarnessDescriptor,
  type ResolvedSession,
} from './harness/registry.js'
export {
  asCapabilitySource,
  capabilityDiff,
  type HarnessCapabilityEvent,
  type HarnessCapabilitySource,
} from './harness/capabilities.js'
export {
  createPgBreadcrumbSource,
  restoreHarnessAliases,
  startAliasRestore,
  DEFAULT_LOOKBACK_MS as ALIAS_RESTORE_LOOKBACK_MS,
  DEFAULT_LIMIT as ALIAS_RESTORE_LIMIT,
  type AliasRestoreResult,
  type RotationBreadcrumb,
  type RotationBreadcrumbSource,
} from './harness/alias-restore.js'
export {
  ClaudeCodeDriver,
  CLAUDE_HARNESS_ID,
  CLAUDE_ROSTER_COMMAND,
  type ClaudeDriverDeps,
  type ClaudePtyHost,
  type ClaudeStoreHost,
  type DenAgentEventLike,
} from './harness/claude-driver.js'
export {
  GrokBuildDriver,
  GROK_HARNESS_ID,
  GROK_ROSTER_COMMAND,
  type GrokDriverDeps,
  type GrokPtyHost,
  type GrokStoreHost,
} from './harness/grok-driver.js'
export {
  HermesDriver,
  HERMES_HARNESS_ID,
  HERMES_ROSTER_COMMAND,
  type HermesDriverDeps,
  type HermesPtyHost,
  type HermesStoreHost,
} from './harness/hermes-driver.js'
export {
  KimiCodeDriver,
  KIMI_HARNESS_ID,
  KIMI_ROSTER_COMMAND,
  type KimiDriverDeps,
  type KimiPtyHost,
  type KimiStoreHost,
} from './harness/kimi-driver.js'
export {
  DeepseekHarnessDriver,
  DEEPSEEK_HARNESS_ID,
  DEEPSEEK_ROSTER_COMMAND,
  type DeepseekDriverDeps,
  type DeepseekPtyHost,
  type DeepseekStoreHost,
} from './harness/deepseek-driver.js'
export { createHarnessStore, type HarnessStoreName } from './harness/harness-store.js'
export {
  PtyHarnessDriver,
  type HarnessPtyHost,
  type HarnessStoreHost,
  type PtyHarnessDriverDeps,
  type PtyHarnessIdentity,
} from './harness/pty-harness-driver.js'
export {
  AdoptingPtyHarnessDriver,
  type AdoptingHarnessIdentity,
} from './harness/adopting-harness-driver.js'
export {
  createHarnessRoutes,
  decodeSessionSegment,
  harnessErrorStatus,
  type HarnessRoutes,
  type HarnessTranscriptSource,
} from './harness/routes.js'

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
  '/audio',
  '/audio/status',
  '/audio/health',
  '/files/list',
  '/files/download',
  '/files/upload',
  '/files/mkdir',
  '/files/rename',
  '/files/delete',
])

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
  // x-rivet-conversation / x-rivet-title: OpenAI /v1 bridge conventions (Android)
  'Access-Control-Allow-Headers':
    'content-type, authorization, x-rivet-conversation, x-rivet-title',
}

interface Client {
  ws: WebSocket
  session?: string
  /** Bound tenancy identity (when a users registry is active) — broadcasts
   *  for sessions this user does not own are withheld. */
  user?: UserContext
  /** Heartbeat flag — set on pong, cleared on ping; dead = terminate. */
  alive: boolean
}

export interface DenServer {
  server: Server
  /** Current reducer state (exposed for tests/inspection). */
  state(): DenState
  /**
   * Harness control plane (docs/ARCHITECTURE.md): the node's
   * `HarnessDriver` registry. The five built-in drivers (`claude-code`,
   * `grok-build`, `hermes`, `kimi-code`, `deepseek-harness`) register here at
   * boot. Extra drivers can still be added via `DenServerOptions.harnessDrivers`.
   */
  harnesses: HarnessRegistry
  /**
   * Post-restart alias reconstruction (§ Rotation migration story): rotation
   * breadcrumbs read back out of the memory DB and re-recorded as aliases.
   * Fired at boot and never awaited by the startup path — exposed so an
   * operator tool or a test can see how it went. Resolves `ok: false` when
   * there was no source or the DB could not answer.
   */
  aliasesRestored: Promise<AliasRestoreResult>
  close(): Promise<void>
}

export interface DenServerOptions {
  /** PTY backend override for tests: a fake spawn, or null to simulate a
   *  failed node-pty import. Omitted = lazy real node-pty. */
  ptySpawn?: PtySpawn | null
  /** tmux control override for tests (T1) — scripted has-session/kill-session
   *  answers so tests never spawn a real tmux. Omitted = real execFileSync
   *  tmux on the per-den `-L rivet-<hash>` socket (when mux resolves to tmux). */
  tmuxCtl?: TmuxCtl
  /** Which mesh.json node is this process — default $RIVETOS_DEN_NODE_ID,
   *  else os.hostname(). Used for attach.host / attach.sshUser. */
  localNodeId?: string
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
  /**
   * Extra HarnessDrivers to register alongside the five built-in drivers
   * (`claude-code`, `grok-build`, `hermes`, `kimi-code`, `deepseek-harness`).
   */
  harnessDrivers?: HarnessDriver[]
  /**
   * Skip registering the built-in `claude-code` + `grok-build` + `hermes` +
   * `kimi-code` + `deepseek-harness` drivers — tests that drive the registry
   * with a fake, and nodes that want their own wiring. They are skipped
   * together: they share the PTY host and the den event tap, so a node that
   * replaces one is replacing that wiring for all of them.
   */
  skipBuiltinHarnessDrivers?: boolean
  /**
   * Rotation-breadcrumb source for the post-restart alias reconstructor.
   * Omitted = the memory DB at `config.pgUrl` (`RIVETOS_PG_URL`); with no URL
   * configured there is nothing to recover from and reconstruction is skipped.
   * `null` disables it outright — what most tests want.
   */
  aliasBreadcrumbs?: RotationBreadcrumbSource | null
}

const json = (res: ServerResponse, code: number, body: unknown): void => {
  res.writeHead(code, { 'Content-Type': 'application/json', ...CORS })
  res.end(JSON.stringify(body))
}

const unauthorized = (req: IncomingMessage, res: ServerResponse, url: URL): void => {
  if (wantsHtmlUnauthorized(req, url.pathname)) {
    res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8', ...CORS })
    res.end(UNAUTHORIZED_HTML)
    return
  }
  json(res, 401, { error: 'unauthorized' })
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
  // Persisted session ownership — hoisted above broadcast so the live event
  // fanout filters by it too, not just the listing routes. Untagged = owner.
  const sessionOwners = createSessionOwners(join(config.stateDir, 'session-owners.json'))

  mkdirSync(join(config.stateDir, 'layouts'), { recursive: true })

  // skip half-dead sockets: readyState alone misses peers that vanished
  // without a FIN, and an unbounded bufferedAmount is a slow memory leak
  const MAX_BUFFERED = 1024 * 1024
  const broadcast = (s: string, session?: string): void => {
    for (const c of clients) {
      if (c.ws.readyState !== 1 || (session && c.session && c.session !== session)) continue
      // tenancy: a session-scoped event never reaches a user who does not own it
      if (session && c.user && !sessionOwners.visible(session, c.user)) continue
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
    t.unref()
    evictTimers.set(session, t)
  }

  const localNodeId = opts.localNodeId ?? process.env.RIVETOS_DEN_NODE_ID ?? hostname()
  const meshView = createMeshView({
    meshFile: config.meshFile,
    sharedRoot: config.sharedRoot,
    cacheMs: config.meshCacheMs,
    localNodeId,
    // Trust the Rivet CA for https peers (#491) — peers' node leaves don't
    // chain to system roots, so without this every TLS peer shows offline.
    caPath: config.tls.caPath,
    // `latest` is only answerable for our own sessions; peers just get probed
    getLocalLatest: () => {
      const sessions = listSessions(state)
      if (sessions.length === 0) return null
      const room = state.rooms[sessions[0].id] as typeof initialRoomState | undefined
      return room ? { activity: room.activity, title: room.title } : null
    },
  })

  /** Raw AgentEvent subscribers — the harness drivers' live event source. */
  const denEventSinks = new Set<(ev: { session: string; type: string }) => void>()

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
    // Harness control plane tap: the drivers' live event source. Same rule —
    // a driver bug must never break den ingest.
    for (const sink of [...denEventSinks]) {
      try {
        sink(ev)
      } catch {
        /* as above */
      }
    }
  }

  // ── terminals (opt-in) ─────────────────────────────────────────────────
  // Off-loopback shells require gateway TLS + device client certs (same gate
  // as the rest of the API). Without TLS paths, terminals stay off unless
  // the bind is loopback.
  const tlsReady = Boolean(config.tls.certPath.trim()) && Boolean(config.tls.keyPath.trim())
  const termGateError =
    config.term.enabled && !tlsReady && !isLoopbackHost(config.host)
      ? 'terminal disabled: gateway TLS (RIVETOS_DEN_TLS_CERT/KEY) required when host is not loopback'
      : ''
  const termEnabled = config.term.enabled && !termGateError
  if (termGateError)
    console.error(
      `[den-server] SECURITY: refusing to enable terminals — RIVETOS_DEN_TERM is set but ` +
        `TLS is not configured and host ${config.host} is not loopback. ` +
        `Set RIVETOS_DEN_TLS_CERT + RIVETOS_DEN_TLS_KEY (node cert) and enroll devices ` +
        `with rivet-ca.sh issue-client, or bind den.host to loopback.`,
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
        tmuxCtl: opts.tmuxCtl,
        log: console.error,
      })
      return termManager
    })())

  // WS /term attach channel — shares the memoized manager (and its 503/gate
  // semantics: gated or disabled terminals destroy the upgrade)
  const termWs = createTermWs({
    manager: ensureManager,
    enabled: () => termEnabled,
    authorize: (req, denSession) => {
      const ctx = boundRequestUser(req)
      if (!sessionForbidden(sessionOwners, ctx, denSession)) return true
      auditTenancyDeny('WS /term attach', denSession, ctx as UserContext)
      return false
    },
  })

  // ── harness control plane ───────────────────────────────────────────────
  // Roster cwd for a harness entry, read at call time — rosterProvider
  // re-reads den-term.json when it changes on disk, so an operator edit is
  // reflected without a restart (passed as a getter, not a snapshot).
  const rosterCwdFor = (key: string) => (): string => {
    const roster = rosterProvider.get()
    if (!Object.hasOwn(roster.commands, key)) return roster.cwd
    return roster.commands[key].cwd ?? roster.cwd
  }
  // The node's HarnessDriver registry (docs/ARCHITECTURE.md).
  // All five built-in drivers formalize the machinery right above them — the
  // term manager (spawn/--resume/inject/Esc), the harness's on-disk store, and
  // the den AgentEvent stream — behind the one contract, and share it through
  // `PtyHarnessDriver`. Capability flags follow what is ACTUALLY wired here: no
  // terminals on this node means no interrupt/resume, no den tap means no
  // liveStream, and `approvals` is false for all five regardless (their
  // permission prompts live inside their TUIs and never reach the den wire).
  // `hermes`, `kimi-code` and `deepseek-harness` cannot pin a new session's id,
  // so they refuse `startSession`, adopt sessions (den stream and/or store),
  // and report a room whose session changed as a rotation.
  const harnesses = createHarnessRegistry({ log: console.error })
  const denEventTap = (sink: (ev: DenAgentEventLike) => void): (() => void) => {
    denEventSinks.add(sink)
    return () => denEventSinks.delete(sink)
  }
  /** Built-ins we own the lifetime of — closed on shutdown to drop the tap. */
  const builtinDrivers: (HarnessDriver & { close(): void })[] = []
  if (!opts.skipBuiltinHarnessDrivers) {
    builtinDrivers.push(
      new ClaudeCodeDriver({
        store: createHarnessStore('claude'),
        pty: termEnabled ? () => ensureManager() : undefined,
        events: denEventTap,
        cwd: rosterCwdFor('claude'),
        log: console.error,
      }),
      new GrokBuildDriver({
        store: createHarnessStore('grok'),
        pty: termEnabled ? () => ensureManager() : undefined,
        events: denEventTap,
        cwd: rosterCwdFor('grok'),
        log: console.error,
      }),
      new HermesDriver({
        store: createHarnessStore('hermes'),
        pty: termEnabled ? () => ensureManager() : undefined,
        events: denEventTap,
        cwd: rosterCwdFor('hermes'),
        log: console.error,
      }),
      new KimiCodeDriver({
        store: createHarnessStore('kimi'),
        pty: termEnabled ? () => ensureManager() : undefined,
        events: denEventTap,
        cwd: rosterCwdFor('kimi'),
        log: console.error,
      }),
      new DeepseekHarnessDriver({
        store: createHarnessStore('deepseek'),
        pty: termEnabled ? () => ensureManager() : undefined,
        // Tap is wired so a future harnessSession stamp can adopt a drawer
        // spawn. dsh itself has no hook-fed events today; liveStream then
        // reports the tap, not a fake assistant stream.
        events: denEventTap,
        cwd: rosterCwdFor('dsh'),
        log: console.error,
      }),
    )
    for (const driver of builtinDrivers) harnesses.register(driver)
  }
  for (const driver of opts.harnessDrivers ?? []) harnesses.register(driver)
  const harnessRoutes = createHarnessRoutes({
    registry: harnesses,
    log: console.error,
    filterSessions: (req, sessions) => {
      const ctx = boundRequestUser(req)
      if (!ctx) return sessions
      return sessionOwners.filter(sessions, ctx, (s) => s.sessionId)
    },
    authorizeSession: (req, sessionId, route) => {
      const ctx = boundRequestUser(req)
      if (!sessionForbidden(sessionOwners, ctx, sessionId)) return true
      auditTenancyDeny(route ?? 'WS harness stream', sessionId, ctx as UserContext)
      return false
    },
    claimSession: (req, sessionId) => {
      const ctx = boundRequestUser(req)
      if (!ctx) return true // tenancy off — single-owner node
      const owner = sessionOwners.get(sessionId)
      if (owner && owner !== ctx.userId) {
        auditTenancyDeny('harness claim', sessionId, ctx)
        return false
      }
      sessionOwners.set(sessionId, ctx.userId)
      return true
    },
  })

  // Post-restart alias reconstruction (§ Rotation migration story). The alias
  // store is in-memory and died with the last process; the rotation
  // breadcrumbs hermes capture wrote to the memory DB did not. Read them back
  // and re-record each link through the registry's own `record()` path, so the
  // chain-hygiene rules apply to a rebuilt chain exactly as to a live one.
  //
  // Deliberately NOT awaited: a remote or down memory DB must never delay a
  // node's boot, and a miss is failure-soft — the breadcrumbs stay on disk and
  // the next boot tries again.
  const aliasesRestored = startAliasRestore({
    registry: harnesses,
    ...(opts.aliasBreadcrumbs !== undefined ? { source: opts.aliasBreadcrumbs } : {}),
    ...(config.pgUrl ? { pgUrl: config.pgUrl } : {}),
    log: console.error,
  })

  // Attachment staging for remote clients (POST /api/uploads). Rides the same
  // mTLS gate as the rest of the harness surface. The disk exposure is bounded
  // by a per-upload cap plus a TTL sweep.
  const uploadRoutes = createUploadRoutes({
    dir: config.uploads?.dir || join(config.stateDir, 'uploads'),
    ...(config.uploads ? { maxBytes: config.uploads.maxBytes, ttlMs: config.uploads.ttlMs } : {}),
    log: console.error,
  })

  // Voice proxy (POST /api/voice/*) — mic bytes → node-configured STT, reply
  // text → TTS audio. Clients never see the upstream addresses; nodes without
  // the env config answer 501 and the hub hides the feature.
  const voiceRoutes = createVoiceRoutes({
    sttUrl: config.voice?.sttUrl ?? '',
    ttsUrl: config.voice?.ttsUrl ?? '',
    ttsInstructions: config.voice?.ttsInstructions ?? '',
    log: console.error,
  })

  // MicBridge — same off-loopback rule as terminals (gateway TLS required).
  const audioGateError =
    config.audio.enabled && !tlsReady && !isLoopbackHost(config.host)
      ? 'audio disabled: gateway TLS required when host is not loopback'
      : ''
  const audioEnabled = config.audio.enabled && !audioGateError
  if (audioGateError)
    console.error(
      `[den-server] SECURITY: refusing to enable MicBridge — RIVETOS_DEN_AUDIO is set but ` +
        `TLS is not configured and host ${config.host} is not loopback.`,
    )
  const audioDir = config.audio.dir || join(config.stateDir, 'audio')
  const micBridge = audioEnabled
    ? new MicBridge({
        dir: audioDir,
        deviceName: config.audio.deviceName,
        sampleRate: config.audio.sampleRate,
        channels: 1,
        format: 's16le',
        log: console.error,
      })
    : null
  if (micBridge) {
    const rt = micBridge.ensureRuntime()
    if (!rt.ok) console.error(`[den-server] MicBridge runtime: ${rt.message}`)
    else console.error(`[den-server] MicBridge ready fifo=${micBridge.fifoPath}`)
  }
  const audioWs = createAudioWs({
    bridge: () => micBridge,
    enabled: () => audioEnabled,
  })

  // Shared filestore — off-loopback needs gateway TLS like every other API.
  const filesGateError =
    config.filesRoot && !tlsReady && !isLoopbackHost(config.host)
      ? 'files disabled: gateway TLS required when host is not loopback'
      : ''
  if (filesGateError)
    console.error(
      `[den-server] SECURITY: refusing to enable /api/files — files root is set but ` +
        `TLS is not configured and host ${config.host} is not loopback.`,
    )
  const filesRoutes =
    config.filesRoot && !filesGateError
      ? createFilesRoutes({ root: config.filesRoot, log: console.error })
      : null

  // sessions gain a `pty: '<id>'` marker while a local PTY is linked to them
  // (extra field — viewers that don't know it ignore it)
  const decorateSessions = (
    sessions: ReturnType<typeof listSessions>,
  ): (ReturnType<typeof listSessions>[number] & { pty?: string })[] =>
    sessions.map((s) => {
      const pty = termManager?.ptyForSession(s.id)
      return pty ? { ...s, pty } : s
    })

  // Mesh device enrollment (Settings → Devices). mTLS-gated except the
  // one-time WireGuard enroll redemption (pairing), matched before the gate.
  const devicesRoutes = config.devices?.enabled
    ? createDevicesRoutes({
        config: config.devices,
        stateDir: config.stateDir,
        gatewayUrl: config.devices.gatewayUrl,
        log: console.error,
      })
    : null

  // Agent presets (Settings → Agents): named model/effort/prompt configs.
  const agentsRoutes = createAgentsRoutes({
    stateDir: config.stateDir,
  })

  const authorized = (req: IncomingMessage, _url: URL): boolean =>
    isGatewayAuthorized(req, {
      tlsConfigured: tlsReady,
      requireClientCert: config.tls.requireClientCert,
    })

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
    '/api/audio': '/audio',
    '/api/audio/status': '/audio/status',
    '/api/audio/health': '/audio/health',
    '/api/audio/mic': '/audio/mic',
  }
  const canonicalize = (url: URL): void => {
    // Exact aliases first — special cases like /api/terminal/ws → /term (not
    // /term/ws) must win over the nested rewrite below.
    const alias = API_ALIASES[url.pathname]
    if (alias) {
      url.pathname = alias
      return
    }
    // Nested /api/terminal/* → /term/* so routes like
    // /api/terminal/harness-sessions/:id/transcript reach the term block
    // (which only matches paths under /term/). Without this, the client
    // gets a bare 404 "not found".
    if (url.pathname.startsWith('/api/terminal/')) {
      url.pathname = `/term/${url.pathname.slice('/api/terminal/'.length)}`
    }
    // /api/files/* → /files/* (RivetHub shared-filestore browser).
    if (url.pathname.startsWith('/api/files/')) {
      url.pathname = `/files/${url.pathname.slice('/api/files/'.length)}`
    }
  }

  const requestHandler = (req: IncomingMessage, res: ServerResponse): void => {
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
      // Static viewer + pack art: the TLS handshake no longer implies
      // enrollment (the TLS layer verifies but never rejects — see the
      // createHttpsServer options), so static shares the SAME app-layer gate
      // as the API: enrolled devices and loopback pass, an unenrolled remote
      // gets nothing — "if the admin did not enroll the device, Hub must not
      // work" includes the shell itself. Carve-outs above the gate: /healthz, the one-time WireGuard enroll
      // redemption — a not-yet-enrolled device MUST reach it, and its
      // pairing token is the auth (see auth.ts rule 4).
      const teamApi = url.pathname === '/api/team' || url.pathname.startsWith('/api/team/')
      if (
        !(devicesRoutes && url.pathname === '/api/devices/enroll') &&
        !teamApi &&
        !authorized(req, url)
      ) {
        unauthorized(req, res, url)
        return
      }
      // Landing redirect (3e): '/' → config.rootRedirect (e.g. /wiki on the
      // datahub node) — before static so the SPA shell doesn't swallow it.
      if (config.rootRedirect && url.pathname === '/' && req.method === 'GET') {
        res.writeHead(302, { Location: config.rootRedirect })
        res.end()
        return
      }
      if (req.method === 'GET' || req.method === 'HEAD') {
        // /api/* belongs to gateway route mounts and aliases — never the
        // static hub. Without this carve-out the SPA fallback hijacks
        // extensionless GETs like /api/tasks (G1 regression, fixed in G2).
        // Gateway mounts own their prefixes even outside /api/ (e.g. /wiki)
        // — without this the SPA fallback hijacks them (G1-regression class).
        const gatewayOwned = (opts.extraRoutes ?? []).some(
          (r) => url.pathname === r.prefix || url.pathname.startsWith(r.prefix + '/'),
        )
        // /term and /term/* are always API (including nested routes like
        // /term/harness-sessions/:id/transcript). API_PATHS only lists exact
        // leaf paths; after /api/terminal/* → /term/* canonicalize, a nested
        // path would otherwise fall through to the SPA shell (HTML 200) and
        // RivetHub would see garbage instead of JSON.
        const termApi = url.pathname === '/term' || url.pathname.startsWith('/term/')
        // Same as term: nested /files/* must not fall through to the SPA shell.
        const filesApi = url.pathname === '/files' || url.pathname.startsWith('/files/')
        const audioApi = url.pathname === '/audio' || url.pathname.startsWith('/audio/')
        if (
          config.staticDir &&
          !API_PATHS.has(url.pathname) &&
          !url.pathname.startsWith('/api/') &&
          !termApi &&
          !filesApi &&
          !audioApi &&
          !gatewayOwned
        ) {
          if (serveStatic(res, config.staticDir, url.pathname)) return
          // SPA fallback: extensionless paths (e.g. /mesh, /demo) get the hub shell.
          if (!extname(url.pathname)) {
            if (serveStatic(res, config.staticDir, '/index.html')) return
          }
        }
      }
      // Enrollment redemption authenticates with its own one-time token — the
      // device has no bearer yet. Everything else under /api/devices stays
      // behind the gate below.
      if (devicesRoutes && url.pathname === '/api/devices/enroll') {
        for (const [k, v] of Object.entries(CORS)) res.setHeader(k, v)
        if (await devicesRoutes.handleEnroll(req, res, url)) return
      }
      if (!authorized(req, url)) {
        unauthorized(req, res, url)
        return
      }

      // Tenancy: resolve identity ONCE at the TLS edge. Fail closed when a
      // registry exists and the cert does not map to a usable DB. The inbound
      // x-rivetos-user is always stripped — only den may assert it.
      delete req.headers['x-rivetos-user']
      let userCtx: UserContext | undefined
      let routedUser: string | undefined
      if (config.usersRegistry) {
        const resolved = resolveRequestUser(config.usersRegistry, req)
        if (!resolved.ok) {
          console.error(`[den] unroutable identity: ${resolved.error}`)
          for (const [k, v] of Object.entries(CORS)) res.setHeader(k, v)
          return json(res, 403, { error: 'unroutable identity', detail: resolved.error })
        }
        userCtx = resolved.ctx
        bindRequestUser(req, userCtx)
        stampUserHeader(req, userCtx)
        if (!userCtx.isOwner) routedUser = userCtx.userId
      }

      // Single ownership guard for every session-scoped route below — one
      // enforcement point, one audit line per refusal (tenancy spec req. 5).
      // Tenancy off (no bound ctx) allows everything, as before.
      const denyIfForbidden = (route: string, sessionId: string): boolean => {
        if (!sessionForbidden(sessionOwners, userCtx, sessionId)) return false
        auditTenancyDeny(route, sessionId, userCtx as UserContext)
        json(res, 403, { error: 'session is owned by another user' })
        return true
      }

      // Gateway route mounts (G0): longest prefix wins; behind the mTLS
      // gate, ahead of den's own API routes.
      if (opts.extraRoutes?.length) {
        const route = opts.extraRoutes
          .filter((r) => url.pathname === r.prefix || url.pathname.startsWith(r.prefix + '/'))
          .sort((a, b) => b.prefix.length - a.prefix.length)
          .at(0)
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

      // Mesh devices (behind the mTLS gate)
      if (url.pathname === '/api/devices' || url.pathname.startsWith('/api/devices/')) {
        if (!devicesRoutes)
          return json(res, 503, { error: 'device enrollment disabled on this node' })
        for (const [k, v] of Object.entries(CORS)) res.setHeader(k, v)
        if (await devicesRoutes.handle(req, res, url)) return
        return json(res, 404, { error: 'not found' })
      }

      // Agent presets (behind the mTLS gate)
      if (url.pathname === '/api/agents' || url.pathname.startsWith('/api/agents/')) {
        for (const [k, v] of Object.entries(CORS)) res.setHeader(k, v)
        if (await agentsRoutes.handle(req, res, url)) return
        return json(res, 404, { error: 'not found' })
      }

      // Harness control plane (behind the mTLS gate). Runs alongside the
      // legacy /term/harness-sessions/* endpoints the hub still uses — the
      // design doc prunes those in Phase 5, not here.
      if (
        url.pathname === '/api/harnesses' ||
        url.pathname.startsWith('/api/harnesses/') ||
        url.pathname === '/api/harness-sessions' ||
        url.pathname.startsWith('/api/harness-sessions/')
      ) {
        for (const [k, v] of Object.entries(CORS)) res.setHeader(k, v)
        if (await harnessRoutes.handle(req, res, url)) return
        return json(res, 404, { error: 'not found' })
      }

      // Voice proxy (behind the mTLS gate) — see voice-proxy.ts.
      if (url.pathname.startsWith('/api/voice/')) {
        for (const [k, v] of Object.entries(CORS)) res.setHeader(k, v)
        if (await voiceRoutes.handle(req, res, url)) return
        return json(res, 404, { error: 'not found' })
      }

      // Harness attachment staging (behind the mTLS gate). Turns remote
      // client bytes into a node-local path a UserTurn can reference.
      if (url.pathname === '/api/uploads' || url.pathname.startsWith('/api/uploads/')) {
        for (const [k, v] of Object.entries(CORS)) res.setHeader(k, v)
        if (uploadRoutes.handle(req, res, url)) return
        return json(res, 404, { error: 'not found' })
      }

      // Shared filestore (behind the bearer gate; CORS headers match den's own)
      if (url.pathname.startsWith('/files/')) {
        if (!filesRoutes)
          return json(res, 503, { error: filesGateError || 'files browser disabled on this node' })
        for (const [k, v] of Object.entries(CORS)) res.setHeader(k, v)
        if (filesRoutes.handle(req, res, url)) return
        return json(res, 404, { error: 'not found' })
      }

      // MicBridge status (behind bearer gate)
      if (url.pathname === '/audio' || url.pathname.startsWith('/audio/')) {
        if (
          handleAudioHttp(
            req,
            res,
            url,
            {
              bridge: () => micBridge,
              enabled: () => audioEnabled,
              gateError: () => audioGateError,
            },
            CORS,
          )
        )
          return
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
        const sessions = decorateSessions(listSessions(state))
        return json(res, 200, {
          sessions: userCtx ? sessionOwners.filter(sessions, userCtx) : sessions,
        })
      }

      // `.json` deliberately: the extensionless /mesh belongs to the viewer
      // SPA and falls through to the static index.html fallback below
      if (req.method === 'GET' && url.pathname === '/mesh.json') {
        try {
          const overview = await meshView.overview()
          if (!overview) return json(res, 404, { error: 'no mesh file' })
          return json(res, 200, overview)
        } catch (err) {
          if (err instanceof MeshParseError) {
            console.error('mesh.json parse failed:', err)
            return json(res, 500, { error: 'mesh.json parse failed', code: err.code })
          }
          throw err
        }
      }

      if (req.method === 'DELETE' && url.pathname === '/session') {
        // Rooms are keyed by the den join key; a caller keyed on canonical
        // SessionIds (hub chat) resolves to the same room (§ Legacy keys).
        const raw = url.searchParams.get('session')
        const id = raw ? denJoinKey(raw) : raw
        if (!id) return json(res, 404, { error: 'unknown session' })
        if (denyIfForbidden('DELETE /session', id)) return
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
            // The PTY's den session IS the room key, so a canonical SessionId
            // from a hub keyed on the identity table resolves to the same
            // room, store filename and `--resume` id a bare native id would
            // (§ Legacy keys).
            // Per-user routing: a mapped device's terminals capture to (and
            // search) that user's memory DB, not the node owner's.
            const sessionKey = p.session === undefined ? undefined : denJoinKey(p.session)
            const resumeKey = p.resume === undefined ? undefined : denJoinKey(p.resume)
            if (userCtx) {
              if (resumeKey && denyIfForbidden('POST /term (resume)', resumeKey)) return
              // sessionKey keeps its claim semantics: an UNTAGGED key is a new
              // room the spawner may claim; a tagged one must be theirs.
              if (
                sessionKey &&
                sessionOwners.get(sessionKey) &&
                denyIfForbidden('POST /term (session)', sessionKey)
              )
                return
            }
            const userEnv = captureEnvFor(userCtx)
            const pty = manager.spawn(
              p.command,
              clamp(p.cols, 20, 500, 80),
              clamp(p.rows, 5, 200, 24),
              req.socket.remoteAddress ?? '',
              sessionKey,
              resumeKey,
              userEnv,
              routedUser,
            )
            if (userCtx) {
              sessionOwners.set(pty.denSession, userCtx.userId)
              if (sessionKey) sessionOwners.set(sessionKey, userCtx.userId)
              if (resumeKey) sessionOwners.set(resumeKey, userCtx.userId)
            }
            const identity = await meshView.localIdentity()
            // `local` is the TCP peer address, not X-Forwarded-For. A
            // same-host reverse proxy makes every requester look loopback, so
            // the copied `tmux -L …` command then fails on the user's machine.
            // We still key off the socket so a client cannot opt into the
            // local tmux path by spoofing a header.
            const attach = composeTermAttach(pty, identity, isLoopbackRemote(req))
            return json(res, 201, {
              id: pty.id,
              denSession: pty.denSession,
              command: pty.command,
              pid: pty.pid,
              createdAt: pty.createdAt,
              // T1: stamped only when tmux backs the PTY — under mux:none the
              // response stays byte-identical to before. `reattached` marks a
              // live client that joined an already-running tmux session
              // (`persisted` is reserved for client-less /term/list rows).
              ...(pty.mux ? { mux: pty.mux } : {}),
              ...(pty.reattached ? { reattached: true } : {}),
              ...(attach ? { attach } : {}),
            })
          } catch (e) {
            if (e instanceof TermSpawnError)
              return json(
                res,
                e.code === 'cap'
                  ? 409
                  : e.code === 'user-mismatch'
                    ? 403
                    : e.code === 'tmux-unavailable'
                      ? 503
                      : 404,
                { error: e.message },
              )
            throw e
          }
        }

        if (req.method === 'GET' && url.pathname === '/term/list') {
          const identity = await meshView.localIdentity()
          // Same loopback-vs-proxy trade-off as POST /term (see above).
          const local = isLoopbackRemote(req)
          const rows = manager.list()
          const visible = userCtx
            ? rows.filter((p) => sessionOwners.visible(p.denSession, userCtx))
            : rows
          return json(res, 200, {
            ptys: visible.map((p) => wirePtyInfo(p, identity, local)),
          })
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
          return json(res, 200, {
            sessions: userCtx ? sessionOwners.filter(sessions, userCtx) : sessions,
          })
        }

        // GET /term/harness-sessions/:id/transcript — hard-resync source: the
        // on-disk TUI conversation (claude/grok/hermes). Client hits the
        // /api/terminal/... alias; canonicalize rewrites it under /term/.
        {
          const m = url.pathname.match(/^\/term\/harness-sessions\/([^/]+)\/transcript$/)
          if (req.method === 'GET' && m) {
            const id = decodeURIComponent(m.at(1) ?? '')
            // the list is filtered; the resource must be too — a transcript
            // is the whole conversation, not metadata
            if (denyIfForbidden('GET /term/harness-sessions/:id/transcript', id)) return
            const transcript = await readHarnessTranscript(id)
            return json(res, 200, transcript)
          }
        }

        if (req.method === 'DELETE' && url.pathname === '/term') {
          const id = url.searchParams.get('id') ?? ''
          // a PTY dies only at its owner's hand. Fail closed: unknown id is
          // 404 and must NOT reach kill() — get() and kill() resolve the same
          // id forms, so a bare denSession can never skip the ownership check.
          const info = manager.get(id)
          if (!info) return json(res, 404, { error: 'unknown pty' })
          if (denyIfForbidden('DELETE /term', info.denSession)) return
          try {
            if (!manager.kill(id)) return json(res, 404, { error: 'unknown pty' })
          } catch (e) {
            // tmux unreachable: fail closed (503) — never pretend the kill
            // happened, never silently skip it
            if (e instanceof TmuxUnavailableError)
              return json(res, 503, { error: `tmux unavailable: ${e.message}` })
            throw e
          }
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
          const p = raw as {
            session?: unknown
            text?: unknown
            submit?: unknown
            interrupt?: unknown
          }
          if (typeof p.session !== 'string' || p.session === '')
            return json(res, 400, { error: 'session (string) is required' })
          if (typeof p.text !== 'string')
            return json(res, 400, { error: 'text (string) is required' })
          const injectKey = denJoinKey(p.session)
          // writing a turn into another user's live harness is the worst
          // cross-user primitive there is — guard before any PTY lookup
          if (denyIfForbidden('POST /term/inject', injectKey)) return
          const ptyId = manager.ptyForSession(injectKey)
          if (!ptyId) return json(res, 409, { error: 'no live harness for session' })
          const submit = p.submit !== false // default true
          const interrupt = p.interrupt === true // Esc the in-flight turn first
          if (!manager.inject(ptyId, p.text, submit, interrupt))
            return json(res, 409, { error: 'harness not writable' })
          return json(res, 202, { ok: true, ptyId })
        }
      }

      if (req.method === 'GET' && url.pathname === '/state') {
        // Echo the id the caller asked with, like the transcript read and the
        // transcript watch do — resolution to the room stays internal, so a
        // client keyed on canonical SessionIds can match the response to its
        // thread. (`DELETE /session` below cannot do the same: its
        // `session.removed` broadcast addresses den VIEWERS, which key on
        // rooms, so that one is necessarily the resolved key.)
        const rawId = url.searchParams.get('session')
        const id = rawId ? denJoinKey(rawId) : rawId
        if (!rawId || !id) return json(res, 404, { error: 'unknown session' })
        if (denyIfForbidden('GET /state', id)) return
        const room = state.rooms[id] as typeof initialRoomState | undefined
        if (!room) return json(res, 404, { error: 'unknown session' })
        return json(res, 200, { session: rawId, state: room })
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
  }

  // Plain HTTP only for loopback. Off-loopback without TLS refuses to listen
  // so a misconfigured node never serves Hub/API to the LAN unauthenticated.
  if (!tlsReady && !isLoopbackHost(config.host)) {
    throw new Error(
      `[den-server] refusing to bind ${config.host}: gateway TLS is required off-loopback ` +
        `(set RIVETOS_DEN_TLS_CERT + RIVETOS_DEN_TLS_KEY to the node cert from rivet-ca issue-node; ` +
        `enroll clients with rivet-ca issue-client). Or bind den.host to 127.0.0.1.`,
    )
  }

  let server: Server
  if (tlsReady) {
    const cert = readFileSync(config.tls.certPath)
    const key = readFileSync(config.tls.keyPath)
    const ca = existsSync(config.tls.caPath) ? readFileSync(config.tls.caPath) : undefined
    if (!ca) {
      throw new Error(
        `[den-server] TLS CA chain missing at ${config.tls.caPath} — cannot verify device client certs`,
      )
    }
    server = createHttpsServer(
      {
        cert,
        key,
        ca,
        // Request and VERIFY the client cert against our CA, but never kill
        // the connection at the TLS layer: under TLS 1.3 rejectUnauthorized
        // sends `certificate required` to every certless client, which
        // breaks the documented open surfaces — /healthz (deploy probe, mesh
        // peer probes) and loopback callers (den hooks) — before the app
        // layer ever runs. Enforcement lives in isGatewayAuthorized: remote
        // API access requires socket.authorized && a device leaf, so an
        // absent, expired, or foreign cert is still refused everything but
        // liveness. (Found live on the ct113 canary, 2026-08-10.)
        requestCert: config.tls.requireClientCert,
        rejectUnauthorized: false,
        // Terminal keystrokes are 1-byte WS frames. Nagle + Windows delayed
        // ACK (~200ms) makes the TUI unusable from the Electron shell.
        noDelay: true,
      },
      requestHandler,
    )
    console.error(
      `[den-server] HTTPS + client certs (requireClientCert=${config.tls.requireClientCert}) ` +
        `cert=${config.tls.certPath}`,
    )
  } else {
    server = createServer({ noDelay: true }, requestHandler)
  }

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
    if (config.usersRegistry) {
      const resolved = resolveRequestUser(config.usersRegistry, req)
      if (!resolved.ok) {
        console.error(`[den] unroutable identity on upgrade: ${resolved.error}`)
        socket.destroy()
        return
      }
      bindRequestUser(req, resolved.ctx)
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
    if (url.pathname === '/audio/mic') {
      audioWs.handleUpgrade(req, socket, head, url)
      return
    }
    if (harnessRoutes.handleUpgrade(req, socket, head, url)) return
    const up = opts.extraUpgrades?.find((u) => u.path === url.pathname)
    if (up) {
      up.handle(req, socket, head, url)
      return
    }
    socket.destroy()
  })
  wss.on('connection', (ws, req) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    // Room scope for this viewer. Canonical SessionIds resolve to their room
    // so an identity-table-keyed client subscribes to the same events.
    const rawSession = url.searchParams.get('session')
    const session = rawSession ? denJoinKey(rawSession) : undefined
    const ctx = boundRequestUser(req)
    const client: Client = { ws, session, alive: true, ...(ctx ? { user: ctx } : {}) }
    clients.add(client)
    // without an error listener one ECONNRESET from a dropped viewer is an
    // uncaught exception that kills the whole server
    ws.on('error', () => {
      clients.delete(client)
      ws.terminate()
    })
    ws.on('close', () => clients.delete(client))
    ws.on('pong', () => (client.alive = true))
    if (session && ctx && !sessionOwners.visible(session, ctx)) {
      auditTenancyDeny('WS /ws attach', session, ctx)
      ws.close(4403, 'session is owned by another user')
      clients.delete(client)
      return
    }
    // catch the viewer up with a single snapshot instead of replayed events
    const snapSessions = decorateSessions(listSessions(state))
    ws.send(
      JSON.stringify({
        type: 'snapshot',
        v: 1,
        sessions: ctx ? sessionOwners.filter(snapSessions, ctx) : snapSessions,
        rooms: session
          ? { [session]: state.rooms[session] ?? initialRoomState }
          : ctx
            ? Object.fromEntries(
                Object.entries(state.rooms).filter(([id]) => sessionOwners.visible(id, ctx)),
              )
            : state.rooms,
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
    audioWs.heartbeat()
    harnessRoutes.heartbeat()
  }, 30_000)
  heartbeat.unref()

  return {
    server,
    state: () => state,
    harnesses,
    aliasesRestored,
    close: () =>
      new Promise((resolve) => {
        clearInterval(heartbeat)
        for (const t of evictTimers.values()) clearTimeout(t)
        evictTimers.clear()
        harnessRoutes.close()
        uploadRoutes.close()
        for (const driver of builtinDrivers) driver.close()
        harnesses.close()
        termWs.close()
        audioWs.close()
        micBridge?.close()
        termManager?.close()
        for (const c of clients) c.ws.close()
        wss.close(() => server.close(() => resolve()))
      }),
  }
}
