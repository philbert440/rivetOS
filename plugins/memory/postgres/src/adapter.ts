/**
 * PostgresMemory — implements the Memory interface from @rivetos/types.
 *
 * This is the composition root for the memory plugin. It owns the
 * connection pool and delegates search/expand to their respective engines.
 *
 * Tables:
 *   ros_messages       — immutable transcript with tool data, embeddings, access tracking
 *   ros_conversations  — sessions grouped by channel/agent with settings
 *   ros_summaries      — compacted summaries forming a DAG (parent_id)
 *   ros_summary_sources — links summaries to their source messages
 *
 * Scoring (from MEMORY-DESIGN.md):
 *   relevance = (fts × 0.3) + (semantic × 0.3) + (temporal × 0.3) + (importance × 0.1)
 */

import pg from 'pg'
import type {
  Memory,
  MemoryEntry,
  MemorySearchResult,
  MemorySessionSummary,
  Message,
} from '@rivetos/types'
import { MemoryError } from '@rivetos/types'
import { SearchEngine } from './search.js'
import { WikiIndex } from './wiki/index-reader.js'
import type { SearchEngineConfig } from './search.js'
import { Expander } from './expand.js'

const { Pool } = pg
const MS_PER_DAY = 86_400_000

// ---------------------------------------------------------------------------
// Row interfaces
// ---------------------------------------------------------------------------

interface IdRow {
  id: string
}

interface RecentMessageRow {
  content: string
  role: string
  created_at: Date
}

interface SessionMessageRow {
  role: string
  content: string
}

interface SettingsRow {
  settings: Record<string, unknown> | null
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface PostgresMemoryConfig {
  connectionString: string
  /** Maximum pool connections (default: 5) */
  maxConnections?: number
  /** Connection timeout in ms (default: 10000) */
  connectionTimeoutMs?: number
  /** Idle timeout in ms before releasing connection (default: 30000) */
  idleTimeoutMs?: number
  /** Embedding service URL for query-time hybrid search (e.g., http://192.0.2.1:9401) */
  embedEndpoint?: string
  /** Embedding model name (default: 'nemotron') */
  embedModel?: string
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class PostgresMemory implements Memory {
  private pool: pg.Pool
  private searchEngine: SearchEngine
  private wikiIndex: WikiIndex
  /** Set false after the first missing-table error — 0005 not applied. */
  private wikiAvailable = true
  private expander: Expander
  private connected = false
  private lastHealthCheck = 0

  constructor(config: PostgresMemoryConfig) {
    this.pool = new Pool({
      connectionString: config.connectionString,
      max: config.maxConnections ?? 5,
      connectionTimeoutMillis: config.connectionTimeoutMs ?? 10_000,
      idleTimeoutMillis: config.idleTimeoutMs ?? 30_000,
    })

    // Track pool errors without crashing the process
    this.pool.on('error', (err) => {
      this.connected = false
      console.error('[PostgresMemory] Pool error:', err.message)
    })

    this.pool.on('connect', () => {
      this.connected = true
    })

    // Build search engine config — pass embedding endpoint for hybrid search
    const searchConfig: SearchEngineConfig | undefined = config.embedEndpoint
      ? { embedEndpoint: config.embedEndpoint, embedModel: config.embedModel }
      : undefined

    this.searchEngine = new SearchEngine(this.pool, searchConfig)
    this.wikiIndex = new WikiIndex(this.pool, {
      embedEndpoint: searchConfig?.embedEndpoint ?? undefined,
      embedModel: searchConfig?.embedModel,
    })
    this.expander = new Expander(this.pool)
  }

  /**
   * Health check — verifies the pool can connect and query.
   * Caches result for 30s to avoid hammering the DB.
   */
  async isHealthy(): Promise<boolean> {
    const now = Date.now()
    if (now - this.lastHealthCheck < 30_000) return this.connected

    try {
      await this.pool.query('SELECT 1')
      this.connected = true
      this.lastHealthCheck = now
      return true
    } catch {
      this.connected = false
      this.lastHealthCheck = now
      return false
    }
  }

  /** Whether the last operation or health check succeeded */
  isConnected(): boolean {
    return this.connected
  }

  /** Expose pool for boot.ts to create shared search/expand instances */
  getPool(): pg.Pool {
    return this.pool
  }

  /** Expose the internal search engine */
  getSearchEngine(): SearchEngine {
    return this.searchEngine
  }

  /** Expose the internal expander */
  getExpander(): Expander {
    return this.expander
  }

  // -----------------------------------------------------------------------
  // append — INSERT into ros_messages + update ros_conversations
  // -----------------------------------------------------------------------

  async append(entry: MemoryEntry): Promise<string> {
    let client: pg.PoolClient | undefined
    try {
      client = await this.pool.connect()
      this.connected = true
    } catch (err: unknown) {
      this.connected = false
      throw new MemoryError('MEMORY_CONNECTION_FAILED', 'Failed to connect to memory database', {
        cause: err instanceof Error ? err : undefined,
      })
    }

    try {
      await client.query('BEGIN')

      const convId = await this.ensureConversation(
        client,
        entry.sessionId,
        entry.agent,
        entry.channel,
      )

      const result = await client.query<IdRow>(
        `INSERT INTO ros_messages
           (conversation_id, agent, channel, role, content,
            tool_name, tool_args, tool_result, metadata, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, COALESCE($10, NOW()))
         RETURNING id`,
        [
          convId,
          entry.agent,
          entry.channel,
          entry.role,
          entry.content,
          entry.toolName ?? null,
          entry.toolArgs ? JSON.stringify(entry.toolArgs) : null,
          entry.toolResult ?? null,
          entry.metadata ? JSON.stringify(entry.metadata) : '{}',
          entry.createdAt ?? null,
        ],
      )

      await client.query('UPDATE ros_conversations SET updated_at = NOW() WHERE id = $1', [convId])

      // Enqueue empty-content assistant tool-call messages for async synthesis
      // via graphile-worker. Best-effort: never fail the main append.
      if (
        entry.role === 'assistant' &&
        (!entry.content || entry.content.trim() === '') &&
        entry.toolName
      ) {
        try {
          await client.query(
            `SELECT graphile_worker.add_job(
               'synthesize-tool-call',
               json_build_object('messageId', $1::text),
               job_key := 'tool-synth-' || $1::text,
               job_key_mode := 'preserve_run_at',
               max_attempts := 3
             )`,
            [result.rows[0].id],
          )
        } catch (enqueueErr) {
          console.warn(
            `[PostgresMemory] Failed to enqueue tool-synth for msg ${result.rows[0].id}:`,
            enqueueErr,
          )
        }
      }

      await client.query('COMMIT')
      return result.rows[0].id
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {}) // fire-and-forget — rollback after primary failure
      throw new MemoryError(
        'MEMORY_QUERY_FAILED',
        `Memory append failed: ${(err as Error).message}`,
        {
          cause: err instanceof Error ? err : undefined,
          context: { operation: 'append', agent: entry.agent, role: entry.role },
        },
      )
    } finally {
      client.release()
    }
  }

  // -----------------------------------------------------------------------
  // search — hybrid FTS + semantic + temporal + importance
  // -----------------------------------------------------------------------

  async search(
    query: string,
    options?: {
      agent?: string
      limit?: number
      scope?: 'messages' | 'summaries' | 'both'
    },
  ): Promise<MemorySearchResult[]> {
    const hits = await this.searchEngine.search(query, {
      mode: 'fts',
      scope: options?.scope ?? 'both',
      limit: options?.limit ?? 20,
      agent: options?.agent,
    })

    return hits.map((h) => ({
      id: h.id,
      content: h.content,
      role: h.role,
      agent: h.agent,
      relevanceScore: h.score,
      createdAt: h.createdAt,
    }))
  }

  // -----------------------------------------------------------------------
  // getContextForTurn — recent + relevant, token-budgeted to ~4000 tokens
  // -----------------------------------------------------------------------

  async getContextForTurn(
    query: string,
    agent: string,
    options?: { maxTokens?: number },
  ): Promise<string> {
    const maxTokens = options?.maxTokens ?? 4000
    const sections: string[] = []
    let tokenEstimate = 0
    // Cross-section dedup: one shared 300-char-prefix key so wiki state,
    // recent lines, and hybrid hits actually collide (#290 — mixed-length
    // keys made the old set dead weight).
    const seen = new Set<string>()
    const dedupKey = (s: string): string => s.slice(0, 300)

    // 1. Recent messages from this agent's active conversations (exclude heartbeat noise)
    const recent = await this.pool.query<RecentMessageRow>(
      `SELECT m.content, m.role, m.created_at
       FROM ros_messages m
       JOIN ros_conversations c ON c.id = m.conversation_id
       WHERE c.agent = $1 AND c.active = true
         AND (c.session_key NOT LIKE 'heartbeat:%' OR c.session_key IS NULL)
       ORDER BY m.created_at DESC
       LIMIT 5`,
      [agent],
    )

    if (recent.rows.length > 0) {
      sections.push('\n## Recent')
      for (const row of recent.rows.reverse()) {
        if (seen.has(dedupKey(row.content))) continue
        seen.add(dedupKey(row.content))
        const line = `[${row.role}] ${row.content.slice(0, 500)}`
        tokenEstimate += Math.ceil(line.length / 4)
        if (tokenEstimate > maxTokens) break
        sections.push(line)
      }
    }

    // 2. Wiki — curated "what is true now" (phase 3f). Highest signal per
    // token, so it goes ABOVE raw hybrid search; currentState only (history
    // stays behind the wiki_read tool / gateway). Degrades silently pre-0005.
    if (this.wikiAvailable) {
      try {
        const wikiHits = await this.wikiIndex.searchTopics(query, { limit: 3 })
        if (wikiHits.length > 0) {
          sections.push('\n## Wiki (curated state)')
          for (const hit of wikiHits) {
            const body = hit.currentState.slice(0, 800)
            seen.add(dedupKey(body))
            const line = `**${hit.title}** (wiki:${hit.slug})\n${body}`
            tokenEstimate += Math.ceil(line.length / 4)
            if (tokenEstimate > maxTokens) break
            sections.push(line)
          }
        }
      } catch (err: unknown) {
        // Latch off ONLY for missing-table (0005 not applied) — transient
        // PG errors just skip the wiki leg this turn (#290).
        const msg = err instanceof Error ? err.message : String(err)
        if (/relation .*ros_wiki_topics.* does not exist/i.test(msg)) {
          this.wikiAvailable = false
        }
      }
    }

    // 3. Relevant results from hybrid search (uses scoring.ts formulas via SQL)
    const relevant = await this.searchEngine.search(query, {
      agent,
      limit: 10,
      scope: 'both',
    })

    if (relevant.length > 0) {
      sections.push('\n## Relevant Context')
      for (const r of relevant) {
        if (seen.has(dedupKey(r.content))) continue
        seen.add(dedupKey(r.content))
        const age = Math.floor((Date.now() - r.createdAt.getTime()) / MS_PER_DAY)
        const line = `[${r.agent}/${r.role}, ${String(age)}d ago] ${r.content.slice(0, 500)}`
        tokenEstimate += Math.ceil(line.length / 4)
        if (tokenEstimate > maxTokens) break
        sections.push(line)
      }
    }

    return sections.join('\n')
  }

  // -----------------------------------------------------------------------
  // getSessionHistory — restore conversation on startup/reconnect
  // -----------------------------------------------------------------------

  async getSessionHistory(sessionId: string, options?: { limit?: number }): Promise<Message[]> {
    const limit = options?.limit ?? 100

    const result = await this.pool.query<SessionMessageRow>(
      `SELECT m.role, m.content
       FROM ros_messages m
       JOIN ros_conversations c ON c.id = m.conversation_id
       WHERE c.session_key = $1 AND c.active = true
       ORDER BY m.created_at DESC
       LIMIT $2`,
      [sessionId, limit],
    )

    // Reverse to chronological order
    return result.rows.reverse().map((r) => ({
      role: r.role as Message['role'],
      content: r.content,
    }))
  }

  // -----------------------------------------------------------------------
  // listSessions — enumerate captured conversations (harness-session drawer)
  // -----------------------------------------------------------------------

  async listSessions(options?: { limit?: number }): Promise<MemorySessionSummary[]> {
    const limit = options?.limit ?? 100
    const result = await this.pool.query<{
      session_key: string
      last_active: Date
      message_count: string
    }>(
      `SELECT c.session_key,
              MAX(m.created_at) AS last_active,
              COUNT(m.id)       AS message_count
       FROM ros_conversations c
       JOIN ros_messages m ON m.conversation_id = c.id
       WHERE c.active = true AND c.session_key IS NOT NULL
       GROUP BY c.session_key
       ORDER BY last_active DESC
       LIMIT $1`,
      [limit],
    )
    return result.rows.map((r) => ({
      sessionId: r.session_key,
      lastActive: r.last_active,
      messageCount: Number(r.message_count),
    }))
  }

  // -----------------------------------------------------------------------
  // Session settings — persisted in ros_conversations.settings (JSONB)
  // -----------------------------------------------------------------------

  async saveSessionSettings(sessionId: string, settings: Record<string, unknown>): Promise<void> {
    await this.pool.query(
      `UPDATE ros_conversations SET settings = $1
       WHERE session_key = $2 AND active = true`,
      [JSON.stringify(settings), sessionId],
    )
  }

  async loadSessionSettings(sessionId: string): Promise<Record<string, unknown> | null> {
    const result = await this.pool.query<SettingsRow>(
      `SELECT settings FROM ros_conversations
       WHERE session_key = $1 AND active = true
       ORDER BY updated_at DESC LIMIT 1`,
      [sessionId],
    )

    if (result.rows.length === 0) return null
    const settings = result.rows[0].settings
    if (!settings || typeof settings !== 'object') return null
    return settings
  }

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  async close(): Promise<void> {
    await this.pool.end()
  }

  // -----------------------------------------------------------------------
  // Internal: conversation upsert
  // -----------------------------------------------------------------------

  private async ensureConversation(
    client: pg.PoolClient,
    sessionId: string,
    agent: string,
    channel?: string,
  ): Promise<string> {
    // Try to find an active conversation for this session + agent
    const existing = await client.query<IdRow>(
      `SELECT id FROM ros_conversations
       WHERE session_key = $1 AND agent = $2 AND active = true
       ORDER BY updated_at DESC LIMIT 1`,
      [sessionId, agent],
    )

    if (existing.rows.length > 0) {
      return existing.rows[0].id
    }

    // Create a new conversation
    const result = await client.query<IdRow>(
      `INSERT INTO ros_conversations (session_key, agent, channel, title, created_at, updated_at)
       VALUES ($1, $2, $3, $4, NOW(), NOW())
       RETURNING id`,
      [sessionId, agent, channel ?? 'unknown', `Session ${sessionId}`],
    )

    return result.rows[0].id
  }
}
