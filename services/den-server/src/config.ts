// Environment-driven configuration for the den server.

import { homedir } from 'node:os'
import { join } from 'node:path'

function intEnv(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  // Read from the PASSED env — loadConfig(env) callers (the embedded
  // gateway) build a synthetic env object; reading process.env here made
  // den.port (and the TTLs) silently ignore config on every embedded node.
  const raw = env[name]
  if (!raw) return fallback
  const parsed = parseInt(raw, 10)
  return Number.isFinite(parsed) ? parsed : fallback
}

function truthyEnv(raw: string | undefined): boolean {
  const v = (raw ?? '').trim().toLowerCase()
  return v === '1' || v === 'on'
}

export interface DenTermConfig {
  /** Opt-in master switch — terminals are OFF unless RIVETOS_DEN_TERM=1/on.
   *  Spawning a shell as the service user is a deliberate act, never a default. */
  enabled: boolean
  /** RIVETOS_DEN_TERM_OPEN=1: explicit operator opt-out of the tokenless
   *  security gate — terminals stay enabled with no token off-loopback.
   *  For trusted private networks; anything that can reach the port can
   *  then spawn a shell as the service user. Loudly logged, never default. */
  open: boolean
  /** Operator-owned command roster (see term/roster.ts). Re-read lazily, so
   *  edits don't need a restart. */
  configFile: string
  /** Max concurrently running PTYs. */
  maxPtys: number
  /** Per-PTY scrollback ring cap (bytes). */
  scrollbackBytes: number
  /** How long a PTY with no attached viewers survives before SIGHUP (ms). */
  detachedTtlMs: number
  /** How long an exited PTY record lingers (scrollback inspectable) before
   *  it is reaped (ms). */
  exitLingerMs: number
  /** Grace after a fresh PTY's first output before buffered chat injects are
   *  flushed — lets the harness TUI settle so the first turn isn't dropped. */
  injectReadyMs: number
  /** Delay between writing a chat inject's text and its submit CR. The two
   *  must be separate PTY writes: harness TUIs (claude/grok) run paste
   *  detection, and a CR fused onto multi-line/long text is absorbed as a
   *  literal newline in the composer instead of submitting the turn. */
  injectSubmitDelayMs?: number
}

export interface DenConfig {
  port: number
  host: string
  /** Bearer token required on every non-health endpoint when set. Mesh nodes
   *  behind the LAN can leave it empty; the hosted tier must not. */
  token: string
  /** Directory for persisted state (per-viewer layouts). */
  stateDir: string
  /** Built viewer app to serve at / (optional). */
  staticDir: string
  /** SpritePack root served at /packs/ (optional). */
  packsDir: string
  /** 302 target for GET / — e.g. '/wiki' makes the wiki the landing page. */
  rootRedirect: string
  /** How long an ended session's room lingers before eviction (ms). */
  evictTtlMs: number
  /** Mesh roster for GET /mesh.json. Empty = try the canonical
   *  /rivet-shared/mesh.json, then ~/.rivetos/mesh.json. */
  meshFile: string
  /** How long one /mesh.json overview (roster read + peer probes) is served
   *  from cache (ms). */
  meshCacheMs: number
  /** Local PTY terminals (opt-in; see term/). */
  term: DenTermConfig
  /** Shared filestore root for /api/files/* (browse/download/upload).
   *  Empty string disables the routes entirely. */
  filesRoot: string
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): DenConfig {
  return {
    port: intEnv(env, 'RIVETOS_DEN_PORT', 5174),
    // fail safe: loopback unless explicitly exposed — the default token is
    // empty, so 0.0.0.0 out of the box would be unauthenticated on all
    // interfaces. Mesh deployments set RIVETOS_DEN_HOST=0.0.0.0.
    host: env.RIVETOS_DEN_HOST ?? '127.0.0.1',
    token: env.RIVETOS_DEN_TOKEN ?? '',
    stateDir: env.RIVETOS_DEN_STATE_DIR ?? join(homedir(), '.rivetos', 'den'),
    staticDir: env.RIVETOS_DEN_STATIC_DIR ?? '',
    rootRedirect: env.RIVETOS_DEN_ROOT_REDIRECT ?? '',
    packsDir: env.RIVETOS_DEN_PACKS_DIR ?? '',
    evictTtlMs: intEnv(env, 'RIVETOS_DEN_EVICT_TTL_MS', 24 * 60 * 60 * 1000),
    meshFile: env.RIVETOS_DEN_MESH_FILE ?? '',
    meshCacheMs: intEnv(env, 'RIVETOS_DEN_MESH_CACHE_MS', 10_000),
    term: {
      enabled: truthyEnv(env.RIVETOS_DEN_TERM),
      open: truthyEnv(env.RIVETOS_DEN_TERM_OPEN),
      configFile: env.RIVETOS_DEN_TERM_CONFIG ?? join(homedir(), '.rivetos', 'den-term.json'),
      maxPtys: intEnv(env, 'RIVETOS_DEN_TERM_MAX', 4),
      scrollbackBytes: intEnv(env, 'RIVETOS_DEN_TERM_SCROLLBACK', 262_144),
      detachedTtlMs: intEnv(env, 'RIVETOS_DEN_TERM_DETACHED_TTL_MS', 1_800_000),
      exitLingerMs: intEnv(env, 'RIVETOS_DEN_TERM_EXIT_LINGER_MS', 60_000),
      injectReadyMs: intEnv(env, 'RIVETOS_DEN_TERM_INJECT_READY_MS', 500),
      injectSubmitDelayMs: intEnv(env, 'RIVETOS_DEN_TERM_INJECT_SUBMIT_DELAY_MS', 80),
    },
    filesRoot: env.RIVETOS_DEN_FILES_ROOT ?? '/rivet-shared',
  }
}
