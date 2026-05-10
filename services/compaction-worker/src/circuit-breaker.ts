/**
 * In-process circuit breaker — track LLM failures per conversation and skip
 * compaction for conversations that have failed repeatedly within a window.
 *
 * Ported from plugins/memory/postgres/workers/compaction/index.js circuitBreaker.
 *
 * The breaker is per-process; restarting the worker resets it. graphile-worker
 * jobs can still be enqueued during the cooldown — they will hit the breaker
 * and exit cleanly instead of burning LLM tokens on a known-bad conversation.
 */

const THRESHOLD = 3
const RESET_MS = 3_600_000 // 1 hour

interface BreakerEntry {
  failures: number
  lastFailAt: number
}

const breaker = new Map<string, BreakerEntry>()

export function shouldSkip(conversationId: string): boolean {
  const entry = breaker.get(conversationId)
  if (!entry) return false
  if (entry.failures < THRESHOLD) return false

  if (Date.now() - entry.lastFailAt < RESET_MS) {
    return true
  }

  // Cooldown elapsed — reset and allow
  breaker.delete(conversationId)
  return false
}

export function recordFailure(conversationId: string): number {
  const entry = breaker.get(conversationId) ?? { failures: 0, lastFailAt: 0 }
  entry.failures += 1
  entry.lastFailAt = Date.now()
  breaker.set(conversationId, entry)
  return entry.failures
}

export function recordSuccess(conversationId: string): void {
  breaker.delete(conversationId)
}

export const breakerThreshold = THRESHOLD
