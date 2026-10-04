/**
 * Relevance scoring for the Postgres backend. The formulas, weights and RRF
 * are backend-neutral and live in @rivetos/memory-core; this file re-exports
 * them and adds the Postgres SQL fragments that apply the same formulas.
 */

import { DECAY_LAMBDA, REINFORCEMENT_ALPHA, REINFORCEMENT_CAP } from '@rivetos/memory-core'

export {
  W_FTS,
  W_SEMANTIC,
  W_TEMPORAL,
  W_IMPORTANCE,
  SUMMARY_IMPORTANCE,
  RRF_K_DEFAULT,
  temporalDecay,
  importanceForRole,
  computeRelevance,
  reciprocalRankFusion,
} from '@rivetos/memory-core'

// ---------------------------------------------------------------------------
// SQL Fragments (for use in search queries)
// ---------------------------------------------------------------------------

/**
 * SQL expression for temporal decay.
 *
 * Usage: replace `${alias}` with the table alias (m, s, etc.)
 * Expects columns: last_accessed_at, created_at, access_count
 */
export function temporalDecaySql(alias: string): string {
  // Decay on memory AGE (created_at), not last_accessed_at. Resetting the clock
  // on every search return made any recently-surfaced row float up regardless of
  // the new query — cross-query contamination, the core of the feedback loop.
  // Reinforcement via access_count is capped (LEAST) so it can't run away.
  return `EXP(-${DECAY_LAMBDA} * EXTRACT(EPOCH FROM (NOW() - ${alias}.created_at)) / 86400.0) * (1.0 + ${REINFORCEMENT_ALPHA} * LEAST(COALESCE(${alias}.access_count, 0), ${REINFORCEMENT_CAP}))`
}

/**
 * SQL expression for message importance.
 *
 * Expects columns: role, tool_name
 */
export function importanceSql(alias: string): string {
  return `CASE WHEN ${alias}.role = 'system' THEN 0.5 WHEN ${alias}.tool_name IS NOT NULL THEN 0.3 WHEN ${alias}.role = 'user' THEN 0.7 ELSE 0.6 END`
}
