/**
 * Relevance Scoring — pure domain logic, no I/O.
 *
 * Formula from MEMORY-DESIGN.md:
 *   relevance = (fts_rank × 0.3) + (semantic × 0.3) + (temporal × 0.3) + (importance × 0.1)
 *
 * Temporal score uses Ebbinghaus-inspired decay with access reinforcement:
 *   temporal = e^(-λ × days_since_access) × (1 + α × access_count)
 *
 * These functions are designed to be used both in-app (TypeScript) and
 * in SQL (the same formulas appear in search.ts queries).
 */

/** Decay rate: how fast memories fade without reinforcement */
const DECAY_LAMBDA = 0.05

/** Reinforcement coefficient: how much each access slows decay (capped below). */
const REINFORCEMENT_ALPHA = 0.01

/**
 * Cap on accesses that count toward reinforcement. Uncapped, a row that keeps
 * surfacing gets bumped → scores higher → surfaces again: a rich-get-richer loop
 * that pumps noise to the top. Capping bounds the multiplier at 1 + ALPHA·CAP.
 */
const REINFORCEMENT_CAP = 25

/** Weight for full-text search rank */
export const W_FTS = 0.3

/** Weight for semantic (embedding) similarity */
export const W_SEMANTIC = 0.3

/** Weight for temporal decay score */
export const W_TEMPORAL = 0.3

/** Weight for content importance */
export const W_IMPORTANCE = 0.1

// ---------------------------------------------------------------------------
// Temporal Decay
// ---------------------------------------------------------------------------

/**
 * Ebbinghaus-inspired temporal decay with access reinforcement.
 *
 * Recent or frequently-accessed memories score higher.
 *
 * @param daysSinceAccess — days since the reference time (now created_at; see SQL)
 * @param accessCount — number of times this item has been returned in search results
 * @returns score in range [0, ~1.25] (reinforcement is capped)
 */
export function temporalDecay(daysSinceAccess: number, accessCount: number): number {
  const reinforced = 1.0 + REINFORCEMENT_ALPHA * Math.min(accessCount, REINFORCEMENT_CAP)
  return Math.exp(-DECAY_LAMBDA * daysSinceAccess) * reinforced
}

// ---------------------------------------------------------------------------
// Importance by Role
// ---------------------------------------------------------------------------

/**
 * Base importance score by message type.
 *
 * User turns (questions, corrections, preferences) anchor intent and rank
 * highest; substantive assistant prose next. Tool-call stubs carry the least
 * recall value — they must NOT outrank prose (the old 0.7 inverted this).
 * System rows (delegation/audit/config events) sit mid.
 */
export function importanceForRole(role: string, hasToolCall: boolean): number {
  if (role === 'system') return 0.5
  if (hasToolCall) return 0.3 // tool-call stubs — least recall value
  if (role === 'user') return 0.7 // user intent / corrections
  return 0.6 // substantive assistant prose
}

/** Importance for summaries (always mid-range) */
export const SUMMARY_IMPORTANCE = 0.6

// ---------------------------------------------------------------------------
// Composite Relevance
// ---------------------------------------------------------------------------

/**
 * Compute the final hybrid relevance score.
 *
 * All inputs should be normalized to [0, 1] where possible.
 * temporalScore can exceed 1.0 for heavily-accessed items — this is intentional.
 *
 * @param ftsRank — BM25/ts_rank_cd score (0 if no FTS match)
 * @param semanticSim — cosine similarity from embedding (0 if no embedding)
 * @param temporalScore — output of temporalDecay()
 * @param importance — output of importanceForRole()
 */
export function computeRelevance(
  ftsRank: number,
  semanticSim: number,
  temporalScore: number,
  importance: number,
): number {
  return (
    ftsRank * W_FTS +
    semanticSim * W_SEMANTIC +
    temporalScore * W_TEMPORAL +
    importance * W_IMPORTANCE
  )
}

// ---------------------------------------------------------------------------
// Reciprocal Rank Fusion
// ---------------------------------------------------------------------------

/** Canonical RRF smoothing constant (Cormack et al., 2009). */
export const RRF_K_DEFAULT = 60

/**
 * Fuse several ranked lists with Reciprocal Rank Fusion.
 *
 * Each list is assumed ordered best-first. A document's fused score is the sum
 * over the lists it appears in of `1 / (k + rank)`, where rank is 1-based. A
 * larger `k` flattens the advantage of top ranks. Documents are identified
 * across lists by `keyOf` and accumulate contributions from every list.
 *
 * Pure and rank-based — no score normalization needed, which is the whole point
 * of RRF: it fuses heterogeneous scorers (ts_rank_cd, trigram similarity,
 * cosine distance) that aren't otherwise comparable.
 *
 * @returns a map of key → { item (first occurrence), rrf } in insertion order.
 */
export function reciprocalRankFusion<T>(
  lists: readonly (readonly T[])[],
  keyOf: (item: T) => string,
  k: number = RRF_K_DEFAULT,
): Map<string, { item: T; rrf: number }> {
  const acc = new Map<string, { item: T; rrf: number }>()
  for (const list of lists) {
    list.forEach((item, idx) => {
      const key = keyOf(item)
      const inc = 1 / (k + idx + 1) // rank is idx + 1 (1-based)
      const cur = acc.get(key)
      if (cur) cur.rrf += inc
      else acc.set(key, { item, rrf: inc })
    })
  }
  return acc
}

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
