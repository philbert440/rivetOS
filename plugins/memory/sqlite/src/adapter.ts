/**
 * SqliteMemory — implements the Memory interface from @rivetos/types.
 *
 * Phase 1: WAL file store, append, session/task history, settings, FTS5 search.
 * Embeddings are queue-only (ros_embed_queue); search is FTS until a later
 * drain + vector arm lands. Driver choice matches SqliteTaskStore (node:sqlite).
 */

import { randomUUID } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, resolve } from 'node:path'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import type { Memory, MemoryEntry, MemorySearchResult, Message } from '@rivetos/types'
import { MemoryError } from '@rivetos/types'
import { SCHEMA, SCHEMA_VERSION } from './schema.js'

function warnMode(target: string, mode: string, err: unknown): void {
  let code = 'error'
  if (err && typeof err === 'object' && 'code' in err) {
    const raw = err.code
    if (typeof raw === 'string' || typeof raw === 'number') code = String(raw)
  }
  console.warn(`memory.sqlite: could not chmod ${target} to ${mode} (${code}); continuing`)
}

const HEARTBEAT_SESSION_PREFIX = 'heartbeat:'

const TASK_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function isTaskUuid(value: string): boolean {
  return TASK_UUID_RE.test(value)
}

function isHeartbeatSessionKey(sessionKey: string | null | undefined): boolean {
  return typeof sessionKey === 'string' && sessionKey.startsWith(HEARTBEAT_SESSION_PREFIX)
}

/** Expand a leading `~/` and resolve relative paths against cwd. */
export function resolveSqlitePath(raw: string): string {
  const trimmed = raw.trim()
  if (trimmed === ':memory:') return trimmed
  let path = trimmed
  if (path.startsWith('~/') || path === '~') {
    path = path === '~' ? homedir() : resolve(homedir(), path.slice(2))
  }
  return isAbsolute(path) ? path : resolve(process.cwd(), path)
}

function iso(ms: number = Date.now()): string {
  return new Date(ms).toISOString()
}

/**
 * Turn a free-text query into an FTS5 MATCH expression.
 * Strips FTS operators so operator characters cannot alter query structure;
 * empty after sanitize → no MATCH (caller falls back to empty results).
 */
export function buildFtsMatchQuery(raw: string): string | null {
  const tokens = raw
    .split(/\s+/)
    .map((t) => t.replace(/["'^~*():]/g, '').trim())
    .filter((t) => t.length > 0)
  if (tokens.length === 0) return null
  return tokens.map((t) => `"${t}"`).join(' AND ')
}

/**
 * FTS5 bm25() returns negative scores for matches (more negative = better).
 * Map into a (0,1]-ish relevance where higher is better.
 */
export function relevanceFromBm25(rank: number): number {
  return 1 / (1 + Math.abs(rank))
}

/** Extract a UUID task id from `task:<uuid>` session keys or metadata.taskId. */
export function resolveTaskId(
  sessionId: string,
  metadata?: Record<string, unknown>,
): string | null {
  if (sessionId.startsWith('task:')) {
    const fromSession = sessionId.slice('task:'.length)
    if (isTaskUuid(fromSession)) return fromSession
  }
  const raw = metadata?.taskId
  if (typeof raw === 'string' && isTaskUuid(raw)) return raw
  return null
}

/**
 * Ensure the DB parent directory exists. chmod 0700 only when we created it —
 * never repermission a pre-existing parent (e.g. `/tmp`, `$HOME`, a shared
 * installer-owned tree). Mode tightening is best-effort: EPERM must not disable
 * the backend.
 */
export function ensureSqliteParentDir(dir: string): void {
  const existed = existsSync(dir)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  if (existed) return
  try {
    chmodSync(dir, 0o700)
  } catch (err) {
    warnMode(dir, '0700', err)
  }
}

/** Restrict a file (and its -wal/-shm siblings) to owner read/write only. Best-effort. */
export function restrictSqliteFileModes(path: string): void {
  if (path === ':memory:') return
  try {
    chmodSync(path, 0o600)
  } catch (err) {
    warnMode(path, '0600', err)
  }
  for (const suffix of ['-wal', '-shm'] as const) {
    const sibling = `${path}${suffix}`
    if (!existsSync(sibling)) continue
    try {
      chmodSync(sibling, 0o600)
    } catch (err) {
      warnMode(sibling, '0600', err)
    }
  }
}

export interface SqliteMemoryConfig {
  /** File path, `~`-expanded, or `:memory:`. */
  path: string
}

interface ConversationRow {
  id: string
}

interface SessionMessageRow {
  role: string
  content: string
}

interface SettingsRow {
  settings: string
}

interface RecentMessageRow {
  content: string
  role: string
  created_at: string
}

interface SearchRow {
  id: string
  content: string
  role: string
  agent: string
  created_at: string
  rank: number
}

/* eslint-disable @typescript-eslint/require-await -- DatabaseSync is sync; methods stay async for Memory. */
export class SqliteMemory implements Memory {
  private readonly db: DatabaseSync
  private readonly filePath: string
  private closed = false

  constructor(config: SqliteMemoryConfig) {
    const path = resolveSqlitePath(config.path)
    this.filePath = path
    if (path !== ':memory:') {
      ensureSqliteParentDir(dirname(path))
    }
    this.db = new DatabaseSync(path)
    // busy_timeout before WAL so a cold-open race waits instead of throwing SQLITE_BUSY.
    this.db.exec('PRAGMA busy_timeout = 5000')
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec('PRAGMA foreign_keys = ON')
    this.db.exec(SCHEMA)
    this.migrateSchema()
    if (path !== ':memory:') {
      // WAL/SHM appear after journal_mode=WAL; tighten DB + siblings.
      restrictSqliteFileModes(path)
    }
  }

  /** Apply incremental upgrades and stamp PRAGMA user_version. */
  private migrateSchema(): void {
    const row = this.db.prepare('PRAGMA user_version').get() as { user_version: number } | undefined
    let version = row?.user_version ?? 0
    // Fresh file or pre-stamp phase-1 DB: SCHEMA already applied via CREATE IF NOT EXISTS.
    // Switch arms land here as SCHEMA_VERSION grows (phase 2+).
    while (version < SCHEMA_VERSION) {
      switch (version) {
        case 0:
          // No-op: baseline DDL is in SCHEMA. Stamp to 1.
          break
        default:
          throw new MemoryError(
            'MEMORY_CONNECTION_FAILED',
            `SqliteMemory has no migration from schema version ${version}`,
          )
      }
      version += 1
      this.db.exec(`PRAGMA user_version = ${version}`)
    }
  }

  /** Absolute path (or `:memory:`) this store opened. */
  getPath(): string {
    return this.filePath
  }

  async isHealthy(): Promise<boolean> {
    try {
      const row = this.db
        .prepare(`SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'ros_messages'`)
        .get() as { ok: number } | undefined
      return row?.ok === 1
    } catch {
      return false
    }
  }

  async append(entry: MemoryEntry): Promise<string> {
    this.assertOpen()
    try {
      return this.tx(() => {
        const taskId = resolveTaskId(entry.sessionId, entry.metadata)
        const convId = this.ensureConversation(entry.sessionId, entry.agent, entry.channel, taskId)
        const id = randomUUID()
        const createdAt = entry.createdAt ? entry.createdAt.toISOString() : iso()
        const toolArgs = entry.toolArgs ? JSON.stringify(entry.toolArgs) : null
        const metadata = entry.metadata ? JSON.stringify(entry.metadata) : '{}'
        const toolResult = entry.toolResult ?? null

        // FTS row is written by the ros_messages_ai trigger.
        this.db
          .prepare(
            `INSERT INTO ros_messages
               (id, conversation_id, agent, channel, role, content,
                tool_name, tool_args, tool_result, metadata, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            id,
            convId,
            entry.agent,
            entry.channel,
            entry.role,
            entry.content,
            entry.toolName ?? null,
            toolArgs,
            toolResult,
            metadata,
            createdAt,
          )

        this.db
          .prepare(`UPDATE ros_conversations SET updated_at = ?, active = 1 WHERE id = ?`)
          .run(createdAt, convId)

        // Queue for a later embed drain. Best-effort — never fail the append.
        try {
          this.db
            .prepare(
              `INSERT OR IGNORE INTO ros_embed_queue (id, message_id, enqueued_at)
               VALUES (?, ?, ?)`,
            )
            .run(randomUUID(), id, createdAt)
        } catch {
          // ignore queue failures
        }

        return id
      })
    } catch (err: unknown) {
      throw new MemoryError(
        'MEMORY_QUERY_FAILED',
        `Memory append failed: ${err instanceof Error ? err.message : String(err)}`,
        {
          cause: err instanceof Error ? err : undefined,
          context: { operation: 'append', agent: entry.agent, role: entry.role },
        },
      )
    }
  }

  async search(
    query: string,
    options?: {
      agent?: string
      limit?: number
      scope?: 'messages' | 'summaries' | 'both'
      userId?: string
    },
  ): Promise<MemorySearchResult[]> {
    this.assertOpen()
    void options?.userId
    // Phase 1: summaries are empty, so scope 'both' returns messages only.
    const scope = options?.scope ?? 'both'
    if (scope === 'summaries') return []

    const match = buildFtsMatchQuery(query)
    if (!match) return []

    const limit = options?.limit ?? 20
    const agent = options?.agent

    try {
      const rows = (agent
        ? this.db
            .prepare(
              `SELECT m.id, m.content, m.role, m.agent, m.created_at,
                        bm25(ros_messages_fts) AS rank
                   FROM ros_messages_fts
                   JOIN ros_messages m ON m.id = ros_messages_fts.id
                  WHERE ros_messages_fts MATCH ?
                    AND m.agent = ?
                  ORDER BY rank
                  LIMIT ?`,
            )
            .all(match, agent, limit)
        : this.db
            .prepare(
              `SELECT m.id, m.content, m.role, m.agent, m.created_at,
                        bm25(ros_messages_fts) AS rank
                   FROM ros_messages_fts
                   JOIN ros_messages m ON m.id = ros_messages_fts.id
                  WHERE ros_messages_fts MATCH ?
                  ORDER BY rank
                  LIMIT ?`,
            )
            .all(match, limit)) as unknown as SearchRow[]

      return rows.map((r) => ({
        id: r.id,
        content: r.content,
        role: r.role,
        agent: r.agent,
        // bm25() is negative for matches; abs so relevance varies and higher = better.
        relevanceScore: relevanceFromBm25(r.rank),
        createdAt: new Date(r.created_at),
      }))
    } catch (err: unknown) {
      throw new MemoryError(
        'MEMORY_QUERY_FAILED',
        `Memory search failed: ${err instanceof Error ? err.message : String(err)}`,
        {
          cause: err instanceof Error ? err : undefined,
          context: { operation: 'search' },
        },
      )
    }
  }

  async getContextForTurn(
    query: string,
    agent: string,
    options?: { maxTokens?: number; userId?: string },
  ): Promise<string> {
    this.assertOpen()
    void options?.userId
    const maxTokens = options?.maxTokens ?? 4000
    const sections: string[] = []
    let tokenEstimate = 0
    const seen = new Set<string>()
    const dedupKey = (s: string): string => s.slice(0, 300)

    const recent = this.db
      .prepare(
        `SELECT m.content, m.role, m.created_at
           FROM ros_messages m
           JOIN ros_conversations c ON c.id = m.conversation_id
          WHERE c.agent = ? AND c.active = 1
            AND (c.session_key NOT LIKE 'heartbeat:%' OR c.session_key IS NULL)
          ORDER BY m.created_at DESC
          LIMIT 5`,
      )
      .all(agent) as unknown as RecentMessageRow[]

    if (recent.length > 0) {
      sections.push('\n## Recent')
      for (const row of recent.reverse()) {
        if (seen.has(dedupKey(row.content))) continue
        seen.add(dedupKey(row.content))
        const line = `[${row.role}] ${row.content.slice(0, 500)}`
        tokenEstimate += Math.ceil(line.length / 4)
        if (tokenEstimate > maxTokens) break
        sections.push(line)
      }
    }

    const relevant = await this.search(query, { agent, limit: 10, scope: 'messages' })
    if (relevant.length > 0) {
      sections.push('\n## Relevant Context')
      for (const r of relevant) {
        if (seen.has(dedupKey(r.content))) continue
        seen.add(dedupKey(r.content))
        const line = `[${r.agent}/${r.role}] ${r.content.slice(0, 500)}`
        tokenEstimate += Math.ceil(line.length / 4)
        if (tokenEstimate > maxTokens) break
        sections.push(line)
      }
    }

    return sections.join('\n')
  }

  async getSessionHistory(sessionId: string, options?: { limit?: number }): Promise<Message[]> {
    this.assertOpen()
    const limit = options?.limit ?? 100
    const rows = this.db
      .prepare(
        `SELECT m.role, m.content
           FROM ros_messages m
           JOIN ros_conversations c ON c.id = m.conversation_id
          WHERE c.session_key = ? AND c.active = 1
          ORDER BY m.created_at DESC, m.id DESC
          LIMIT ?`,
      )
      .all(sessionId, limit) as unknown as SessionMessageRow[]

    return rows.reverse().map((r) => ({
      role: r.role as Message['role'],
      content: r.content,
    }))
  }

  async getTaskHistory(taskId: string, options?: { limit?: number }): Promise<Message[]> {
    this.assertOpen()
    const limit = options?.limit ?? 100
    const legacyKey = `task:${taskId}`
    const joined = isTaskUuid(taskId)

    const rows = (joined
      ? this.db
          .prepare(
            `SELECT m.role, m.content
                 FROM ros_messages m
                 JOIN ros_conversations c ON c.id = m.conversation_id
                WHERE c.task_id = ? OR c.session_key = ?
                ORDER BY m.created_at DESC, m.id DESC
                LIMIT ?`,
          )
          .all(taskId, legacyKey, limit)
      : this.db
          .prepare(
            `SELECT m.role, m.content
                 FROM ros_messages m
                 JOIN ros_conversations c ON c.id = m.conversation_id
                WHERE c.session_key = ?
                ORDER BY m.created_at DESC, m.id DESC
                LIMIT ?`,
          )
          .all(legacyKey, limit)) as unknown as SessionMessageRow[]

    return rows.reverse().map((r) => ({
      role: r.role as Message['role'],
      content: r.content,
    }))
  }

  async saveSessionSettings(sessionId: string, settings: Record<string, unknown>): Promise<void> {
    this.assertOpen()
    this.db
      .prepare(
        `UPDATE ros_conversations SET settings = ?, updated_at = ?
         WHERE session_key = ? AND active = 1`,
      )
      .run(JSON.stringify(settings), iso(), sessionId)
  }

  async loadSessionSettings(sessionId: string): Promise<Record<string, unknown> | null> {
    this.assertOpen()
    const row = this.db
      .prepare(
        `SELECT settings FROM ros_conversations
          WHERE session_key = ? AND active = 1
          ORDER BY updated_at DESC LIMIT 1`,
      )
      .get(sessionId) as SettingsRow | undefined

    if (!row) return null
    try {
      const parsed: unknown = JSON.parse(row.settings)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
      return parsed as Record<string, unknown>
    } catch {
      return null
    }
  }

  /**
   * Stamp `task_id` on the active conversation for a session (harness-spawn
   * association). Prefer passing `metadata.taskId` on append when available;
   * this remains for callers that learn the task id after the first write.
   * No-op when no active conversation.
   */
  associateTask(sessionId: string, agent: string, taskId: string): void {
    this.assertOpen()
    this.db
      .prepare(
        `UPDATE ros_conversations SET task_id = ?, updated_at = ?
         WHERE session_key = ? AND agent = ? AND active = 1`,
      )
      .run(taskId, iso(), sessionId, agent)
  }

  /** Test helper — current PRAGMA user_version. */
  schemaVersionForTest(): number {
    const row = this.db.prepare('PRAGMA user_version').get() as { user_version: number } | undefined
    return row?.user_version ?? 0
  }

  /** Test helper — conversation task_id for a session/agent, if any. */
  conversationTaskIdForTest(sessionId: string, agent: string): string | null {
    const row = this.db
      .prepare(
        `SELECT task_id FROM ros_conversations
          WHERE session_key = ? AND agent = ? AND active = 1
          ORDER BY updated_at DESC LIMIT 1`,
      )
      .get(sessionId, agent) as { task_id: string | null } | undefined
    return row?.task_id ?? null
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.db.close()
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new MemoryError('MEMORY_CONNECTION_FAILED', 'SqliteMemory is closed')
    }
  }

  private tx<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = fn()
      this.db.exec('COMMIT')
      return result
    } catch (err) {
      try {
        this.db.exec('ROLLBACK')
      } catch {
        // ignore
      }
      throw err
    }
  }

  private ensureConversation(
    sessionId: string,
    agent: string,
    channel?: string,
    taskId?: string | null,
  ): string {
    const now = iso()
    const channelValue = channel ?? 'unknown'
    const title = isHeartbeatSessionKey(sessionId) ? `Heartbeat ${agent}` : `Session ${sessionId}`
    const taskValue = taskId ?? null

    // Sticky task_id: set when the caller supplies one; never clear an existing stamp.
    const upserted = this.db
      .prepare(
        `INSERT INTO ros_conversations
           (id, session_key, agent, channel, title, task_id, created_at, updated_at, active)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
         ON CONFLICT (session_key, agent) DO UPDATE SET
           updated_at = excluded.updated_at,
           active = 1,
           task_id = CASE
             WHEN excluded.task_id IS NOT NULL THEN excluded.task_id
             ELSE ros_conversations.task_id
           END
         RETURNING id`,
      )
      .get(randomUUID(), sessionId, agent, channelValue, title, taskValue, now, now) as
      ConversationRow | undefined

    if (!upserted?.id) {
      throw new Error('ensureConversation failed to return an id')
    }
    return upserted.id
  }

  /** Test helper — run a parameterized statement. */
  execForTest(sql: string, ...params: SQLInputValue[]): void {
    this.db.prepare(sql).run(...params)
  }

  /** Test helper — whether a message id is waiting on the embed queue. */
  hasEmbedQueueEntryForTest(messageId: string): boolean {
    const row = this.db
      .prepare(`SELECT 1 AS ok FROM ros_embed_queue WHERE message_id = ?`)
      .get(messageId) as { ok: number } | undefined
    return row?.ok === 1
  }

  /** Test helper — count FTS rows for a message id (detects orphans). */
  ftsRowCountForTest(messageId: string): number {
    const row = this.db
      .prepare(`SELECT count(*) AS n FROM ros_messages_fts WHERE id = ?`)
      .get(messageId) as { n: number } | undefined
    return row?.n ?? 0
  }
}
/* eslint-enable @typescript-eslint/require-await */
