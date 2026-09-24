/**
 * Tiny pool for `ros_agent_presets` only. Mirrors boot's `createSharedPgPool`
 * (pool `'error'` listener, per-client `'error'` on `'connect'`, bounded
 * `end`) with den's own budgets: connect 5s, query 10s, `end` 5s. An idle
 * client whose backend disappears emits `'error'` on the pool; without a
 * listener Node takes down the process, and den is embedded in that process.
 */

import pg from 'pg'

/** OS connect (and pool queue wait) budget. A blackholed DataHub must fail inside this. */
export const PRESET_POOL_CONNECTION_TIMEOUT_MS = 5_000
/** Statement / client query budget. A hung primary answers 503 inside this, not the OS timeout. */
export const PRESET_POOL_QUERY_TIMEOUT_MS = 10_000
/** Bound on `pool.end()` so `den.close()` cannot hang on a stuck checkout. */
export const PRESET_POOL_END_TIMEOUT_MS = 5_000

const defaultLog = (msg: string): void => {
  console.error(`[den-server] ${msg}`)
}

export function createPresetPool(
  connectionString: string,
  log: (msg: string) => void = defaultLog,
): pg.Pool {
  const pool = new pg.Pool({
    connectionString,
    max: 2,
    connectionTimeoutMillis: PRESET_POOL_CONNECTION_TIMEOUT_MS,
    query_timeout: PRESET_POOL_QUERY_TIMEOUT_MS,
    statement_timeout: PRESET_POOL_QUERY_TIMEOUT_MS,
  })
  pool.on('error', (err: Error) => {
    log(`preset pg pool error: ${err.message}`)
  })
  pool.on('connect', (client) => {
    client.on('error', (err: Error) => {
      log(`preset pg client error: ${err.message}`)
    })
  })
  return pool
}

/**
 * One bounded `pool.end()`. A rejection is logged, not thrown. On timeout we
 * log and return so close can finish; the underlying end keeps running.
 */
export async function endPresetPool(
  pool: { end: () => Promise<void> } | undefined,
  log: (msg: string) => void = defaultLog,
  timeoutMs: number = PRESET_POOL_END_TIMEOUT_MS,
): Promise<void> {
  if (!pool) return
  let timer: ReturnType<typeof setTimeout> | undefined
  const work = pool.end().then(
    () => 'done' as const,
    (err: unknown) => {
      log(`preset pool close failed: ${err instanceof Error ? err.message : String(err)}`)
      return 'done' as const
    },
  )
  try {
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), timeoutMs)
    })
    const winner = await Promise.race([work, timeout])
    if (winner === 'timeout') {
      log(`preset pool end timed out after ${String(timeoutMs)}ms`)
    }
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}
