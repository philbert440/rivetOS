/**
 * LCM Memory Adapter — implements Memory interface over LCM tables.
 *
 * Tables used:
 *   messages        — role, content, token_count, embedding, content_tsv
 *   message_parts   — tool calls, reasoning, files, cost tracking
 *   conversations   — session_id, agent_id, title
 *   summaries       — compacted summaries with embeddings
 */

import pg from 'pg';
import type { Memory, MemoryEntry, MemorySearchResult, Message } from '@rivetos/types';

const { Pool } = pg;

const MS_PER_DAY = 86_400_000;

export interface LcmMemoryConfig {
  connectionString: string;
  /** Max pool connections (default: 5) */
  maxConnections?: number;
}

export class LcmMemory implements Memory {
  private pool: pg.Pool;

  constructor(config: LcmMemoryConfig) {
    this.pool = new Pool({
      connectionString: config.connectionString,
      max: config.maxConnections ?? 5,
    });
  }

  // -----------------------------------------------------------------------
  // append — write to LCM's messages + message_parts tables
  // -----------------------------------------------------------------------

  async append(entry: MemoryEntry): Promise<string> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      // Find or create conversation
      const convId = await this.getOrCreateConversation(client, entry.sessionId, entry.agent);

      // Get next seq number
      const seqResult = await client.query(
        'SELECT COALESCE(MAX(seq), 0) + 1 as next_seq FROM messages WHERE conversation_id = $1',
        [convId],
      );
      const seq = seqResult.rows[0].next_seq;

      // Insert message
      const msgResult = await client.query(
        `INSERT INTO messages (conversation_id, seq, role, content, token_count, created_at)
         VALUES ($1, $2, $3, $4, $5, NOW())
         RETURNING message_id`,
        [convId, seq, entry.role, entry.content, Math.ceil(entry.content.length / 4)],
      );
      const messageId = msgResult.rows[0].message_id;

      // Insert message_part (text)
      await client.query(
        `INSERT INTO message_parts (part_id, message_id, session_id, part_type, ordinal, text_content)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          `part_${messageId}_0`,
          messageId,
          entry.sessionId,
          'text',
          0,
          entry.content,
        ],
      );

      // If tool call, add tool part
      if (entry.toolName) {
        await client.query(
          `INSERT INTO message_parts (part_id, message_id, session_id, part_type, ordinal, tool_name, tool_input, tool_output, tool_status)
           VALUES ($1, $2, $3, 'tool', 1, $4, $5, $6, $7)`,
          [
            `part_${messageId}_1`,
            messageId,
            entry.sessionId,
            entry.toolName,
            entry.toolArgs ? JSON.stringify(entry.toolArgs) : null,
            entry.toolResult ?? null,
            'completed',
          ],
        );
      }

      // Update conversation timestamp
      await client.query(
        'UPDATE conversations SET updated_at = NOW() WHERE conversation_id = $1',
        [convId],
      );

      await client.query('COMMIT');
      return String(messageId);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  // -----------------------------------------------------------------------
  // search — hybrid FTS + temporal decay over messages and summaries
  // -----------------------------------------------------------------------

  async search(
    query: string,
    options?: { agent?: string; limit?: number; scope?: 'messages' | 'summaries' | 'both' },
  ): Promise<MemorySearchResult[]> {
    const limit = options?.limit ?? 20;
    const scope = options?.scope ?? 'both';
    const results: MemorySearchResult[] = [];

    if (scope === 'messages' || scope === 'both') {
      const msgResults = await this.searchMessages(query, limit, options?.agent);
      results.push(...msgResults);
    }

    if (scope === 'summaries' || scope === 'both') {
      const sumResults = await this.searchSummaries(query, limit);
      results.push(...sumResults);
    }

    // Sort by relevance, take top N
    results.sort((a, b) => b.relevanceScore - a.relevanceScore);
    return results.slice(0, limit);
  }

  private async searchMessages(query: string, limit: number, agent?: string): Promise<MemorySearchResult[]> {
    const agentClause = agent
      ? 'AND c.agent_id = $3'
      : '';
    const params: any[] = [query, limit];
    if (agent) params.push(agent);

    const sql = `
      WITH scored AS (
        SELECT
          m.message_id,
          m.content,
          m.role,
          c.agent_id,
          m.created_at,
          ts_rank_cd(m.content_tsv, plainto_tsquery('english', $1)) AS fts_rank,
          EXP(-0.05 * EXTRACT(EPOCH FROM (NOW() - m.created_at)) / 86400.0) AS temporal_score,
          LEAST(LENGTH(m.content) / 1000.0, 1.0) AS length_score
        FROM messages m
        JOIN conversations c ON c.conversation_id = m.conversation_id
        WHERE m.content_tsv @@ plainto_tsquery('english', $1)
          ${agentClause}
      )
      SELECT *, (fts_rank * 0.4 + temporal_score * 0.3 + length_score * 0.3) AS relevance
      FROM scored
      ORDER BY relevance DESC
      LIMIT $2
    `;

    const result = await this.pool.query(sql, params);
    return result.rows.map((r) => ({
      id: String(r.message_id),
      content: r.content,
      role: r.role,
      agent: r.agent_id,
      relevanceScore: parseFloat(r.relevance),
      createdAt: r.created_at,
    }));
  }

  private async searchSummaries(query: string, limit: number): Promise<MemorySearchResult[]> {
    const sql = `
      WITH scored AS (
        SELECT
          s.summary_id,
          s.content,
          s.kind,
          c.agent_id,
          s.created_at,
          ts_rank_cd(s.content_tsv, plainto_tsquery('english', $1)) AS fts_rank,
          EXP(-0.05 * EXTRACT(EPOCH FROM (NOW() - s.created_at)) / 86400.0) AS temporal_score,
          LEAST(LENGTH(s.content) / 1000.0, 1.0) AS length_score
        FROM summaries s
        JOIN conversations c ON c.conversation_id = s.conversation_id
        WHERE s.content_tsv @@ plainto_tsquery('english', $1)
      )
      SELECT *, (fts_rank * 0.4 + temporal_score * 0.3 + length_score * 0.3) AS relevance
      FROM scored
      ORDER BY relevance DESC
      LIMIT $2
    `;

    const result = await this.pool.query(sql, [query, limit]);
    return result.rows.map((r) => ({
      id: r.summary_id,
      content: r.content,
      role: r.kind,
      agent: r.agent_id,
      relevanceScore: parseFloat(r.relevance),
      createdAt: r.created_at,
    }));
  }

  // -----------------------------------------------------------------------
  // getContextForTurn — recent + relevant for system prompt injection
  // -----------------------------------------------------------------------

  async getContextForTurn(
    query: string,
    agent: string,
    options?: { maxTokens?: number },
  ): Promise<string> {
    const maxTokens = options?.maxTokens ?? 4000;
    const sections: string[] = [];
    let tokenEstimate = 0;
    const seen = new Set<string>();

    // Recent messages from this agent
    const recent = await this.pool.query(
      `SELECT m.content, m.role, m.created_at
       FROM messages m
       JOIN conversations c ON c.conversation_id = m.conversation_id
       WHERE c.agent_id = $1
       ORDER BY m.created_at DESC
       LIMIT 5`,
      [agent],
    );

    if (recent.rows.length > 0) {
      sections.push('\n## Recent');
      for (const row of recent.rows.reverse()) {
        if (seen.has(row.content)) continue;
        seen.add(row.content);
        const line = `[${row.role}] ${row.content.slice(0, 500)}`;
        tokenEstimate += line.length / 4;
        if (tokenEstimate > maxTokens) break;
        sections.push(line);
      }
    }

    // Relevant from search
    const relevant = await this.search(query, { agent, limit: 10, scope: 'both' });
    if (relevant.length > 0) {
      sections.push('\n## Relevant Context');
      for (const r of relevant) {
        if (seen.has(r.content)) continue;
        seen.add(r.content);
        const age = Math.floor((Date.now() - r.createdAt.getTime()) / MS_PER_DAY);
        const line = `[${r.agent}/${r.role}, ${age}d ago] ${r.content.slice(0, 500)}`;
        tokenEstimate += line.length / 4;
        if (tokenEstimate > maxTokens) break;
        sections.push(line);
      }
    }

    return sections.join('\n');
  }

  // -----------------------------------------------------------------------
  // getSessionHistory — restore conversation on startup / reconnect
  // -----------------------------------------------------------------------

  async getSessionHistory(
    sessionId: string,
    options?: { limit?: number },
  ): Promise<Message[]> {
    const limit = options?.limit ?? 100;

    // sessionId format: "channelId:userId" — map to LCM's session_key
    const result = await this.pool.query(
      `SELECT m.role, m.content
       FROM messages m
       JOIN conversations c ON c.conversation_id = m.conversation_id
       WHERE c.session_key = $1
         AND c.active = true
       ORDER BY m.created_at DESC
       LIMIT $2`,
      [sessionId, limit],
    );

    // Reverse to chronological order
    return result.rows.reverse().map((r) => ({
      role: r.role as Message['role'],
      content: r.content,
    }));
  }

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  private async getOrCreateConversation(
    client: pg.PoolClient,
    sessionId: string,
    agentId: string,
  ): Promise<number> {
    // Try to find active conversation for this session
    const existing = await client.query(
      `SELECT conversation_id FROM conversations
       WHERE session_key = $1 AND agent_id = $2 AND active = true
       ORDER BY updated_at DESC LIMIT 1`,
      [sessionId, agentId],
    );

    if (existing.rows.length > 0) {
      return existing.rows[0].conversation_id;
    }

    // Create new conversation
    const result = await client.query(
      `INSERT INTO conversations (session_id, session_key, agent_id, title, created_at, updated_at, active)
       VALUES ($1, $2, $3, $4, NOW(), NOW(), true)
       RETURNING conversation_id`,
      [sessionId, sessionId, agentId, `Session ${sessionId}`],
    );

    return result.rows[0].conversation_id;
  }

  // -----------------------------------------------------------------------
  // Session settings persistence
  // -----------------------------------------------------------------------

  async saveSessionSettings(sessionId: string, settings: Record<string, unknown>): Promise<void> {
    // Store in conversations table metadata (JSON column)
    await this.pool.query(
      `UPDATE conversations SET metadata = $1
       WHERE session_key = $2 AND active = true`,
      [JSON.stringify(settings), sessionId],
    );
  }

  async loadSessionSettings(sessionId: string): Promise<Record<string, unknown> | null> {
    const result = await this.pool.query(
      `SELECT metadata FROM conversations
       WHERE session_key = $1 AND active = true
       ORDER BY updated_at DESC LIMIT 1`,
      [sessionId],
    );

    if (result.rows.length === 0) return null;
    const meta = result.rows[0].metadata;
    if (!meta || typeof meta !== 'object') return null;
    return meta as Record<string, unknown>;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
