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
  SUMMARY_FUSION_BONUS,
  SUMMARY_IMPORTANCE,
  W_IMPORTANCE,
  W_TEMPORAL,
  hybridPoolSize,
  importanceForRole,
  looksLiteral,
  reciprocalRankFusion,
  shouldTrigramFallback,
  temporalDecay,
} from '@rivetos/memory-core'
import { SqliteBackend } from './backend.js'
import { COMPACT_TASK, SqliteCompactor, type CompactionSettings } from './compaction.js'
import { EmbedClient, type EmbedConfig } from './embed.js'
import { JobRunner, SqliteJobQueue } from './jobs.js'
import { LlmClient, type LlmConfig } from './llm.js'
import { SCHEMA, SCHEMA_VERSION } from './schema.js'
import { SqliteTagStore } from './tags.js'
import { ExactScanIndex, encodeVector, type VectorIndex } from './vectors.js'
import { EXTRACT_WIKI_TASK, SqliteWikiExtractor, SqliteWikiIndex } from './wiki.js'

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

/** Merge two ranked lists rank by rank, so neither layer starts at a disadvantage. */
function interleave(a: readonly string[], b: readonly string[]): string[] {
  const out: string[] = []
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    if (i < a.length) out.push(a[i])
    if (i < b.length) out.push(b[i])
  }
  return out
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
   * Summarization endpoint (OpenAI-compatible chat). When set, conversations
   * are compacted into leaf / branch / root summaries in the background, with
   * the same prompts and batch policy as the Postgres worker.
   */
  compactor?: LlmConfig
  /** Batch sizes and idle thresholds; defaults match the Postgres worker. */
  compaction?: Partial<CompactionSettings>
  /**
   * User ids from the users registry other than the node owner. The file is
   * the owner's: these users get no search results or turn context from it,
   * and their sessions (`<channel>:<user>` keys) are neither stored nor read.
   */
  otherUsers?: Iterable<string>
  /**
   * The wiki. `dir` is where the page files live (a git repository the
   * writer creates). With `extraction` on and a compactor endpoint, leaf
   * summaries are mined into pages. Without `dir` there is no wiki.
   */
  wiki?: { dir: string; extraction?: boolean }
  /**
   * Run the in-process job loop (embedding, compaction; wiki and tagging as
   * they land). Default: on when `embed` or `compactor` is set. Turn off to
   * queue work without draining it, e.g. in a short-lived CLI process.
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

/**
 * A summary hit carries the shape the Postgres backend returns: `role` is the
 * summary's kind (leaf, branch, root) and `agent` is this marker. Filtering
 * by agent still goes by the conversation the summary belongs to.
 */
export const SUMMARY_AGENT = 'summary'

/** A search hit that also says which layer it came from. */
export type SqliteSearchHit = MemorySearchResult & { layer: 'message' | 'summary' }

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
  private readonly expectedDims: number | undefined
  private embedStoreReconciled = false
  private readonly clock: () => Date
  private backendInstance: SqliteBackend | undefined
  private readonly otherUsers: ReadonlySet<string>
  private readonly warnedUsers = new Set<string>()
  private readonly summaryIndex: VectorIndex
  private readonly topicIndex: VectorIndex
  private readonly wikiIndex: SqliteWikiIndex | undefined
  private readonly wikiDir: string | undefined
  private readonly wikiExtractor: SqliteWikiExtractor | undefined
  private readonly compactor: SqliteCompactor | undefined
  private readonly log: (line: string) => void

  constructor(config: SqliteMemoryConfig) {
    this.otherUsers = new Set(config.otherUsers ?? [])
    this.clock = config.now ?? (() => new Date())
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
    // Keeps the unembedded-rows sweep proportional to the backlog, not the
    // table. Created on every open, after the migrations: the columns it
    // names do not exist on an older file until those have run.
    this.db.exec(
      `CREATE INDEX IF NOT EXISTS idx_ros_messages_unembedded ON ros_messages (created_at)
        WHERE embedding IS NULL AND embed_status IS NULL`,
    )
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
    this.vectorIndex = new ExactScanIndex(
      this.db,
      `FROM ros_messages m WHERE ${MESSAGE_QUALITY_SQL}`,
      this.log,
    )
    this.summaryIndex = new ExactScanIndex(
      this.db,
      `FROM ros_summaries m LEFT JOIN ros_conversations c ON c.id = m.conversation_id WHERE 1 = 1`,
      this.log,
      'c.agent',
    )
    // Topics are keyed by slug and belong to no agent.
    this.topicIndex = new ExactScanIndex(
      this.db,
      `FROM (SELECT slug AS id, embedding, '' AS agent FROM ros_wiki_topics) m WHERE 1 = 1`,
      this.log,
    )
    this.embedClient = config.embed ? new EmbedClient(config.embed) : undefined
    this.expectedDims = config.embed?.expectedDims
    const embedClient = this.embedClient
    this.wikiDir = config.wiki?.dir
    this.wikiIndex = config.wiki
      ? new SqliteWikiIndex(this.db, {
          ...(embedClient
            ? { embedQuery: (text) => embedClient.embedQuery(text), vectors: this.topicIndex }
            : {}),
          onTopicChanged: (slug) => {
            this.enqueueTopicEmbed(slug)
          },
          now: this.clock,
        })
      : undefined
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
          this.enqueueUnembeddedTopics()
        },
      })
      if (config.workers ?? true) this.reconcileEmbedStore()
      else this.warnOnForeignModel(this.embedClient.model)
    }
    if (config.compactor) {
      const llm = new LlmClient(config.compactor)
      if (config.wiki?.extraction && this.wikiIndex) {
        const extractor = new SqliteWikiExtractor(
          this.db,
          this.wikiIndex,
          config.wiki.dir,
          llm,
          this.jobQueue,
          () => this.tags(),
          { log: this.log, now: this.clock },
        )
        this.wikiExtractor = extractor
        this.jobRunner.handle(EXTRACT_WIKI_TASK, (payload) => extractor.extract(payload))
        // Leaves written before extraction was on, failed ones, and ones mined
        // by an older pipeline version.
        this.jobRunner.sweep({
          name: 'enqueue-wiki-backfill',
          everyMs: 10 * 60 * 1000,
          run: () => {
            extractor.enqueueBackfill()
          },
        })
      }
      this.compactor = new SqliteCompactor(
        this.db,
        llm,
        this.jobQueue,
        config.compaction,
        {
          log: this.log,
          onSummary: ({ id, kind }) => {
            this.enqueueSummaryEmbed(id)
            if (kind === 'leaf') {
              try {
                this.wikiExtractor?.enqueue(id)
              } catch {
                // the backfill sweep picks it up
              }
            }
          },
        },
        config.now,
      )
      const compactor = this.compactor
      this.jobRunner.handle(COMPACT_TASK, async (payload) => {
        await compactor.compactConversation(payload)
      })
      this.jobRunner.sweep({
        name: 'enqueue-idle',
        everyMs: 5 * 60 * 1000,
        run: () => {
          compactor.enqueueIdle()
        },
      })
    }
    if ((this.embedClient || this.compactor) && (config.workers ?? true)) this.jobRunner.start()
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
        case 3:
          // v4: ros_summaries, ros_summary_sources and their FTS table are
          // all new tables, created by SCHEMA above. Stamp to 4.
          break
        case 4:
          // v5: the wiki index tables are all new, created by SCHEMA above.
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
    const now = this.stamp()
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
    // Another registry user's session is neither read nor written here: the
    // file is the owner's, and that user has no store on this node yet.
    if (this.isOtherUsersSession(entry.sessionId)) return randomUUID()
    try {
      return this.tx(() => {
        const taskId = resolveTaskId(entry.sessionId, entry.metadata)
        const convId = this.ensureConversation(entry.sessionId, entry.agent, entry.channel, taskId)
        const id = randomUUID()
        const createdAt = entry.createdAt ? entry.createdAt.toISOString() : this.stamp()
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
        this.enqueueMessageEmbed(id)

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
    /** Filled in when the vector arm was dropped for this query. */
    info?: { degraded?: string },
  ): Promise<SqliteSearchHit[]> {
    this.assertOpen()
    // This file is the node owner's. A turn den resolved to another user gets
    // nothing from it, rather than the owner's transcripts.
    if (this.isOtherUser(options?.userId)) return []
    const scope = options?.scope ?? 'both'
    const limit = options?.limit ?? 20
    const agent = options?.agent
    const match = buildFtsMatchQuery(query)

    try {
      if (this.embedClient) return await this.hybridSearch(query, match, agent, limit, scope, info)
      // No vector arm: full-text only. A query with no searchable token has no results.
      if (!match) return []
      return this.ftsSearch(match, agent, limit, scope)
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

  /** Full-text search over messages and/or summaries, best bm25 first. */
  private ftsSearch(
    match: string,
    agent: string | undefined,
    limit: number,
    scope: 'messages' | 'summaries' | 'both',
  ): SqliteSearchHit[] {
    const out: Array<SqliteSearchHit & { rank: number }> = []
    if (scope !== 'summaries') {
      const rows = this.db
        .prepare(
          `SELECT m.id, m.content, m.role, m.agent, m.created_at,
                  bm25(ros_messages_fts) AS rank
             FROM ros_messages_fts
             JOIN ros_messages m ON m.id = ros_messages_fts.id
            WHERE ros_messages_fts MATCH ?${agent ? ' AND m.agent = ?' : ''}
            ORDER BY rank
            LIMIT ?`,
        )
        .all(...(agent ? [match, agent, limit] : [match, limit])) as unknown as SearchRow[]
      for (const r of rows) {
        out.push({
          id: r.id,
          content: r.content,
          role: r.role,
          agent: r.agent,
          // bm25() is negative for matches; abs so relevance varies and higher = better.
          relevanceScore: relevanceFromBm25(r.rank),
          createdAt: new Date(r.created_at),
          layer: 'message',
          rank: r.rank,
        })
      }
    }
    if (scope !== 'messages') {
      const rows = this.db
        .prepare(
          `SELECT s.id, s.content, s.kind AS role, s.created_at,
                  bm25(ros_summaries_fts) AS rank
             FROM ros_summaries_fts
             JOIN ros_summaries s ON s.id = ros_summaries_fts.id
             LEFT JOIN ros_conversations c ON c.id = s.conversation_id
            WHERE ros_summaries_fts MATCH ?${agent ? ' AND c.agent = ?' : ''}
            ORDER BY rank
            LIMIT ?`,
        )
        .all(...(agent ? [match, agent, limit] : [match, limit])) as unknown as Array<
        Omit<SearchRow, 'agent'>
      >
      for (const r of rows) {
        out.push({
          id: r.id,
          content: r.content,
          // The shape Postgres returns for a summary: role is its kind.
          role: r.role,
          agent: SUMMARY_AGENT,
          relevanceScore: relevanceFromBm25(r.rank),
          createdAt: new Date(r.created_at),
          layer: 'summary',
          rank: r.rank,
        })
      }
    }
    const top = out.sort((x, y) => x.rank - y.rank).slice(0, limit)
    // Returned rows are reinforced on every path, as in hybrid search.
    this.bumpAccess(top.map((h) => (h.layer === 'summary' ? `s:${h.id}` : `m:${h.id}`)))
    return top.map(({ rank: _rank, ...hit }) => hit)
  }

  async getContextForTurn(
    query: string,
    agent: string,
    options?: { maxTokens?: number; userId?: string },
  ): Promise<string> {
    this.assertOpen()
    if (this.isOtherUser(options?.userId)) return ''
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

    // Curated state before raw recall, as on Postgres. A wiki failure costs
    // this turn its wiki section, nothing more.
    if (this.wikiIndex) {
      try {
        const topics = await this.wikiIndex.searchTopics(query, { limit: 3 })
        if (topics.length > 0) {
          const lines: string[] = []
          for (const t of topics) {
            const body =
              t.currentState.slice(0, 1200) + (t.article ? `\n${t.article.slice(0, 800)}` : '')
            const line = `**${t.title}** (wiki:${t.slug})\n${body}`
            tokenEstimate += Math.ceil(line.length / 4)
            if (tokenEstimate > maxTokens) break
            seen.add(dedupKey(t.currentState))
            lines.push(line)
          }
          if (lines.length > 0) sections.push('\n## Wiki (curated state)', ...lines)
        }
      } catch (err) {
        this.log(
          `[memory.sqlite] wiki context skipped: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    }

    const relevant = await this.search(query, { agent, limit: 10, scope: 'both' })
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
    if (this.isOtherUsersSession(sessionId)) return []
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
    if (this.isOtherUsersSession(sessionId)) return
    this.db
      .prepare(
        `UPDATE ros_conversations SET settings = ?, updated_at = ?
         WHERE session_key = ? AND active = 1`,
      )
      .run(JSON.stringify(settings), this.stamp(), sessionId)
  }

  async loadSessionSettings(sessionId: string): Promise<Record<string, unknown> | null> {
    this.assertOpen()
    if (this.isOtherUsersSession(sessionId)) return null
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
      .run(taskId, this.stamp(), sessionId, agent)
  }

  /**
   * Hybrid search over messages and summaries: per layer a full-text arm, a
   * literal arm for queries FTS tokenization mangles, and a vector arm, all
   * fused with the policy every backend shares (@rivetos/memory-core).
   * Summaries get the same fusion bonus and importance as on Postgres. A
   * failed query embedding drops the vector arms rather than failing the search.
   */
  private async hybridSearch(
    query: string,
    match: string | null,
    agent: string | undefined,
    limit: number,
    scope: 'messages' | 'summaries' | 'both',
    info?: { degraded?: string },
  ): Promise<SqliteSearchHit[]> {
    const pool = hybridPoolSize(limit)
    const wantMessages = scope !== 'summaries'
    const wantSummaries = scope !== 'messages'
    const agentArgs: SQLInputValue[] = agent ? [agent] : []
    const key = (layer: 'm' | 's', id: string): string => `${layer}:${id}`

    const fts: string[] = []
    if (match && wantMessages) {
      const rows = this.db
        .prepare(
          `SELECT m.id, bm25(ros_messages_fts) AS rank FROM ros_messages_fts
             JOIN ros_messages m ON m.id = ros_messages_fts.id
            WHERE ros_messages_fts MATCH ? AND ${MESSAGE_QUALITY_SQL}${agent ? ' AND m.agent = ?' : ''}
            ORDER BY rank
            LIMIT ?`,
        )
        .all(match, ...agentArgs, pool) as unknown as Array<{ id: string; rank: number }>
      for (const r of rows) fts.push(key('m', r.id))
    }
    const ftsSummaries: string[] = []
    if (match && wantSummaries) {
      const rows = this.db
        .prepare(
          `SELECT s.id FROM ros_summaries_fts
             JOIN ros_summaries s ON s.id = ros_summaries_fts.id
             LEFT JOIN ros_conversations c ON c.id = s.conversation_id
            WHERE ros_summaries_fts MATCH ?${agent ? ' AND c.agent = ?' : ''}
            ORDER BY bm25(ros_summaries_fts)
            LIMIT ?`,
        )
        .all(match, ...agentArgs, pool) as unknown as Array<{ id: string }>
      for (const r of rows) ftsSummaries.push(key('s', r.id))
    }

    // Literal arm: substring match, for dotted ids, paths, host:port. Joins
    // the fusion when the query looks literal; otherwise only when full-text
    // found nothing and the query has a token worth a substring try.
    const ftsEmpty = fts.length === 0 && ftsSummaries.length === 0
    const useLiteral = looksLiteral(query) || (ftsEmpty && shouldTrigramFallback(query))
    const literal = useLiteral
      ? this.literalKeys(query, agent, pool, wantMessages, wantSummaries)
      : []

    const vector: string[] = []
    const vectorSummaries: string[] = []
    if (this.embedClient) {
      try {
        const queryVector = await this.embedClient.embedQuery(query)
        // The store may have been closed while the embedding was in flight.
        this.assertOpen()
        if (wantMessages) {
          for (const h of this.vectorIndex.search(queryVector, pool, { agent })) {
            vector.push(key('m', h.id))
          }
        }
        if (wantSummaries) {
          for (const h of this.summaryIndex.search(queryVector, pool, { agent })) {
            vectorSummaries.push(key('s', h.id))
          }
        }
      } catch (err) {
        if (this.closed) throw err
        const reason = err instanceof Error ? err.message : String(err)
        if (info) info.degraded = `query embedding failed: ${reason}`
        this.log(
          `[memory.sqlite] query embedding failed, searching without the vector arm: ${reason}`,
        )
      }
    }

    // One ranked list per arm, both layers interleaved by their own rank, as
    // the Postgres arms return messages and summaries together.
    const lists = [
      interleave(fts, ftsSummaries),
      literal,
      interleave(vector, vectorSummaries),
    ].filter((l) => l.length > 0)
    if (lists.length === 0) return []
    const fused = reciprocalRankFusion(lists, (k) => k, HYBRID_RRF_K)
    const rows = this.loadHits([...fused.keys()])

    const nowMs = Date.now()
    const scored: Array<{ key: string; row: HybridRow; score: number; arms: number }> = []
    for (const [k, { rrf }] of fused) {
      const row = rows.get(k)
      if (!row) continue
      const isSummary = k.startsWith('s:')
      const days = Math.max(0, (nowMs - new Date(row.created_at).getTime()) / 86_400_000)
      const importance = isSummary
        ? SUMMARY_IMPORTANCE
        : importanceForRole(row.role, row.tool_name !== null)
      const boost = temporalDecay(days, row.access_count) * W_TEMPORAL + importance * W_IMPORTANCE
      const arms = lists.reduce((n, l) => n + (l.includes(k) ? 1 : 0), 0)
      scored.push({
        key: k,
        row,
        score: rrf * (1 + boost) * (isSummary ? SUMMARY_FUSION_BONUS : 1),
        arms,
      })
    }
    scored.sort((a, b) => b.score - a.score)
    const top = scored[0]?.score ?? 0
    const kept = scored.filter((s) => s.arms >= 2 || s.score >= top * GATE_FRACTION).slice(0, limit)
    this.bumpAccess(kept.map((k) => k.key))
    return kept.map(({ key: k, row, score }) => ({
      id: row.id,
      content: row.content,
      role: row.role,
      agent: row.agent,
      relevanceScore: score,
      createdAt: new Date(row.created_at),
      layer: k.startsWith('s:') ? 'summary' : 'message',
    }))
  }

  /** Rows behind fused keys (`m:<id>` message, `s:<id>` summary). */
  private loadHits(keys: readonly string[]): Map<string, HybridRow> {
    const out = new Map<string, HybridRow>()
    const messageIds = keys.filter((k) => k.startsWith('m:')).map((k) => k.slice(2))
    const summaryIds = keys.filter((k) => k.startsWith('s:')).map((k) => k.slice(2))
    for (let i = 0; i < messageIds.length; i += 500) {
      const chunk = messageIds.slice(i, i + 500)
      const got = this.db
        .prepare(
          `SELECT id, content, role, agent, created_at, tool_name, access_count
             FROM ros_messages WHERE id IN (${chunk.map(() => '?').join(', ')})`,
        )
        .all(...chunk) as unknown as HybridRow[]
      for (const r of got) out.set(`m:${r.id}`, r)
    }
    for (let i = 0; i < summaryIds.length; i += 500) {
      const chunk = summaryIds.slice(i, i + 500)
      const got = this.db
        .prepare(
          `SELECT s.id, s.content, s.kind AS role, '${SUMMARY_AGENT}' AS agent,
                  s.created_at, NULL AS tool_name, s.access_count
             FROM ros_summaries s
            WHERE s.id IN (${chunk.map(() => '?').join(', ')})`,
        )
        .all(...chunk) as unknown as HybridRow[]
      for (const r of got) out.set(`s:${r.id}`, r)
    }
    return out
  }

  /**
   * Returned rows are reinforced, as on Postgres: the access count feeds the
   * temporal term (capped). Best-effort — a failed bump never fails a search.
   */
  private bumpAccess(keys: readonly string[]): void {
    const now = this.stamp()
    for (const [prefix, table] of [
      ['m:', 'ros_messages'],
      ['s:', 'ros_summaries'],
    ] as const) {
      const ids = keys.filter((k) => k.startsWith(prefix)).map((k) => k.slice(2))
      try {
        for (let i = 0; i < ids.length; i += 500) {
          const chunk = ids.slice(i, i + 500)
          this.db
            .prepare(
              `UPDATE ${table} SET access_count = access_count + 1, last_accessed_at = ?
                WHERE id IN (${chunk.map(() => '?').join(', ')})`,
            )
            .run(now, ...chunk)
        }
      } catch {
        // access stats are best-effort
      }
    }
  }

  /** Newest rows whose text contains the query, as fused keys. */
  private literalKeys(
    query: string,
    agent: string | undefined,
    pool: number,
    wantMessages: boolean,
    wantSummaries: boolean,
  ): string[] {
    const needle = query.trim()
    if (needle.length < 3) return []
    const pattern = `%${needle.replace(/[\\%_]/g, '\\$&')}%`
    const agentArgs: SQLInputValue[] = agent ? [agent] : []
    const found: Array<{ key: string; at: string }> = []
    if (wantMessages) {
      const rows = this.db
        .prepare(
          `SELECT m.id, m.created_at FROM ros_messages m
            WHERE (m.content LIKE ? ESCAPE '\\' OR m.tool_result LIKE ? ESCAPE '\\')
              AND ${MESSAGE_QUALITY_SQL}${agent ? ' AND m.agent = ?' : ''}
            ORDER BY m.created_at DESC
            LIMIT ?`,
        )
        .all(pattern, pattern, ...agentArgs, pool) as unknown as Array<{
        id: string
        created_at: string
      }>
      for (const r of rows) found.push({ key: `m:${r.id}`, at: r.created_at })
    }
    if (wantSummaries) {
      const rows = this.db
        .prepare(
          `SELECT s.id, s.created_at FROM ros_summaries s
             LEFT JOIN ros_conversations c ON c.id = s.conversation_id
            WHERE s.content LIKE ? ESCAPE '\\'${agent ? ' AND c.agent = ?' : ''}
            ORDER BY s.created_at DESC
            LIMIT ?`,
        )
        .all(pattern, ...agentArgs, pool) as unknown as Array<{ id: string; created_at: string }>
      for (const r of rows) found.push({ key: `s:${r.id}`, at: r.created_at })
    }
    return found
      .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
      .slice(0, pool)
      .map((f) => f.key)
  }

  /** `embed-target` job: embed one message or summary and store the vector on its row. */
  private async embedTarget(payload: unknown): Promise<void> {
    const client = this.embedClient
    // No endpoint: leave the work queued for when one is configured.
    if (!client) throw new Error('no embed endpoint configured')
    const p = payload as { targetTable?: unknown; targetId?: unknown } | null
    if (typeof p?.targetId !== 'string') return
    const id = p.targetId
    if (p.targetTable === 'ros_summaries') {
      await this.embedSummary(client, id)
      return
    }
    if (p.targetTable === 'ros_wiki_topics') {
      await this.embedTopic(client, id)
      return
    }
    if (p.targetTable !== 'ros_messages') return
    const row = this.db
      .prepare(`SELECT content, tool_result, agent FROM ros_messages WHERE id = ?`)
      .get(id) as unknown as
      { content: string | null; tool_result: string | null; agent: string } | undefined
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
      // The index applies the quality floor itself (MESSAGE_QUALITY_SQL).
      this.vectorIndex.add(id, row.agent, blob)
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

  private async embedSummary(client: EmbedClient, id: string): Promise<void> {
    const row = this.db
      .prepare(
        `SELECT s.content, coalesce(c.agent, '') AS agent FROM ros_summaries s
           LEFT JOIN ros_conversations c ON c.id = s.conversation_id
          WHERE s.id = ?`,
      )
      .get(id) as unknown as { content: string; agent: string } | undefined
    if (!row) return
    try {
      const outcome = await client.embedMessage(row.content, null)
      if (this.closed) return
      if (outcome.kind === 'unembeddable') {
        this.db
          .prepare(
            `UPDATE ros_summaries SET embed_status = 'unembeddable', embed_error = ?, embedding = NULL
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
          `UPDATE ros_summaries
              SET embedding = ?, embed_status = 'done', embed_error = NULL, embed_failures = 0
            WHERE id = ?`,
        )
        .run(blob, id)
      this.summaryIndex.add(id, row.agent, blob)
    } catch (err) {
      if (!this.closed) {
        this.db
          .prepare(
            `UPDATE ros_summaries SET embed_error = ?, embed_failures = embed_failures + 1 WHERE id = ?`,
          )
          .run((err instanceof Error ? err.message : String(err)).slice(0, 500), id)
      }
      throw err
    }
  }

  /** Embed a wiki topic's search text; the row is keyed by slug. */
  private async embedTopic(client: EmbedClient, slug: string): Promise<void> {
    const row = this.db
      .prepare(`SELECT search_text FROM ros_wiki_topics WHERE slug = ?`)
      .get(slug) as { search_text: string } | undefined
    if (!row) return
    try {
      const outcome = await client.embedMessage(row.search_text, null)
      if (this.closed) return
      if (outcome.kind === 'unembeddable') {
        this.db
          .prepare(
            `UPDATE ros_wiki_topics SET embed_status = 'unembeddable', embed_error = ?, embedding = NULL
              WHERE slug = ?`,
          )
          .run(`unembeddable: ${outcome.reason}`, slug)
        return
      }
      const blob = encodeVector(outcome.vector)
      if (!blob) throw new Error('embedding is a zero vector')
      this.noteEmbedDims(outcome.vector.length)
      // Only if the text is still the one that was embedded: a page rewritten
      // meanwhile has a newer job of its own.
      const stored = this.db
        .prepare(
          `UPDATE ros_wiki_topics
              SET embedding = ?, embed_status = 'done', embed_error = NULL, embed_failures = 0
            WHERE slug = ? AND search_text = ?`,
        )
        .run(blob, slug, row.search_text)
      if (Number(stored.changes) > 0) this.topicIndex.add(slug, '', blob)
    } catch (err) {
      if (!this.closed) {
        this.db
          .prepare(
            `UPDATE ros_wiki_topics SET embed_error = ?, embed_failures = embed_failures + 1 WHERE slug = ?`,
          )
          .run((err instanceof Error ? err.message : String(err)).slice(0, 500), slug)
      }
      throw err
    }
  }

  /** Queue a wiki topic whose search text changed (no-op without an endpoint). */
  private enqueueTopicEmbed(slug: string): void {
    if (!this.embedClient) return
    const payload = { targetTable: 'ros_wiki_topics', targetId: slug }
    const key = `embed-ros_wiki_topics-${slug}`
    try {
      // A dead job for an older text holds the key: give it the new work.
      if (!this.jobQueue.enqueue(EMBED_TARGET_TASK, payload, { key })) {
        this.jobQueue.revive(key, payload)
      }
    } catch {
      // the sweep picks it up
    }
  }

  /** Topics that still need a vector and have no job (the sweep's wiki half). */
  private enqueueUnembeddedTopics(limit = 200): number {
    const rows = this.db
      .prepare(
        `SELECT t.slug FROM ros_wiki_topics t
          WHERE t.embedding IS NULL AND t.embed_status IS NULL AND length(t.search_text) > 20
            AND NOT EXISTS (SELECT 1 FROM ros_jobs j
                             WHERE j.job_key = 'embed-ros_wiki_topics-' || t.slug AND j.state <> 'dead')
          ORDER BY t.updated_at ASC LIMIT ?`,
      )
      .all(limit) as unknown as Array<{ slug: string }>
    for (const { slug } of rows) this.enqueueTopicEmbed(slug)
    return rows.length
  }

  /** Queue a freshly written summary for embedding (no-op without an endpoint). */
  private enqueueSummaryEmbed(id: string): void {
    if (!this.embedClient) return
    try {
      this.jobQueue.enqueue(
        EMBED_TARGET_TASK,
        { targetTable: 'ros_summaries', targetId: id },
        { key: `embed-ros_summaries-${id}` },
      )
    } catch {
      // ignore queue failures
    }
  }

  /**
   * Queue rows that still need a vector: those with no job at all, and those
   * whose job went dead (an endpoint outage longer than the retries). Dead
   * jobs get fresh attempts and are due at once; the single-job runner and
   * the queue's backoff pace them, and they can go dead again at most once
   * per sweep. Oldest first.
   */
  private enqueueUnembedded(limit = 500): number {
    const now = this.stamp()
    let queued = 0
    for (const table of ['ros_messages', 'ros_summaries'] as const) {
      const prefix = `embed-${table}-`
      queued += Number(
        this.db
          .prepare(
            `UPDATE ros_jobs SET state = 'queued', attempts = 0, run_at = ?, updated_at = ?
              WHERE state = 'dead' AND task = ?
                AND EXISTS (SELECT 1 FROM ${table} m
                             WHERE m.embedding IS NULL AND m.embed_status IS NULL
                               AND ros_jobs.job_key = ? || m.id)`,
          )
          .run(now, now, EMBED_TARGET_TASK, prefix).changes,
      )
      // Dead jobs whose row no longer needs a vector (embedded since, marked
      // unembeddable, or deleted) would otherwise sit in the queue for good.
      this.db
        .prepare(
          `DELETE FROM ros_jobs
            WHERE state = 'dead' AND task = ? AND substr(job_key, 1, length(?)) = ?
              AND NOT EXISTS (SELECT 1 FROM ${table} m
                               WHERE m.embedding IS NULL AND m.embed_status IS NULL
                                 AND ros_jobs.job_key = ? || m.id)`,
        )
        .run(EMBED_TARGET_TASK, prefix, prefix, prefix)
      const rows = this.db
        .prepare(
          `SELECT m.id FROM ${table} m
            WHERE m.embedding IS NULL AND m.embed_status IS NULL
              AND NOT EXISTS (SELECT 1 FROM ros_jobs j WHERE j.job_key = ? || m.id)
            ORDER BY m.created_at ASC
            LIMIT ?`,
        )
        .all(prefix, limit) as unknown as Array<{ id: string }>
      for (const { id } of rows) {
        if (
          this.jobQueue.enqueue(
            EMBED_TARGET_TASK,
            { targetTable: table, targetId: id },
            { key: `${prefix}${id}` },
          )
        ) {
          queued += 1
        }
      }
    }
    return queued
  }

  /**
   * Bring the stored vectors in line with the configured model: a model
   * change clears them for re-embedding, and a store without a recorded
   * width adopts one. Runs once, when this process starts draining jobs
   * (worker start, or the first `runJobs()`).
   */
  reconcileEmbedStore(): void {
    this.assertOpen()
    if (this.embedStoreReconciled || !this.embedClient) return
    const model = this.embedClient.model
    // One transaction: a failure leaves the store as it was, to try again.
    this.tx(() => {
      this.noteEmbedModel(model)
      this.adoptEmbedDims()
    })
    this.embedStoreReconciled = true
  }

  private warnOnForeignModel(model: string): void {
    const prior = this.db.prepare(`SELECT value FROM ros_meta WHERE key = 'embed_model'`).get() as
      { value: string } | undefined
    if (prior && prior.value !== model) {
      this.log(
        `[memory.sqlite] stored vectors were written by ${prior.value}, this process is configured for ${model}; ` +
          `they are re-embedded only by a process that runs the job loop`,
      )
    }
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
        `[memory.sqlite] embedding model changed (${prior.value} → ${model}); re-embedding stored messages and summaries`,
      )
      this.clearVectors()
      // No vectors are left, so the new model is free to set its own width.
      this.db.exec(`DELETE FROM ros_meta WHERE key = 'embed_dims'`)
    }
    this.db
      .prepare(
        `INSERT INTO ros_meta (key, value) VALUES ('embed_model', ?)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
      )
      .run(model)
  }

  /**
   * Check a new vector's width against the store's. Vectors of different
   * widths are not comparable, but one odd response must not destroy the
   * store: a width that differs from the recorded one clears and re-embeds
   * only when it is the configured `embed_expected_dims` (a deliberate
   * change). Otherwise the job fails and says what to set.
   */
  private noteEmbedDims(dims: number): void {
    const prior = this.db.prepare(`SELECT value FROM ros_meta WHERE key = 'embed_dims'`).get() as
      { value: string } | undefined
    if (prior && Number(prior.value) === dims) return
    if (prior) {
      if (this.expectedDims !== dims) {
        throw new Error(
          `embedding is ${String(dims)} wide but the store holds ${prior.value}-wide vectors; ` +
            `set embed_expected_dims to ${String(dims)} to re-embed at the new width`,
        )
      }
      this.log(
        `[memory.sqlite] embedding width changed (${prior.value} → ${String(dims)}); re-embedding stored messages and summaries`,
      )
      this.clearVectors()
    }
    this.db
      .prepare(
        `INSERT INTO ros_meta (key, value) VALUES ('embed_dims', ?)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
      )
      .run(String(dims))
  }

  /**
   * A store written before the width was recorded: adopt the width most
   * vectors have, and re-queue the rest instead of leaving them out of
   * vector search for good.
   */
  private adoptEmbedDims(): void {
    const known = this.db.prepare(`SELECT 1 AS ok FROM ros_meta WHERE key = 'embed_dims'`).get()
    if (known) return
    const widths = this.db
      .prepare(
        `SELECT dims, count(*) AS n FROM (
           SELECT length(embedding) / 4 AS dims FROM ros_messages WHERE embedding IS NOT NULL
           UNION ALL
           SELECT length(embedding) / 4 FROM ros_summaries WHERE embedding IS NOT NULL
           UNION ALL
           SELECT length(embedding) / 4 FROM ros_wiki_topics WHERE embedding IS NOT NULL
         ) GROUP BY dims ORDER BY n DESC, dims DESC`,
      )
      .all() as unknown as Array<{ dims: number; n: number }>
    if (widths.length === 0) return
    const dims = widths[0].dims
    this.db
      .prepare(`INSERT OR REPLACE INTO ros_meta (key, value) VALUES ('embed_dims', ?)`)
      .run(String(dims))
    let reset = 0
    for (const table of ['ros_messages', 'ros_summaries', 'ros_wiki_topics']) {
      reset += Number(
        this.db
          .prepare(
            `UPDATE ${table} SET embedding = NULL, embed_status = NULL, embed_error = NULL, embed_failures = 0
              WHERE embedding IS NOT NULL AND length(embedding) <> ?`,
          )
          .run(dims * 4).changes,
      )
    }
    if (reset > 0) {
      // The indexes may already hold the rows that were just reset.
      this.vectorIndex.invalidate()
      this.summaryIndex.invalidate()
      this.topicIndex.invalidate()
      this.log(
        `[memory.sqlite] ${String(reset)} stored vector(s) were not ${String(dims)} wide and will be re-embedded`,
      )
    }
  }

  /** Drop every stored vector (messages and summaries) so the sweep re-embeds them. */
  private clearVectors(): void {
    for (const table of ['ros_messages', 'ros_summaries', 'ros_wiki_topics']) {
      this.db.exec(
        `UPDATE ${table} SET embedding = NULL, embed_status = NULL, embed_error = NULL, embed_failures = 0
          WHERE embedding IS NOT NULL OR embed_status = 'done'`,
      )
    }
    this.vectorIndex.invalidate()
    this.summaryIndex.invalidate()
    this.topicIndex.invalidate()
  }

  /** Summaries for stats, tools and tests: by depth, oldest first. */
  summariesForConversation(conversationId: string): Array<{
    id: string
    kind: string
    depth: number
    parentId: string | null
    content: string
    messageCount: number
    model: string | null
  }> {
    this.assertOpen()
    return (
      this.db
        .prepare(
          `SELECT id, kind, depth, parent_id, content, message_count, model FROM ros_summaries
            WHERE conversation_id = ? ORDER BY depth, created_at, id`,
        )
        .all(conversationId) as unknown as Array<{
        id: string
        kind: string
        depth: number
        parent_id: string | null
        content: string
        message_count: number
        model: string | null
      }>
    ).map((r) => ({
      id: r.id,
      kind: r.kind,
      depth: r.depth,
      parentId: r.parent_id,
      content: r.content,
      messageCount: r.message_count,
      model: r.model,
    }))
  }

  /** The wiki index and where its page files live; undefined without a wiki. */
  wiki(): { index: SqliteWikiIndex; wikiDir: string; extractor?: SqliteWikiExtractor } | undefined {
    this.assertOpen()
    if (!this.wikiIndex || !this.wikiDir) return undefined
    return {
      index: this.wikiIndex,
      wikiDir: this.wikiDir,
      ...(this.wikiExtractor ? { extractor: this.wikiExtractor } : {}),
    }
  }

  /**
   * The wider surface (capture, the hub's Memory pages, tools over HTTP) on
   * this store. See `MemoryBackend` in `@rivetos/types`.
   */
  backend(): SqliteBackend {
    this.assertOpen()
    this.backendInstance ??= new SqliteBackend({
      db: this.db,
      tx: (fn) => this.tx(fn),
      search: (query, options, info) => this.search(query, options, info),
      hasEmbedding: () => this.embedClient !== undefined,
      hasCompactor: () => this.compactor !== undefined,
      workersRunning: () => this.jobRunner.isRunning(),
      enqueueMessageEmbed: (id) => {
        this.enqueueMessageEmbed(id)
      },
      tags: () => this.tags(),
      wiki: () => this.wiki(),
      assertOpen: () => {
        this.assertOpen()
      },
    })
    return this.backendInstance
  }

  private enqueueMessageEmbed(id: string): void {
    // Only with an endpoint: without one a job per message would pile up
    // for nothing. Rows written meanwhile are found by the
    // enqueue-unembedded sweep once an endpoint is configured.
    if (!this.embedClient) return
    try {
      this.jobQueue.enqueue(
        EMBED_TARGET_TASK,
        { targetTable: 'ros_messages', targetId: id },
        { key: `embed-ros_messages-${id}` },
      )
    } catch {
      // Best-effort: a write never fails because of the queue.
    }
  }

  /** The job queue behind the background work, for stats and requeueing. */
  jobs(): SqliteJobQueue {
    this.assertOpen()
    return this.jobQueue
  }

  /** Run due background jobs now. Returns how many ran. Tests and CLI use this. */
  async runJobs(): Promise<number> {
    this.assertOpen()
    this.reconcileEmbedStore()
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

  /** Now, as stored text. One clock for rows and jobs, so their timestamps compare. */
  private stamp(): string {
    return this.clock().toISOString()
  }

  /** True for a user id the registry lists as someone other than the owner. */
  private isOtherUser(userId: string | undefined): boolean {
    return userId !== undefined && this.otherUsers.has(userId)
  }

  /**
   * True when a session key names another registry user. Session keys are
   * `<channel>:<user>` (the turn handler's convention, and the one the
   * Postgres backend routes by); `task:<id>` is the task engine's and never
   * a user's.
   */
  private isOtherUsersSession(sessionId: string): boolean {
    if (this.otherUsers.size === 0 || sessionId.startsWith('task:')) return false
    const at = sessionId.lastIndexOf(':')
    if (at < 0 || at === sessionId.length - 1) return false
    const user = sessionId.slice(at + 1)
    if (!this.otherUsers.has(user)) return false
    if (!this.warnedUsers.has(user)) {
      this.warnedUsers.add(user)
      this.log(
        `[memory.sqlite] user "${user}" has no memory on this node: the store is the owner's, so their sessions are not stored or read`,
      )
    }
    return true
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
    const now = this.stamp()
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

  /** Test helper — run a raw statement (fixtures that no API writes). */
  rawForTest(sql: string): void {
    this.db.exec(sql)
  }

  /** Test helper — row count of one of the store's tables. */
  countForTest(table: string): number {
    if (!/^ros_[a-z_]+$/.test(table)) throw new Error('not a store table')
    return (this.db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n
  }

  /** Test helper — wiki extraction status per summary, oldest first. */
  extractionStatusForTest(): string[] {
    return (
      this.db
        .prepare(`SELECT status FROM ros_wiki_extractions ORDER BY extracted_at, summary_id`)
        .all() as unknown as Array<{ status: string }>
    ).map((r) => r.status)
  }

  /** Test helper — width of a wiki topic's stored vector (0 when none). */
  topicEmbedDimsForTest(slug: string): number {
    const row = this.db
      .prepare(`SELECT embedding FROM ros_wiki_topics WHERE slug = ?`)
      .get(slug) as { embedding: Uint8Array | null } | undefined
    return row?.embedding ? row.embedding.byteLength / 4 : 0
  }

  /** Test helper — the conversation id for a session and agent. */
  conversationIdForTest(sessionId: string, agent: string): string {
    const row = this.db
      .prepare(`SELECT id FROM ros_conversations WHERE session_key = ? AND agent = ?`)
      .get(sessionId, agent) as { id: string } | undefined
    return row?.id ?? ''
  }

  /** Test helper — queue a compaction job for a conversation now. */
  enqueueCompactionForTest(sessionId: string, agent: string): void {
    const id = this.conversationIdForTest(sessionId, agent)
    this.jobQueue.enqueue(
      COMPACT_TASK,
      { conversationId: id, triggerType: 'session_idle' },
      { key: `compact-${id}`, maxAttempts: 3 },
    )
  }

  /** Test helper — how often a summary was returned by search. */
  summaryAccessCountForTest(id: string): number {
    const row = this.db.prepare(`SELECT access_count FROM ros_summaries WHERE id = ?`).get(id) as
      { access_count: number } | undefined
    return row?.access_count ?? 0
  }

  /** Test helper — width of a summary's stored vector (0 when none). */
  summaryEmbedDimsForTest(id: string): number {
    const row = this.db.prepare(`SELECT embedding FROM ros_summaries WHERE id = ?`).get(id) as
      { embedding: Uint8Array | null } | undefined
    return row?.embedding ? row.embedding.byteLength / 4 : 0
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
