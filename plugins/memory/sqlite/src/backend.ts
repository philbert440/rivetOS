/**
 * SqliteBackend — `MemoryBackend` on the SQLite file: harness capture, the
 * hub's Memory pages (search, browse, stats, health, tags) and the memory
 * tools served over HTTP. Same wire contract as the Postgres routes.
 *
 * Not here yet: the rule-based project tag at capture, vocabulary edits and
 * tag suggestions (the tagging slice), and per-user stores (routing).
 */

import { createHash, randomUUID } from 'node:crypto'
import type { DatabaseSync, SQLInputValue } from 'node:sqlite'
import {
  DEFAULT_IDLE_MINUTES,
  MIN_BATCH_SIZE,
  applyWindowArgs,
  planProjectRuleTag,
  type ProjectResolver,
} from '@rivetos/memory-core'
import {
  MemoryRequestError,
  formatTag,
  normalizeTagKey,
  normalizeTagValue,
  parseTagLiteral,
} from '@rivetos/types'
import type {
  CaptureBatchRequest,
  CaptureBatchResult,
  MemoryBackend,
  MemoryBrowseFilter,
  MemoryBrowseMessage,
  MemoryBrowseResponse,
  MemoryHealthResponse,
  MemorySearchHit,
  MemorySearchResponse,
  MemoryStatsResponse,
  MemoryTagsBackend,
  ProjectRuleResult,
  TagState,
  Tool,
} from '@rivetos/types'
import type { SqliteSearchHit } from './adapter.js'
import { TAGGED_CONVERSATIONS_SQL, type SqliteTagStore } from './tags.js'
import type { SqliteWikiIndex } from './wiki.js'
import type { SqliteTagVocabulary } from './tag-vocabulary.js'

/** Same cap as the Postgres capture path. */
const MAX_CONTENT = 16000
const EMBED_TASK = 'embed-target'
/** The widest pool ranked for a tag-filtered search. */
const TAG_FILTER_POOL_MAX = 2000
/** How far back a dead job still marks the store degraded. */
const HEALTH_WINDOW_MS = 7 * 24 * 60 * 60 * 1000
const KEYWORD_ONLY = 'Keyword / FTS ranking only — not meaning-based.'
const SUMMARIZABLE_SQL = `((m.content IS NOT NULL AND length(m.content) > 10) OR m.tool_name IS NOT NULL)`

/** What the backend needs from the store that owns the file. */
export interface SqliteBackendHost {
  db: DatabaseSync
  tx<T>(fn: () => T): T
  search(
    query: string,
    options: { agent?: string; limit?: number; scope?: 'messages' | 'summaries' | 'both' },
    info: { degraded?: string },
  ): Promise<SqliteSearchHit[]>
  hasEmbedding(): boolean
  hasCompactor(): boolean
  /** True while this process runs the job loop. */
  workersRunning(): boolean
  enqueueMessageEmbed(id: string): void
  tags(): SqliteTagStore
  wiki(): { index: SqliteWikiIndex; wikiDir: string } | undefined
  vocabulary(): SqliteTagVocabulary
  /** Whose store this is; stamped on rows as `owner_user_id`. */
  userId: string | null
  /** `null` turns the rule-based project tag off; undefined is the default rule. */
  projectRule: ProjectResolver | null | undefined
  log(line: string): void
  assertOpen(): void
}

function placeholders(n: number): string {
  return Array.from({ length: n }, () => '?').join(', ')
}

/** ISO UTC for a stored timestamp, so text comparison is time comparison. */
function isoUtc(value: string, what: string): string {
  const ms = Date.parse(value)
  if (Number.isNaN(ms)) throw new MemoryRequestError(`${what} is not a timestamp`)
  return new Date(ms).toISOString()
}

/** Cut at the cap without splitting a surrogate pair; note it in the metadata. */
function capText(text: string, field: string, metadata: Record<string, unknown>): string {
  if (text.length <= MAX_CONTENT) return text
  metadata[`full_${field}_length`] = text.length
  metadata.truncated = true
  const last = text.charCodeAt(MAX_CONTENT - 1)
  return text.slice(0, MAX_CONTENT - (last >= 0xd800 && last <= 0xdbff ? 1 : 0))
}

const TRUNCATION_MARKER = '\n…[truncated]'

/** The write tools' cut: the marker tells a reader the tail is gone. */
function truncateWithMarker(
  text: string,
  metadata: Record<string, unknown>,
  field: string,
): string {
  if (text.length <= MAX_CONTENT || text.endsWith(TRUNCATION_MARKER)) return text
  metadata[`full_${field}_length`] = text.length
  metadata.truncated = true
  const last = text.charCodeAt(MAX_CONTENT - 1)
  return text.slice(0, MAX_CONTENT - (last >= 0xd800 && last <= 0xdbff ? 1 : 0)) + TRUNCATION_MARKER
}

/** A read tool answers a bad filter in text, like its Postgres counterpart. */
function answerBadRequests(tool: Tool): Tool {
  return {
    ...tool,
    execute: async (args, signal, context) => {
      try {
        return await tool.execute(args, signal, context)
      } catch (err) {
        if (err instanceof MemoryRequestError) return `Error: ${err.message}`
        throw err
      }
    },
  }
}

/** True when the stored metadata JSON has `key: true` at its top level. */
function metadataFlag(json: string, key: string): boolean {
  try {
    const parsed: unknown = JSON.parse(json)
    return (
      typeof parsed === 'object' &&
      parsed !== null &&
      (parsed as Record<string, unknown>)[key] === true
    )
  } catch {
    return false
  }
}

function clampInt(v: unknown, fallback: number, lo: number, hi: number): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v !== '' ? Number(v) : NaN
  return Number.isFinite(n) ? Math.min(Math.max(Math.trunc(n), lo), hi) : fallback
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined
}

/* eslint-disable @typescript-eslint/require-await -- DatabaseSync is sync; the interface is async. */
export class SqliteBackend implements MemoryBackend {
  private toolList: Tool[] | undefined

  constructor(private readonly host: SqliteBackendHost) {}

  private get db(): DatabaseSync {
    this.host.assertOpen()
    return this.host.db
  }

  // -------------------------------------------------------------------------
  // Capture
  // -------------------------------------------------------------------------

  async capture(
    batch: CaptureBatchRequest,
    options?: { allowFilesystem?: boolean },
  ): Promise<CaptureBatchResult> {
    // Resolved before the transaction: no filesystem work while the write
    // lock is held. A batch from another machine never touches this host's
    // filesystem. Never throws.
    const project = await planProjectRuleTag(
      batch.settings,
      {
        ...(this.host.projectRule !== undefined ? { resolveProject: this.host.projectRule } : {}),
        allowFilesystem: options?.allowFilesystem !== false,
      },
      (line) => {
        this.host.log(line)
      },
    )
    return this.write(batch, false, project).result
  }

  /**
   * One transaction per batch. `rows` says, per message, which stored row it
   * is and whether this call wrote it. `capped`: the caller already cut the
   * text and recorded that in the metadata.
   */
  private write(
    batch: CaptureBatchRequest,
    capped = false,
    project: ProjectRuleResult | null = null,
  ): {
    result: CaptureBatchResult
    rows: Array<{ eventId: string; id: string; inserted: boolean }>
  } {
    const db = this.db
    return this.host.tx(() => {
      const now = new Date().toISOString()
      const channel = batch.channel ?? 'unknown'
      const conversation = db
        .prepare(
          `INSERT INTO ros_conversations
             (id, session_key, agent, channel, title, settings, task_id, created_at, updated_at, active,
              owner_user_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
           ON CONFLICT (session_key, agent) DO UPDATE SET
             updated_at = excluded.updated_at,
             title = CASE WHEN ? THEN excluded.title ELSE ros_conversations.title END,
             settings = CASE WHEN ? THEN excluded.settings ELSE ros_conversations.settings END,
             task_id = CASE WHEN ? THEN excluded.task_id ELSE ros_conversations.task_id END
           RETURNING id`,
        )
        .get(
          randomUUID(),
          batch.session_key,
          batch.agent,
          channel,
          batch.title ?? null,
          JSON.stringify(batch.settings ?? {}),
          batch.task_id ?? null,
          now,
          now,
          this.host.userId,
          batch.title !== undefined ? 1 : 0,
          batch.settings !== undefined ? 1 : 0,
          batch.task_id !== undefined ? 1 : 0,
        ) as { id: string } | undefined
      if (!conversation) throw new Error('capture could not open the conversation')
      const conversationId = conversation.id
      // The rule tag never costs a capture its messages.
      if (project) {
        try {
          this.host.vocabulary().applyRuleTag(conversationId, project)
        } catch (err) {
          this.host.log(
            `[memory.sqlite] project rule tag skipped for ${conversationId.slice(0, 8)}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          )
        }
      }

      // Delivery is at-least-once: an event already stored is skipped.
      const seen = new Map<string, string>()
      const written: Array<{ eventId: string; id: string; inserted: boolean }> = []
      const eventIds = batch.messages.map((m) => m.event_id)
      for (let i = 0; i < eventIds.length; i += 500) {
        const chunk = eventIds.slice(i, i + 500)
        const rows = db
          .prepare(
            `SELECT id, json_extract(metadata, '$.event_id') AS event_id FROM ros_messages
              WHERE conversation_id = ?
                AND json_extract(metadata, '$.event_id') IN (${placeholders(chunk.length)})`,
          )
          .all(conversationId, ...chunk) as unknown as Array<{ id: string; event_id: string }>
        for (const r of rows) seen.set(r.event_id, r.id)
      }

      const insert = db.prepare(
        `INSERT INTO ros_messages
           (id, conversation_id, agent, channel, role, content,
            tool_name, tool_args, tool_result, metadata, created_at, owner_user_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      let inserted = 0
      for (const message of batch.messages) {
        const existing = seen.get(message.event_id)
        if (existing !== undefined) {
          written.push({ eventId: message.event_id, id: existing, inserted: false })
          continue
        }
        const metadata: Record<string, unknown> = {
          ...message.metadata,
          event_id: message.event_id,
        }
        const content = capped ? message.content : capText(message.content, 'content', metadata)
        const toolResult =
          message.tool_result === undefined
            ? null
            : capped
              ? message.tool_result
              : capText(message.tool_result, 'tool_result', metadata)
        const id = randomUUID()
        insert.run(
          id,
          conversationId,
          batch.agent,
          channel,
          message.role,
          content,
          message.tool_name ?? null,
          message.tool_args === undefined ? null : JSON.stringify(message.tool_args),
          toolResult,
          JSON.stringify(metadata),
          message.created_at ? isoUtc(message.created_at, 'created_at') : now,
          this.host.userId,
        )
        this.host.enqueueMessageEmbed(id)
        seen.set(message.event_id, id)
        written.push({ eventId: message.event_id, id, inserted: true })
        inserted += 1
      }
      if (batch.finalize) {
        db.prepare(
          `UPDATE ros_conversations SET active = 0, updated_at = ? WHERE id = ? AND active = 1`,
        ).run(now, conversationId)
      }
      return {
        result: {
          ok: true,
          conversation_id: conversationId,
          inserted,
          skipped: batch.messages.length - inserted,
        },
        rows: written,
      }
    })
  }

  // -------------------------------------------------------------------------
  // Search / browse
  // -------------------------------------------------------------------------

  async search(
    query: string,
    options: {
      scope: 'messages' | 'summaries' | 'both'
      limit: number
      tag?: string
      agent?: string
    },
  ): Promise<MemorySearchResponse> {
    const db = this.db
    let tagged: Set<string> | undefined
    if (options.tag) {
      const parsed = parseTagLiteral(options.tag)
      if (!parsed) throw new MemoryRequestError('tag must be key:value')
      tagged = new Set(this.host.tags().conversationIdsWithTag(parsed.key, parsed.value))
    }
    const info: { degraded?: string } = {}
    const agentOpt = options.agent ? { agent: options.agent } : {}
    let hits: SqliteSearchHit[] = []
    if (!tagged) {
      hits = await this.host.search(
        query,
        { scope: options.scope, limit: options.limit, ...agentOpt },
        info,
      )
    } else if (tagged.size > 0) {
      // The filter is applied after ranking, so rank a wider pool, and widen
      // it again while it yields fewer tagged hits than asked for.
      const pools = [options.limit * 5, options.limit * 25, TAG_FILTER_POOL_MAX].map((n) =>
        Math.min(n, TAG_FILTER_POOL_MAX),
      )
      for (const size of [...new Set(pools)]) {
        hits = await this.host.search(
          query,
          { scope: options.scope, limit: size, ...agentOpt },
          info,
        )
        if (hits.length < size) break
        if (this.countTagged(hits, tagged) >= options.limit) break
        if (size >= TAG_FILTER_POOL_MAX) break
      }
    }

    const detail = new Map<
      string,
      {
        conversation_id: string | null
        session_key: string | null
        kind?: string
        tool_name?: string | null
      }
    >()
    const messageIds = hits.filter((h) => h.layer === 'message').map((h) => h.id)
    const summaryIds = hits.filter((h) => h.layer === 'summary').map((h) => h.id)
    for (let i = 0; i < messageIds.length; i += 500) {
      const chunk = messageIds.slice(i, i + 500)
      const rows = db
        .prepare(
          `SELECT m.id, m.conversation_id, m.tool_name, c.session_key FROM ros_messages m
             LEFT JOIN ros_conversations c ON c.id = m.conversation_id
            WHERE m.id IN (${placeholders(chunk.length)})`,
        )
        .all(...chunk) as unknown as Array<{
        id: string
        conversation_id: string
        tool_name: string | null
        session_key: string | null
      }>
      for (const r of rows) detail.set(r.id, r)
    }
    for (let i = 0; i < summaryIds.length; i += 500) {
      const chunk = summaryIds.slice(i, i + 500)
      const rows = db
        .prepare(
          `SELECT s.id, s.conversation_id, s.kind, c.session_key FROM ros_summaries s
             LEFT JOIN ros_conversations c ON c.id = s.conversation_id
            WHERE s.id IN (${placeholders(chunk.length)})`,
        )
        .all(...chunk) as unknown as Array<{
        id: string
        conversation_id: string | null
        kind: string
        session_key: string | null
      }>
      for (const r of rows) detail.set(r.id, r)
    }

    const kept = hits
      .filter((h) => {
        if (!tagged) return true
        const conv = detail.get(h.id)?.conversation_id
        return conv !== null && conv !== undefined && tagged.has(conv)
      })
      .slice(0, options.limit)
    const tagMap = this.acceptedTags(kept.map((h) => detail.get(h.id)?.conversation_id))
    const results: MemorySearchHit[] = kept.map((h) => {
      const d = detail.get(h.id)
      const conversationId = d?.conversation_id ?? undefined
      const tags = conversationId ? tagMap.get(conversationId) : undefined
      return {
        id: h.id,
        source: h.layer,
        content: h.content,
        createdAt: h.createdAt.toISOString(),
        score: h.relevanceScore,
        role: h.role,
        agent: h.agent,
        ...(d?.kind ? { kind: d.kind } : {}),
        ...(d?.tool_name ? { toolName: d.tool_name } : {}),
        ...(conversationId ? { conversationId } : {}),
        sessionId: d?.session_key ?? null,
        ...(tags && tags.length > 0 ? { tags } : {}),
      }
    })
    const degraded = info.degraded
      ? { reason: info.degraded, effect: KEYWORD_ONLY }
      : !this.host.hasEmbedding()
        ? { reason: 'embedding endpoint not configured', effect: KEYWORD_ONLY }
        : null
    return { query, scope: options.scope, degraded, results }
  }

  /** How many of these hits belong to a tagged conversation. */
  private countTagged(hits: readonly SqliteSearchHit[], tagged: ReadonlySet<string>): number {
    let n = 0
    for (const [layer, table] of [
      ['message', 'ros_messages'],
      ['summary', 'ros_summaries'],
    ] as const) {
      const ids = hits.filter((h) => h.layer === layer).map((h) => h.id)
      for (let i = 0; i < ids.length; i += 500) {
        const chunk = ids.slice(i, i + 500)
        const rows = this.db
          .prepare(
            `SELECT conversation_id FROM ${table} WHERE id IN (${placeholders(chunk.length)})`,
          )
          .all(...chunk) as unknown as Array<{ conversation_id: string | null }>
        for (const r of rows) if (r.conversation_id && tagged.has(r.conversation_id)) n += 1
      }
    }
    return n
  }

  /** Accepted `key:value` tags per conversation id. */
  private acceptedTags(conversationIds: Array<string | null | undefined>): Map<string, string[]> {
    const out = new Map<string, string[]>()
    const ids = [...new Set(conversationIds.filter((id): id is string => Boolean(id)))]
    // A tag on the session or on any of its summaries: the definition the
    // tag filter and the counts use, so a hit shows the tag that selected it.
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500)
      const marks = placeholders(chunk.length)
      const rows = this.db
        .prepare(
          `SELECT conversation_id, key, value, display FROM (
             SELECT t.entity_id AS conversation_id, t.key, t.value, t.display, t.created_at
               FROM ros_tags t
              WHERE t.entity_type = 'conversation' AND t.state = 'accepted'
                AND t.entity_id IN (${marks})
             UNION ALL
             SELECT s.conversation_id, t.key, t.value, t.display, t.created_at
               FROM ros_tags t
               JOIN ros_summaries s ON t.entity_type = 'summary' AND s.id = t.entity_id
              WHERE t.state = 'accepted' AND s.conversation_id IN (${marks})
           )
           ORDER BY conversation_id, key, value, created_at`,
        )
        .all(...chunk, ...chunk) as unknown as Array<{
        conversation_id: string
        key: string
        value: string
        display: string
      }>
      const seen = new Set<string>()
      for (const r of rows) {
        const id = `${r.conversation_id}\0${r.key}:${r.value}`
        if (seen.has(id)) continue
        seen.add(id)
        const list = out.get(r.conversation_id) ?? []
        list.push(formatTag(r))
        out.set(r.conversation_id, list)
      }
    }
    return out
  }

  async browse(filter: MemoryBrowseFilter): Promise<MemoryBrowseResponse> {
    return { messages: this.browseRows({ ...filter, order: 'desc' }) }
  }

  private browseRows(
    filter: MemoryBrowseFilter & {
      order: 'asc' | 'desc'
      conversationId?: string
      includeTools?: boolean
    },
  ): MemoryBrowseMessage[] {
    const db = this.db
    const conds: string[] = []
    const params: SQLInputValue[] = []
    if (filter.tag) {
      const parsed = parseTagLiteral(filter.tag)
      if (!parsed) throw new MemoryRequestError('tag must be key:value')
      conds.push(`m.conversation_id IN (${TAGGED_CONVERSATIONS_SQL})`)
      const tagKey = normalizeTagKey(parsed.key)
      const tagValue = normalizeTagValue(parsed.value)
      params.push(tagKey, tagValue, tagKey, tagValue)
    }
    if (filter.conversationId) {
      conds.push('m.conversation_id = ?')
      params.push(filter.conversationId)
    }
    if (filter.role) {
      conds.push('m.role = ?')
      params.push(filter.role)
    }
    if (filter.agent) {
      conds.push('m.agent = ?')
      params.push(filter.agent)
    }
    if (filter.toolName) {
      conds.push('m.tool_name = ?')
      params.push(filter.toolName)
    }
    if (filter.includeTools === false) conds.push(`m.role <> 'tool' AND m.tool_name IS NULL`)
    let since: string | undefined
    let before: string | undefined
    try {
      ;({ since, before } = applyWindowArgs(filter))
    } catch (err) {
      throw new MemoryRequestError(err instanceof Error ? err.message : String(err))
    }
    if (since) {
      conds.push('m.created_at >= ?')
      params.push(isoUtc(since, 'since'))
    }
    if (before) {
      conds.push('m.created_at < ?')
      params.push(isoUtc(before, 'before'))
    }
    const limit = clampInt(filter.limit, 50, 1, 200)
    const rows = db
      .prepare(
        `SELECT m.id, m.role, m.agent, m.content, m.created_at, m.conversation_id,
                c.session_key, m.tool_name
           FROM ros_messages m
           LEFT JOIN ros_conversations c ON c.id = m.conversation_id
          ${conds.length > 0 ? `WHERE ${conds.join(' AND ')}` : ''}
          ORDER BY m.created_at ${filter.order === 'asc' ? 'ASC' : 'DESC'}, m.id
          LIMIT ?`,
      )
      .all(...params, limit) as unknown as Array<{
      id: string
      role: string
      agent: string
      content: string
      created_at: string
      conversation_id: string
      session_key: string | null
      tool_name: string | null
    }>
    const tagMap = this.acceptedTags(rows.map((r) => r.conversation_id))
    return rows.map((r) => {
      const tags = tagMap.get(r.conversation_id)
      return {
        id: r.id,
        role: r.role,
        agent: r.agent,
        content: r.content,
        createdAt: r.created_at,
        conversationId: r.conversation_id,
        sessionId: r.session_key,
        toolName: r.tool_name,
        ...(tags ? { tags } : {}),
      }
    })
  }

  // -------------------------------------------------------------------------
  // Stats / health
  // -------------------------------------------------------------------------

  private count(sql: string, ...params: SQLInputValue[]): number {
    const row = this.db.prepare(sql).get(...params) as { n: number } | undefined
    return row?.n ?? 0
  }

  /** Embedding jobs queued or running. */
  private embedQueueDepth(): number {
    return this.count(
      `SELECT count(*) AS n FROM ros_jobs WHERE task = ? AND state IN ('queued', 'running')`,
      EMBED_TASK,
    )
  }

  private failedEmbeddings(): number {
    return this.count(
      `SELECT (SELECT count(*) FROM ros_messages
                WHERE embedding IS NULL AND embed_status IS NULL AND embed_failures > 0)
            + (SELECT count(*) FROM ros_summaries
                WHERE embedding IS NULL AND embed_status IS NULL AND embed_failures > 0) AS n`,
    )
  }

  async stats(agent?: string): Promise<MemoryStatsResponse> {
    const db = this.db
    const a: SQLInputValue[] = agent ? [agent] : []
    const mWhere = agent ? ' WHERE agent = ?' : ''
    const mAnd = agent ? ' AND agent = ?' : ''
    const topTools = db
      .prepare(
        `SELECT tool_name AS tool, count(*) AS n FROM ros_messages
          WHERE tool_name IS NOT NULL${mAnd}
          GROUP BY tool_name ORDER BY n DESC, tool_name LIMIT 12`,
      )
      .all(...a) as unknown as Array<{ tool: string; n: number }>
    const recent = db
      .prepare(
        `SELECT c.session_key, c.title, c.agent, c.updated_at, count(m.id) AS messages
           FROM ros_conversations c
           LEFT JOIN ros_messages m ON m.conversation_id = c.id
          ${agent ? 'WHERE c.agent = ?' : ''}
          GROUP BY c.id
          ORDER BY c.updated_at DESC
          LIMIT 12`,
      )
      .all(...a) as unknown as Array<{
      session_key: string
      title: string | null
      agent: string
      updated_at: string
      messages: number
    }>
    return {
      conversations: this.count(`SELECT count(*) AS n FROM ros_conversations${mWhere}`, ...a),
      messages: this.count(`SELECT count(*) AS n FROM ros_messages${mWhere}`, ...a),
      toolCalls: this.count(
        `SELECT count(*) AS n FROM ros_messages WHERE (role = 'tool' OR tool_name IS NOT NULL)${mAnd}`,
        ...a,
      ),
      summaries: agent
        ? this.count(
            `SELECT count(*) AS n FROM ros_summaries s
               JOIN ros_conversations c ON c.id = s.conversation_id WHERE c.agent = ?`,
            agent,
          )
        : this.count(`SELECT count(*) AS n FROM ros_summaries`),
      embedQueueDepth: this.embedQueueDepth(),
      embeddedMessages: this.count(`SELECT count(embedding) AS n FROM ros_messages${mWhere}`, ...a),
      failedEmbeddings: this.failedEmbeddings(),
      topTools: topTools.map((r) => ({ tool: r.tool, count: r.n })),
      recentSessions: recent.map((r) => ({
        sessionId: r.session_key,
        title: r.title,
        agent: r.agent,
        lastActive: r.updated_at,
        messages: r.messages,
      })),
    }
  }

  async health(): Promise<MemoryHealthResponse> {
    const db = this.db
    const now = new Date()
    const nowIso = now.toISOString()
    const queues = (
      db
        .prepare(
          `SELECT task,
                  sum(CASE WHEN state = 'queued' AND run_at <= ? THEN 1 ELSE 0 END) AS pending,
                  sum(CASE WHEN state = 'queued' AND run_at > ? THEN 1 ELSE 0 END) AS scheduled,
                  sum(CASE WHEN state = 'running' THEN 1 ELSE 0 END) AS running,
                  sum(CASE WHEN state = 'dead' THEN 1 ELSE 0 END) AS dead,
                  min(CASE WHEN state = 'queued' AND run_at <= ? THEN created_at END) AS oldest
             FROM ros_jobs GROUP BY task ORDER BY task`,
        )
        .all(nowIso, nowIso, nowIso) as unknown as Array<{
        task: string
        pending: number
        scheduled: number
        running: number
        dead: number
        oldest: string | null
      }>
    ).map((q) => ({
      task: q.task,
      pending: q.pending,
      running: q.running,
      scheduled: q.scheduled,
      dead: q.dead,
      oldestPendingMinutes:
        q.oldest === null
          ? null
          : Math.max(0, Math.floor((now.getTime() - Date.parse(q.oldest)) / 60_000)),
    }))

    // Unsummarized messages per conversation, bucketed the way the sweep sees them.
    const idleBefore = new Date(now.getTime() - DEFAULT_IDLE_MINUTES * 60_000).toISOString()
    const backlog = db
      .prepare(
        `SELECT count(m.id) AS n, c.updated_at FROM ros_conversations c
           JOIN ros_messages m ON m.conversation_id = c.id
           LEFT JOIN ros_summary_sources ss ON ss.message_id = m.id
          WHERE ss.summary_id IS NULL AND ${SUMMARIZABLE_SQL}
            AND (c.session_key IS NULL OR c.session_key NOT LIKE 'heartbeat:%')
          GROUP BY c.id`,
      )
      .all() as unknown as Array<{ n: number; updated_at: string }>
    const compaction = { eligible: 0, activeTail: 0, belowFloor: 0 }
    for (const row of backlog) {
      const n = row.n
      if (n < MIN_BATCH_SIZE) compaction.belowFloor += n
      else if (row.updated_at < idleBefore) compaction.eligible += n
      else compaction.activeTail += n
    }

    const embedding = this.host.hasEmbedding()
    const failed = this.failedEmbeddings()
    // Status looks at recent trouble only: one old dead job or failed row
    // must not keep the banner up for good. The counts stay cumulative.
    const recentBefore = new Date(now.getTime() - HEALTH_WINDOW_MS).toISOString()
    const dead =
      this.count(
        `SELECT count(*) AS n FROM ros_jobs WHERE state = 'dead' AND updated_at > ?`,
        recentBefore,
      ) > 0
    const recentFailed = this.count(
      `SELECT (SELECT count(*) FROM ros_messages
                WHERE embedding IS NULL AND embed_status IS NULL AND embed_failures > 0 AND created_at > ?)
            + (SELECT count(*) FROM ros_summaries
                WHERE embedding IS NULL AND embed_status IS NULL AND embed_failures > 0 AND created_at > ?) AS n`,
      recentBefore,
      recentBefore,
    )
    return {
      status: embedding && !dead && recentFailed === 0 ? 'ok' : 'degraded',
      observedAt: nowIso,
      embeddings: embedding
        ? { status: 'ok', checkedAt: nowIso }
        : {
            status: 'unavailable',
            checkedAt: nowIso,
            error: 'embedding endpoint not configured',
            impact: 'Keyword matching still works; meaning-based ranking is offline.',
          },
      embedQueueDepth: this.embedQueueDepth(),
      failedEmbeddings: failed,
      skippedEmbeddings: this.count(
        `SELECT (SELECT count(*) FROM ros_messages WHERE embed_status = 'unembeddable')
              + (SELECT count(*) FROM ros_summaries WHERE embed_status = 'unembeddable') AS n`,
      ),
      // Without the job loop nothing drains the queues this process can see.
      queueStatus: this.host.workersRunning() ? 'available' : 'unavailable',
      queues,
      compaction,
      capture: {
        status: 'unknown',
        impact: 'Capture progress is not measured by this endpoint yet.',
      },
    }
  }

  // -------------------------------------------------------------------------
  // Tags
  // -------------------------------------------------------------------------

  tags(): MemoryTagsBackend {
    const store = (): SqliteTagStore => {
      this.host.assertOpen()
      return this.host.tags()
    }
    return {
      list: async (filter) => store().list(filter),
      pending: async (limit) => store().pending(limit),
      counts: async (key, limit) => store().counts(key, limit),
      decide: async (ids, state, decidedBy) => store().decide(ids, state, decidedBy),
      add: async (input, decidedBy) => store().add(input, decidedBy),
      forSessionKeys: async (keys, states) => store().forSessionKeys(keys, states),
      taxonomy: async (filter) => this.host.vocabulary().list(filter),
      upsertTaxonomy: async (input) => this.host.vocabulary().upsert(input),
      decideTaxonomy: async (entries, state) => this.host.vocabulary().decide(entries, state),
      mergeTaxonomy: async (key, from, into) => this.host.vocabulary().merge(key, from, into),
    }
  }

  /** The wiki index and page directory, for the den's wiki routes. */
  wiki(): { index: SqliteWikiIndex; wikiDir: string } | undefined {
    this.host.assertOpen()
    return this.host.wiki()
  }

  // -------------------------------------------------------------------------
  // Tools
  // -------------------------------------------------------------------------

  tools(): Tool[] {
    this.toolList ??= [
      answerBadRequests(this.searchTool()),
      answerBadRequests(this.browseTool()),
      this.statsTool(),
      this.getFullTool(),
      this.tagsTool(true),
      this.appendTool(),
      this.ingestTool(),
    ]
    return this.toolList
  }

  /**
   * The tools handed to the agent: reading only. The tags tool here cannot
   * add or decide, as on Postgres: deciding a tag is a person's call.
   */
  readTools(): Tool[] {
    return [
      this.searchTool(),
      this.browseTool(),
      this.statsTool(),
      this.getFullTool(),
      this.tagsTool(false),
    ].map(answerBadRequests)
  }

  private searchTool(): Tool {
    return {
      name: 'memory_search',
      description:
        'Search conversation memory (messages and summaries). Returns ranked hits with ids; use memory_get_full for the whole record.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search text' },
          scope: { type: 'string', enum: ['messages', 'summaries', 'both'] },
          limit: { type: 'number', description: 'Maximum results, 1–50 (default 10)' },
          agent: { type: 'string', description: 'Filter by agent' },
          tag: { type: 'string', description: 'Only conversations carrying this key:value tag' },
        },
        required: ['query'],
      },
      execute: async (args) => {
        const query = str(args.query)?.trim()
        if (!query) return 'Error: query is required'
        const scope = args.scope === 'messages' || args.scope === 'summaries' ? args.scope : 'both'
        const res = await this.search(query, {
          scope,
          limit: clampInt(args.limit, 10, 1, 50),
          ...(str(args.tag) ? { tag: str(args.tag) } : {}),
          ...(str(args.agent) ? { agent: str(args.agent) } : {}),
        })
        const lines: string[] = []
        if (res.degraded) lines.push(`⚠ ${res.degraded.reason} — ${res.degraded.effect}`)
        if (res.results.length === 0) lines.push(`No results for "${query}".`)
        for (const [i, h] of res.results.entries()) {
          const who =
            h.source === 'summary'
              ? `summary/${h.kind ?? 'leaf'}`
              : `${h.agent ?? '?'}/${h.role ?? '?'}`
          const tags = h.tags && h.tags.length > 0 ? ` [${h.tags.join(', ')}]` : ''
          lines.push(
            `${String(i + 1)}. [${who}] ${h.createdAt} score=${h.score.toFixed(3)} id=${h.id}${tags}`,
            `   ${h.content.replace(/\s+/g, ' ').slice(0, 400)}`,
          )
        }
        return lines.join('\n')
      },
    }
  }

  private browseTool(): Tool {
    return {
      name: 'memory_browse',
      description: 'Browse messages in time order, optionally within one conversation or window.',
      parameters: {
        type: 'object',
        properties: {
          conversation_id: { type: 'string' },
          since: { type: 'string', description: 'ISO lower bound' },
          before: { type: 'string', description: 'ISO upper bound' },
          window: {
            type: 'string',
            description: 'today, yesterday, this_week, last_24h, last_7d, last_14d',
          },
          agent: { type: 'string' },
          tag: { type: 'string', description: 'key:value' },
          include_tools: {
            type: 'boolean',
            description: 'Include tool calls and results (default false)',
          },
          limit: { type: 'number', description: '1–200 (default 50)' },
          order: { type: 'string', enum: ['asc', 'desc'] },
        },
      },
      execute: async (args) => {
        const rows = this.browseRows({
          conversationId: str(args.conversation_id),
          since: str(args.since),
          before: str(args.before),
          window: str(args.window),
          agent: str(args.agent),
          tag: str(args.tag),
          includeTools: args.include_tools === true,
          limit: clampInt(args.limit, 50, 1, 200),
          order: args.order === 'asc' ? 'asc' : 'desc',
        })
        if (rows.length === 0) return 'No messages in that range.'
        return rows
          .map(
            (r) =>
              `[${r.createdAt}] ${r.agent}/${r.role}${r.toolName ? ` (${r.toolName})` : ''} id=${r.id}\n${r.content.slice(0, 1000)}`,
          )
          .join('\n\n')
      },
    }
  }

  private statsTool(): Tool {
    return {
      name: 'memory_stats',
      description:
        'Counts for the memory store: conversations, messages, summaries, embeddings and queues.',
      parameters: { type: 'object', properties: { agent: { type: 'string' } } },
      execute: async (args) => {
        const s = await this.stats(str(args.agent))
        const h = await this.health()
        const lines = [
          `Backend: sqlite`,
          `Conversations: ${String(s.conversations)}`,
          `Messages: ${String(s.messages)} (${String(s.embeddedMessages)} embedded, ${String(s.toolCalls)} tool calls)`,
          `Summaries: ${String(s.summaries)}`,
          `Embeddings: ${h.embeddings.status}${h.embeddings.error ? ` (${h.embeddings.error})` : ''}, queue ${String(s.embedQueueDepth)}, failed ${String(s.failedEmbeddings)}`,
          `Summarization: ${this.host.hasCompactor() ? 'on' : 'off (no compactor endpoint)'}, ${String(h.compaction?.eligible ?? 0)} messages eligible, ${String(h.compaction?.activeTail ?? 0)} in active sessions, ${String(h.compaction?.belowFloor ?? 0)} below the batch floor`,
        ]
        for (const q of h.queues ?? []) {
          lines.push(
            `Queue ${q.task}: ${String(q.pending)} pending, ${String(q.scheduled)} scheduled, ${String(q.running)} running, ${String(q.dead)} dead`,
          )
        }
        if (s.topTools.length > 0) {
          lines.push(
            `Top tools: ${s.topTools.map((t) => `${t.tool} (${String(t.count)})`).join(', ')}`,
          )
        }
        return lines.join('\n')
      },
    }
  }

  private getFullTool(): Tool {
    return {
      name: 'memory_get_full',
      description:
        'The full record behind a search hit: a message with its tool data, or a summary with what it covers.',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string', description: 'Message or summary id' } },
        required: ['id'],
      },
      execute: async (args) => {
        const id = str(args.id)
        if (!id) return 'Error: id is required'
        const db = this.db
        const m = db
          .prepare(
            `SELECT m.id, m.role, m.agent, m.channel, m.content, m.tool_name, m.tool_args,
                    m.tool_result, m.metadata, m.created_at, m.conversation_id, c.session_key
               FROM ros_messages m LEFT JOIN ros_conversations c ON c.id = m.conversation_id
              WHERE m.id = ?`,
          )
          .get(id) as
          | {
              id: string
              role: string
              agent: string
              channel: string
              content: string
              tool_name: string | null
              tool_args: string | null
              tool_result: string | null
              metadata: string
              created_at: string
              conversation_id: string
              session_key: string | null
            }
          | undefined
        if (m) {
          const lines = [
            `Message ${m.id}`,
            `Agent: ${m.agent}  Role: ${m.role}  Channel: ${m.channel}`,
            `Created: ${m.created_at}`,
            `Conversation: ${m.conversation_id}${m.session_key ? ` (session ${m.session_key})` : ''}`,
          ]
          if (m.tool_name) lines.push(`Tool: ${m.tool_name}`)
          if (m.tool_args) lines.push(`Tool args: ${m.tool_args}`)
          lines.push('', m.content)
          if (m.tool_result) lines.push('', 'Tool result:', m.tool_result)
          if (metadataFlag(m.metadata, 'truncated')) {
            lines.push(
              '',
              '(stored text was truncated at capture; the original is not in this store)',
            )
          }
          return lines.join('\n')
        }
        const s = db
          .prepare(
            `SELECT s.id, s.kind, s.depth, s.content, s.message_count, s.earliest_at, s.latest_at,
                    s.model, s.created_at, s.conversation_id, s.parent_id, c.session_key
               FROM ros_summaries s LEFT JOIN ros_conversations c ON c.id = s.conversation_id
              WHERE s.id = ?`,
          )
          .get(id) as
          | {
              id: string
              kind: string
              depth: number
              content: string
              message_count: number
              earliest_at: string | null
              latest_at: string | null
              model: string | null
              created_at: string
              conversation_id: string | null
              parent_id: string | null
              session_key: string | null
            }
          | undefined
        if (!s) return `No message or summary with id ${id}.`
        const lines = [
          `Summary ${s.id} (${s.kind}, depth ${String(s.depth)})`,
          `Covers ${String(s.message_count)} messages${s.earliest_at ? `, ${s.earliest_at} to ${s.latest_at ?? '?'}` : ''}`,
          `Written: ${s.created_at}${s.model ? ` by ${s.model}` : ''}`,
          `Conversation: ${s.conversation_id ?? '?'}${s.session_key ? ` (session ${s.session_key})` : ''}`,
        ]
        if (s.parent_id) lines.push(`Parent summary: ${s.parent_id}`)
        lines.push('', s.content)
        const children = db
          .prepare(`SELECT id, kind FROM ros_summaries WHERE parent_id = ? ORDER BY created_at, id`)
          .all(id) as unknown as Array<{ id: string; kind: string }>
        if (children.length > 0) {
          lines.push('', 'Child summaries:', ...children.map((c) => `- ${c.kind} ${c.id}`))
        }
        const sources = db
          .prepare(
            `SELECT m.id, m.role, m.agent, m.created_at, m.content FROM ros_summary_sources ss
               JOIN ros_messages m ON m.id = ss.message_id
              WHERE ss.summary_id = ? ORDER BY ss.ordinal LIMIT 100`,
          )
          .all(id) as unknown as Array<{
          id: string
          role: string
          agent: string
          created_at: string
          content: string
        }>
        if (sources.length > 0) {
          lines.push(
            '',
            'Source messages:',
            ...sources.map(
              (m) =>
                `- [${m.created_at}] ${m.agent}/${m.role} id=${m.id}: ${m.content.replace(/\s+/g, ' ').slice(0, 200)}`,
            ),
          )
        }
        return lines.join('\n')
      },
    }
  }

  private tagsTool(allowWrite: boolean): Tool {
    return {
      name: 'memory_tags',
      description: allowWrite
        ? 'Read and decide session tags: list, pending, counts, add, decide, lookup, taxonomy and its edits.'
        : 'Read session tags: list, pending, counts, lookup, taxonomy. Read-only: adding and deciding tags, and editing the vocabulary, is done by a person.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: [
              'list',
              'pending',
              'counts',
              'decide',
              'add',
              'lookup',
              'taxonomy',
              'taxonomy_upsert',
              'taxonomy_decide',
              'taxonomy_merge',
            ],
          },
          entity_type: { type: 'string', enum: ['conversation', 'summary'] },
          entity_id: { type: 'string' },
          session_key: { type: 'string' },
          agent: { type: 'string' },
          key: { type: 'string' },
          value: { type: 'string' },
          tag: { type: 'string', description: 'key:value' },
          display: { type: 'string' },
          state: { type: 'string', enum: ['suggested', 'accepted', 'rejected'] },
          ids: { type: 'array', items: { type: 'string' } },
          session_keys: { type: 'array', items: { type: 'string' } },
          entries: { type: 'array', items: { type: 'object' } },
          parent_value: { type: 'string' },
          aliases: { type: 'array', items: { type: 'string' } },
          from: { type: 'string' },
          into: { type: 'string' },
          reason: { type: 'string' },
          decided_by: { type: 'string' },
          limit: { type: 'number' },
        },
      },
      execute: async (args) => {
        const tags = this.tags()
        const action = str(args.action) ?? 'pending'
        const by = str(args.decided_by)?.trim().slice(0, 120) || 'mcp'
        if (!allowWrite && (action === 'decide' || action === 'add')) {
          return `Error: "${action}" is not available to the agent; tags are decided by a person`
        }
        const strings = (v: unknown): string[] =>
          Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x !== '') : []
        try {
          if (action === 'list') {
            const entityType =
              args.entity_type === 'conversation' || args.entity_type === 'summary'
                ? args.entity_type
                : undefined
            const state: TagState[] | undefined =
              args.state === 'suggested' || args.state === 'accepted' || args.state === 'rejected'
                ? [args.state]
                : undefined
            return JSON.stringify({
              tags: await tags.list({
                entityType,
                entityId: str(args.entity_id),
                key: str(args.key),
                value: str(args.value),
                states: state,
                limit: clampInt(args.limit, 200, 1, 1000),
              }),
            })
          }
          if (action === 'pending') {
            return JSON.stringify({ tags: await tags.pending(clampInt(args.limit, 50, 1, 500)) })
          }
          if (action === 'counts') {
            return JSON.stringify({
              counts: await tags.counts(str(args.key), clampInt(args.limit, 200, 1, 1000)),
            })
          }
          if (action === 'taxonomy') {
            return JSON.stringify({
              entries: await tags.taxonomy({
                key: str(args.key),
                limit: clampInt(args.limit, 500, 1, 5000),
              }),
            })
          }
          if (action.startsWith('taxonomy_')) {
            if (!allowWrite) {
              return `Error: "${action}" is not available to the agent; the vocabulary is edited by a person`
            }
            const vocab = this.host.vocabulary()
            if (action === 'taxonomy_upsert') {
              const key = str(args.key)
              const value = str(args.value)
              if (!key || !value) return 'Error: key and value required'
              return JSON.stringify({
                entry: vocab.upsert({
                  key,
                  value,
                  display: str(args.display),
                  parentValue:
                    args.parent_value === null ? null : (str(args.parent_value) ?? undefined),
                  aliases: Array.isArray(args.aliases) ? strings(args.aliases) : undefined,
                  state:
                    args.state === 'suggested' ||
                    args.state === 'accepted' ||
                    args.state === 'rejected'
                      ? args.state
                      : undefined,
                  reason: str(args.reason),
                }),
              })
            }
            if (action === 'taxonomy_decide') {
              const entries = (
                Array.isArray(args.entries) ? (args.entries as unknown[]) : []
              ).filter(
                (e): e is { key: string; value: string } =>
                  typeof e === 'object' &&
                  e !== null &&
                  typeof (e as { key?: unknown }).key === 'string' &&
                  typeof (e as { value?: unknown }).value === 'string',
              )
              if (entries.length === 0) return 'Error: entries required'
              if (args.state !== 'accepted' && args.state !== 'rejected') {
                return 'Error: state must be accepted or rejected'
              }
              return JSON.stringify({ changed: vocab.decide(entries, args.state) })
            }
            if (action === 'taxonomy_merge') {
              const key = str(args.key)
              const from = str(args.from)
              const into = str(args.into)
              if (!key || !from || !into) return 'Error: key, from and into required'
              return JSON.stringify(vocab.merge(key, from, into))
            }
          }
          if (action === 'lookup') {
            const keys = strings(args.session_keys)
            if (keys.length === 0) return 'Error: session_keys required'
            const sessions: Record<string, unknown> = {}
            for (const [k, v] of await tags.forSessionKeys(keys.slice(0, 500))) sessions[k] = v
            return JSON.stringify({ sessions })
          }
          if (action === 'decide') {
            const ids = strings(args.ids)
            if (ids.length === 0) return 'Error: ids required'
            if (ids.length > 1000) return 'Error: at most 1000 ids'
            if (args.state !== 'accepted' && args.state !== 'rejected') {
              return 'Error: state must be accepted or rejected'
            }
            return JSON.stringify({ changed: await tags.decide(ids, args.state, by) })
          }
          if (action === 'add') {
            if (args.entity_type !== 'conversation' && args.entity_type !== 'summary') {
              return 'Error: entity_type required'
            }
            if (!str(args.entity_id) && !str(args.session_key)) {
              return 'Error: entity_id or session_key required'
            }
            return JSON.stringify({
              tag: await tags.add(
                {
                  entityType: args.entity_type,
                  entityId: str(args.entity_id),
                  sessionKey: str(args.session_key),
                  agent: str(args.agent),
                  tag: str(args.tag),
                  key: str(args.key),
                  value: str(args.value),
                  display: str(args.display),
                  reason: str(args.reason),
                },
                by,
              ),
            })
          }
          return `Error: this memory backend does not support action "${action}"`
        } catch (err) {
          return `Error: ${err instanceof Error ? err.message : String(err)}`
        }
      },
    }
  }

  /** Who a tool write is attributed to: arguments, then the harness's variables, then "mcp". */
  private writeTags(args: Record<string, unknown>): {
    source: string
    agent: string
    channel: string
    persona?: string
  } {
    const pick = (arg: unknown, env: string | undefined): string =>
      ((typeof arg === 'string' ? arg : undefined) ?? env ?? 'mcp').trim() || 'mcp'
    const persona = (
      (typeof args.persona === 'string' ? args.persona : undefined) ??
      process.env.RIVETOS_MEMORY_PERSONA ??
      ''
    ).trim()
    return {
      source: pick(args.source, process.env.RIVETOS_MEMORY_SOURCE),
      agent: pick(args.agent, process.env.RIVETOS_MEMORY_AGENT),
      channel: pick(args.channel, process.env.RIVETOS_MEMORY_CHANNEL),
      ...(persona ? { persona } : {}),
    }
  }

  // The two write tools answer with the JSON the Postgres tools return, and
  // refuse the same inputs (by throwing), so a capture client cannot tell
  // the backends apart.

  private appendTool(): Tool {
    return {
      name: 'memory_append',
      description: 'Append one message to a capture session. Idempotent on event_id.',
      parameters: {
        type: 'object',
        properties: {
          session_id: { type: 'string' },
          content: { type: 'string' },
          role: { type: 'string', enum: ['user', 'assistant', 'system', 'tool'] },
          tool_name: { type: 'string' },
          tool_args: { type: 'object' },
          tool_result: { type: 'string' },
          event_id: { type: 'string' },
          agent: { type: 'string' },
          persona: { type: 'string' },
          source: { type: 'string' },
          channel: { type: 'string' },
        },
        required: ['session_id', 'role'],
      },
      execute: async (args) => {
        const sessionId = (str(args.session_id) ?? '').trim()
        const content = typeof args.content === 'string' ? args.content : ''
        const role = args.role
        const toolName = str(args.tool_name)
        if (!sessionId) throw new Error('memory_append: session_id is required')
        if (role !== 'user' && role !== 'assistant' && role !== 'system' && role !== 'tool') {
          throw new Error('memory_append: role must be user|assistant|system|tool')
        }
        if (!content && !toolName && role !== 'tool') {
          throw new Error(
            'memory_append: content is required (or provide tool_name for tool-call messages)',
          )
        }
        const tags = this.writeTags(args)
        const eventId =
          str(args.event_id)?.trim() ||
          createHash('sha256')
            .update(
              ['append', sessionId, tags.agent, role, content, toolName ?? ''].join('\0'),
              'utf8',
            )
            .digest('hex')
        const metadata: Record<string, unknown> = {
          source: tags.source,
          ...(tags.persona ? { persona: tags.persona } : {}),
        }
        const toolArgs =
          typeof args.tool_args === 'object' &&
          args.tool_args !== null &&
          !Array.isArray(args.tool_args)
            ? args.tool_args
            : undefined
        const toolResult =
          typeof args.tool_result === 'string' && args.tool_result ? args.tool_result : undefined
        const { rows } = this.write(
          {
            session_key: sessionId,
            agent: tags.agent,
            channel: tags.channel,
            messages: [
              {
                event_id: eventId,
                role,
                content: truncateWithMarker(content, metadata, 'content'),
                ...(toolName ? { tool_name: toolName } : {}),
                ...(toolArgs ? { tool_args: toolArgs } : {}),
                ...(toolResult
                  ? { tool_result: truncateWithMarker(toolResult, metadata, 'tool_result') }
                  : {}),
                metadata,
              },
            ],
          },
          true,
        )
        const row = rows[0]
        if (!row.inserted) {
          return JSON.stringify({
            skipped: true,
            id: row.id,
            event_id: eventId,
            session_id: sessionId,
            ...tags,
          })
        }
        const full = Math.max(
          Number(metadata.full_content_length ?? 0),
          Number(metadata.full_tool_result_length ?? 0),
        )
        return JSON.stringify({
          id: row.id,
          event_id: eventId,
          session_id: sessionId,
          ...tags,
          ...(metadata.truncated ? { truncated: true } : {}),
          ...(full > 0 ? { full_content_length: full } : {}),
        })
      },
    }
  }

  private ingestTool(): Tool {
    return {
      name: 'memory_ingest_session',
      description:
        'Ingest a batch of session messages in order. Re-sending the same batch stores nothing twice.',
      parameters: {
        type: 'object',
        properties: {
          session_id: { type: 'string' },
          messages: { type: 'array', items: { type: 'object' } },
          agent: { type: 'string' },
          persona: { type: 'string' },
          source: { type: 'string' },
          channel: { type: 'string' },
        },
        required: ['session_id', 'messages'],
      },
      execute: async (args) => {
        const sessionId = (str(args.session_id) ?? '').trim()
        if (!sessionId) throw new Error('memory_ingest_session: session_id is required')
        if (!Array.isArray(args.messages) || args.messages.length === 0) {
          throw new Error('memory_ingest_session: messages array is required and must be non-empty')
        }
        const tags = this.writeTags(args)
        const messages: CaptureBatchRequest['messages'] = []
        let skipped = 0
        let truncated = false
        let fullLength = 0
        for (const [ordinal, raw] of (args.messages as unknown[]).entries()) {
          if (typeof raw !== 'object' || raw === null) {
            throw new Error(`memory_ingest_session: messages[${String(ordinal)}] must be an object`)
          }
          const m = raw as Record<string, unknown>
          const role = m.role
          if (role !== 'user' && role !== 'assistant' && role !== 'system' && role !== 'tool') {
            throw new Error(`memory_ingest_session: messages[${String(ordinal)}].role is invalid`)
          }
          const content = typeof m.content === 'string' ? m.content : ''
          const calls = (Array.isArray(m.tool_calls) ? (m.tool_calls as unknown[]) : []).map(
            (tc) => {
              const o = typeof tc === 'object' && tc !== null ? (tc as Record<string, unknown>) : {}
              return {
                ...(typeof o.id === 'string' ? { id: o.id } : {}),
                name: typeof o.name === 'string' ? o.name : '',
                ...(typeof o.input === 'object' && o.input !== null && !Array.isArray(o.input)
                  ? { input: o.input as Record<string, unknown> }
                  : {}),
              }
            },
          )
          // Nothing to store, or a timestamp that is not one: skipped, as on Postgres.
          if (!content && calls.length === 0) {
            skipped += 1
            continue
          }
          const createdAt = str(m.created_at)
          if (createdAt && Number.isNaN(Date.parse(createdAt))) {
            skipped += 1
            continue
          }
          const primary = calls.at(0)
          const metadata: Record<string, unknown> = {
            source: tags.source,
            ordinal,
            ...(tags.persona ? { persona: tags.persona } : {}),
            ...(calls.length > 0 ? { tool_calls: calls } : {}),
          }
          const stored = truncateWithMarker(content, metadata, 'content')
          if (metadata.truncated) {
            truncated = true
            fullLength = Math.max(fullLength, Number(metadata.full_content_length ?? 0))
          }
          messages.push({
            // Position in the batch is part of the identity, so a repeated
            // line is kept and a re-sent batch is not stored twice.
            event_id: createHash('sha256')
              .update(
                [sessionId, tags.agent, role, content, String(ordinal), primary?.name ?? ''].join(
                  '\0',
                ),
                'utf8',
              )
              .digest('hex'),
            role,
            content: stored,
            ...(primary?.name ? { tool_name: primary.name } : {}),
            ...(primary?.input ? { tool_args: primary.input } : {}),
            ...(createdAt ? { created_at: new Date(Date.parse(createdAt)).toISOString() } : {}),
            metadata,
          })
        }
        const { rows } = this.write(
          { session_key: sessionId, agent: tags.agent, channel: tags.channel, messages },
          true,
        )
        const ids = rows.filter((r) => r.inserted).map((r) => r.id)
        return JSON.stringify({
          session_id: sessionId,
          ingested: ids.length,
          skipped: skipped + rows.length - ids.length,
          ids,
          ...(truncated ? { truncated: true } : {}),
          ...(fullLength > 0 ? { full_content_length: fullLength } : {}),
          ...tags,
        })
      },
    }
  }
}
/* eslint-enable @typescript-eslint/require-await */
