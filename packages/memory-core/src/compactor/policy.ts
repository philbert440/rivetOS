/**
 * Compaction policy — which batches get summarized, backend-neutral.
 *
 * The thresholds are the defaults every backend starts from; the Postgres
 * worker reads its own from the environment, the SQLite backend from config.
 */

import { MIN_BATCH_SIZE } from './types.js'

/** Messages per leaf summary. */
export const DEFAULT_LEAF_BATCH = 10
/** Leaves per branch, and how many must exist before one is written. */
export const DEFAULT_BRANCH_BATCH = 8
export const DEFAULT_MIN_LEAVES_FOR_BRANCH = 5
/** Branches per root, and how many must exist before one is written. */
export const DEFAULT_ROOT_BATCH = 5
export const DEFAULT_MIN_BRANCHES_FOR_ROOT = 3
/** A conversation idle this long with a full-floor backlog is summarized. */
export const DEFAULT_IDLE_MINUTES = 15
/** Idle this long, even a below-floor tail is flushed into a leaf. */
export const DEFAULT_STALE_MINUTES = 4 * 24 * 60
/** Floor for that flush: 2, so a lone message does not get its own summary. */
export const DEFAULT_STALE_MIN_BATCH = 2
/** Leaf rounds per compaction job, so one job cannot run unbounded. */
export const MAX_LEAF_ROUNDS = 10

/**
 * Leaf floor for a compaction job: a 'session_stale' flush treats the
 * conversation as final and drops to staleMinBatch so its leftover below-floor
 * tail gets summarized; every other trigger holds the normal MIN_BATCH_SIZE.
 */
export function leafFloorFor(triggerType: string | undefined, staleMinBatch: number): number {
  return triggerType === 'session_stale' ? staleMinBatch : MIN_BATCH_SIZE
}

const TRUNCATION_RE = /truncated at max_tokens=/i

/** True when callLlm exhausted the output budget — same prompt will not help. */
export function isLlmTruncationError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return TRUNCATION_RE.test(msg)
}

/**
 * Next smaller leaf batch after a truncated LLM response.
 * Null when the batch is already at the floor (cannot shrink further).
 */
export function shrinkLeafBatch(current: number, minBatch: number): number | null {
  if (current <= minBatch) return null
  const next = Math.max(minBatch, Math.floor(current / 2))
  return next < current ? next : null
}
