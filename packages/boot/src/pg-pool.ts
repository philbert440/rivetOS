/**
 * Host-owned Postgres pool — one per runtime process.
 *
 * Boot (composition root) builds this and injects it into Runtime, the
 * task/heartbeat graphile runners, and adapters. Adapters must not end() it.
 */

import pg from 'pg'
import { logger, type Logger } from '@rivetos/core'

const log = logger('Boot:PgPool')

/** Bound on `pool.end()` so cleanup cannot hang the rethrow or `process.exit`. */
export const POOL_END_TIMEOUT_MS = 5_000
/** Bound on `runtime.stop()` during boot-failure cleanup so a claimed task cannot hang the rethrow. */
export const BOOT_FAILURE_STOP_TIMEOUT_MS = 10_000

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
    // Also the queue-wait timeout when the pool is full. graphile's private
    // pools used to wait indefinitely; graphile's job bookkeeping is
    // fire-and-forget, so a short queue timeout turns contention into a
    // process exit.
    connectionTimeoutMillis: 30_000,
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

type PoolLog = Pick<Logger, 'error' | 'warn'>

export interface EndablePool {
  end: () => Promise<void>
}

/**
 * Memoize one `pool.end()`: every caller awaits the same drain. Races the
 * end against {@link POOL_END_TIMEOUT_MS} and warns on timeout so a stuck
 * checkout cannot swallow a rethrow or block process.exit.
 */
export function createEndSharedPool(
  pool: EndablePool | undefined,
  poolLog: PoolLog = log,
): () => Promise<void> {
  let inflight: Promise<void> | undefined
  return (): Promise<void> => {
    if (inflight) return inflight
    if (!pool) {
      inflight = Promise.resolve()
      return inflight
    }
    const target = pool
    inflight = endPoolBounded(target, poolLog)
    return inflight
  }
}

/**
 * Race `work` against `timeoutMs`. `onReject` is attached to `work` itself so a
 * rejection after the timeout has already won cannot become unhandled. The
 * timer is always cleared.
 */
async function awaitBounded(
  work: Promise<void>,
  timeoutMs: number,
  onTimeout: () => void,
  onReject: (err: unknown) => void,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), timeoutMs)
    })
    const settled = work.then(
      () => 'done' as const,
      (err: unknown) => {
        onReject(err)
        return 'done' as const
      },
    )
    const winner = await Promise.race([settled, timeout])
    if (winner === 'timeout') {
      onTimeout()
    }
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

async function endPoolBounded(pool: EndablePool, poolLog: PoolLog): Promise<void> {
  await awaitBounded(
    pool.end(),
    POOL_END_TIMEOUT_MS,
    () => {
      poolLog.warn(`Shared pg pool end timed out after ${String(POOL_END_TIMEOUT_MS)}ms`)
    },
    (err: unknown) => {
      poolLog.error(
        `Shared pg pool end failed: ${err instanceof Error ? err.message : String(err)}`,
      )
    },
  )
}

export interface BootFailureCleanup {
  runtime?: { stop: () => Promise<void> }
  endPool: () => Promise<void>
  log: PoolLog
  err: unknown
}

/**
 * Partial-boot catch path: log the original error, stop started consumers
 * (task runner / waiter / gateway / heartbeat), then end the shared pool,
 * then rethrow. Extracted so the hang-forever path is unit-testable without
 * driving the full `bootWithConfig` graph.
 */
export async function cleanupAfterBootFailure(opts: BootFailureCleanup): Promise<never> {
  const msg = opts.err instanceof Error ? opts.err.message : String(opts.err)
  opts.log.error(`Boot failed: ${msg}`)
  if (opts.runtime) {
    try {
      await awaitBounded(
        opts.runtime.stop(),
        BOOT_FAILURE_STOP_TIMEOUT_MS,
        () => {
          opts.log.warn(
            `Runtime consumers did not stop in time after ${String(BOOT_FAILURE_STOP_TIMEOUT_MS)}ms; proceeding with cleanup`,
          )
        },
        (stopErr: unknown) => {
          opts.log.error(
            `Runtime stop during boot-failure cleanup failed: ${
              stopErr instanceof Error ? stopErr.message : String(stopErr)
            }`,
          )
        },
      )
    } catch (stopErr: unknown) {
      opts.log.error(
        `Runtime stop during boot-failure cleanup failed: ${
          stopErr instanceof Error ? stopErr.message : String(stopErr)
        }`,
      )
    }
  }
  await opts.endPool()
  throw opts.err
}
