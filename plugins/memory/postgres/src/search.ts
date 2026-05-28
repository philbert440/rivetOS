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
} from './scoring.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SearchOptions {
  mode?: 'fts' | 'vector' | 'regex' | 'trigram'
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
   * Search messages and/or summaries with hybrid scoring.
   *
   * For FTS mode: embeds the query once and passes to both message and
   * summary search for real cosine similarity scoring. Falls back to
   * length-based proxy if embedding fails.
   *
   * Results are scored, sorted by relevance, and the top N returned.
   * Access counts are incremented for returned results.
   */
  async search(query: string, options?: SearchOptions): Promise<SearchHit[]> {
    const mode = options?.mode ?? 'fts'
    const scope = options?.scope ?? 'both'
    const limit = options?.limit ?? 20
    const results: SearchHit[] = []

    // Embed query once for FTS hybrid scoring
    let queryEmbedding: number[] | null = null
    if (mode === 'fts' && this.embedEndpoint) {
      queryEmbedding = await this.embedQuery(query)
    }

    if (scope === 'messages' || scope === 'both') {
      const hits = await this.searchMessages(query, mode, limit, options, queryEmbedding)
      results.push(...hits)
    }

    if (scope === 'summaries' || scope === 'both') {
      const hits = await this.searchSummaries(query, mode, limit, options, queryEmbedding)
      results.push(...hits)
    }

    // Sort by composite score, take top N
    results.sort((a, b) => b.score - a.score)
    const topResults = results.slice(0, limit)

    // Bump access counts (non-blocking, fire-and-forget)
    void this.bumpAccess(topResults)

    return topResults
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
