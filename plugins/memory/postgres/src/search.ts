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
  /** Embedding service URL for query-time embedding (e.g., http://10.4.20.12:9401) */
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
const SEMANTIC_PROXY = (alias: string): string =>
  `LEAST(LENGTH(${alias}.content) / 1000.0, 1.0)`

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
    const vecLiteral = `[${embedding.join(',')}]`
    const results: SearchHit[] = []

    if (scope === 'messages' || scope === 'both') {
      const agentFilter = options?.agent ? `AND m.agent = ${this.literal(options.agent)}` : ''
      const temporal = temporalDecaySql('m')
      const importance = importanceSql('m')

      const sql = `
        SELECT m.id, m.content, m.role, m.agent,
               m.conversation_id, m.created_at,
               (1 - (m.embedding <=> '${vecLiteral}'::halfvec)) AS semantic_sim,
               (
                 (1 - (m.embedding <=> '${vecLiteral}'::halfvec)) * ${W_SEMANTIC}
                 + (${temporal}) * ${W_TEMPORAL}
                 + (${importance}) * ${W_IMPORTANCE}
               ) AS score
        FROM ros_messages m
        WHERE m.embedding IS NOT NULL ${agentFilter}
        ORDER BY m.embedding <=> '${vecLiteral}'::halfvec
        LIMIT $1
      `

      const res = await this.pool.query<MessageSearchRow>(sql, [limit])
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
               (1 - (s.embedding <=> '${vecLiteral}'::halfvec)) AS semantic_sim,
               (
                 (1 - (s.embedding <=> '${vecLiteral}'::halfvec)) * ${W_SEMANTIC}
                 + (${temporal}) * ${W_TEMPORAL}
                 + ${SUMMARY_IMPORTANCE} * ${W_IMPORTANCE}
               ) AS score
        FROM ros_summaries s
        WHERE s.embedding IS NOT NULL
        ORDER BY s.embedding <=> '${vecLiteral}'::halfvec
        LIMIT $1
      `

      const res = await this.pool.query<SummarySearchRow>(sql, [limit])
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

      return vec
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
  // Internal: message search
  // -----------------------------------------------------------------------

  private async searchMessages(
    query: string,
    mode: string,
    limit: number,
    options?: SearchOptions,
    queryEmbedding?: number[] | null,
  ): Promise<SearchHit[]> {
    const conditions: string[] = []
    const params: unknown[] = []
    let pi = 1 // parameter index

    // Agent filter
    if (options?.agent) {
      conditions.push(`m.agent = $${String(pi)}`)
      params.push(options.agent)
      pi++
    }

    // Date filters
    if (options?.since) {
      conditions.push(`m.created_at >= $${String(pi)}`)
      params.push(options.since)
      pi++
    }
    if (options?.before) {
      conditions.push(`m.created_at < $${String(pi)}`)
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
        matchCondition = `m.content_tsv @@ plainto_tsquery('english', $${String(queryParamIdx)})`
        ftsScoreExpr = `ts_rank_cd(m.content_tsv, plainto_tsquery('english', $${String(queryParamIdx)}))`
        break
      case 'trigram':
        matchCondition = `similarity(m.content, $${String(queryParamIdx)}) > 0.3`
        ftsScoreExpr = `similarity(m.content, $${String(queryParamIdx)})`
        break
      case 'regex':
        matchCondition = `m.content ~* $${String(queryParamIdx)}`
        ftsScoreExpr = '1.0'
        break
      default:
        throw new Error(`Unknown search mode: ${mode}`)
    }

    conditions.push(matchCondition)

    // Limit param
    params.push(limit)
    const limitIdx = pi

    const temporal = temporalDecaySql('m')
    const importance = importanceSql('m')

    // Semantic scoring: real cosine similarity when we have a query embedding,
    // otherwise fall back to length-based proxy
    let semanticExpr: string
    if (mode === 'fts' && queryEmbedding) {
      const vecLiteral = `[${queryEmbedding.join(',')}]`
      // COALESCE: use real cosine sim when row has embedding, fall back to length proxy
      semanticExpr = `COALESCE(1 - (m.embedding <=> '${vecLiteral}'::halfvec), ${SEMANTIC_PROXY('m')})`
    } else {
      semanticExpr = SEMANTIC_PROXY('m')
    }

    const sql = `
      SELECT m.id, m.content, m.role, m.agent, m.conversation_id, m.created_at,
             (
               ${ftsScoreExpr} * ${W_FTS}
               + ${semanticExpr} * ${W_SEMANTIC}
               + (${temporal}) * ${W_TEMPORAL}
               + (${importance}) * ${W_IMPORTANCE}
             ) AS score
      FROM ros_messages m
      WHERE ${conditions.join(' AND ')}
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
    const conditions: string[] = []
    const params: unknown[] = []
    let pi = 1

    // Date filters (agent filter doesn't apply to summaries — they're cross-agent)
    if (options?.since) {
      conditions.push(`s.created_at >= $${String(pi)}`)
      params.push(options.since)
      pi++
    }
    if (options?.before) {
      conditions.push(`s.created_at < $${String(pi)}`)
      params.push(options.before)
      pi++
    }

    const queryParamIdx = pi
    params.push(query)
    pi++

    let matchCondition: string
    let ftsScoreExpr: string

    switch (mode) {
      case 'fts':
        matchCondition = `s.content_tsv @@ plainto_tsquery('english', $${String(queryParamIdx)})`
        ftsScoreExpr = `ts_rank_cd(s.content_tsv, plainto_tsquery('english', $${String(queryParamIdx)}))`
        break
      case 'trigram':
        matchCondition = `similarity(s.content, $${String(queryParamIdx)}) > 0.3`
        ftsScoreExpr = `similarity(s.content, $${String(queryParamIdx)})`
        break
      case 'regex':
        matchCondition = `s.content ~* $${String(queryParamIdx)}`
        ftsScoreExpr = '1.0'
        break
      default:
        throw new Error(`Unknown search mode: ${mode}`)
    }

    conditions.push(matchCondition)

    params.push(limit)
    const limitIdx = pi

    const temporal = temporalDecaySql('s')

    // Semantic scoring: real cosine similarity when we have a query embedding
    let semanticExpr: string
    if (mode === 'fts' && queryEmbedding) {
      const vecLiteral = `[${queryEmbedding.join(',')}]`
      semanticExpr = `COALESCE(1 - (s.embedding <=> '${vecLiteral}'::halfvec), ${SEMANTIC_PROXY('s')})`
    } else {
      semanticExpr = SEMANTIC_PROXY('s')
    }

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
      WHERE ${conditions.join(' AND ')}
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

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  /** Escape a string literal for SQL injection-safe inclusion in template strings */
  private literal(value: string): string {
    return `'${value.replace(/'/g, "''")}'`
  }
}
