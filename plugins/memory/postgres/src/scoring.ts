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
const DECAY_LAMBDA = 0.05;

/** Reinforcement coefficient: how much each access slows decay */
const REINFORCEMENT_ALPHA = 0.02;

/** Weight for full-text search rank */
export const W_FTS = 0.3;

/** Weight for semantic (embedding) similarity */
export const W_SEMANTIC = 0.3;

/** Weight for temporal decay score */
export const W_TEMPORAL = 0.3;

/** Weight for content importance */
export const W_IMPORTANCE = 0.1;

// ---------------------------------------------------------------------------
// Temporal Decay
// ---------------------------------------------------------------------------

/**
 * Ebbinghaus-inspired temporal decay with access reinforcement.
 *
 * Recent or frequently-accessed memories score higher.
 *
 * @param daysSinceAccess — days since last access (or creation if never accessed)
 * @param accessCount — number of times this item has been returned in search results
 * @returns score in range [0, ~1.5] (can exceed 1.0 for heavily reinforced items)
 */
export function temporalDecay(daysSinceAccess: number, accessCount: number): number {
  return Math.exp(-DECAY_LAMBDA * daysSinceAccess) * (1.0 + REINFORCEMENT_ALPHA * accessCount);
}

// ---------------------------------------------------------------------------
// Importance by Role
// ---------------------------------------------------------------------------

/**
 * Base importance score by message type.
 *
 * Corrections and preferences matter most (they change behavior).
 * System messages and tool calls carry configuration weight.
 * Regular conversation is baseline.
 */
export function importanceForRole(role: string, hasToolCall: boolean): number {
  if (role === 'system') return 0.9;
  if (hasToolCall) return 0.7;
  if (role === 'user') return 0.6;
  return 0.5; // assistant without tools
}

/** Importance for summaries (always mid-range) */
export const SUMMARY_IMPORTANCE = 0.6;

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
  );
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
  return `EXP(-${DECAY_LAMBDA} * EXTRACT(EPOCH FROM (NOW() - COALESCE(${alias}.last_accessed_at, ${alias}.created_at))) / 86400.0) * (1.0 + ${REINFORCEMENT_ALPHA} * COALESCE(${alias}.access_count, 0))`;
}

/**
 * SQL expression for message importance.
 *
 * Expects columns: role, tool_name
 */
export function importanceSql(alias: string): string {
  return `CASE WHEN ${alias}.role = 'system' THEN 0.9 WHEN ${alias}.tool_name IS NOT NULL THEN 0.7 WHEN ${alias}.role = 'user' THEN 0.6 ELSE 0.5 END`;
}
