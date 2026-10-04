/**
 * Hybrid search fusion policy — backend-neutral.
 *
 * A backend fetches candidates per arm (full-text, literal/trigram, vector)
 * however its storage does; how deep to fetch, when the literal arm joins, how
 * the lists fuse and which fused hits survive is decided here, so every
 * backend ranks the same way.
 */

/**
 * Candidate pool depth retrieved per method before fusion. Deeper pools let a
 * doc that one method ranks mediocre — but another ranks highly — still surface
 * (the whole point of fusion). Bounded so the three parallel queries stay cheap.
 */
export const HYBRID_POOL_MIN = 50
export const HYBRID_POOL_MAX = 100

/** Candidates to fetch per arm for a request of `limit` results. */
export function hybridPoolSize(limit: number): number {
  return Math.min(HYBRID_POOL_MAX, Math.max(HYBRID_POOL_MIN, limit * 3))
}

/**
 * RRF smoothing constant for hybrid fusion. Lower than the canonical 60 so the
 * top cross-method matches separate from the long tail instead of clustering in
 * a near-flat band (the old behavior let an empty row outrank the answer).
 */
export const HYBRID_RRF_K = 20

/**
 * Relevance gate: after fusion, drop hits scoring below this fraction of the top
 * hit — unless found by ≥2 arms (cross-method agreement). Stops the result list
 * being padded to `limit` with weak filler.
 */
export const GATE_FRACTION = 0.5

/**
 * Fusion bonus for summaries — the curated, high-signal layer. Without it the
 * far more numerous raw messages bury summaries; a modest multiplier keeps the
 * distilled layer competitive.
 */
export const SUMMARY_FUSION_BONUS = 1.3

/**
 * A query "looks literal" when it carries tokens FTS tokenization mangles —
 * dotted ids/domains/versions, paths, host:port, IPs, or dotted brand/package
 * names (`families.app`, `qwen3.6-27b-int4`). Hyphens are NOT in this class:
 * ordinary hyphenated prose (`state-of-the-art model`) must not inject the
 * trigram arm into hybrid RRF. Hyphenated tokens still qualify for the
 * empty-FTS trigram *fallback* via {@link shouldTrigramFallback}.
 */
const LITERAL_QUERY_RE = /\w[./:_@]\w|\d{1,3}(?:\.\d{1,3}){2,}|[a-z]\d|\d[a-z]/i

export function looksLiteral(q: string): boolean {
  return LITERAL_QUERY_RE.test(q)
}

/**
 * Server-side trigram fallback eligibility: looksLiteral OR a token containing
 * `.` `/` `:` `-` (domains, paths, ids, IPs, model names). Hyphen is gated on
 * an empty FTS arm — it must not route trigram as a hybrid parallel arm.
 */
export function shouldTrigramFallback(q: string): boolean {
  if (looksLiteral(q)) return true
  return /[^\s][./:-][^\s]/.test(q)
}

/**
 * Quality floor for every arm of a hybrid search: a message needs this much
 * substantive text (its content, or for a tool row its tool result) to be a
 * candidate. One-liners ("ok", "thanks") otherwise crowd the pool. Explicit
 * single-mode literal or regex searches are exempt: a "find this exact token
 * anywhere" sweep must still reach short rows.
 */
export const HYBRID_MIN_CONTENT_LEN = 40
