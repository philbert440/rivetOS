/**
 * SearchEngine — hybrid FTS + semantic + temporal + importance scoring.
 *
 * Supports four search modes:
 *   fts     — PostgreSQL full-text search (ts_rank_cd) + real cosine similarity
 *   vector  — cosine similarity via pgvector (requires pre-computed embedding)
 *   trigram — fuzzy matching via pg_trgm
 *   regex   — PostgreSQL regex (~*)
 *
 * When mode=fts and an embedding endpoint is configured, the query is embedded
 * at search time and combined with FTS rank for true hybrid scoring:
 *   relevance = (fts_rank × 0.3) + (cosine_sim × 0.3) + (temporal × 0.3) + (importance × 0.1)
 *
 * Falls back gracefully to a length-based semantic proxy if embedding is
 * unavailable or fails.
 *
 * Scoring uses the formulas from scoring.ts, expressed as SQL for
 * database-side evaluation. Access counts are bumped for returned results.
 */

import pg from 'pg'
import {
  W_FTS,
  W_SEMANTIC,
  W_TEMPORAL,
  W_IMPORTANCE,
  SUMMARY_IMPORTANCE,
  temporalDecaySql,
  importanceSql,
  reciprocalRankFusion,
} from './scoring.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SearchOptions {
  mode?: 'hybrid' | 'fts' | 'vector' | 'regex' | 'trigram'
  scope?: 'messages' | 'summaries' | 'both'
  limit?: number
  agent?: string
  since?: string // ISO timestamp
  before?: string // ISO timestamp
}

export interface SearchDegraded {
  vector: true
  reason: string
}

export interface SearchHit {
  id: string
  type: 'message' | 'summary'
  content: string
  role: string
  agent: string
  conversationId: string
  score: number
  createdAt: Date
  /** Set when the stored content/tool_result was truncated at capture
   *  (metadata.truncated) — memory_get_full can fetch the rest. */
  truncated?: boolean
  fullLength?: number
  /** Tool call name when the hit is a tool row (or has tool metadata). */
  toolName?: string | null
  /** Tool payload — often the only substantive text on role=tool rows. */
  toolResult?: string | null
  // Summary-specific fields
  kind?: string
  earliestAt?: Date
  latestAt?: Date
  /**
   * Present when this hit was recovered because FTS returned nothing and the
   * server-side trigram fallback ran. Additive — older callers ignore it.
   */
  fallback?: 'trigram'
  /**
   * Present when the vector arm was dropped for the search that produced this
   * hit. Additive — older callers ignore it. Also set on the result array
   * (see {@link SearchResults}) so empty result sets can still signal it.
   */
  degraded?: SearchDegraded
}

/**
 * `search()` return: a hit array with optional result-set metadata. Assignable
 * to `SearchHit[]`; `degraded` / `fallback` live on the array so an empty
 * result can still tell the caller the vector arm dropped or trigram recovered.
 */
export type SearchResults = SearchHit[] & {
  degraded?: SearchDegraded
  fallback?: 'trigram'
}

/**
 * In-process counters surfaced by `memory_stats`.
 *
 * Each `SearchEngine` owns its own counters (owner DB vs each per-user DB).
 * Routed `memory_stats` reports the engine for that user; values are not
 * summed across users (tenant isolation).
 */
export interface SearchRuntimeStats {
  vectorArmDropped: number
  vectorArmDroppedLastHour: number
  queryEmbedCacheHits: number
  queryEmbedCacheMisses: number
}

/**
 * A retrieval candidate: a SearchHit plus the recency/importance boost used as
 * a multiplier during fusion. `score` on a candidate holds the per-method raw
 * relevance (for ordering within that method's list); the fused score is
 * computed in rrfFuse and written back onto the returned SearchHit.
 */
interface Candidate extends SearchHit {
  /** temporal·W_TEMPORAL + importance·W_IMPORTANCE, roughly [0, 0.55] */
  boost: number
}

export interface SearchEngineConfig {
  /** Embedding service URL for query-time embedding (e.g., http://192.0.2.1:9401) */
  embedEndpoint?: string
  /** Model name for embedding (required when embedEndpoint is set) */
  embedModel?: string
  /**
   * Prefix applied ONLY to search-time query embeddings (Qwen3-Embedding is
   * asymmetric). Empty string disables. Default is the Qwen3 instruct prefix.
   * Documents (embedding-worker) are never prefixed.
   */
  embedQueryInstruction?: string
  /** Query-embed fetch timeout in ms (default 8000, floor 500, cap 60000). */
  embedTimeoutMs?: number | string
  /** Per-query hnsw.ef_search (default 100, clamp 10..1000). */
  hnswEfSearch?: number | string
}

// ---------------------------------------------------------------------------
// Row interfaces
// ---------------------------------------------------------------------------

interface MessageSearchRow {
  id: string
  content: string
  role: string
  agent: string
  conversation_id: string
  created_at: Date
  score: string
  metadata?: Record<string, unknown> | null
  tool_name?: string | null
  tool_result?: string | null
}

interface SummarySearchRow {
  id: string
  content: string
  role: string
  agent: string
  conversation_id: string
  created_at: Date
  kind: string
  earliest_at: Date | null
  latest_at: Date | null
  score: string
  semantic_sim?: string
}

/** Row shape returned by the hybrid candidate retrievers (text + vector). */
interface CandidateRow {
  id: string
  content: string
  role: string
  agent: string
  conversation_id: string
  created_at: Date
  boost: string
  metadata?: Record<string, unknown> | null
  tool_name?: string | null
  tool_result?: string | null
  kind?: string
  earliest_at?: Date | null
  latest_at?: Date | null
}

interface EmbedResponseItem {
  embedding?: number[]
  index?: number
}

interface EmbedResponse {
  data?: EmbedResponseItem[]
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Qwen3-Embedding query prefix. Documents get nothing. Empty string disables. */
export const DEFAULT_EMBED_QUERY_INSTRUCTION =
  'Instruct: Given a search query, retrieve relevant passages that answer the query\nQuery: '

export const DEFAULT_EMBED_TIMEOUT_MS = 8_000
export const MIN_EMBED_TIMEOUT_MS = 500
export const MAX_EMBED_TIMEOUT_MS = 60_000
export const DEFAULT_HNSW_EF_SEARCH = 100
export const MIN_HNSW_EF_SEARCH = 10
export const MAX_HNSW_EF_SEARCH = 1_000
export const QUERY_EMBED_CACHE_MAX = 256
export const QUERY_EMBED_CACHE_TTL_MS = 10 * 60 * 1000
const EMBED_INPUT_MAX = 8_000
const VECTOR_DROP_LOG_INTERVAL_MS = 60_000
const DROP_BUCKET_MINUTES = 60
const MINUTE_MS = 60_000

/**
 * Candidate pool depth retrieved per method before fusion. Deeper pools let a
 * doc that one method ranks mediocre — but another ranks highly — still surface
 * (the whole point of fusion). Bounded so the three parallel queries stay cheap.
 */
const HYBRID_POOL_MIN = 50
const HYBRID_POOL_MAX = 100

/**
 * Minimum trimmed content length for a message to be eligible in HYBRID search.
 * Mirrors the embedder's >20 floor but stricter: kills stubs that carry no
 * recall value — empty rows, "het", "[thinking]", "[tool call] Bash",
 * "still there?" — which otherwise ride the recency/importance boost to the top.
 * Applied to hybrid only; explicit trigram/regex modes stay unfiltered so the
 * "find this literal token anywhere" sweep still reaches short/tool rows.
 *
 * Tool rows store the real payload in `tool_result` (content is often just
 * `[tool] name`). The quality floor therefore accepts role=tool when
 * tool_result is substantive — see {@link MESSAGE_QUALITY_SQL}.
 */
const MIN_CONTENT_LEN = 40

/**
 * Hybrid quality floor for ros_messages: substantive non-tool content, or a
 * tool row whose tool_result carries real payload (≥ {@link MIN_CONTENT_LEN}).
 * Replaces the old `role <> 'tool'` ban that hid ~85k tool payloads from search.
 */
export const MESSAGE_QUALITY_SQL = `(
  (m.role <> 'tool' AND length(btrim(m.content)) >= ${String(MIN_CONTENT_LEN)})
  OR
  (m.role = 'tool' AND length(btrim(coalesce(m.tool_result, ''))) >= ${String(MIN_CONTENT_LEN)})
)`

/**
 * RRF smoothing constant for hybrid fusion. Lower than the canonical 60 so the
 * top cross-method matches separate from the long tail instead of clustering in
 * a near-flat band (the old behavior let an empty row outrank the answer).
 */
const HYBRID_RRF_K = 20

/**
 * Relevance gate: after fusion, drop hits scoring below this fraction of the top
 * hit — unless found by ≥2 arms (cross-method agreement). Stops the result list
 * being padded to `limit` with weak filler.
 */
const GATE_FRACTION = 0.5

/**
 * Fusion bonus for summaries — the curated, high-signal layer. Without it the
 * far more numerous raw messages bury summaries; a modest multiplier keeps the
 * distilled layer competitive.
 */
const SUMMARY_FUSION_BONUS = 1.3

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

export function normalizeQueryText(text: string): string {
  return text.trim().replace(/\s+/g, ' ')
}

export function applyEmbedQueryInstruction(instruction: string, text: string): string {
  const budget = Math.max(0, EMBED_INPUT_MAX - instruction.length)
  const sliced = text.slice(0, budget)
  if (!instruction) return sliced
  return `${instruction}${sliced}`
}

export function clampEmbedTimeoutMs(raw: unknown): number {
  const n = coerceNumber(raw)
  if (n === null) return DEFAULT_EMBED_TIMEOUT_MS
  return Math.min(MAX_EMBED_TIMEOUT_MS, Math.max(MIN_EMBED_TIMEOUT_MS, Math.trunc(n)))
}

export function clampHnswEfSearch(raw: unknown): number {
  const n = coerceNumber(raw)
  if (n === null) return DEFAULT_HNSW_EF_SEARCH
  return Math.min(MAX_HNSW_EF_SEARCH, Math.max(MIN_HNSW_EF_SEARCH, Math.trunc(n)))
}

function coerceNumber(raw: unknown): number | null {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null
  if (typeof raw === 'string' && raw.trim() !== '') {
    const n = Number(raw)
    return Number.isFinite(n) ? n : null
  }
  return null
}

/** LRU + TTL cache for successful query embeddings. */
class QueryEmbedCache {
  hits = 0
  misses = 0
  private map = new Map<string, { vec: number[]; expiresAt: number }>()

  get(key: string, now: number): number[] | undefined {
    const entry = this.map.get(key)
    if (!entry) {
      this.misses += 1
      return undefined
    }
    if (now >= entry.expiresAt) {
      this.map.delete(key)
      this.misses += 1
      return undefined
    }
    this.map.delete(key)
    this.map.set(key, entry)
    this.hits += 1
    return entry.vec
  }

  set(key: string, vec: number[], now: number): void {
    if (this.map.has(key)) this.map.delete(key)
    this.map.set(key, { vec, expiresAt: now + QUERY_EMBED_CACHE_TTL_MS })
    while (this.map.size > QUERY_EMBED_CACHE_MAX) {
      const oldest = this.map.keys().next().value
      if (oldest === undefined) break
      this.map.delete(oldest)
    }
  }
}

function withSearchMeta(
  hits: SearchHit[],
  meta: { degraded?: SearchDegraded; fallback?: 'trigram' } = {},
): SearchResults {
  const prior = hits as SearchResults
  const fallback = meta.fallback ?? prior.fallback
  const degraded = meta.degraded ?? prior.degraded
  const needAnnotate = Boolean(degraded || fallback)
  const annotated = needAnnotate
    ? hits.map((h) => ({
        ...h,
        ...(fallback ? { fallback } : {}),
        ...(degraded ? { degraded } : {}),
      }))
    : hits
  const out = annotated as SearchResults
  if (degraded) out.degraded = degraded
  if (fallback) out.fallback = fallback
  return out
}

/** Fallback semantic proxy when embedding is unavailable */
const SEMANTIC_PROXY = (alias: string): string => `LEAST(LENGTH(${alias}.content) / 1000.0, 1.0)`

/**
 * Render an embedding as a pgvector text literal (`[1,2,3]`). Always passed to
 * the driver as a bound parameter (`$n::halfvec`), never interpolated into SQL.
 */
const toVectorLiteral = (embedding: number[]): string => `[${embedding.join(',')}]`

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

export class SearchEngine {
  private pool: pg.Pool
  private embedEndpoint: string | null
  private embedModel: string
  private embedQueryInstruction: string
  private embedTimeoutMs: number
  private hnswEfSearch: number
  private queryEmbedCache = new QueryEmbedCache()
  private vectorArmDroppedTotal = 0
  /** 60 one-minute buckets; index = epochMinute % 60. Bounded last-hour count. */
  private dropBucketCounts = new Array<number>(DROP_BUCKET_MINUTES).fill(0)
  private dropBucketEpoch = new Array<number>(DROP_BUCKET_MINUTES).fill(-1)
  private lastVectorDropLogAt = 0

  constructor(pool: pg.Pool, config?: SearchEngineConfig) {
    this.pool = pool
    this.embedEndpoint = config?.embedEndpoint ?? null
    if (this.embedEndpoint && !config?.embedModel) {
      throw new Error(
        'embedModel is required when embedEndpoint is set (env: RIVETOS_EMBED_MODEL). OpenAI-compatible embedding model id (example: text-embedding-3-small)',
      )
    }
    this.embedModel = config?.embedModel ?? ''
    this.embedQueryInstruction =
      config?.embedQueryInstruction === undefined
        ? DEFAULT_EMBED_QUERY_INSTRUCTION
        : config.embedQueryInstruction
    this.embedTimeoutMs = clampEmbedTimeoutMs(config?.embedTimeoutMs)
    this.hnswEfSearch = clampHnswEfSearch(config?.hnswEfSearch)
  }

  getRuntimeStats(): SearchRuntimeStats {
    return {
      vectorArmDropped: this.vectorArmDroppedTotal,
      vectorArmDroppedLastHour: this.lastHourDropCount(Date.now()),
      queryEmbedCacheHits: this.queryEmbedCache.hits,
      queryEmbedCacheMisses: this.queryEmbedCache.misses,
    }
  }

  /**
   * Search messages and/or summaries.
   *
   * Default mode `hybrid` fuses three independent retrievers — FTS, trigram, and
   * vector (HNSW) — with Reciprocal Rank Fusion, then applies a gentle
   * recency/importance boost. This makes recall robust to the way any single
   * method fails: FTS tokenization mangles literal/dotted terms (domains, IPs,
   * model ids), trigram is blind to meaning, and vector misses exact tokens.
   * Fusing them means a hit any one method finds survives.
   *
   * Explicit modes are deliberate escape hatches and skip fusion:
   *   fts / trigram / regex — single text method (composite-scored as before)
   *   vector                — pure ANN over the HNSW index (needs an embedding)
   *
   * Access counts are incremented for returned results.
   */
  async search(query: string, options?: SearchOptions): Promise<SearchResults> {
    const mode = options?.mode ?? 'hybrid'
    const scope = options?.scope ?? 'both'
    const limit = options?.limit ?? 20

    if (mode === 'hybrid') {
      return this.hybridSearch(query, scope, limit, options)
    }

    if (mode === 'vector') {
      const embedded = await this.embedQuery(query)
      // No embedding available (endpoint down / not configured) — degrade to FTS
      // rather than returning nothing.
      if (!embedded.vec) {
        // Skip a second embed attempt — the query embed already failed.
        const hits = await this.singleTextSearch('fts', query, scope, limit, options, {
          skipEmbed: true,
        })
        if (this.embedEndpoint) {
          this.recordVectorArmDropped(embedded.reason ?? 'unknown', embedded.elapsedMs)
          return withSearchMeta(hits, {
            degraded: { vector: true, reason: embedded.reason ?? 'unknown' },
          })
        }
        return withSearchMeta(hits)
      }
      const hits = await this.vectorSearch(embedded.vec, { scope, limit, agent: options?.agent })
      void this.bumpAccess(hits)
      return withSearchMeta(hits)
    }

    // Explicit single text mode: fts / trigram / regex.
    return this.singleTextSearch(mode, query, scope, limit, options)
  }

  /**
   * Single-method text search (fts / trigram / regex) with the original
   * composite scoring. Preserved as the explicit escape hatch.
   *
   * Explicit `fts` may embed the query for a cosine rerank term (not a hybrid
   * vector arm). If that embed fails, we attach `degraded` and emit the
   * rate-limited warn log so the miss is never silent — but we do **not**
   * increment `vectorArmDropped`. That counter is the hybrid/vector arm only.
   */
  private async singleTextSearch(
    mode: string,
    query: string,
    scope: 'messages' | 'summaries' | 'both',
    limit: number,
    options?: SearchOptions,
    extras?: { skipEmbed?: boolean },
  ): Promise<SearchResults> {
    const results: SearchHit[] = []

    // Embed query once for FTS hybrid scoring (semantic rerank term).
    let queryEmbedding: number[] | null = null
    let degraded: SearchDegraded | undefined
    if (mode === 'fts' && this.embedEndpoint && !extras?.skipEmbed) {
      const embedded = await this.embedQuery(query)
      queryEmbedding = embedded.vec
      if (!queryEmbedding) {
        this.logVectorArmDropped(embedded.reason ?? 'unknown', embedded.elapsedMs)
        degraded = { vector: true, reason: embedded.reason ?? 'unknown' }
      }
    }

    if (scope === 'messages' || scope === 'both') {
      results.push(...(await this.searchMessages(query, mode, limit, options, queryEmbedding)))
    }
    if (scope === 'summaries' || scope === 'both') {
      results.push(...(await this.searchSummaries(query, mode, limit, options, queryEmbedding)))
    }

    results.sort((a, b) => b.score - a.score)
    const topResults = results.slice(0, limit)

    // Explicit fts: if FTS returned nothing and the query looks like a literal
    // token, recover via trigram and annotate. Recurses only into trigram.
    if (mode === 'fts' && topResults.length === 0 && shouldTrigramFallback(query)) {
      const recovered = await this.singleTextSearch('trigram', query, scope, limit, options)
      if (recovered.length > 0) {
        return withSearchMeta(recovered, { fallback: 'trigram', degraded })
      }
    }

    void this.bumpAccess(topResults)
    return withSearchMeta(topResults, { degraded })
  }

  /**
   * Hybrid retrieval: run FTS, trigram, and vector arms in parallel over a deep
   * candidate pool, fuse with RRF, boost by recency/importance, return top N.
   * The vector arm is dropped (gracefully) when no embedding can be produced.
   */
  private async hybridSearch(
    query: string,
    scope: 'messages' | 'summaries' | 'both',
    limit: number,
    options?: SearchOptions,
  ): Promise<SearchResults> {
    const pool = Math.min(HYBRID_POOL_MAX, Math.max(HYBRID_POOL_MIN, limit * 3))

    // Embed once for the vector arm; null (no endpoint / failure) drops that arm.
    const embedded = this.embedEndpoint ? await this.embedQuery(query) : null
    const qvec = embedded?.vec ?? null
    let degraded: SearchDegraded | undefined
    if (this.embedEndpoint && embedded && !embedded.vec) {
      this.recordVectorArmDropped(embedded.reason ?? 'unknown', embedded.elapsedMs)
      degraded = { vector: true, reason: embedded.reason ?? 'unknown' }
    }

    // Route the trigram arm in only for literal/dotted queries; on prose it is
    // blind character-overlap noise. FTS always runs; vector runs when embedded.
    const useTrigram = looksLiteral(query)

    const [ftsList, initialTrigram, vectorList] = await Promise.all([
      this.retrieveTextCandidates('fts', query, scope, pool, options),
      useTrigram
        ? this.retrieveTextCandidates('trigram', query, scope, pool, options)
        : Promise.resolve([] as Candidate[]),
      qvec
        ? this.retrieveVectorCandidates(qvec, scope, pool, options)
        : Promise.resolve([] as Candidate[]),
    ])

    let trigramList = initialTrigram
    let fallback: 'trigram' | undefined
    // Only annotate fallback when trigram ran as recovery — not when it was
    // already the hybrid-routed arm (`useTrigram` / looksLiteral).
    if (!useTrigram && ftsList.length === 0 && shouldTrigramFallback(query)) {
      if (trigramList.length === 0) {
        trigramList = await this.retrieveTextCandidates('trigram', query, scope, pool, options)
      }
      if (trigramList.length > 0) {
        fallback = 'trigram'
      }
    }

    const fused = this.rrfFuse([ftsList, trigramList, vectorList])
    const topResults = withSearchMeta(fused.slice(0, limit), { degraded, fallback })
    void this.bumpAccess(topResults)
    return topResults
  }

  /**
   * Fuse ranked candidate lists with Reciprocal Rank Fusion, then scale each
   * doc's fused score by its recency/importance boost. Dedupes by type+id;
   * a doc found by multiple methods accumulates contributions from each.
   */
  private rrfFuse(lists: Candidate[][]): SearchHit[] {
    const keyOf = (hit: Candidate): string => `${hit.type}:${hit.id}`
    const fusedMap = reciprocalRankFusion(lists, keyOf, HYBRID_RRF_K)

    // Per-doc arm membership: a hit found by ≥2 methods is strong cross-method
    // agreement, kept regardless of the relevance gate below.
    const armKeySets = lists.map((l) => new Set(l.map(keyOf)))

    const scored = Array.from(fusedMap.values()).map(({ item, rrf }) => {
      const { boost, ...rest } = item
      const key = keyOf(item)
      const armCount = armKeySets.reduce((n, s) => n + (s.has(key) ? 1 : 0), 0)
      // Summaries (curated layer) get a modest bonus so they aren't buried under
      // the far more numerous raw messages; boost (≤ ~0.55) nudges by recency.
      const layerBonus = item.type === 'summary' ? SUMMARY_FUSION_BONUS : 1
      const score = rrf * (1 + boost) * layerBonus
      return { hit: { ...rest, score }, armCount }
    })

    scored.sort((a, b) => b.hit.score - a.hit.score)
    if (scored.length === 0) return []

    // Relevance gate: keep cross-method agreement (≥2 arms) or anything within
    // GATE_FRACTION of the top score; drop the weak tail instead of padding.
    const top = scored[0].hit.score
    return scored
      .filter((s) => s.armCount >= 2 || s.hit.score >= top * GATE_FRACTION)
      .map((s) => s.hit)
  }

  /**
   * Retrieve a candidate pool for a single text method (fts | trigram), ordered
   * by that method's raw relevance. Carries the recency/importance boost so
   * fusion can apply it once, post-merge.
   */
  private async retrieveTextCandidates(
    method: 'fts' | 'trigram',
    query: string,
    scope: 'messages' | 'summaries' | 'both',
    pool: number,
    options?: SearchOptions,
  ): Promise<Candidate[]> {
    const out: Candidate[] = []

    if (scope === 'messages' || scope === 'both') {
      const { whereClause, ftsScoreExpr, params, limitIdx } = this.buildTextQuery(
        'm',
        query,
        method,
        pool,
        options,
        null,
        { agentFilter: true, qualityFilter: true },
      )
      const boostExpr = `((${temporalDecaySql('m')}) * ${W_TEMPORAL} + (${importanceSql('m')}) * ${W_IMPORTANCE})`
      const sql = `
        SELECT m.id, m.content, m.role, m.agent, m.metadata, m.conversation_id, m.created_at,
               m.tool_name, m.tool_result,
               ${boostExpr} AS boost
        FROM ros_messages m
        WHERE ${whereClause}
        ORDER BY ${ftsScoreExpr} DESC
        LIMIT $${String(limitIdx)}
      `
      const res = await this.pool.query<CandidateRow>(sql, params)
      out.push(...res.rows.map((r) => this.mapCandidate(r, 'message')))
    }

    if (scope === 'summaries' || scope === 'both') {
      const { whereClause, ftsScoreExpr, params, limitIdx } = this.buildTextQuery(
        's',
        query,
        method,
        pool,
        options,
        null,
        { agentFilter: false, qualityFilter: true },
      )
      const boostExpr = `((${temporalDecaySql('s')}) * ${W_TEMPORAL} + ${SUMMARY_IMPORTANCE} * ${W_IMPORTANCE})`
      const sql = `
        SELECT s.id, s.content, s.kind AS role, 'summary' AS agent, s.conversation_id,
               s.created_at, s.kind, s.earliest_at, s.latest_at,
               ${boostExpr} AS boost
        FROM ros_summaries s
        WHERE ${whereClause}
        ORDER BY ${ftsScoreExpr} DESC
        LIMIT $${String(limitIdx)}
      `
      const res = await this.pool.query<CandidateRow>(sql, params)
      out.push(...res.rows.map((r) => this.mapCandidate(r, 'summary')))
    }

    return out
  }

  /**
   * Retrieve a candidate pool via approximate-nearest-neighbour over the HNSW
   * index, ordered by cosine distance. Honors agent (messages) + date filters.
   */
  private async retrieveVectorCandidates(
    qvec: number[],
    scope: 'messages' | 'summaries' | 'both',
    pool: number,
    options?: SearchOptions,
  ): Promise<Candidate[]> {
    const vecLiteral = toVectorLiteral(qvec)
    return this.withHnswEfSearch(async (client) => {
      const out: Candidate[] = []

      if (scope === 'messages' || scope === 'both') {
        const params: unknown[] = [vecLiteral]
        const conds = ['m.embedding IS NOT NULL', MESSAGE_QUALITY_SQL]
        if (options?.agent) {
          params.push(options.agent)
          conds.push(`m.agent = $${String(params.length)}`)
        }
        if (options?.since) {
          params.push(options.since)
          conds.push(`m.created_at >= $${String(params.length)}`)
        }
        if (options?.before) {
          params.push(options.before)
          conds.push(`m.created_at < $${String(params.length)}`)
        }
        params.push(pool)
        const boostExpr = `((${temporalDecaySql('m')}) * ${W_TEMPORAL} + (${importanceSql('m')}) * ${W_IMPORTANCE})`
        const sql = `
        SELECT m.id, m.content, m.role, m.agent, m.metadata, m.conversation_id, m.created_at,
               m.tool_name, m.tool_result,
               ${boostExpr} AS boost
        FROM ros_messages m
        WHERE ${conds.join(' AND ')}
        ORDER BY m.embedding <=> $1::halfvec
        LIMIT $${String(params.length)}
      `
        const res = await client.query<CandidateRow>(sql, params)
        out.push(...res.rows.map((r) => this.mapCandidate(r, 'message')))
      }

      if (scope === 'summaries' || scope === 'both') {
        const params: unknown[] = [vecLiteral]
        const conds = [
          's.embedding IS NOT NULL', // summaries are cross-agent
          `length(btrim(s.content)) >= ${String(MIN_CONTENT_LEN)}`,
        ]
        if (options?.since) {
          params.push(options.since)
          conds.push(`s.created_at >= $${String(params.length)}`)
        }
        if (options?.before) {
          params.push(options.before)
          conds.push(`s.created_at < $${String(params.length)}`)
        }
        params.push(pool)
        const boostExpr = `((${temporalDecaySql('s')}) * ${W_TEMPORAL} + ${SUMMARY_IMPORTANCE} * ${W_IMPORTANCE})`
        const sql = `
        SELECT s.id, s.content, s.kind AS role, 'summary' AS agent, s.conversation_id,
               s.created_at, s.kind, s.earliest_at, s.latest_at,
               ${boostExpr} AS boost
        FROM ros_summaries s
        WHERE ${conds.join(' AND ')}
        ORDER BY s.embedding <=> $1::halfvec
        LIMIT $${String(params.length)}
      `
        const res = await client.query<CandidateRow>(sql, params)
        out.push(...res.rows.map((r) => this.mapCandidate(r, 'summary')))
      }

      return out
    })
  }

  /** Map a candidate row to a Candidate (raw per-method score is unused → 0). */
  private mapCandidate(r: CandidateRow, type: 'message' | 'summary'): Candidate {
    const base: Candidate = {
      id: r.id,
      type,
      content: r.content,
      role: r.role,
      agent: r.agent,
      conversationId: r.conversation_id,
      score: 0,
      createdAt: r.created_at,
      boost: parseFloat(r.boost),
    }
    if (type === 'message') {
      base.toolName = r.tool_name ?? null
      base.toolResult = r.tool_result ?? null
      if (r.metadata?.truncated === true) {
        base.truncated = true
        const full = r.metadata.full_content_length ?? r.metadata.full_tool_result_length
        if (typeof full === 'number') base.fullLength = full
      }
    }
    if (type === 'summary') {
      base.kind = r.kind
      base.earliestAt = r.earliest_at ?? undefined
      base.latestAt = r.latest_at ?? undefined
    }
    return base
  }

  /**
   * Vector search with a pre-computed embedding.
   *
   * Bypasses text matching — scores purely on cosine similarity + temporal + importance.
   */
  async vectorSearch(
    embedding: number[],
    options?: { scope?: 'messages' | 'summaries' | 'both'; limit?: number; agent?: string },
  ): Promise<SearchHit[]> {
    const scope = options?.scope ?? 'both'
    const limit = options?.limit ?? 10
    const vecLiteral = toVectorLiteral(embedding)
    const results = await this.withHnswEfSearch(async (client) => {
      const out: SearchHit[] = []

      if (scope === 'messages' || scope === 'both') {
        // $1 = vector, optional $2 = agent, last = limit
        const params: unknown[] = [vecLiteral]
        let agentFilter = ''
        if (options?.agent) {
          params.push(options.agent)
          agentFilter = `AND m.agent = $${String(params.length)}`
        }
        params.push(limit)
        const limitIdx = params.length
        const temporal = temporalDecaySql('m')
        const importance = importanceSql('m')

        const sql = `
        SELECT m.id, m.content, m.role, m.agent, m.metadata,
               m.conversation_id, m.created_at, m.tool_name, m.tool_result,
               (1 - (m.embedding <=> $1::halfvec)) AS semantic_sim,
               (
                 (1 - (m.embedding <=> $1::halfvec)) * ${W_SEMANTIC}
                 + (${temporal}) * ${W_TEMPORAL}
                 + (${importance}) * ${W_IMPORTANCE}
               ) AS score
        FROM ros_messages m
        WHERE m.embedding IS NOT NULL ${agentFilter}
        ORDER BY m.embedding <=> $1::halfvec
        LIMIT $${String(limitIdx)}
      `

        const res = await client.query<MessageSearchRow>(sql, params)
        out.push(
          ...res.rows.map((r) => ({
            id: r.id,
            type: 'message' as const,
            content: r.content,
            role: r.role,
            agent: r.agent,
            conversationId: r.conversation_id,
            score: parseFloat(r.score),
            createdAt: r.created_at,
            toolName: r.tool_name ?? null,
            toolResult: r.tool_result ?? null,
            ...(r.metadata?.truncated === true
              ? {
                  truncated: true,
                  fullLength: [
                    r.metadata.full_content_length,
                    r.metadata.full_tool_result_length,
                  ].find((v): v is number => typeof v === 'number'),
                }
              : {}),
          })),
        )
      }

      if (scope === 'summaries' || scope === 'both') {
        const temporal = temporalDecaySql('s')

        const sql = `
        SELECT s.id, s.content, s.kind AS role, 'summary' AS agent,
               s.conversation_id, s.created_at,
               s.kind, s.earliest_at, s.latest_at,
               (1 - (s.embedding <=> $1::halfvec)) AS semantic_sim,
               (
                 (1 - (s.embedding <=> $1::halfvec)) * ${W_SEMANTIC}
                 + (${temporal}) * ${W_TEMPORAL}
                 + ${SUMMARY_IMPORTANCE} * ${W_IMPORTANCE}
               ) AS score
        FROM ros_summaries s
        WHERE s.embedding IS NOT NULL
        ORDER BY s.embedding <=> $1::halfvec
        LIMIT $2
      `

        const res = await client.query<SummarySearchRow>(sql, [vecLiteral, limit])
        out.push(
          ...res.rows.map((r) => ({
            id: r.id,
            type: 'summary' as const,
            content: r.content,
            role: r.role,
            agent: r.agent,
            conversationId: r.conversation_id,
            score: parseFloat(r.score),
            createdAt: r.created_at,
            kind: r.kind,
            earliestAt: r.earliest_at ?? undefined,
            latestAt: r.latest_at ?? undefined,
          })),
        )
      }

      return out
    })

    results.sort((a, b) => b.score - a.score)
    const topResults = results.slice(0, limit)
    void this.bumpAccess(topResults)
    return topResults
  }

  // -----------------------------------------------------------------------
  // Query embedding — call Nemotron at search time
  // -----------------------------------------------------------------------

  /**
   * Embed a query string via the configured embedding endpoint.
   * Failures return a reason + elapsed ms so callers can signal degraded mode
   * instead of dropping the vector arm silently. Successful vectors are cached.
   */
  private async embedQuery(text: string): Promise<{
    vec: number[] | null
    reason?: string
    elapsedMs: number
  }> {
    if (!this.embedEndpoint) {
      return { vec: null, reason: 'not configured', elapsedMs: 0 }
    }

    const now = Date.now()
    const normalized = normalizeQueryText(text)
    const cacheKey = `${this.embedQueryInstruction}\0${normalized}`
    const cached = this.queryEmbedCache.get(cacheKey, now)
    if (cached) {
      return { vec: cached, elapsedMs: 0 }
    }

    const started = Date.now()
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.embedTimeoutMs)
    try {
      const response = await fetch(`${this.embedEndpoint}/v1/embeddings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          input: [applyEmbedQueryInstruction(this.embedQueryInstruction, normalized)],
          model: this.embedModel,
        }),
        signal: controller.signal,
      })

      const elapsedMs = Date.now() - started
      if (!response.ok) {
        return { vec: null, reason: `http ${String(response.status)}`, elapsedMs }
      }

      let data: EmbedResponse
      try {
        data = (await response.json()) as EmbedResponse
      } catch {
        return { vec: null, reason: 'bad response', elapsedMs }
      }
      const vec = data.data?.[0]?.embedding
      if (!vec || !Array.isArray(vec) || vec.length === 0) {
        return { vec: null, reason: 'empty vector', elapsedMs }
      }

      // Truncate to pgvector halfvec max (4000 dims). Nemotron returns 4096
      // natively; stored rows are sliced to 4000 by the embedding worker.
      // Must match to avoid "different halfvec dimensions" errors on <=>.
      const EMBED_DIMS = 4000
      const clipped = vec.length > EMBED_DIMS ? vec.slice(0, EMBED_DIMS) : vec
      this.queryEmbedCache.set(cacheKey, clipped, Date.now())
      return { vec: clipped, elapsedMs }
    } catch (err: unknown) {
      const elapsedMs = Date.now() - started
      const isAbort =
        (err instanceof Error && err.name === 'AbortError') ||
        (typeof err === 'object' &&
          err !== null &&
          'name' in err &&
          (err as { name: string }).name === 'AbortError') ||
        (err instanceof Error && /abort/i.test(err.message))
      return {
        vec: null,
        reason: isAbort ? 'timeout' : 'network',
        elapsedMs,
      }
    } finally {
      clearTimeout(timeout)
    }
  }

  /**
   * Run vector-arm SQL inside a transaction with `SET LOCAL hnsw.ef_search`
   * so each query uses the configured probe depth regardless of the database
   * default. `n` is interpolated only after clamping to 10..1000.
   *
   * Callers must invoke this only after the query embedding has resolved so a
   * pooled connection is never held across the embed HTTP call.
   */
  private async withHnswEfSearch<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect()
    let releaseErr: Error | boolean | undefined
    try {
      await client.query('BEGIN')
      await client.query(`SET LOCAL hnsw.ef_search = ${String(this.hnswEfSearch)}`)
      const result = await fn(client)
      await client.query('COMMIT')
      return result
    } catch (err) {
      releaseErr = err instanceof Error ? err : true
      try {
        await client.query('ROLLBACK')
      } catch {
        // ignore — original error is what matters; release still gets the err
      }
      throw err
    } finally {
      client.release(releaseErr)
    }
  }

  private recordVectorArmDropped(reason: string, elapsedMs: number): void {
    this.vectorArmDroppedTotal += 1
    this.addDropBucket(Date.now())
    this.logVectorArmDropped(reason, elapsedMs)
  }

  /**
   * Rate-limited warn for a dropped vector signal. Used by the hybrid/vector
   * arm (via {@link recordVectorArmDropped}) and by explicit-fts rerank
   * failure (no counter bump — rerank is not an arm).
   */
  private logVectorArmDropped(reason: string, elapsedMs: number): void {
    const now = Date.now()
    if (now - this.lastVectorDropLogAt >= VECTOR_DROP_LOG_INTERVAL_MS) {
      console.warn(`[memory-search] vector arm dropped: ${reason} (${String(elapsedMs)}ms)`)
      this.lastVectorDropLogAt = now
    }
  }

  private addDropBucket(now: number): void {
    const minute = Math.floor(now / MINUTE_MS)
    const i = minute % DROP_BUCKET_MINUTES
    if (this.dropBucketEpoch[i] !== minute) {
      this.dropBucketCounts[i] = 0
      this.dropBucketEpoch[i] = minute
    }
    this.dropBucketCounts[i] += 1
  }

  private lastHourDropCount(now: number): number {
    const minute = Math.floor(now / MINUTE_MS)
    let n = 0
    for (let i = 0; i < DROP_BUCKET_MINUTES; i++) {
      const epoch = this.dropBucketEpoch[i]
      if (epoch >= 0 && minute - epoch < DROP_BUCKET_MINUTES) {
        n += this.dropBucketCounts[i]
      }
    }
    return n
  }

  // -----------------------------------------------------------------------
  // Internal: shared text-search scaffolding
  // -----------------------------------------------------------------------

  /**
   * Build the WHERE clause, match/FTS expressions, semantic expression and the
   * bound parameter list shared by message and summary search. Everything that
   * differs between the two (SELECT columns, importance term, row mapping) stays
   * in the callers; only the param bookkeeping and mode switch live here.
   *
   * Parameter order: [optional agent], [optional since], [optional before],
   * query, [optional query-vector], limit.
   */
  private buildTextQuery(
    alias: 'm' | 's',
    query: string,
    mode: string,
    limit: number,
    options: SearchOptions | undefined,
    queryEmbedding: number[] | null | undefined,
    opts: { agentFilter: boolean; qualityFilter?: boolean },
  ): {
    whereClause: string
    ftsScoreExpr: string
    semanticExpr: string
    params: unknown[]
    limitIdx: number
  } {
    const conditions: string[] = []
    const params: unknown[] = []
    let pi = 1 // parameter index

    // Agent filter (messages only — summaries are cross-agent)
    if (opts.agentFilter && options?.agent) {
      conditions.push(`${alias}.agent = $${String(pi)}`)
      params.push(options.agent)
      pi++
    }

    // Date filters
    if (options?.since) {
      conditions.push(`${alias}.created_at >= $${String(pi)}`)
      params.push(options.since)
      pi++
    }
    if (options?.before) {
      conditions.push(`${alias}.created_at < $${String(pi)}`)
      params.push(options.before)
      pi++
    }

    // Content-quality floor (hybrid only): drop stub/empty rows that carry
    // no recall value. Tool rows are eligible when tool_result is substantive
    // (see MESSAGE_QUALITY_SQL). Skipped for explicit trigram/regex escape hatches.
    if (opts.qualityFilter) {
      conditions.push(
        alias === 'm'
          ? MESSAGE_QUALITY_SQL
          : `length(btrim(s.content)) >= ${String(MIN_CONTENT_LEN)}`,
      )
    }

    // Mode-specific match condition and FTS score
    const queryParamIdx = pi
    params.push(query)
    pi++
    const q = `$${String(queryParamIdx)}`

    let matchCondition: string
    let ftsScoreExpr: string
    switch (mode) {
      case 'fts':
        // content_tsv includes tool_result after migration 0008.
        matchCondition = `${alias}.content_tsv @@ plainto_tsquery('english', ${q})`
        // Norm flag 32 = rank/(rank+1): bounds long, repetitive tool payloads
        // (build logs full of the query term) so they don't outrank prose —
        // same precision class as #210; review on #440. Summaries stay default.
        ftsScoreExpr =
          alias === 'm'
            ? `ts_rank_cd(${alias}.content_tsv, plainto_tsquery('english', ${q}), 32)`
            : `ts_rank_cd(${alias}.content_tsv, plainto_tsquery('english', ${q}))`
        break
      case 'trigram':
        if (alias === 'm') {
          // Match content OR tool_result — tool payloads are the high-value text.
          matchCondition =
            `(similarity(m.content, ${q}) > 0.3` +
            ` OR similarity(coalesce(m.tool_result, ''), ${q}) > 0.3)`
          ftsScoreExpr =
            `GREATEST(similarity(m.content, ${q}),` +
            ` similarity(coalesce(m.tool_result, ''), ${q}))`
        } else {
          matchCondition = `similarity(s.content, ${q}) > 0.3`
          ftsScoreExpr = `similarity(s.content, ${q})`
        }
        break
      case 'regex':
        if (alias === 'm') {
          matchCondition = `(m.content ~* ${q} OR coalesce(m.tool_result, '') ~* ${q})`
        } else {
          matchCondition = `s.content ~* ${q}`
        }
        ftsScoreExpr = '1.0'
        break
      default:
        throw new Error(`Unknown search mode: ${mode}`)
    }
    conditions.push(matchCondition)

    // Semantic scoring: real cosine similarity when we have a query embedding,
    // otherwise fall back to length-based proxy. The vector is bound as a
    // parameter ($pi::halfvec), not interpolated.
    let semanticExpr: string
    if (mode === 'fts' && queryEmbedding) {
      params.push(toVectorLiteral(queryEmbedding))
      semanticExpr = `COALESCE(1 - (${alias}.embedding <=> $${String(pi)}::halfvec), ${SEMANTIC_PROXY(alias)})`
      pi++
    } else {
      semanticExpr = SEMANTIC_PROXY(alias)
    }

    // Limit param (always last)
    params.push(limit)
    const limitIdx = pi

    return { whereClause: conditions.join(' AND '), ftsScoreExpr, semanticExpr, params, limitIdx }
  }

  // -----------------------------------------------------------------------
  // Internal: message search
  // -----------------------------------------------------------------------

  private async searchMessages(
    query: string,
    mode: string,
    limit: number,
    options?: SearchOptions,
    queryEmbedding?: number[] | null,
  ): Promise<SearchHit[]> {
    const { whereClause, ftsScoreExpr, semanticExpr, params, limitIdx } = this.buildTextQuery(
      'm',
      query,
      mode,
      limit,
      options,
      queryEmbedding,
      { agentFilter: true },
    )

    const temporal = temporalDecaySql('m')
    const importance = importanceSql('m')

    const sql = `
      SELECT m.id, m.content, m.role, m.agent, m.metadata, m.conversation_id, m.created_at,
             m.tool_name, m.tool_result,
             (
               ${ftsScoreExpr} * ${W_FTS}
               + ${semanticExpr} * ${W_SEMANTIC}
               + (${temporal}) * ${W_TEMPORAL}
               + (${importance}) * ${W_IMPORTANCE}
             ) AS score
      FROM ros_messages m
      WHERE ${whereClause}
      ORDER BY score DESC
      LIMIT $${String(limitIdx)}
    `

    const result = await this.pool.query<MessageSearchRow>(sql, params)

    return result.rows.map((r) => ({
      id: r.id,
      type: 'message' as const,
      content: r.content,
      role: r.role,
      agent: r.agent,
      conversationId: r.conversation_id,
      score: parseFloat(r.score),
      createdAt: r.created_at,
      toolName: r.tool_name ?? null,
      toolResult: r.tool_result ?? null,
      ...(r.metadata?.truncated === true
        ? {
            truncated: true,
            fullLength: [r.metadata.full_content_length, r.metadata.full_tool_result_length].find(
              (v): v is number => typeof v === 'number',
            ),
          }
        : {}),
    }))
  }

  // -----------------------------------------------------------------------
  // Internal: summary search
  // -----------------------------------------------------------------------

  private async searchSummaries(
    query: string,
    mode: string,
    limit: number,
    options?: SearchOptions,
    queryEmbedding?: number[] | null,
  ): Promise<SearchHit[]> {
    const { whereClause, ftsScoreExpr, semanticExpr, params, limitIdx } = this.buildTextQuery(
      's',
      query,
      mode,
      limit,
      options,
      queryEmbedding,
      { agentFilter: false },
    )

    const temporal = temporalDecaySql('s')

    const sql = `
      SELECT s.id, s.content, s.kind AS role, 'summary' AS agent,
             s.conversation_id, s.created_at,
             s.kind, s.earliest_at, s.latest_at,
             (
               ${ftsScoreExpr} * ${W_FTS}
               + ${semanticExpr} * ${W_SEMANTIC}
               + (${temporal}) * ${W_TEMPORAL}
               + ${SUMMARY_IMPORTANCE} * ${W_IMPORTANCE}
             ) AS score
      FROM ros_summaries s
      WHERE ${whereClause}
      ORDER BY score DESC
      LIMIT $${String(limitIdx)}
    `

    const result = await this.pool.query<SummarySearchRow>(sql, params)

    return result.rows.map((r) => ({
      id: r.id,
      type: 'summary' as const,
      content: r.content,
      role: r.role,
      agent: r.agent,
      conversationId: r.conversation_id,
      score: parseFloat(r.score),
      createdAt: r.created_at,
      kind: r.kind,
      earliestAt: r.earliest_at ?? undefined,
      latestAt: r.latest_at ?? undefined,
    }))
  }

  // -----------------------------------------------------------------------
  // Access tracking: increment counters for returned search results
  // -----------------------------------------------------------------------

  private async bumpAccess(results: SearchHit[]): Promise<void> {
    const msgIds = results.filter((r) => r.type === 'message').map((r) => r.id)
    const sumIds = results.filter((r) => r.type === 'summary').map((r) => r.id)

    if (msgIds.length > 0) {
      await this.pool.query(
        `UPDATE ros_messages
         SET access_count = access_count + 1, last_accessed_at = NOW()
         WHERE id = ANY($1::uuid[])`,
        [msgIds],
      )
    }

    if (sumIds.length > 0) {
      await this.pool.query(
        `UPDATE ros_summaries
         SET access_count = access_count + 1, last_accessed_at = NOW()
         WHERE id = ANY($1::uuid[])`,
        [sumIds],
      )
    }
  }
}
