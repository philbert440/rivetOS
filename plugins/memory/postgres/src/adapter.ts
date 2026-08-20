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
import type { Memory, MemoryEntry, MemorySearchResult, Message } from '@rivetos/types'
import { MemoryError } from '@rivetos/types'
import { SearchEngine } from './search.js'
import { WikiIndex } from './wiki/index-reader.js'
import type { SearchEngineConfig } from './search.js'
import { Expander } from './expand.js'
import { fmtHitWhen } from './tools/helpers.js'

const { Pool } = pg

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

/** ros_tasks.id, and therefore ros_conversations.task_id, is a UUID. */
const TASK_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function isTaskUuid(value: string): boolean {
  return TASK_UUID_RE.test(value)
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
  /**
   * Latch for ux_ros_conversations_session_agent (0009/0010). Sticky once true;
   * a false result is never cached — see hasConversationUniqueIndex.
   */
  private conversationUniqueIndex = false
  /**
   * Latch for ros_conversations.task_id (0011). Sticky once true; a false
   * result is never cached — see hasConversationTaskId.
   */
  private conversationTaskId = false

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

  async append(entry: MemoryEntry, options?: { client?: pg.PoolClient }): Promise<string> {
    const providedClient = options?.client
    let client: pg.PoolClient

    if (providedClient) {
      // Use the provided client (already in a transaction)
      client = providedClient
    } else {
      // Acquire our own client
      try {
        client = await this.pool.connect()
        this.connected = true
      } catch (err: unknown) {
        this.connected = false
        throw new MemoryError('MEMORY_CONNECTION_FAILED', 'Failed to connect to memory database', {
          cause: err instanceof Error ? err : undefined,
        })
      }
    }

    try {
      if (!providedClient) {
        await client.query('BEGIN')
      }

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

      if (!providedClient) {
        await client.query('COMMIT')
      }
      return result.rows[0].id
    } catch (err) {
      if (!providedClient) {
        await client.query('ROLLBACK').catch(() => {}) // fire-and-forget — rollback after primary failure
      }
      throw new MemoryError(
        'MEMORY_QUERY_FAILED',
        `Memory append failed: ${(err as Error).message}`,
        {
          cause: err instanceof Error ? err : undefined,
          context: { operation: 'append', agent: entry.agent, role: entry.role },
        },
      )
    } finally {
      if (!providedClient) {
        client.release()
      }
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

    // 2. Wiki — curated "what is true now" (phase 3f / memory v7). Highest
    // signal per token, so it goes ABOVE raw hybrid search. Inject Summary
    // (lead) plus a short Article excerpt when present; history stays behind
    // wiki_read. Degrades silently pre-0005.
    if (this.wikiAvailable) {
      try {
        const wikiHits = await this.wikiIndex.searchTopics(query, { limit: 3 })
        if (wikiHits.length > 0) {
          sections.push('\n## Wiki (curated state)')
          for (const hit of wikiHits) {
            const summary = hit.currentState.slice(0, 1200)
            const article = hit.article.trim()
            const articleSlice = article !== '' ? `\n${article.slice(0, 800)}` : ''
            const body = `${summary}${articleSlice}`
            seen.add(dedupKey(summary))
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
        // Match memory_search / browse: relative age + local-TZ absolute
        // (floor-day-only ages made same-day injection look timeless).
        const line = `[${r.agent}/${r.role}, ${fmtHitWhen(r.createdAt)}] ${r.content.slice(0, 500)}`
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

  /**
   * The active conversation's transcript for a session key, oldest-first.
   *
   * `m.id` breaks ties on created_at. Rows inserted in one transaction can share
   * a timestamp — capture writes a whole transcript pass that way — and without
   * a tiebreaker Postgres is free to return them in a different order on every
   * call, so a reconnecting session could see its own history reshuffled. The id
   * is a random UUID, so this buys determinism, not chronology: same-timestamp
   * rows get an arbitrary but STABLE order.
   */
  async getSessionHistory(sessionId: string, options?: { limit?: number }): Promise<Message[]> {
    const limit = options?.limit ?? 100

    const result = await this.pool.query<SessionMessageRow>(
      `SELECT m.role, m.content
       FROM ros_messages m
       JOIN ros_conversations c ON c.id = m.conversation_id
       WHERE c.session_key = $1 AND c.active = true
       ORDER BY m.created_at DESC, m.id DESC
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
  // getTaskHistory — union transcript for a task (query-time join)
  // -----------------------------------------------------------------------

  /**
   * A task's transcript across every session it spawned, oldest-first.
   *
   * Two legs, deliberately UNIONed rather than either one alone:
   *
   *  - `task_id` — the canonical association (0011). Each spawned harness
   *    session writes capture under its own `claude-code:<native>` key and
   *    stamps the task on its conversation, so this leg is what makes
   *    multi-spawn transcript unity work without a shared write key.
   *  - `session_key = 'task:<id>'` — the legacy namespace the executors wrote
   *    into before the migration, and still the key the chat-loop executor
   *    appends under (it drives AgentLoop with sessionId `task:<id>`). Those
   *    rows were never migrated and never need to be.
   *
   * Unlike getSessionHistory this does NOT filter on `active`: a task's earlier
   * spawns are finalized by their SessionEnd hook, and they are precisely the
   * history a resume needs to see.
   *
   * `limit` bounds the newest N messages across the union, matching
   * getSessionHistory's semantics.
   *
   * `m.id` breaks ties on created_at. Rows inserted in one transaction can share
   * a timestamp — capture writes a whole transcript pass that way — and without
   * a tiebreaker Postgres is free to return them in a different order on every
   * call, so a resumed task could see its own history reshuffled. The id is a
   * random UUID, so this buys determinism, not chronology: same-timestamp rows
   * get an arbitrary but STABLE order.
   */
  async getTaskHistory(taskId: string, options?: { limit?: number }): Promise<Message[]> {
    const limit = options?.limit ?? 100
    const legacyKey = `task:${taskId}`

    // A non-UUID task id cannot be in the task_id column, and binding it would
    // raise 22P02 — read the legacy leg only. Same for a node whose 0011 has
    // not landed: the column does not exist yet, so the union will not parse.
    const joined = isTaskUuid(taskId) && (await this.hasConversationTaskId())

    const result = joined
      ? await this.pool.query<SessionMessageRow>(
          `SELECT m.role, m.content
             FROM ros_messages m
             JOIN ros_conversations c ON c.id = m.conversation_id
            WHERE c.task_id = $1::uuid OR c.session_key = $2
            ORDER BY m.created_at DESC, m.id DESC
            LIMIT $3`,
          [taskId, legacyKey, limit],
        )
      : await this.pool.query<SessionMessageRow>(
          `SELECT m.role, m.content
             FROM ros_messages m
             JOIN ros_conversations c ON c.id = m.conversation_id
            WHERE c.session_key = $1
            ORDER BY m.created_at DESC, m.id DESC
            LIMIT $2`,
          [legacyKey, limit],
        )

    return result.rows.reverse().map((r) => ({
      role: r.role as Message['role'],
      content: r.content,
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
    if (await this.hasConversationUniqueIndex(client)) {
      // Race-safe path: one (session_key, agent) => one conversation, enforced by
      // ux_ros_conversations_session_agent (0009). Two concurrent appends for the
      // same session can no longer both miss a SELECT and both INSERT.
      //
      // DO UPDATE (not DO NOTHING) so the conflicting row is always RETURNED —
      // DO NOTHING returns zero rows and would need a second round-trip.
      //
      // active is forced back to true: a finalized conversation (active = false)
      // that receives a new append is a resumed session, and the adapter's own
      // reads (getSessionHistory, getContextForTurn) filter on active = true.
      // Pre-0009 this created a second conversation row instead — which is the
      // duplication the migration had to clean up.
      const upserted = await client.query<IdRow>(
        `INSERT INTO ros_conversations (session_key, agent, channel, title, created_at, updated_at)
         VALUES ($1, $2, $3, $4, NOW(), NOW())
         ON CONFLICT (session_key, agent) DO UPDATE
           SET updated_at = NOW(), active = true
         RETURNING id`,
        [sessionId, agent, channel ?? 'unknown', `Session ${sessionId}`],
      )
      return upserted.rows[0].id
    }

    // Legacy path — the index is not there yet. ON CONFLICT would raise 42P10 with
    // no arbiter index, so keep capture working (racy, as it has always been)
    // rather than failing every append on an unmigrated node. The probe above
    // re-checks on every call while this is the case, so the process switches to
    // the upsert as soon as the migration lands — no restart needed.
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

  /**
   * Whether the unique index on (session_key, agent) exists.
   *
   * Only a TRUE result is cached. A migration cannot be un-applied under a live
   * pool, so once the index is there it stays — but it very much CAN be applied
   * under a live pool, which is the normal deploy order: new code ships to the
   * nodes, then `rivetos db migrate` runs. Caching a negative would pin that
   * process to the legacy path for its whole lifetime, and the legacy path starts
   * raising 23505 the moment the index exists (it INSERTs a fresh row whenever the
   * conversation is finalized, and races on first insert). Re-probing costs one
   * catalog lookup per append until the migration lands, and nothing after.
   *
   * to_regclass returns NULL rather than raising for a name that does not resolve,
   * so this is safe to run inside the caller's open transaction: it cannot poison
   * it the way a failed `ON CONFLICT` (42P10) would.
   */
  private async hasConversationUniqueIndex(client: pg.PoolClient): Promise<boolean> {
    if (this.conversationUniqueIndex) return true

    const res = await client.query<{ present: boolean }>(
      `SELECT to_regclass('ux_ros_conversations_session_agent') IS NOT NULL AS present`,
    )
    this.conversationUniqueIndex = res.rows[0]?.present ?? false

    return this.conversationUniqueIndex
  }

  /**
   * Whether `ros_conversations.task_id` exists (migration 0011).
   *
   * Same caching rule as the unique-index probe, for the same reason: only TRUE
   * is cached, because the normal deploy order ships code to the nodes before
   * `rivetos db migrate` runs and a cached negative would pin this process to
   * the legacy-only read for its whole lifetime.
   *
   * A NULL `to_regclass` matches no pg_attribute row, so a database missing
   * ros_conversations entirely answers false instead of raising.
   */
  private async hasConversationTaskId(): Promise<boolean> {
    if (this.conversationTaskId) return true

    const res = await this.pool.query<{ present: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM pg_attribute
          WHERE attrelid = to_regclass('ros_conversations')
            AND attname = 'task_id'
            AND NOT attisdropped
       ) AS present`,
    )
    this.conversationTaskId = res.rows[0]?.present ?? false

    return this.conversationTaskId
  }
}
