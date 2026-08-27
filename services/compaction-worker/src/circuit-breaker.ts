/**
 * In-process circuit breaker — track LLM failures per conversation *level*
 * and skip compaction for levels that have failed repeatedly within a window.
 *
 * Ported from plugins/memory/postgres/workers/compaction/index.js circuitBreaker.
 *
 * Keys are `${conversationId}:${kind}` (leaf / branch / root). A healthy leaf
 * must not wipe a failing parent level — that was the motivating outage case
 * (active conversation, leaves ok, branch LLM hammered forever).
 *
 * Two failure classes share the map:
 * - Transient: counted only by the caller on a job's *final* graphile attempt
 *   so one job's maxAttempts:3 retries are a single failure. THRESHOLD=3
 *   still means ~3 exhausted jobs before a 1-hour skip.
 * - Terminal (permanent 4xx): `recordTerminal` — skip that level until
 *   `recordSuccess` or process restart. No threshold, no 1-hour expiry.
 *
 * The breaker is per-process; restarting the worker resets it. graphile-worker
 * jobs can still be enqueued during the cooldown — they will hit the breaker
 * and exit cleanly instead of burning LLM tokens on a known-bad level.
 */

const THRESHOLD = 3
const RESET_MS = 3_600_000 // 1 hour

export type CompactKind = 'leaf' | 'branch' | 'root'

interface BreakerEntry {
  failures: number
  lastFailAt: number
  /** Permanent (non-retryable) failure — skip until success or process restart. */
  terminal?: boolean
}

const breaker = new Map<string, BreakerEntry>()

export function breakerKey(conversationId: string, kind: CompactKind): string {
  return `${conversationId}:${kind}`
}

export function shouldSkip(conversationId: string, kind: CompactKind): boolean {
  const key = breakerKey(conversationId, kind)
  const entry = breaker.get(key)
  if (!entry) return false
  if (entry.terminal) return true
  if (entry.failures < THRESHOLD) return false

  if (Date.now() - entry.lastFailAt < RESET_MS) {
    return true
  }

  // Cooldown elapsed — reset and allow
  breaker.delete(key)
  return false
}

export function recordFailure(conversationId: string, kind: CompactKind): number {
  const key = breakerKey(conversationId, kind)
  const entry = breaker.get(key) ?? { failures: 0, lastFailAt: 0 }
  entry.failures += 1
  entry.lastFailAt = Date.now()
  breaker.set(key, entry)
  return entry.failures
}

/** Mark this level as permanently failed (non-retryable LLM 4xx). */
export function recordTerminal(conversationId: string, kind: CompactKind): void {
  const key = breakerKey(conversationId, kind)
  const entry = breaker.get(key) ?? { failures: 0, lastFailAt: 0 }
  entry.terminal = true
  entry.lastFailAt = Date.now()
  breaker.set(key, entry)
}

export function recordSuccess(conversationId: string, kind: CompactKind): void {
  breaker.delete(breakerKey(conversationId, kind))
}

/** Structured skip log so a breaker-open window is queryable (`event=circuit_breaker_skip`). */
export function logBreakerSkip(conversationId: string, kind: CompactKind): void {
  const entry = breaker.get(breakerKey(conversationId, kind))
  console.warn(
    `[CompactWorker] circuit-breaker skip ${JSON.stringify({
      event: 'circuit_breaker_skip',
      conversationId,
      kind,
      terminal: entry?.terminal === true,
      failures: entry?.failures ?? 0,
    })}`,
  )
}

/** Test helper — equivalent to a process restart. */
export function resetBreaker(): void {
  breaker.clear()
}

export const breakerThreshold = THRESHOLD
