/**
 * Summaries for the SQLite backend: the same bottom-up compaction the
 * Postgres worker runs — leaves over batches of messages, branches over
 * leaves, a root over branches — with the same prompts, budgets and batch
 * policy (@rivetos/memory-core), on the in-process job loop.
 *
 * One process, one writer: where the Postgres task needs row locks and a lock
 * order, this needs only that each write is one transaction and re-checks
 * that its inputs are still unclaimed (the LLM call in between is awaited, so
 * an append or another job can run meanwhile).
 */

import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import {
  BRANCH_MAX_TOKENS,
  BRANCH_SYSTEM_PROMPT,
  DEFAULT_BRANCH_BATCH,
  DEFAULT_IDLE_MINUTES,
  DEFAULT_LEAF_BATCH,
  DEFAULT_MIN_BRANCHES_FOR_ROOT,
  DEFAULT_MIN_LEAVES_FOR_BRANCH,
  DEFAULT_ROOT_BATCH,
  DEFAULT_STALE_MINUTES,
  DEFAULT_STALE_MIN_BATCH,
  LEAF_MAX_TOKENS,
  LEAF_SYSTEM_PROMPT,
  MAX_LEAF_ROUNDS,
  MIN_BATCH_SIZE,
  PIPELINE_VERSION,
  ROOT_MAX_TOKENS,
  ROOT_SYSTEM_PROMPT,
  formatBranchPrompt,
  formatLeafPrompt,
  formatRootPrompt,
  isLlmTruncationError,
  leafFloorFor,
  shrinkLeafBatch,
  type CompactMessageRow,
  type ConversationMeta,
  type SummaryRow,
} from '@rivetos/memory-core'
import type { SqliteJobQueue } from './jobs.js'
import type { LlmClient } from './llm.js'

export const COMPACT_TASK = 'compact-conversation'

export interface CompactionSettings {
  leafBatch: number
  branchBatch: number
  rootBatch: number
  minLeavesForBranch: number
  minBranchesForRoot: number
  idleMinutes: number
  staleMinutes: number
  staleMinBatch: number
}

export const DEFAULT_COMPACTION_SETTINGS: CompactionSettings = {
  leafBatch: DEFAULT_LEAF_BATCH,
  branchBatch: DEFAULT_BRANCH_BATCH,
  rootBatch: DEFAULT_ROOT_BATCH,
  minLeavesForBranch: DEFAULT_MIN_LEAVES_FOR_BRANCH,
  minBranchesForRoot: DEFAULT_MIN_BRANCHES_FOR_ROOT,
  idleMinutes: DEFAULT_IDLE_MINUTES,
  staleMinutes: DEFAULT_STALE_MINUTES,
  staleMinBatch: DEFAULT_STALE_MIN_BATCH,
}

/** Conversations the idle sweep considers per pass. */
const ENQUEUE_LIMIT = 50

/** Messages worth summarizing: real text, or a tool call. Same rule as Postgres. */
const SUMMARIZABLE_SQL = `((m.content IS NOT NULL AND length(m.content) > 10) OR m.tool_name IS NOT NULL)`

interface ConvRow {
  id: string
  session_key: string | null
  agent: string | null
  channel: string | null
  channel_id: string | null
  title: string | null
}

interface MessageRow {
  id: string
  role: string
  content: string
  agent: string
  created_at: string
  tool_name: string | null
  tool_args: string | null
}

interface ChildRow {
  id: string
  content: string
  kind: string
  earliest_at: string | null
  latest_at: string | null
  message_count: number
  created_at: string
}

export interface CompactionHooks {
  /** Called after a summary row is committed (embedding, later wiki and tags). */
  onSummary?: (summary: {
    id: string
    kind: 'leaf' | 'branch' | 'root'
    conversationId: string
  }) => void
  log?: (line: string) => void
}

export class SqliteCompactor {
  private readonly settings: CompactionSettings
  private readonly log: (line: string) => void

  constructor(
    private readonly db: DatabaseSync,
    private readonly llm: LlmClient,
    private readonly jobs: SqliteJobQueue,
    settings: Partial<CompactionSettings> = {},
    private readonly hooks: CompactionHooks = {},
    private readonly now: () => Date = () => new Date(),
  ) {
    this.settings = { ...DEFAULT_COMPACTION_SETTINGS, ...settings }
    this.log = hooks.log ?? (() => {})
  }

  /**
   * Sweep: queue a compaction job for every conversation with enough
   * unsummarized messages — a full leaf window at once, a floor-sized backlog
   * once the conversation has gone idle, or a below-floor tail once it has
   * gone stale. Heartbeat conversations are never summarized.
   */
  enqueueIdle(): number {
    const s = this.settings
    const nowMs = this.now().getTime()
    const idleBefore = new Date(nowMs - s.idleMinutes * 60_000).toISOString()
    const staleBefore = new Date(nowMs - s.staleMinutes * 60_000).toISOString()
    const rows = this.db
      .prepare(
        `SELECT c.id AS conversation_id, count(m.id) AS unsummarized, c.updated_at
           FROM ros_conversations c
           JOIN ros_messages m ON m.conversation_id = c.id
           LEFT JOIN ros_summary_sources ss ON ss.message_id = m.id
          WHERE ss.summary_id IS NULL
            AND ${SUMMARIZABLE_SQL}
            AND (c.session_key IS NULL OR c.session_key NOT LIKE 'heartbeat:%')
          GROUP BY c.id
         HAVING (count(m.id) >= ? AND (count(m.id) >= ? OR c.updated_at < ?))
             OR (count(m.id) >= ? AND c.updated_at < ?)
          ORDER BY c.updated_at ASC
          LIMIT ?`,
      )
      .all(
        MIN_BATCH_SIZE,
        s.leafBatch,
        idleBefore,
        s.staleMinBatch,
        staleBefore,
        ENQUEUE_LIMIT,
      ) as unknown as Array<{
      conversation_id: string
      unsummarized: number
      updated_at: string
    }>
    let queued = 0
    for (const row of rows) {
      const triggerType = row.unsummarized >= MIN_BATCH_SIZE ? 'session_idle' : 'session_stale'
      if (
        this.jobs.enqueue(
          COMPACT_TASK,
          { conversationId: row.conversation_id, triggerType },
          { key: `compact-${row.conversation_id}`, maxAttempts: 3 },
        )
      ) {
        queued += 1
      }
    }
    return queued
  }

  /** `compact-conversation` job: leaves, then a branch, then a root. Returns summaries written. */
  async compactConversation(payload: unknown): Promise<number> {
    const p = payload as { conversationId?: unknown; triggerType?: unknown } | null
    if (typeof p?.conversationId !== 'string') return 0
    const conversationId = p.conversationId
    const conv = this.db
      .prepare(
        `SELECT id, session_key, agent, channel, channel_id, title
           FROM ros_conversations WHERE id = ?`,
      )
      .get(conversationId) as unknown as ConvRow | undefined
    if (!conv) return 0
    if (conv.session_key?.startsWith('heartbeat:')) return 0
    const meta: ConversationMeta = {
      id: conv.id,
      agent: conv.agent,
      channel: conv.channel,
      channel_id: conv.channel_id,
      title: conv.title,
    }
    const leafFloor = leafFloorFor(
      typeof p.triggerType === 'string' ? p.triggerType : undefined,
      this.settings.staleMinBatch,
    )

    let created = 0
    for (let round = 0; round < MAX_LEAF_ROUNDS; round += 1) {
      const wrote = await this.compactLeaf(meta, conversationId, leafFloor)
      if (!wrote) break
      created += 1
    }
    if (
      await this.compactParent(meta, conversationId, {
        childKind: 'leaf',
        kind: 'branch',
        depth: 1,
        batchSize: this.settings.branchBatch,
        minChildren: this.settings.minLeavesForBranch,
        systemPrompt: BRANCH_SYSTEM_PROMPT,
        maxTokens: BRANCH_MAX_TOKENS,
        format: formatBranchPrompt,
      })
    ) {
      created += 1
    }
    if (
      await this.compactParent(meta, conversationId, {
        childKind: 'branch',
        kind: 'root',
        depth: 2,
        batchSize: this.settings.rootBatch,
        minChildren: this.settings.minBranchesForRoot,
        systemPrompt: ROOT_SYSTEM_PROMPT,
        maxTokens: ROOT_MAX_TOKENS,
        format: formatRootPrompt,
      })
    ) {
      created += 1
    }
    if (created > 0) {
      this.log(
        `[memory.sqlite] compacted ${conversationId.slice(0, 8)}: ${String(created)} summaries`,
      )
    }
    return created
  }

  private async compactLeaf(
    meta: ConversationMeta,
    conversationId: string,
    minBatch: number,
  ): Promise<boolean> {
    const messages = this.db
      .prepare(
        `SELECT m.id, m.role, m.content, m.agent, m.created_at, m.tool_name, m.tool_args
           FROM ros_messages m
           LEFT JOIN ros_summary_sources ss ON ss.message_id = m.id
          WHERE ss.summary_id IS NULL AND m.conversation_id = ?
            AND ${SUMMARIZABLE_SQL}
          ORDER BY m.created_at ASC, m.id ASC
          LIMIT ?`,
      )
      .all(conversationId, this.settings.leafBatch) as unknown as MessageRow[]
    if (messages.length < minBatch) return false

    // A truncated answer is a batch-size problem: shrink and retry, the rest
    // of the window stays unsummarized for the next round.
    let batch = messages
    let answer: { content: string; model: string }
    for (;;) {
      const prompt = formatLeafPrompt(meta, batch.map(toCompactRow))
      try {
        answer = await this.llm.chat(LEAF_SYSTEM_PROMPT, prompt, LEAF_MAX_TOKENS)
        break
      } catch (err) {
        const next = shrinkLeafBatch(batch.length, minBatch)
        if (isLlmTruncationError(err) && next !== null) {
          batch = batch.slice(0, next)
          continue
        }
        throw err
      }
    }

    const id = randomUUID()
    const ids = batch.map((m) => m.id)
    const wrote = this.tx(() => {
      // The call above was awaited: make sure nothing claimed these meanwhile.
      const claimed = this.db
        .prepare(
          `SELECT 1 FROM ros_summary_sources WHERE message_id IN (${ids.map(() => '?').join(', ')}) LIMIT 1`,
        )
        .get(...ids)
      if (claimed) return false
      const present = this.db
        .prepare(
          `SELECT count(*) AS n FROM ros_messages WHERE id IN (${ids.map(() => '?').join(', ')})`,
        )
        .get(...ids) as unknown as { n: number }
      if (present.n !== ids.length) return false
      this.insertSummary({
        id,
        conversationId,
        parentId: null,
        depth: 0,
        kind: 'leaf',
        content: answer.content,
        messageCount: batch.length,
        earliestAt: batch[0].created_at,
        latestAt: batch[batch.length - 1].created_at,
        model: answer.model,
      })
      const insert = this.db.prepare(
        `INSERT INTO ros_summary_sources (summary_id, message_id, ordinal) VALUES (?, ?, ?)`,
      )
      batch.forEach((m, ordinal) => insert.run(id, m.id, ordinal))
      return true
    })
    if (!wrote) return false
    this.hooks.onSummary?.({ id, kind: 'leaf', conversationId })
    return true
  }

  private async compactParent(
    meta: ConversationMeta,
    conversationId: string,
    cfg: {
      childKind: 'leaf' | 'branch'
      kind: 'branch' | 'root'
      depth: number
      batchSize: number
      minChildren: number
      systemPrompt: string
      maxTokens: number
      format: (meta: ConversationMeta, rows: SummaryRow[]) => string
    },
  ): Promise<boolean> {
    const children = this.db
      .prepare(
        `SELECT id, content, kind, earliest_at, latest_at, message_count, created_at
           FROM ros_summaries
          WHERE conversation_id = ? AND kind = ? AND parent_id IS NULL
          ORDER BY created_at ASC, id ASC
          LIMIT ?`,
      )
      .all(conversationId, cfg.childKind, cfg.batchSize) as unknown as ChildRow[]
    if (children.length < cfg.minChildren) return false

    let batch = children
    let answer: { content: string; model: string }
    for (;;) {
      try {
        answer = await this.llm.chat(
          cfg.systemPrompt,
          cfg.format(meta, batch.map(toSummaryRow)),
          cfg.maxTokens,
        )
        break
      } catch (err) {
        const next = shrinkLeafBatch(batch.length, cfg.minChildren)
        if (isLlmTruncationError(err) && next !== null) {
          batch = batch.slice(0, next)
          continue
        }
        throw err
      }
    }

    const id = randomUUID()
    const ids = batch.map((c) => c.id)
    const wrote = this.tx(() => {
      // Never write a parent whose prose covers children that another parent took.
      const free = this.db
        .prepare(
          `SELECT count(*) AS n FROM ros_summaries
            WHERE id IN (${ids.map(() => '?').join(', ')}) AND parent_id IS NULL`,
        )
        .get(...ids) as unknown as { n: number }
      if (free.n !== ids.length) return false
      const earliest = batch
        .map((c) => c.earliest_at)
        .filter((v): v is string => v !== null)
        .sort()[0]
      const latest = batch
        .map((c) => c.latest_at)
        .filter((v): v is string => v !== null)
        .sort()
        .at(-1)
      this.insertSummary({
        id,
        conversationId,
        parentId: null,
        depth: cfg.depth,
        kind: cfg.kind,
        content: answer.content,
        messageCount: batch.reduce((n, c) => n + c.message_count, 0),
        earliestAt: earliest ?? null,
        latestAt: latest ?? null,
        model: answer.model,
      })
      this.db
        .prepare(
          `UPDATE ros_summaries SET parent_id = ? WHERE id IN (${ids.map(() => '?').join(', ')})`,
        )
        .run(id, ...ids)
      return true
    })
    if (!wrote) return false
    this.hooks.onSummary?.({ id, kind: cfg.kind, conversationId })
    return true
  }

  private insertSummary(s: {
    id: string
    conversationId: string
    parentId: string | null
    depth: number
    kind: string
    content: string
    messageCount: number
    earliestAt: string | null
    latestAt: string | null
    model: string
  }): void {
    this.db
      .prepare(
        `INSERT INTO ros_summaries
           (id, conversation_id, parent_id, depth, content, kind, message_count,
            earliest_at, latest_at, model, pipeline_version, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        s.id,
        s.conversationId,
        s.parentId,
        s.depth,
        s.content,
        s.kind,
        s.messageCount,
        s.earliestAt,
        s.latestAt,
        s.model,
        PIPELINE_VERSION,
        this.now().toISOString(),
      )
  }

  private tx<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const out = fn()
      this.db.exec('COMMIT')
      return out
    } catch (err) {
      try {
        this.db.exec('ROLLBACK')
      } catch {
        // ignore
      }
      throw err
    }
  }
}

function toCompactRow(m: MessageRow): CompactMessageRow {
  let toolArgs: unknown = null
  if (m.tool_args) {
    try {
      toolArgs = JSON.parse(m.tool_args) as unknown
    } catch {
      toolArgs = m.tool_args
    }
  }
  return {
    id: m.id,
    role: m.role,
    content: m.content,
    agent: m.agent,
    created_at: new Date(m.created_at),
    tool_name: m.tool_name,
    tool_args: toolArgs,
  }
}

function toSummaryRow(c: ChildRow): SummaryRow {
  return {
    id: c.id,
    content: c.content,
    kind: c.kind,
    earliest_at: c.earliest_at ? new Date(c.earliest_at) : null,
    latest_at: c.latest_at ? new Date(c.latest_at) : null,
    message_count: c.message_count,
    created_at: new Date(c.created_at),
  }
}
