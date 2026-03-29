/**
 * SearchEngine — hybrid FTS + semantic + temporal + importance scoring.
 *
 * Supports four search modes:
 *   fts     — PostgreSQL full-text search (ts_rank_cd)
 *   vector  — cosine similarity via pgvector (requires pre-computed embedding)
 *   trigram — fuzzy matching via pg_trgm
 *   regex   — PostgreSQL regex (~*)
 *
 * Scoring uses the formulas from scoring.ts, expressed as SQL for
 * database-side evaluation. Access counts are bumped for returned results.
 */

import pg from 'pg';
import {
  W_FTS,
  W_SEMANTIC,
  W_TEMPORAL,
  W_IMPORTANCE,
  SUMMARY_IMPORTANCE,
  temporalDecaySql,
  importanceSql,
} from './scoring.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SearchOptions {
  mode?: 'fts' | 'vector' | 'regex' | 'trigram';
  scope?: 'messages' | 'summaries' | 'both';
  limit?: number;
  agent?: string;
  since?: string;  // ISO timestamp
  before?: string; // ISO timestamp
}

export interface SearchHit {
  id: string;
  type: 'message' | 'summary';
  content: string;
  role: string;
  agent: string;
  conversationId: string;
  score: number;
  createdAt: Date;
  // Summary-specific fields
  kind?: string;
  earliestAt?: Date;
  latestAt?: Date;
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

export class SearchEngine {
  private pool: pg.Pool;

  constructor(pool: pg.Pool) {
    this.pool = pool;
  }

  /**
   * Search messages and/or summaries with hybrid scoring.
   *
   * Results are scored, sorted by relevance, and the top N returned.
   * Access counts are incremented for returned results.
   */
  async search(query: string, options?: SearchOptions): Promise<SearchHit[]> {
    const mode = options?.mode ?? 'fts';
    const scope = options?.scope ?? 'both';
    const limit = options?.limit ?? 20;
    const results: SearchHit[] = [];

    if (scope === 'messages' || scope === 'both') {
      const hits = await this.searchMessages(query, mode, limit, options);
      results.push(...hits);
    }

    if (scope === 'summaries' || scope === 'both') {
      const hits = await this.searchSummaries(query, mode, limit, options);
      results.push(...hits);
    }

    // Sort by composite score, take top N
    results.sort((a, b) => b.score - a.score);
    const topResults = results.slice(0, limit);

    // Bump access counts (non-blocking, fire-and-forget)
    this.bumpAccess(topResults).catch(() => {});

    return topResults;
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
    const scope = options?.scope ?? 'both';
    const limit = options?.limit ?? 10;
    const vecLiteral = `[${embedding.join(',')}]`;
    const results: SearchHit[] = [];

    if (scope === 'messages' || scope === 'both') {
      const agentFilter = options?.agent ? `AND m.agent = ${this.literal(options.agent)}` : '';
      const temporal = temporalDecaySql('m');
      const importance = importanceSql('m');

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
      `;

      const res = await this.pool.query(sql, [limit]);
      results.push(
        ...res.rows.map((r: any) => ({
          id: String(r.id),
          type: 'message' as const,
          content: r.content,
          role: r.role,
          agent: r.agent,
          conversationId: r.conversation_id,
          score: parseFloat(r.score),
          createdAt: r.created_at,
        })),
      );
    }

    if (scope === 'summaries' || scope === 'both') {
      const temporal = temporalDecaySql('s');

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
      `;

      const res = await this.pool.query(sql, [limit]);
      results.push(
        ...res.rows.map((r: any) => ({
          id: String(r.id),
          type: 'summary' as const,
          content: r.content,
          role: r.role,
          agent: r.agent,
          conversationId: r.conversation_id,
          score: parseFloat(r.score),
          createdAt: r.created_at,
          kind: r.kind,
          earliestAt: r.earliest_at,
          latestAt: r.latest_at,
        })),
      );
    }

    results.sort((a, b) => b.score - a.score);
    const topResults = results.slice(0, limit);
    this.bumpAccess(topResults).catch(() => {});
    return topResults;
  }

  // -----------------------------------------------------------------------
  // Internal: message search
  // -----------------------------------------------------------------------

  private async searchMessages(
    query: string,
    mode: string,
    limit: number,
    options?: SearchOptions,
  ): Promise<SearchHit[]> {
    const conditions: string[] = [];
    const params: any[] = [];
    let pi = 1; // parameter index

    // Agent filter
    if (options?.agent) {
      conditions.push(`m.agent = $${pi}`);
      params.push(options.agent);
      pi++;
    }

    // Date filters
    if (options?.since) {
      conditions.push(`m.created_at >= $${pi}`);
      params.push(options.since);
      pi++;
    }
    if (options?.before) {
      conditions.push(`m.created_at < $${pi}`);
      params.push(options.before);
      pi++;
    }

    // Mode-specific match condition and FTS score
    const queryParamIdx = pi;
    params.push(query);
    pi++;

    let matchCondition: string;
    let ftsScoreExpr: string;

    switch (mode) {
      case 'fts':
        matchCondition = `m.content_tsv @@ plainto_tsquery('english', $${queryParamIdx})`;
        ftsScoreExpr = `ts_rank_cd(m.content_tsv, plainto_tsquery('english', $${queryParamIdx}))`;
        break;
      case 'trigram':
        matchCondition = `similarity(m.content, $${queryParamIdx}) > 0.3`;
        ftsScoreExpr = `similarity(m.content, $${queryParamIdx})`;
        break;
      case 'regex':
        matchCondition = `m.content ~* $${queryParamIdx}`;
        ftsScoreExpr = '1.0';
        break;
      default:
        throw new Error(`Unknown search mode: ${mode}`);
    }

    conditions.push(matchCondition);

    // Limit param
    params.push(limit);
    const limitIdx = pi;
    pi++;

    const temporal = temporalDecaySql('m');
    const importance = importanceSql('m');

    // Composite score: FTS (0.3) + semantic proxy (0.3) + temporal (0.3) + importance (0.1)
    // For text-only searches, we use length as a semantic proxy (longer = more context)
    const semanticProxy = `LEAST(LENGTH(m.content) / 1000.0, 1.0)`;

    const sql = `
      SELECT m.id, m.content, m.role, m.agent, m.conversation_id, m.created_at,
             (
               ${ftsScoreExpr} * ${W_FTS}
               + ${semanticProxy} * ${W_SEMANTIC}
               + (${temporal}) * ${W_TEMPORAL}
               + (${importance}) * ${W_IMPORTANCE}
             ) AS score
      FROM ros_messages m
      WHERE ${conditions.join(' AND ')}
      ORDER BY score DESC
      LIMIT $${limitIdx}
    `;

    const result = await this.pool.query(sql, params);

    return result.rows.map((r: any) => ({
      id: String(r.id),
      type: 'message' as const,
      content: r.content,
      role: r.role,
      agent: r.agent,
      conversationId: r.conversation_id,
      score: parseFloat(r.score),
      createdAt: r.created_at,
    }));
  }

  // -----------------------------------------------------------------------
  // Internal: summary search
  // -----------------------------------------------------------------------

  private async searchSummaries(
    query: string,
    mode: string,
    limit: number,
    options?: SearchOptions,
  ): Promise<SearchHit[]> {
    const conditions: string[] = [];
    const params: any[] = [];
    let pi = 1;

    // Date filters (agent filter doesn't apply to summaries — they're cross-agent)
    if (options?.since) {
      conditions.push(`s.created_at >= $${pi}`);
      params.push(options.since);
      pi++;
    }
    if (options?.before) {
      conditions.push(`s.created_at < $${pi}`);
      params.push(options.before);
      pi++;
    }

    const queryParamIdx = pi;
    params.push(query);
    pi++;

    let matchCondition: string;
    let ftsScoreExpr: string;

    switch (mode) {
      case 'fts':
        matchCondition = `s.content_tsv @@ plainto_tsquery('english', $${queryParamIdx})`;
        ftsScoreExpr = `ts_rank_cd(s.content_tsv, plainto_tsquery('english', $${queryParamIdx}))`;
        break;
      case 'trigram':
        matchCondition = `similarity(s.content, $${queryParamIdx}) > 0.3`;
        ftsScoreExpr = `similarity(s.content, $${queryParamIdx})`;
        break;
      case 'regex':
        matchCondition = `s.content ~* $${queryParamIdx}`;
        ftsScoreExpr = '1.0';
        break;
      default:
        throw new Error(`Unknown search mode: ${mode}`);
    }

    conditions.push(matchCondition);

    params.push(limit);
    const limitIdx = pi;
    pi++;

    const temporal = temporalDecaySql('s');
    const semanticProxy = `LEAST(LENGTH(s.content) / 1000.0, 1.0)`;

    const sql = `
      SELECT s.id, s.content, s.kind AS role, 'summary' AS agent,
             s.conversation_id, s.created_at,
             s.kind, s.earliest_at, s.latest_at,
             (
               ${ftsScoreExpr} * ${W_FTS}
               + ${semanticProxy} * ${W_SEMANTIC}
               + (${temporal}) * ${W_TEMPORAL}
               + ${SUMMARY_IMPORTANCE} * ${W_IMPORTANCE}
             ) AS score
      FROM ros_summaries s
      WHERE ${conditions.join(' AND ')}
      ORDER BY score DESC
      LIMIT $${limitIdx}
    `;

    const result = await this.pool.query(sql, params);

    return result.rows.map((r: any) => ({
      id: String(r.id),
      type: 'summary' as const,
      content: r.content,
      role: r.role,
      agent: r.agent,
      conversationId: r.conversation_id,
      score: parseFloat(r.score),
      createdAt: r.created_at,
      kind: r.kind,
      earliestAt: r.earliest_at,
      latestAt: r.latest_at,
    }));
  }

  // -----------------------------------------------------------------------
  // Access tracking: increment counters for returned search results
  // -----------------------------------------------------------------------

  private async bumpAccess(results: SearchHit[]): Promise<void> {
    const msgIds = results.filter((r) => r.type === 'message').map((r) => r.id);
    const sumIds = results.filter((r) => r.type === 'summary').map((r) => r.id);

    if (msgIds.length > 0) {
      await this.pool.query(
        `UPDATE ros_messages
         SET access_count = access_count + 1, last_accessed_at = NOW()
         WHERE id = ANY($1::uuid[])`,
        [msgIds],
      );
    }

    if (sumIds.length > 0) {
      await this.pool.query(
        `UPDATE ros_summaries
         SET access_count = access_count + 1, last_accessed_at = NOW()
         WHERE id = ANY($1::uuid[])`,
        [sumIds],
      );
    }
  }

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  /** Escape a string literal for SQL injection-safe inclusion in template strings */
  private literal(value: string): string {
    return `'${value.replace(/'/g, "''")}'`;
  }
}
