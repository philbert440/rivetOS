/**
 * Host-owned Postgres pool — one per runtime process.
 *
 * Boot (composition root) builds this and injects it into Runtime, the
 * task/heartbeat graphile runners, and adapters. Adapters must not end() it.
 */

import pg from 'pg'
import { logger } from '@rivetos/core'

const log = logger('Boot:PgPool')

const DEFAULT_POOL_MAX = 8
/** Two graphile LISTEN clients live in this pool permanently. */
const MIN_POOL_MAX = 4

/**
 * Read `RIVETOS_PG_POOL_MAX`. Default 8; non-numeric/empty → default;
 * values below 4 clamp to 4 (and log one warning).
 */
export function resolvePgPoolMax(env: NodeJS.ProcessEnv): number {
  const raw = env.RIVETOS_PG_POOL_MAX
  if (raw === undefined || raw === '') return DEFAULT_POOL_MAX
  const n = Number.parseInt(raw, 10)
  if (!Number.isFinite(n)) return DEFAULT_POOL_MAX
  if (n < MIN_POOL_MAX) {
    log.warn(
      `RIVETOS_PG_POOL_MAX=${raw} is below ${String(MIN_POOL_MAX)}; clamping to ${String(MIN_POOL_MAX)} (graphile LISTEN clients live in this pool)`,
    )
    return MIN_POOL_MAX
  }
  return n
}

/**
 * Construct the process-wide pool. Installs both a pool `'error'` listener
 * and a pool `'connect'` listener that attaches a client `'error'` listener
 * — graphile-worker warns and installs its own if either is empty.
 * Listeners log and never throw.
 */
export function createSharedPgPool(pgUrl: string, env: NodeJS.ProcessEnv = process.env): pg.Pool {
  const max = resolvePgPoolMax(env)
  const pool = new pg.Pool({
    connectionString: pgUrl,
    max,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  })
  pool.on('error', (err) => {
    log.error(`Shared pg pool error: ${err.message}`)
  })
  pool.on('connect', (client) => {
    client.on('error', (err) => {
      log.error(`Shared pg client error: ${err.message}`)
    })
  })
  return pool
}
