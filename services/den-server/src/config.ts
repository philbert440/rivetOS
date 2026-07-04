// Environment-driven configuration for the den server.

import { homedir } from 'node:os'
import { join } from 'node:path'

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const parsed = parseInt(raw, 10)
  return Number.isFinite(parsed) ? parsed : fallback
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
  }
}
