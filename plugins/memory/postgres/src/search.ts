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

export interface SearchHit {
  id: string
  type: 'message' | 'summary'
  content: string
  role: string
  agent: string
  conversationId: string
  score: number
  createdAt: Date
  // Summary-specific fields
  kind?: string
  earliestAt?: Date
  latestAt?: Date
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
  /** Model name for embedding (default: 'nemotron') */
  embedModel?: string
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

/** Query embedding timeout — single text, should be fast */
const EMBED_TIMEOUT_MS = 5_000

/**
 * Candidate pool depth retrieved per method before fusion. Deeper pools let a
 * doc that one method ranks mediocre — but another ranks highly — still surface
 * (the whole point of fusion). Bounded so the three parallel queries stay cheap.
 */
const HYBRID_POOL_MIN = 50
const HYBRID_POOL_MAX = 100

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

  constructor(pool: pg.Pool, config?: SearchEngineConfig) {
    this.pool = pool
    this.embedEndpoint = config?.embedEndpoint ?? null
    this.embedModel = config?.embedModel ?? 'nemotron'
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
  async search(query: string, options?: SearchOptions): Promise<SearchHit[]> {
    const mode = options?.mode ?? 'hybrid'
    const scope = options?.scope ?? 'both'
    const limit = options?.limit ?? 20

    if (mode === 'hybrid') {
      return this.hybridSearch(query, scope, limit, options)
    }

    if (mode === 'vector') {
      const qvec = await this.embedQuery(query)
      // No embedding available (endpoint down / not configured) — degrade to FTS
      // rather than returning nothing.
      if (!qvec) return this.singleTextSearch('fts', query, scope, limit, options)
      const hits = await this.vectorSearch(qvec, { scope, limit, agent: options?.agent })
      void this.bumpAccess(hits)
      return hits
    }

    // Explicit single text mode: fts / trigram / regex.
    return this.singleTextSearch(mode, query, scope, limit, options)
  }

  /**
   * Single-method text search (fts / trigram / regex) with the original
   * composite scoring. Preserved as the explicit escape hatch.
   */
  private async singleTextSearch(
    mode: string,
    query: string,
    scope: 'messages' | 'summaries' | 'both',
    limit: number,
    options?: SearchOptions,
  ): Promise<SearchHit[]> {
    const results: SearchHit[] = []

    // Embed query once for FTS hybrid scoring (semantic rerank term).
    let queryEmbedding: number[] | null = null
    if (mode === 'fts' && this.embedEndpoint) {
      queryEmbedding = await this.embedQuery(query)
    }

    if (scope === 'messages' || scope === 'both') {
      results.push(...(await this.searchMessages(query, mode, limit, options, queryEmbedding)))
    }
    if (scope === 'summaries' || scope === 'both') {
      results.push(...(await this.searchSummaries(query, mode, limit, options, queryEmbedding)))
    }

    results.sort((a, b) => b.score - a.score)
    const topResults = results.slice(0, limit)
    void this.bumpAccess(topResults)
    return topResults
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
  ): Promise<SearchHit[]> {
    const pool = Math.min(HYBRID_POOL_MAX, Math.max(HYBRID_POOL_MIN, limit * 3))

    // Embed once for the vector arm; null (no endpoint / failure) drops that arm.
    const qvec = this.embedEndpoint ? await this.embedQuery(query) : null

    const [ftsList, trigramList, vectorList] = await Promise.all([
      this.retrieveTextCandidates('fts', query, scope, pool, options),
      this.retrieveTextCandidates('trigram', query, scope, pool, options),
      qvec
        ? this.retrieveVectorCandidates(qvec, scope, pool, options)
        : Promise.resolve([] as Candidate[]),
    ])

    const fused = this.rrfFuse([ftsList, trigramList, vectorList])
    const topResults = fused.slice(0, limit)
    void this.bumpAccess(topResults)
    return topResults
  }

  /**
   * Fuse ranked candidate lists with Reciprocal Rank Fusion, then scale each
   * doc's fused score by its recency/importance boost. Dedupes by type+id;
   * a doc found by multiple methods accumulates contributions from each.
   */
  private rrfFuse(lists: Candidate[][]): SearchHit[] {
    const fusedMap = reciprocalRankFusion(lists, (hit) => `${hit.type}:${hit.id}`)
    const fused: SearchHit[] = []
    for (const { item, rrf } of fusedMap.values()) {
      const { boost, ...rest } = item
      // RRF orders by relevance; boost (≤ ~0.55) lets recency/importance nudge
      // adjacent ranks without overriding a strong cross-method match.
      fused.push({ ...rest, score: rrf * (1 + boost) })
    }
    fused.sort((a, b) => b.score - a.score)
    return fused
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
        { agentFilter: true },
      )
      const boostExpr = `((${temporalDecaySql('m')}) * ${W_TEMPORAL} + (${importanceSql('m')}) * ${W_IMPORTANCE})`
      const sql = `
        SELECT m.id, m.content, m.role, m.agent, m.conversation_id, m.created_at,
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
        { agentFilter: false },
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
    const out: Candidate[] = []

    if (scope === 'messages' || scope === 'both') {
      const params: unknown[] = [vecLiteral]
      const conds = ['m.embedding IS NOT NULL']
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
        SELECT m.id, m.content, m.role, m.agent, m.conversation_id, m.created_at,
               ${boostExpr} AS boost
        FROM ros_messages m
        WHERE ${conds.join(' AND ')}
        ORDER BY m.embedding <=> $1::halfvec
        LIMIT $${String(params.length)}
      `
      const res = await this.pool.query<CandidateRow>(sql, params)
      out.push(...res.rows.map((r) => this.mapCandidate(r, 'message')))
    }

    if (scope === 'summaries' || scope === 'both') {
      const params: unknown[] = [vecLiteral]
      const conds = ['s.embedding IS NOT NULL'] // summaries are cross-agent
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
      const res = await this.pool.query<CandidateRow>(sql, params)
      out.push(...res.rows.map((r) => this.mapCandidate(r, 'summary')))
    }

    return out
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
    const results: SearchHit[] = []

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
        SELECT m.id, m.content, m.role, m.agent,
               m.conversation_id, m.created_at,
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

      const res = await this.pool.query<MessageSearchRow>(sql, params)
      results.push(
        ...res.rows.map((r) => ({
          id: r.id,
          type: 'message' as const,
          content: r.content,
          role: r.role,
          agent: r.agent,
          conversationId: r.conversation_id,
          score: parseFloat(r.score),
          createdAt: r.created_at,
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

      const res = await this.pool.query<SummarySearchRow>(sql, [vecLiteral, limit])
      results.push(
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
   * Returns null on any failure (timeout, network, bad response).
   * Caller should fall back to the length-based semantic proxy.
   */
  private async embedQuery(text: string): Promise<number[] | null> {
    if (!this.embedEndpoint) return null

    try {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), EMBED_TIMEOUT_MS)

      const response = await fetch(`${this.embedEndpoint}/v1/embeddings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          input: [text.slice(0, 8000)],
          model: this.embedModel,
        }),
        signal: controller.signal,
      })

      clearTimeout(timeout)

      if (!response.ok) {
        console.warn(`[SearchEngine] Query embedding failed: HTTP ${String(response.status)}`)
        return null
      }

      const data = (await response.json()) as EmbedResponse
      const vec = data.data?.[0]?.embedding
      if (!vec || !Array.isArray(vec) || vec.length === 0) {
        console.warn('[SearchEngine] Query embedding returned empty/invalid vector')
        return null
      }

      // Truncate to pgvector halfvec max (4000 dims). Nemotron returns 4096
      // natively; stored rows are sliced to 4000 by the embedding worker.
      // Must match to avoid "different halfvec dimensions" errors on <=>.
      const EMBED_DIMS = 4000
      return vec.length > EMBED_DIMS ? vec.slice(0, EMBED_DIMS) : vec
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      // Don't log abort as an error — it's expected on timeout
      if (msg.includes('abort')) {
        console.warn('[SearchEngine] Query embedding timed out (5s)')
      } else {
        console.warn(`[SearchEngine] Query embedding failed: ${msg}`)
      }
      return null
    }
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
    opts: { agentFilter: boolean },
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

    // Mode-specific match condition and FTS score
    const queryParamIdx = pi
    params.push(query)
    pi++

    let matchCondition: string
    let ftsScoreExpr: string
    switch (mode) {
      case 'fts':
        matchCondition = `${alias}.content_tsv @@ plainto_tsquery('english', $${String(queryParamIdx)})`
        ftsScoreExpr = `ts_rank_cd(${alias}.content_tsv, plainto_tsquery('english', $${String(queryParamIdx)}))`
        break
      case 'trigram':
        matchCondition = `similarity(${alias}.content, $${String(queryParamIdx)}) > 0.3`
        ftsScoreExpr = `similarity(${alias}.content, $${String(queryParamIdx)})`
        break
      case 'regex':
        matchCondition = `${alias}.content ~* $${String(queryParamIdx)}`
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
      SELECT m.id, m.content, m.role, m.agent, m.conversation_id, m.created_at,
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
