/**
 * Tag reads and writes for the SQLite backend — the same behaviour as the
 * Postgres tag store (plugins/memory/postgres/src/tags/store.ts) over the
 * mirrored ros_tags table: `value` is the normalized slug, `display` the
 * first-seen casing, a decision never deletes (accept/reject flips `state`
 * and stamps who/when), and a rejected row blocks re-suggestion.
 *
 * Tags sit on conversations and on summaries; a summary's tag counts for its
 * conversation in filters, counts and the review queue. The vocabulary
 * (ros_tag_taxonomy) is in tag-vocabulary.ts. node:sqlite is synchronous, so
 * is this.
 */

import { randomUUID } from 'node:crypto'
import type { DatabaseSync, SQLInputValue } from 'node:sqlite'
import {
  normalizeTagKey,
  normalizeTagValue,
  parseTagLiteral,
  sessionKeyAliases,
  sessionKeyMatchers,
  splitTagLiteral,
  type Tag,
  type TagEntityType,
  type TagProposal,
  type TagState,
} from '@rivetos/types'

interface TagRow {
  id: string
  entity_type: TagEntityType
  entity_id: string
  key: string
  value: string
  display: string
  source: string
  state: TagState
  confidence: number | null
  proposed_by: string
  reason: string
  decided_by: string | null
  decided_at: string | null
  created_at: string
  updated_at: string
}

const COLUMNS =
  'id, entity_type, entity_id, key, value, display, source, state, confidence, proposed_by, reason, decided_by, decided_at, created_at, updated_at'
const T_COLUMNS = COLUMNS.split(', ')
  .map((c) => `t.${c}`)
  .join(', ')

function rowToTag(r: TagRow): Tag {
  return {
    id: r.id,
    entityType: r.entity_type,
    entityId: r.entity_id,
    key: r.key,
    value: r.value,
    display: r.display,
    source: r.source,
    state: r.state,
    ...(r.confidence === null ? {} : { confidence: r.confidence }),
    proposedBy: r.proposed_by,
    reason: r.reason,
    ...(r.decided_by === null ? {} : { decidedBy: r.decided_by }),
    ...(r.decided_at === null ? {} : { decidedAt: new Date(r.decided_at) }),
    createdAt: new Date(r.created_at),
    updatedAt: new Date(r.updated_at),
  }
}

/** `?, ?, ?` for a list bound positionally. */
function marks(n: number): string {
  return Array.from({ length: n }, () => '?').join(', ')
}

function clamp(n: number | undefined, fallback: number, max: number): number {
  const v = typeof n === 'number' && Number.isFinite(n) ? Math.trunc(n) : fallback
  return Math.min(Math.max(v, 1), max)
}

/** SQLite binds at most 32766 variables; stay far below it. */
const MAX_BOUND = 500

export interface SqliteListTagsOptions {
  entityType?: TagEntityType
  entityId?: string
  key?: string
  value?: string
  /** Default: suggested + accepted (everything a user would see). */
  states?: TagState[]
  limit?: number
}

export interface SqliteAddTagInput {
  entityType: TagEntityType
  /** Conversation or summary id. For a conversation, `sessionKey` may be given instead. */
  entityId?: string
  /** Resolve the conversation from its capture session key (every alias is tried). */
  sessionKey?: string
  /** Narrow `sessionKey` to one agent: the same key can exist under two agents. */
  agent?: string
  /** `key:value` literal or separate key/value. */
  tag?: string
  key?: string
  value?: string
  display?: string
  reason?: string
}

/** A pending suggestion with enough context to decide it without opening the session. */
export interface SqlitePendingTag extends Tag {
  sessionKey: string | null
  title: string | null
  agent: string | null
  /** The session, or the conversation a tagged summary belongs to. */
  conversationId: string | null
  /** First 200 characters of a tagged summary. */
  excerpt: string | null
}

export interface SqliteTagCount {
  key: string
  value: string
  display: string
  conversations: number
}

/**
 * Conversations carrying an accepted tag, on the session or on any of its
 * summaries. Binds key, value, key, value. Yields `conversation_id`.
 */
export const TAGGED_CONVERSATIONS_SQL = `
  SELECT c.id AS conversation_id FROM ros_tags t
    JOIN ros_conversations c ON t.entity_type = 'conversation' AND c.id = t.entity_id
   WHERE t.key = ? AND t.value = ? AND t.state = 'accepted'
  UNION
  SELECT s.conversation_id FROM ros_tags t
    JOIN ros_summaries s ON t.entity_type = 'summary' AND s.id = t.entity_id
   WHERE t.key = ? AND t.value = ? AND t.state = 'accepted' AND s.conversation_id IS NOT NULL`

export class SqliteTagStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  list(opts: SqliteListTagsOptions = {}): Tag[] {
    const conds: string[] = []
    const params: SQLInputValue[] = []
    if (opts.entityType) {
      conds.push('entity_type = ?')
      params.push(opts.entityType)
    }
    if (opts.entityId) {
      conds.push('entity_id = ?')
      params.push(opts.entityId)
    }
    if (opts.key) {
      conds.push('key = ?')
      params.push(normalizeTagKey(opts.key))
    }
    if (opts.value) {
      conds.push('value = ?')
      params.push(normalizeTagValue(opts.value))
    }
    const states = opts.states && opts.states.length > 0 ? opts.states : ['suggested', 'accepted']
    conds.push(`state IN (${marks(states.length)})`)
    params.push(...states)
    params.push(clamp(opts.limit, 200, 1000))
    const rows = this.db
      .prepare(
        `SELECT ${COLUMNS} FROM ros_tags
          WHERE ${conds.join(' AND ')}
          ORDER BY (state = 'accepted') DESC, key, value, created_at DESC
          LIMIT ?`,
      )
      .all(...params) as unknown as TagRow[]
    return rows.map(rowToTag)
  }

  /**
   * Suggestions awaiting review, newest first, on sessions and on summaries
   * (a summary suggestion carries its conversation and an excerpt). A
   * suggestion whose conversation or summary is gone is left out.
   */
  pending(limit = 50): SqlitePendingTag[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM (
           SELECT ${T_COLUMNS}, c.session_key, c.title, c.agent,
                  c.id AS conversation_id, NULL AS excerpt
             FROM ros_tags t
             JOIN ros_conversations c ON t.entity_type = 'conversation' AND c.id = t.entity_id
            WHERE t.state = 'suggested'
           UNION ALL
           SELECT ${T_COLUMNS}, c.session_key, c.title, c.agent,
                  s.conversation_id, substr(s.content, 1, 200) AS excerpt
             FROM ros_tags t
             JOIN ros_summaries s ON t.entity_type = 'summary' AND s.id = t.entity_id
             LEFT JOIN ros_conversations c ON c.id = s.conversation_id
            WHERE t.state = 'suggested'
         )
         ORDER BY created_at DESC, id
         LIMIT ?`,
      )
      .all(clamp(limit, 50, 500)) as unknown as Array<
      TagRow & {
        session_key: string | null
        title: string | null
        agent: string | null
        conversation_id: string | null
        excerpt: string | null
      }
    >
    return rows.map((r) => ({
      ...rowToTag(r),
      sessionKey: r.session_key,
      title: r.title,
      agent: r.agent,
      conversationId: r.conversation_id,
      excerpt: r.excerpt,
    }))
  }

  /**
   * Accept or reject tags by id. Returns the ids that changed. Re-accepting a
   * rejected rule tag makes it a user tag, like re-adding it.
   */
  decide(ids: readonly string[], state: 'accepted' | 'rejected', decidedBy: string): string[] {
    const changed: string[] = []
    const now = this.now()
    for (let i = 0; i < ids.length; i += MAX_BOUND) {
      const chunk = ids.slice(i, i + MAX_BOUND)
      const rows = this.db
        .prepare(
          `UPDATE ros_tags
              SET state = ?, decided_by = ?, decided_at = ?, updated_at = ?,
                  source = CASE WHEN source = 'rule' AND ? = 'accepted' THEN 'user' ELSE source END
            WHERE id IN (${marks(chunk.length)}) AND state <> ?
            RETURNING id`,
        )
        .all(state, decidedBy, now, now, state, ...chunk, state) as unknown as Array<{
        id: string
      }>
      changed.push(...rows.map((r) => r.id))
    }
    return changed
  }

  /**
   * User-created tag: born accepted. If the same (entity, key, value) exists
   * in any state it is flipped to accepted (re-adding a rejected tag means
   * the user changed their mind), and a rule tag becomes a user tag.
   */
  add(input: SqliteAddTagInput, decidedBy: string): Tag {
    let key = input.key ? normalizeTagKey(input.key) : ''
    let value = input.value ? normalizeTagValue(input.value) : ''
    let display = input.display ?? input.value ?? ''
    if (input.tag) {
      const parsed = parseTagLiteral(input.tag)
      if (!parsed) throw new Error(`invalid tag literal "${input.tag}" (want key:value)`)
      key = parsed.key
      value = parsed.value
      display = input.display ?? (splitTagLiteral(input.tag)?.value ?? '').trim()
    }
    if (!key || !value) throw new Error('key and value are required')
    let entityId = input.entityId
    if (!entityId && input.sessionKey && input.entityType === 'conversation') {
      entityId = this.conversationForSessionKey(input.sessionKey, input.agent)
    }
    if (!entityId) throw new Error('entity_id (or session_key for a conversation) is required')
    const now = this.now()
    const row = this.db
      .prepare(
        `INSERT INTO ros_tags
           (id, entity_type, entity_id, key, value, display, source, state, proposed_by, reason,
            decided_by, decided_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'user', 'accepted', ?, ?, ?, ?, ?, ?)
         ON CONFLICT (entity_type, entity_id, key, value) DO UPDATE
           SET state = 'accepted', decided_by = excluded.decided_by,
               decided_at = excluded.decided_at, updated_at = excluded.updated_at,
               source = CASE WHEN ros_tags.source = 'rule' THEN 'user' ELSE ros_tags.source END,
               display = CASE WHEN ros_tags.display = '' THEN excluded.display ELSE ros_tags.display END
         RETURNING ${COLUMNS}`,
      )
      .get(
        randomUUID(),
        input.entityType,
        entityId,
        key,
        value,
        display,
        decidedBy,
        input.reason ?? '',
        decidedBy,
        now,
        now,
        now,
      ) as unknown as TagRow
    return rowToTag(row)
  }

  /**
   * Record proposals from a rule or a model. A rule's tag is born accepted
   * (decided by the rule), anything else is a suggestion. An existing row in
   * ANY state wins — a rejected tag is never re-proposed. Returns how many
   * rows were written.
   */
  propose(
    entityType: TagEntityType,
    entityId: string,
    proposals: readonly TagProposal[],
    by: { source: string; proposedBy: string },
  ): number {
    const now = this.now()
    const accepted = by.source === 'rule'
    const insert = this.db.prepare(
      `INSERT INTO ros_tags
         (id, entity_type, entity_id, key, value, display, source, state, confidence, proposed_by,
          reason, decided_by, decided_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (entity_type, entity_id, key, value) DO NOTHING`,
    )
    let written = 0
    for (const p of proposals) {
      const key = normalizeTagKey(p.key)
      const value = normalizeTagValue(p.value)
      if (!key || !value) continue
      const confidence =
        typeof p.confidence === 'number' && Number.isFinite(p.confidence)
          ? Math.min(Math.max(p.confidence, 0), 1)
          : null
      const r = insert.run(
        randomUUID(),
        entityType,
        entityId,
        key,
        value,
        p.display ?? '',
        by.source,
        accepted ? 'accepted' : 'suggested',
        confidence,
        by.proposedBy,
        p.reason ?? '',
        accepted ? by.proposedBy : null,
        accepted ? now : null,
        now,
        now,
      )
      written += Number(r.changes)
    }
    return written
  }

  /**
   * Tags by session key (what a client holds), including suggestions. A
   * session may be captured under an alias of the key asked for, so every
   * alias is matched and the tags come back under the requested key.
   */
  forSessionKeys(
    sessionKeys: readonly string[],
    states: readonly TagState[] = ['suggested', 'accepted'],
  ): Map<string, Tag[]> {
    const out = new Map<string, Tag[]>()
    const keys = [...new Set(sessionKeys.filter(Boolean))]
    // An empty state list means the default, like list(). (Postgres'
    // tagsForSessionKeys returns nothing for an empty list; here it would be
    // invalid SQL, and nothing calls it that way.)
    const wanted: readonly TagState[] = states.length > 0 ? states : ['suggested', 'accepted']
    for (let i = 0; i < keys.length; i += 100) {
      this.lookupChunk(keys.slice(i, i + 100), wanted, out)
    }
    return out
  }

  private lookupChunk(keys: string[], states: readonly TagState[], out: Map<string, Tag[]>): void {
    /** alias → the requested keys it answers for. */
    const requestedBy = new Map<string, string[]>()
    const exact = new Set<string>()
    const like = new Set<string>()
    for (const key of keys) {
      const m = sessionKeyMatchers(key)
      for (const alias of m.exact) {
        exact.add(alias)
        const list = requestedBy.get(alias) ?? []
        if (!list.includes(key)) list.push(key)
        requestedBy.set(alias, list)
      }
      for (const pattern of m.like) like.add(pattern)
    }
    const rows = this.db
      .prepare(
        `SELECT ${T_COLUMNS}, c.session_key
           FROM ros_tags t
           JOIN ros_conversations c ON c.id = t.entity_id AND t.entity_type = 'conversation'
          WHERE (${sessionKeyPredicate('c.session_key', exact.size, like.size)})
            AND t.state IN (${marks(states.length)})
          ORDER BY (t.state = 'accepted') DESC, t.key, t.value`,
      )
      .all(...exact, ...like, ...states) as unknown as Array<TagRow & { session_key: string }>
    for (const r of rows) {
      // A stored key answers for every requested key that shares an alias
      // with it (path-form → canonical → bare, which the request cannot derive).
      const answers = new Set<string>()
      for (const alias of sessionKeyAliases(r.session_key)) {
        for (const key of requestedBy.get(alias) ?? []) answers.add(key)
      }
      for (const key of answers) {
        const list = out.get(key) ?? []
        if (!list.some((t) => t.key === r.key && t.value === r.value)) list.push(rowToTag(r))
        out.set(key, list)
      }
    }
  }

  /** Conversation ids carrying an accepted `key:value`. */
  conversationIdsWithTag(key: string, value: string): string[] {
    const k = normalizeTagKey(key)
    const v = normalizeTagValue(value)
    const rows = this.db
      .prepare(`SELECT conversation_id AS id FROM (${TAGGED_CONVERSATIONS_SQL})`)
      .all(k, v, k, v) as unknown as Array<{ id: string }>
    return rows.map((r) => r.id)
  }

  /** Accepted tag usage across conversations, most used first. */
  counts(key?: string, limit = 200): SqliteTagCount[] {
    const params: SQLInputValue[] = []
    let where = `WHERE t.state = 'accepted'`
    if (key) {
      where += ' AND t.key = ?'
      params.push(normalizeTagKey(key))
    }
    params.push(clamp(limit, 200, 1000))
    // A conversation counts when the tag sits on the session or on any of
    // its summaries: the definition the tag filter uses.
    const rows = this.db
      .prepare(
        `SELECT t.key, t.value, max(t.display) AS display,
                count(DISTINCT CASE WHEN t.entity_type = 'conversation' THEN c.id
                                    ELSE s.conversation_id END) AS n
           FROM ros_tags t
           LEFT JOIN ros_conversations c ON t.entity_type = 'conversation' AND c.id = t.entity_id
           LEFT JOIN ros_summaries s ON t.entity_type = 'summary' AND s.id = t.entity_id
           ${where}
            AND (c.id IS NOT NULL OR s.conversation_id IS NOT NULL)
          GROUP BY t.key, t.value
          ORDER BY n DESC, t.key, t.value
          LIMIT ?`,
      )
      .all(...params) as unknown as Array<{
      key: string
      value: string
      display: string
      n: number
    }>
    return rows.map((r) => ({
      key: r.key,
      value: r.value,
      display: r.display,
      conversations: r.n,
    }))
  }

  /**
   * The conversation a session key names. The same key can exist under two
   * agents; tagging the wrong one would be silent, so without an agent to
   * narrow by that is refused, not guessed.
   */
  private conversationForSessionKey(sessionKey: string, agent: string | undefined): string {
    const m = sessionKeyMatchers(sessionKey)
    const match = `(${sessionKeyPredicate('session_key', m.exact.length, m.like.length)})
                   AND (? IS NULL OR agent = ?)`
    const bind: SQLInputValue[] = [...m.exact, ...m.like, agent ?? null, agent ?? null]
    const agents = this.db
      .prepare(`SELECT count(DISTINCT agent) AS n FROM ros_conversations WHERE ${match}`)
      .get(...bind) as unknown as { n: number }
    if (agents.n > 1) {
      throw new Error(
        `invalid request: session "${sessionKey}" exists under several agents; pass agent`,
      )
    }
    const hit = this.db
      .prepare(
        `SELECT id FROM ros_conversations WHERE ${match}
          ORDER BY (session_key = ?) DESC, updated_at DESC LIMIT 1`,
      )
      .get(...bind, sessionKey) as unknown as { id: string } | undefined
    if (!hit) throw new Error(`no conversation captured for session "${sessionKey}"`)
    return hit.id
  }
}

/**
 * `col IN (…) OR col LIKE ? ESCAPE '\' …` for `exact` then `like` bound in
 * that order. The exact list is never empty (a key aliases at least to itself).
 * SQLite's LIKE ignores ASCII case where Postgres' does not; the patterns pin
 * a harness prefix and a uuid tail, so only a case variant of the same
 * session could match.
 */
function sessionKeyPredicate(col: string, exact: number, like: number): string {
  const parts = [`${col} IN (${marks(exact)})`]
  for (let i = 0; i < like; i += 1) parts.push(`${col} LIKE ? ESCAPE '\\'`)
  return parts.join(' OR ')
}
