/**
 * Signals that occur at connection establishment / pool checkout.
 *
 * Used to retry `TaskStore.claim` only. For that caller the statement is a
 * single UPDATE that a server-side error rolls back, so a retry cannot
 * double-claim. Errors that can follow a committed UPDATE (`ECONNRESET`,
 * `ETIMEDOUT`, query timeouts) are NOT retried: a retried claim would then
 * see `status='running'`, return undefined, and strand the row.
 */

const PRE_SEND_CODES = new Set(['53300', '57P03', 'ECONNREFUSED'])
const POOL_CHECKOUT_TIMEOUT = 'timeout exceeded when trying to connect'

const DEFAULT_DELAYS_MS = [250, 1000, 3000]

export function isPreSendConnectError(err: unknown): boolean {
  if (err == null || typeof err !== 'object') return false
  const rec = err as { code?: unknown; message?: unknown }
  if (typeof rec.code === 'string' && PRE_SEND_CODES.has(rec.code)) return true
  return rec.message === POOL_CHECKOUT_TIMEOUT
}

function withJitter(ms: number): number {
  const spread = 0.2
  return Math.round(ms * (1 - spread + Math.random() * spread * 2))
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

export interface RetryPreSendConnectOptions {
  delaysMs?: number[]
  sleep?: (ms: number) => Promise<void>
  onRetry?: (err: unknown, attempt: number) => void
}

/**
 * Retry `fn` on {@link isPreSendConnectError} only. Default delays
 * `[250, 1000, 3000]` with ±20% jitter (3 retries → 4 calls). Non-matching
 * errors rethrow immediately; after the last delay the final error rethrows.
 * Worst-case exhaustion is 4 × checkout timeout + ~4.25s (≈2 minutes at the
 * shared pool's 30s `connectionTimeoutMillis`). That wait holds a worker
 * slot, not a pool connection.
 */
export async function retryPreSendConnect<T>(
  fn: () => Promise<T>,
  opts?: RetryPreSendConnectOptions,
): Promise<T> {
  const delays = opts?.delaysMs ?? DEFAULT_DELAYS_MS
  const sleep = opts?.sleep ?? defaultSleep
  let attempt = 0
  for (;;) {
    try {
      return await fn()
    } catch (err: unknown) {
      attempt += 1
      if (!isPreSendConnectError(err) || attempt > delays.length) {
        throw err
      }
      opts?.onRetry?.(err, attempt)
      await sleep(withJitter(delays[attempt - 1]))
    }
  }
}
