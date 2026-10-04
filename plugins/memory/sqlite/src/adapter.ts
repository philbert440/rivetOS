/**
 * SqliteMemory — implements the Memory interface from @rivetos/types.
 *
 * WAL file store, append, session/task history, settings, session tags
 * (tags.ts), background embedding on an in-process job loop (jobs.ts,
 * embed.ts) and hybrid full-text + vector search (vectors.ts).
 * Driver choice matches SqliteTaskStore (node:sqlite).
 */

import { randomUUID } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, resolve } from 'node:path'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import type { Memory, MemoryEntry, MemorySearchResult, Message } from '@rivetos/types'
import { MemoryError } from '@rivetos/types'
import {
  GATE_FRACTION,
  HYBRID_MIN_CONTENT_LEN,
  HYBRID_RRF_K,
  W_IMPORTANCE,
  W_TEMPORAL,
  hybridPoolSize,
  importanceForRole,
  looksLiteral,
  reciprocalRankFusion,
  shouldTrigramFallback,
  temporalDecay,
} from '@rivetos/memory-core'
import { EmbedClient, type EmbedConfig } from './embed.js'
import { JobRunner, SqliteJobQueue } from './jobs.js'
import { SCHEMA, SCHEMA_VERSION } from './schema.js'
import { SqliteTagStore } from './tags.js'
import { ExactScanIndex, encodeVector, type VectorIndex } from './vectors.js'

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
  /**
   * Embedding endpoint. When set, messages are embedded in the background and
   * `search` fuses a vector arm with full-text. Unset: full-text only.
   */
  embed?: EmbedConfig
  /**
   * Run the in-process job loop (embedding today; compaction, wiki and
   * tagging as they land). Default: on when `embed` is set. Turn off to queue
   * work without draining it, e.g. in a short-lived CLI process.
   */
  workers?: boolean
  /** Where the job loop reports failures. Default: console.warn. */
  log?: (line: string) => void
  /** Clock for the job queue (run times, retry delays, sweeps). For tests. */
  now?: () => Date
}

/**
 * Quality floor for the full-text and vector arms, the same rule the Postgres
 * backend applies: substantive non-tool content, or a tool row whose
 * tool_result carries real payload.
 */
const MESSAGE_QUALITY_SQL = `(
  (m.role <> 'tool' AND length(trim(m.content)) >= ${String(HYBRID_MIN_CONTENT_LEN)})
  OR (m.role = 'tool' AND length(trim(coalesce(m.tool_result, ''))) >= ${String(HYBRID_MIN_CONTENT_LEN)})
)`

/** Job name shared with the Postgres embedding worker. */
export const EMBED_TARGET_TASK = 'embed-target'

interface HybridRow {
  id: string
  content: string
  role: string
  agent: string
  created_at: string
  tool_name: string | null
  access_count: number
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
  private tagStore: SqliteTagStore | undefined
  private readonly jobQueue: SqliteJobQueue
  private readonly jobRunner: JobRunner
  private readonly embedClient: EmbedClient | undefined
  private readonly vectorIndex: VectorIndex
  private readonly log: (line: string) => void

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

    this.log =
      config.log ??
      ((line) => {
        console.warn(line)
      })
    this.jobQueue = new SqliteJobQueue(this.db, config.now)
    this.vectorIndex = new ExactScanIndex(this.db, 'ros_messages', MESSAGE_QUALITY_SQL, this.log)
    this.embedClient = config.embed ? new EmbedClient(config.embed) : undefined
    this.jobRunner = new JobRunner(this.jobQueue, {
      log: this.log,
      ...(config.now ? { now: config.now } : {}),
    })
    this.jobRunner.handle(EMBED_TARGET_TASK, (payload) => this.embedTarget(payload))
    if (this.embedClient) {
      // Backstop: rows that have no job (written before embedding was
      // configured), and rows whose job died during an endpoint outage, are
      // queued again in batches.
      this.jobRunner.sweep({
        name: 'enqueue-unembedded',
        everyMs: 10 * 60 * 1000,
        run: () => {
          this.enqueueUnembedded()
        },
      })
      this.noteEmbedModel(this.embedClient.model)
      if (config.workers ?? true) this.jobRunner.start()
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
        case 1:
          // v2: ros_tags + ros_tag_taxonomy. Both are CREATE IF NOT EXISTS in
          // SCHEMA, already applied above. Stamp to 2.
          break
        case 2:
          // v3: ros_jobs + ros_meta come from SCHEMA. An existing file keeps
          // its old ros_messages, so the vector columns are added here, and
          // what waited in the phase-1 queue moves to the job queue.
          this.migrateToV3()
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

  private migrateToV3(): void {
    const cols = new Set(
      (this.db.prepare('PRAGMA table_info(ros_messages)').all() as Array<{ name: string }>).map(
        (c) => c.name,
      ),
    )
    if (!cols.has('embedding')) this.db.exec('ALTER TABLE ros_messages ADD COLUMN embedding BLOB')
    if (!cols.has('embed_error'))
      this.db.exec('ALTER TABLE ros_messages ADD COLUMN embed_error TEXT')
    if (!cols.has('embed_failures')) {
      this.db.exec('ALTER TABLE ros_messages ADD COLUMN embed_failures INTEGER NOT NULL DEFAULT 0')
    }
    const now = iso()
    this.db
      .prepare(
        `INSERT OR IGNORE INTO ros_jobs
           (id, task, job_key, payload, run_at, attempts, max_attempts, state, created_at, updated_at)
         SELECT q.id, 'embed-target', 'embed-ros_messages-' || q.message_id,
                json_object('targetTable', 'ros_messages', 'targetId', q.message_id),
                q.enqueued_at, 0, 5, 'queued', ?, ?
           FROM ros_embed_queue q`,
      )
      .run(now, now)
    this.db.exec('DELETE FROM ros_embed_queue')
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

        // Queue the row for embedding. Best-effort — never fail the append.
        // Only with an endpoint: without one a job per message would pile up
        // for nothing. Rows written meanwhile are found by the
        // enqueue-unembedded sweep once an endpoint is configured.
        if (this.embedClient) {
          try {
            this.jobQueue.enqueue(
              EMBED_TARGET_TASK,
              { targetTable: 'ros_messages', targetId: id },
              { key: `embed-ros_messages-${id}` },
            )
          } catch {
            // ignore queue failures
          }
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
    // Without a vector arm, a query with no searchable token has no results.
    if (!match && !this.embedClient) return []

    const limit = options?.limit ?? 20
    const agent = options?.agent

    if (this.embedClient) {
      try {
        return await this.hybridSearch(query, match, agent, limit)
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

    if (!match) return []
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

  /**
   * Hybrid search: full-text, a literal arm for queries FTS tokenization
   * mangles, and a vector arm, fused with the policy every backend shares
   * (@rivetos/memory-core). A failed query embedding drops the vector arm
   * rather than failing the search.
   */
  private async hybridSearch(
    query: string,
    match: string | null,
    agent: string | undefined,
    limit: number,
  ): Promise<MemorySearchResult[]> {
    const pool = hybridPoolSize(limit)
    const agentSql = agent ? ' AND m.agent = ?' : ''
    const agentArgs: SQLInputValue[] = agent ? [agent] : []

    const ftsIds = match
      ? (
          this.db
            .prepare(
              `SELECT m.id FROM ros_messages_fts
                 JOIN ros_messages m ON m.id = ros_messages_fts.id
                WHERE ros_messages_fts MATCH ? AND ${MESSAGE_QUALITY_SQL}${agentSql}
                ORDER BY bm25(ros_messages_fts)
                LIMIT ?`,
            )
            .all(match, ...agentArgs, pool) as unknown as Array<{ id: string }>
        ).map((r) => r.id)
      : []

    // Literal arm: substring match, for dotted ids, paths, host:port. Joins
    // the fusion when the query looks literal; otherwise only when full-text
    // found nothing and the query has a token worth a substring try.
    const useLiteral = looksLiteral(query) || (ftsIds.length === 0 && shouldTrigramFallback(query))
    const literalIds = useLiteral ? this.literalIds(query, agentSql, agentArgs, pool) : []

    let vectorIds: string[] = []
    if (this.embedClient) {
      try {
        const vector = await this.embedClient.embedQuery(query)
        // The store may have been closed while the embedding was in flight.
        this.assertOpen()
        vectorIds = this.vectorIndex.search(vector, pool, { agent }).map((h) => h.id)
      } catch (err) {
        if (this.closed) throw err
        this.log(
          `[memory.sqlite] query embedding failed, searching without the vector arm: ${
            err instanceof Error ? err.message : String(err)
          }`,
        )
      }
    }

    const lists = [ftsIds, literalIds, vectorIds].filter((l) => l.length > 0)
    if (lists.length === 0) return []
    const fused = reciprocalRankFusion(lists, (id) => id, HYBRID_RRF_K)
    const ids = [...fused.keys()]
    const rows = new Map<string, HybridRow>()
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500)
      const got = this.db
        .prepare(
          `SELECT id, content, role, agent, created_at, tool_name, access_count
             FROM ros_messages WHERE id IN (${chunk.map(() => '?').join(', ')})`,
        )
        .all(...chunk) as unknown as HybridRow[]
      for (const r of got) rows.set(r.id, r)
    }

    const nowMs = Date.now()
    const scored: Array<{ row: HybridRow; score: number; arms: number }> = []
    for (const [id, { rrf }] of fused) {
      const row = rows.get(id)
      if (!row) continue
      const days = Math.max(0, (nowMs - new Date(row.created_at).getTime()) / 86_400_000)
      const boost =
        temporalDecay(days, row.access_count) * W_TEMPORAL +
        importanceForRole(row.role, row.tool_name !== null) * W_IMPORTANCE
      const arms = lists.reduce((n, l) => n + (l.includes(id) ? 1 : 0), 0)
      scored.push({ row, score: rrf * (1 + boost), arms })
    }
    scored.sort((a, b) => b.score - a.score)
    const top = scored[0]?.score ?? 0
    const kept = scored.filter((s) => s.arms >= 2 || s.score >= top * GATE_FRACTION).slice(0, limit)
    this.bumpAccess(kept.map((k) => k.row.id))
    return kept.map(({ row, score }) => ({
      id: row.id,
      content: row.content,
      role: row.role,
      agent: row.agent,
      relevanceScore: score,
      createdAt: new Date(row.created_at),
    }))
  }

  /**
   * Returned rows are reinforced, as on Postgres: the access count feeds the
   * temporal term (capped). Best-effort — a failed bump never fails a search.
   */
  private bumpAccess(ids: readonly string[]): void {
    if (ids.length === 0) return
    try {
      this.db
        .prepare(
          `UPDATE ros_messages SET access_count = access_count + 1, last_accessed_at = ?
            WHERE id IN (${ids.map(() => '?').join(', ')})`,
        )
        .run(iso(), ...ids)
    } catch {
      // ignore
    }
  }

  /** Newest rows whose content or tool result contains the query text. */
  private literalIds(
    query: string,
    agentSql: string,
    agentArgs: SQLInputValue[],
    pool: number,
  ): string[] {
    const needle = query.trim()
    if (needle.length < 3) return []
    const pattern = `%${needle.replace(/[\\%_]/g, '\\$&')}%`
    return (
      this.db
        .prepare(
          `SELECT m.id FROM ros_messages m
            WHERE (m.content LIKE ? ESCAPE '\\' OR m.tool_result LIKE ? ESCAPE '\\')
              AND ${MESSAGE_QUALITY_SQL}${agentSql}
            ORDER BY m.created_at DESC
            LIMIT ?`,
        )
        .all(pattern, pattern, ...agentArgs, pool) as unknown as Array<{ id: string }>
    ).map((r) => r.id)
  }

  /** `embed-target` job: embed one message and store the vector on its row. */
  private async embedTarget(payload: unknown): Promise<void> {
    const client = this.embedClient
    // No endpoint: leave the work queued for when one is configured.
    if (!client) throw new Error('no embed endpoint configured')
    const p = payload as { targetTable?: unknown; targetId?: unknown } | null
    if (p?.targetTable !== 'ros_messages' || typeof p.targetId !== 'string') return
    const id = p.targetId
    const row = this.db
      .prepare(`SELECT content, tool_result, agent, role FROM ros_messages WHERE id = ?`)
      .get(id) as unknown as
      | { content: string | null; tool_result: string | null; agent: string; role: string }
      | undefined
    // The row was deleted since it was queued: nothing to do.
    if (!row) return
    try {
      const outcome = await client.embedMessage(row.content, row.tool_result)
      if (this.closed) return
      if (outcome.kind === 'unembeddable') {
        this.db
          .prepare(
            `UPDATE ros_messages SET embed_status = 'unembeddable', embed_error = ?, embedding = NULL
              WHERE id = ?`,
          )
          .run(`unembeddable: ${outcome.reason}`, id)
        return
      }
      const blob = encodeVector(outcome.vector)
      if (!blob) throw new Error('embedding is a zero vector')
      this.noteEmbedDims(outcome.vector.length)
      this.db
        .prepare(
          `UPDATE ros_messages
              SET embedding = ?, embed_status = 'done', embed_error = NULL, embed_failures = 0
            WHERE id = ?`,
        )
        .run(blob, id)
      // Searchable rows are the ones past the quality floor (MESSAGE_QUALITY_SQL).
      const body = row.role === 'tool' ? (row.tool_result ?? '') : (row.content ?? '')
      if (body.trim().length >= HYBRID_MIN_CONTENT_LEN) this.vectorIndex.add(id, row.agent, blob)
    } catch (err) {
      if (!this.closed) {
        this.db
          .prepare(
            `UPDATE ros_messages SET embed_error = ?, embed_failures = embed_failures + 1 WHERE id = ?`,
          )
          .run((err instanceof Error ? err.message : String(err)).slice(0, 500), id)
      }
      throw err
    }
  }

  /**
   * Queue rows that still need a vector: those with no job at all, and those
   * whose job went dead (an endpoint outage longer than the retries). Dead
   * jobs are given fresh attempts once per sweep, so a hard-down endpoint is
   * retried on the sweep's interval rather than hammered. Oldest first.
   */
  private enqueueUnembedded(limit = 500): number {
    const now = iso()
    const revived = Number(
      this.db
        .prepare(
          `UPDATE ros_jobs SET state = 'queued', attempts = 0, run_at = ?, updated_at = ?
            WHERE state = 'dead' AND task = ?
              AND EXISTS (SELECT 1 FROM ros_messages m
                           WHERE m.embedding IS NULL AND m.embed_status IS NULL
                             AND ros_jobs.job_key = 'embed-ros_messages-' || m.id)`,
        )
        .run(now, now, EMBED_TARGET_TASK).changes,
    )
    const rows = this.db
      .prepare(
        `SELECT m.id FROM ros_messages m
          WHERE m.embedding IS NULL AND m.embed_status IS NULL
            AND NOT EXISTS (SELECT 1 FROM ros_jobs j WHERE j.job_key = 'embed-ros_messages-' || m.id)
          ORDER BY m.created_at ASC
          LIMIT ?`,
      )
      .all(limit) as unknown as Array<{ id: string }>
    let queued = revived
    for (const { id } of rows) {
      if (
        this.jobQueue.enqueue(
          EMBED_TARGET_TASK,
          { targetTable: 'ros_messages', targetId: id },
          { key: `embed-ros_messages-${id}` },
        )
      ) {
        queued += 1
      }
    }
    return queued
  }

  /**
   * Remember which model wrote the vectors. Vectors from another model are
   * not comparable: when the model changes they are cleared and re-queued.
   */
  private noteEmbedModel(model: string): void {
    const prior = this.db.prepare(`SELECT value FROM ros_meta WHERE key = 'embed_model'`).get() as
      { value: string } | undefined
    if (prior?.value === model) return
    if (prior) {
      this.log(
        `[memory.sqlite] embedding model changed (${prior.value} → ${model}); re-embedding stored messages`,
      )
      this.db.exec(
        `UPDATE ros_messages SET embedding = NULL, embed_status = NULL, embed_error = NULL, embed_failures = 0
          WHERE embedding IS NOT NULL OR embed_status = 'done'`,
      )
      this.vectorIndex.invalidate()
    }
    this.db
      .prepare(
        `INSERT INTO ros_meta (key, value) VALUES ('embed_model', ?)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
      )
      .run(model)
  }

  /**
   * Remember how wide the stored vectors are. A vector of another width (a
   * changed `embed_expected_dims`, or an endpoint that now returns a different
   * size under the same model name) is not comparable with the stored ones:
   * they are cleared and re-queued, like a model change.
   */
  private noteEmbedDims(dims: number): void {
    const prior = this.db.prepare(`SELECT value FROM ros_meta WHERE key = 'embed_dims'`).get() as
      { value: string } | undefined
    if (prior && Number(prior.value) === dims) return
    if (prior) {
      this.log(
        `[memory.sqlite] embedding width changed (${prior.value} → ${String(dims)}); re-embedding stored messages`,
      )
      this.db.exec(
        `UPDATE ros_messages SET embedding = NULL, embed_status = NULL, embed_error = NULL, embed_failures = 0
          WHERE embedding IS NOT NULL OR embed_status = 'done'`,
      )
      this.vectorIndex.invalidate()
    }
    this.db
      .prepare(
        `INSERT INTO ros_meta (key, value) VALUES ('embed_dims', ?)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
      )
      .run(String(dims))
  }

  /** The job queue behind the background work, for stats and requeueing. */
  jobs(): SqliteJobQueue {
    this.assertOpen()
    return this.jobQueue
  }

  /** Run due background jobs now. Returns how many ran. Tests and CLI use this. */
  async runJobs(): Promise<number> {
    this.assertOpen()
    return this.jobRunner.tick()
  }

  /** Stop the job loop and wait for a running job to finish its write. */
  async stopWorkers(): Promise<void> {
    await this.jobRunner.stop()
  }

  /**
   * Session tags on this file (list, pending, decide, add, propose, lookup by
   * session key, counts). Same behaviour as the Postgres tag store; see tags.ts
   * for what phase 1 leaves out.
   */
  tags(): SqliteTagStore {
    this.assertOpen()
    this.tagStore ??= new SqliteTagStore(this.db)
    return this.tagStore
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
    // A job in flight is abandoned, not awaited; it is requeued on the next open.
    this.jobRunner.halt()
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

  /** Test helper — embedding state per message id. */
  embedStateForTest(
    ids: readonly string[],
  ): Record<
    string,
    { status: string | null; error: string | null; dims: number; failures: number }
  > {
    const out: Record<
      string,
      { status: string | null; error: string | null; dims: number; failures: number }
    > = {}
    for (const id of ids) {
      const row = this.db
        .prepare(
          `SELECT embed_status, embed_error, embedding, embed_failures FROM ros_messages WHERE id = ?`,
        )
        .get(id) as unknown as
        | {
            embed_status: string | null
            embed_error: string | null
            embedding: Uint8Array | null
            embed_failures: number
          }
        | undefined
      if (!row) continue
      out[id] = {
        status: row.embed_status,
        error: row.embed_error,
        dims: row.embedding ? row.embedding.byteLength / 4 : 0,
        failures: row.embed_failures,
      }
    }
    return out
  }

  /** Test helper — how often a message was returned by search. */
  accessCountForTest(id: string): number {
    const row = this.db.prepare(`SELECT access_count FROM ros_messages WHERE id = ?`).get(id) as
      { access_count: number } | undefined
    return row?.access_count ?? 0
  }

  /** Test helper — whether a message id has an embed job waiting. */
  hasEmbedQueueEntryForTest(messageId: string): boolean {
    const row = this.db
      .prepare(`SELECT 1 AS ok FROM ros_jobs WHERE job_key = ?`)
      .get(`embed-ros_messages-${messageId}`) as { ok: number } | undefined
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
