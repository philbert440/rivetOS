/**
 * LCM Search Engine — FTS, vector, and regex search across messages + summaries.
 *
 * Replicates lcm_grep functionality.
 */

import pg from 'pg';

export interface SearchOptions {
  mode?: 'fts' | 'vector' | 'regex' | 'trigram';
  scope?: 'messages' | 'summaries' | 'both';
  limit?: number;
  agent?: string;
  since?: string;    // ISO date
  before?: string;   // ISO date
}

export interface SearchHit {
  id: string;
  type: 'message' | 'summary';
  content: string;
  role: string;
  agent: string;
  conversationId: number;
  similarity: number;
  createdAt: Date;
  // Summary-specific
  summaryId?: string;
  kind?: string;
  earliestAt?: Date;
  latestAt?: Date;
}

export class LcmSearchEngine {
  private pool: pg.Pool;

  constructor(pool: pg.Pool) {
    this.pool = pool;
  }

  /**
   * Search across messages and/or summaries.
   */
  async search(query: string, options?: SearchOptions): Promise<SearchHit[]> {
    const mode = options?.mode ?? 'fts';
    const scope = options?.scope ?? 'both';
    const limit = options?.limit ?? 20;
    const results: SearchHit[] = [];

    if (scope === 'messages' || scope === 'both') {
      const hits = await this.searchTable('messages', query, mode, limit, options);
      results.push(...hits);
    }

    if (scope === 'summaries' || scope === 'both') {
      const hits = await this.searchTable('summaries', query, mode, limit, options);
      results.push(...hits);
    }

    results.sort((a, b) => b.similarity - a.similarity);
    return results.slice(0, limit);
  }

  private async searchTable(
    table: 'messages' | 'summaries',
    query: string,
    mode: string,
    limit: number,
    options?: SearchOptions,
  ): Promise<SearchHit[]> {
    const isMessages = table === 'messages';
    const idCol = isMessages ? 'm.message_id' : 's.summary_id';
    const contentCol = isMessages ? 'm.content' : 's.content';
    const tsvCol = isMessages ? 'm.content_tsv' : 's.content_tsv';
    const alias = isMessages ? 'm' : 's';
    const joinClause = isMessages
      ? 'JOIN conversations c ON c.conversation_id = m.conversation_id'
      : 'JOIN conversations c ON c.conversation_id = s.conversation_id';

    // Build WHERE conditions
    const conditions: string[] = [];
    const params: any[] = [];
    let paramIdx = 1;

    // Agent filter
    if (options?.agent) {
      conditions.push(`c.agent_id = $${paramIdx}`);
      params.push(options.agent);
      paramIdx++;
    }

    // Date filters
    if (options?.since) {
      conditions.push(`${alias}.created_at >= $${paramIdx}`);
      params.push(options.since);
      paramIdx++;
    }
    if (options?.before) {
      conditions.push(`${alias}.created_at < $${paramIdx}`);
      params.push(options.before);
      paramIdx++;
    }

    let scoreExpr: string;
    let matchCondition: string;

    switch (mode) {
      case 'fts':
        params.push(query);
        matchCondition = `${tsvCol} @@ plainto_tsquery('english', $${paramIdx})`;
        scoreExpr = `ts_rank_cd(${tsvCol}, plainto_tsquery('english', $${paramIdx}))`;
        paramIdx++;
        break;

      case 'trigram':
        params.push(query);
        matchCondition = `similarity(${contentCol}, $${paramIdx}) > 0.3`;
        scoreExpr = `similarity(${contentCol}, $${paramIdx})`;
        paramIdx++;
        break;

      case 'regex':
        params.push(query);
        matchCondition = `${contentCol} ~* $${paramIdx}`;
        scoreExpr = '1.0'; // Regex doesn't have a score
        paramIdx++;
        break;

      case 'vector':
        // Vector search requires an embedding — caller must provide it
        // For now, fall back to FTS
        params.push(query);
        matchCondition = `${tsvCol} @@ plainto_tsquery('english', $${paramIdx})`;
        scoreExpr = `ts_rank_cd(${tsvCol}, plainto_tsquery('english', $${paramIdx}))`;
        paramIdx++;
        break;

      default:
        throw new Error(`Unknown search mode: ${mode}`);
    }

    conditions.push(matchCondition);
    params.push(limit);

    const roleCol = isMessages ? `${alias}.role` : `${alias}.kind`;
    const extraCols = isMessages
      ? ''
      : `, ${alias}.summary_id, ${alias}.kind, ${alias}.earliest_at, ${alias}.latest_at`;

    const sql = `
      SELECT ${idCol} as id, ${contentCol} as content, ${roleCol} as role,
             c.agent_id as agent, c.conversation_id, ${alias}.created_at,
             ${scoreExpr} as similarity${extraCols}
      FROM ${table} ${alias}
      ${joinClause}
      WHERE ${conditions.join(' AND ')}
      ORDER BY similarity DESC
      LIMIT $${paramIdx}
    `;

    const result = await this.pool.query(sql, params);

    return result.rows.map((r) => ({
      id: String(r.id),
      type: isMessages ? 'message' : 'summary',
      content: r.content,
      role: r.role,
      agent: r.agent,
      conversationId: r.conversation_id,
      similarity: parseFloat(r.similarity),
      createdAt: r.created_at,
      ...(isMessages ? {} : {
        summaryId: r.summary_id,
        kind: r.kind,
        earliestAt: r.earliest_at,
        latestAt: r.latest_at,
      }),
    }));
  }

  /**
   * Vector search with a pre-computed embedding.
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
      const agentClause = options?.agent ? `AND c.agent_id = '${options.agent}'` : '';
      const sql = `
        SELECT m.message_id as id, m.content, m.role, c.agent_id as agent,
               c.conversation_id, m.created_at,
               1 - (m.embedding <=> '${vecLiteral}'::vector) as similarity
        FROM messages m
        JOIN conversations c ON c.conversation_id = m.conversation_id
        WHERE m.embedding IS NOT NULL ${agentClause}
        ORDER BY m.embedding <=> '${vecLiteral}'::vector
        LIMIT $1
      `;
      const res = await this.pool.query(sql, [limit]);
      results.push(...res.rows.map((r: any) => ({
        id: String(r.id),
        type: 'message' as const,
        content: r.content,
        role: r.role,
        agent: r.agent,
        conversationId: r.conversation_id,
        similarity: parseFloat(r.similarity),
        createdAt: r.created_at,
      })));
    }

    if (scope === 'summaries' || scope === 'both') {
      const sql = `
        SELECT s.summary_id as id, s.content, s.kind as role, c.agent_id as agent,
               c.conversation_id, s.created_at, s.summary_id, s.kind,
               s.earliest_at, s.latest_at,
               1 - (s.embedding <=> '${vecLiteral}'::vector) as similarity
        FROM summaries s
        JOIN conversations c ON c.conversation_id = s.conversation_id
        WHERE s.embedding IS NOT NULL
        ORDER BY s.embedding <=> '${vecLiteral}'::vector
        LIMIT $1
      `;
      const res = await this.pool.query(sql, [limit]);
      results.push(...res.rows.map((r: any) => ({
        id: r.id,
        type: 'summary' as const,
        content: r.content,
        role: r.role,
        agent: r.agent,
        conversationId: r.conversation_id,
        similarity: parseFloat(r.similarity),
        createdAt: r.created_at,
        summaryId: r.summary_id,
        kind: r.kind,
        earliestAt: r.earliest_at,
        latestAt: r.latest_at,
      })));
    }

    results.sort((a, b) => b.similarity - a.similarity);
    return results.slice(0, limit);
  }
}
