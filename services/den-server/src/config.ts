// Environment-driven configuration for the den server.

import { homedir } from 'node:os'
import { join } from 'node:path'

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name]
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
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): DenConfig {
  return {
    port: intEnv('RIVETOS_DEN_PORT', 5174),
    // fail safe: loopback unless explicitly exposed — the default token is
    // empty, so 0.0.0.0 out of the box would be unauthenticated on all
    // interfaces. Mesh deployments set RIVETOS_DEN_HOST=0.0.0.0.
    host: env.RIVETOS_DEN_HOST ?? '127.0.0.1',
    token: env.RIVETOS_DEN_TOKEN ?? '',
    stateDir: env.RIVETOS_DEN_STATE_DIR ?? join(homedir(), '.rivetos', 'den'),
    staticDir: env.RIVETOS_DEN_STATIC_DIR ?? '',
    packsDir: env.RIVETOS_DEN_PACKS_DIR ?? '',
    evictTtlMs: intEnv('RIVETOS_DEN_EVICT_TTL_MS', 24 * 60 * 60 * 1000),
    meshFile: env.RIVETOS_DEN_MESH_FILE ?? '',
    meshCacheMs: intEnv('RIVETOS_DEN_MESH_CACHE_MS', 10_000),
    term: {
      enabled: truthyEnv(env.RIVETOS_DEN_TERM),
      configFile: env.RIVETOS_DEN_TERM_CONFIG ?? join(homedir(), '.rivetos', 'den-term.json'),
      maxPtys: intEnv('RIVETOS_DEN_TERM_MAX', 4),
      scrollbackBytes: intEnv('RIVETOS_DEN_TERM_SCROLLBACK', 262_144),
      detachedTtlMs: intEnv('RIVETOS_DEN_TERM_DETACHED_TTL_MS', 1_800_000),
      exitLingerMs: intEnv('RIVETOS_DEN_TERM_EXIT_LINGER_MS', 60_000),
    },
  }
}
