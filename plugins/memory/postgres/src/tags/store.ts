/**
 * Tag store — every read/write of ros_tags and ros_tag_taxonomy that is not
 * the capture rule (tags/rule-project.ts) or the worker's suggest-tags task.
 * Shared by the /api/memory/tags HTTP routes and the memory_tags MCP tool, so
 * the hub and agents see one behaviour.
 *
 * Conventions: `value` is the normalized slug, `display` the first-seen
 * casing. A decision never deletes: accept/reject flips `state` and stamps
 * who/when. "Remove this tag" is a reject, which also blocks re-suggestion.
 */

import type pg from 'pg'
import {
  normalizeTagKey,
  normalizeTagValue,
  parseTagLiteral,
  sessionKeyAliases,
  sessionKeyMatchers,
  splitTagLiteral,
  type Tag,
  type TagEntityType,
  type TagState,
  type TagTaxonomyEntry,
} from '@rivetos/types'

type Queryable = Pick<pg.Pool, 'query'> | Pick<pg.PoolClient, 'query'>

/**
 * Run `fn` in one transaction. A Pool gets its own client + BEGIN/COMMIT; a
 * client (already in the caller's transaction) is used as-is.
 */
async function inTransaction<T>(
  db: Queryable,
  fn: (q: Queryable) => Promise<T>,
  /**
   * Serialize with every other transaction holding the same lock name (a
   * transaction-scoped advisory lock, released at COMMIT/ROLLBACK). Taken
   * only when this call opens the transaction.
   */
  lockName?: string,
): Promise<T> {
  const maybePool = db as Partial<pg.Pool>
  if (typeof maybePool.connect !== 'function' || typeof maybePool.totalCount !== 'number') {
    return fn(db)
  }
  const client = await (db as pg.Pool).connect()
  try {
    await client.query('BEGIN')
    if (lockName !== undefined) {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [lockName])
    }
    const out = await fn(client)
    await client.query('COMMIT')
    return out
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

/** Ancestor walk bound for the taxonomy tree. */
const TAXONOMY_MAX_DEPTH = 32

export interface TagRow {
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
  decided_at: Date | null
  created_at: Date
  updated_at: Date
}

export function rowToTag(r: TagRow): Tag {
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
    ...(r.decided_at === null ? {} : { decidedAt: r.decided_at }),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

const TAG_COLUMNS =
  'id, entity_type, entity_id, key, value, display, source, state, confidence, proposed_by, reason, decided_by, decided_at, created_at, updated_at'

export const TAG_STATES: readonly TagState[] = ['suggested', 'accepted', 'rejected']

export function isTagState(v: unknown): v is TagState {
  return typeof v === 'string' && (TAG_STATES as readonly string[]).includes(v)
}

export function isEntityType(v: unknown): v is TagEntityType {
  return v === 'conversation' || v === 'summary'
}

export interface ListTagsOptions {
  entityType?: TagEntityType
  entityId?: string
  key?: string
  value?: string
  /** Default: suggested + accepted (everything a user would see). */
  states?: TagState[]
  limit?: number
}

export async function listTags(db: Queryable, opts: ListTagsOptions = {}): Promise<Tag[]> {
  const conds: string[] = []
  const params: unknown[] = []
  /** Next positional placeholder for a value just pushed. */
  const bind = (v: unknown): string => {
    params.push(v)
    return `$${String(params.length)}`
  }
  if (opts.entityType) conds.push(`entity_type = ${bind(opts.entityType)}`)
  if (opts.entityId) conds.push(`entity_id = ${bind(opts.entityId)}`)
  if (opts.key) conds.push(`key = ${bind(normalizeTagKey(opts.key))}`)
  if (opts.value) conds.push(`value = ${bind(normalizeTagValue(opts.value))}`)
  const states = opts.states && opts.states.length > 0 ? opts.states : ['suggested', 'accepted']
  conds.push(`state = ANY(${bind(states)}::text[])`)
  const limit = bind(Math.min(Math.max(opts.limit ?? 200, 1), 1000))
  const { rows } = await db.query<TagRow>(
    `SELECT ${TAG_COLUMNS} FROM ros_tags
      WHERE ${conds.join(' AND ')}
      ORDER BY state = 'accepted' DESC, key, value, created_at DESC
      LIMIT ${limit}`,
    params,
  )
  return rows.map(rowToTag)
}

/**
 * A pending suggestion with enough context to decide it without opening the
 * session. Suggestions whose entity was deleted are left out (the worker's
 * hourly sweep removes them).
 */
export interface PendingTag extends Tag {
  sessionKey?: string | null
  title?: string | null
  agent?: string | null
  /** For summary suggestions: the summary's conversation. */
  conversationId?: string | null
  /** First ~200 chars of the summary, for summary suggestions. */
  excerpt?: string | null
}

export async function pendingTags(db: Queryable, limit = 50): Promise<PendingTag[]> {
  const { rows } = await db.query<
    TagRow & {
      session_key: string | null
      title: string | null
      agent: string | null
      conversation_id: string | null
      excerpt: string | null
    }
  >(
    `SELECT ${TAG_COLUMNS.split(', ')
      .map((c) => `t.${c}`)
      .join(', ')},
            COALESCE(c.session_key, sc.session_key) AS session_key,
            COALESCE(c.title, sc.title) AS title,
            COALESCE(c.agent, sc.agent) AS agent,
            COALESCE(c.id, s.conversation_id) AS conversation_id,
            left(s.content, 200) AS excerpt
       FROM ros_tags t
       LEFT JOIN ros_conversations c ON t.entity_type = 'conversation' AND c.id = t.entity_id
       LEFT JOIN ros_summaries s ON t.entity_type = 'summary' AND s.id = t.entity_id
       -- A summary suggestion names its session too, so the reviewer can open it.
       LEFT JOIN ros_conversations sc ON sc.id = s.conversation_id
      WHERE t.state = 'suggested'
        AND (c.id IS NOT NULL OR s.id IS NOT NULL)
      ORDER BY t.created_at DESC
      LIMIT $1`,
    [Math.min(Math.max(limit, 1), 500)],
  )
  return rows.map((r) => ({
    ...rowToTag(r),
    sessionKey: r.session_key,
    title: r.title,
    agent: r.agent,
    conversationId: r.conversation_id,
    excerpt: r.excerpt,
  }))
}

/** Accept or reject tags by id. Returns the ids that changed. */
export async function decideTags(
  db: Queryable,
  ids: string[],
  state: 'accepted' | 'rejected',
  decidedBy: string,
): Promise<string[]> {
  if (ids.length === 0) return []
  const { rows } = await db.query<{ id: string }>(
    `UPDATE ros_tags
        SET state = $2, decided_by = $3, decided_at = now(), updated_at = now()
      WHERE id = ANY($1::uuid[]) AND state <> $2
      RETURNING id`,
    [ids, state, decidedBy],
  )
  return rows.map((r) => r.id)
}

export interface AddTagInput {
  entityType: TagEntityType
  /** Conversation or summary id. For a conversation, `sessionKey` may be given instead. */
  entityId?: string
  /**
   * Resolve the conversation from its capture session key, trying every
   * alias of the key (sessionKeyAliases). An exact key match wins, then the
   * most recently updated.
   */
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

/**
 * User-created tag: born accepted. If the same (entity, key, value) exists
 * in any state it is flipped to accepted (a user re-adding a rejected tag
 * means they changed their mind). Returns the row.
 */
export async function addTag(db: Queryable, input: AddTagInput, decidedBy: string): Promise<Tag> {
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
    const match = sessionKeyMatchers(input.sessionKey)
    // The same key can exist under two agents. Tagging the wrong one would be
    // silent, so without an agent to narrow by this is refused, not guessed.
    // The agent count covers every match, not just the row that is picked.
    const found = await db.query<{ id: string; agents: string | number }>(
      `WITH m AS (
         SELECT id, agent, session_key, updated_at FROM ros_conversations
          WHERE (session_key = ANY($1::text[]) OR session_key LIKE ANY($4::text[]))
            AND ($3::text IS NULL OR agent = $3)
       )
       SELECT id, (SELECT count(DISTINCT agent) FROM m) AS agents
         FROM m
        ORDER BY (session_key = $2) DESC, updated_at DESC
        LIMIT 1`,
      [match.exact, input.sessionKey, input.agent ?? null, match.like],
    )
    const hit = found.rows.at(0)
    if (hit && Number(hit.agents) > 1) {
      throw new Error(
        `invalid request: session "${input.sessionKey}" exists under several agents; pass agent`,
      )
    }
    entityId = hit?.id
    if (!entityId) throw new Error(`no conversation captured for session "${input.sessionKey}"`)
  }
  if (!entityId) throw new Error('entity_id (or session_key for a conversation) is required')
  const { rows } = await db.query<TagRow>(
    `INSERT INTO ros_tags
       (entity_type, entity_id, key, value, display, source, state, proposed_by, reason, decided_by, decided_at)
     VALUES ($1, $2, $3, $4, $5, 'user', 'accepted', $6, $7, $6, now())
     ON CONFLICT (entity_type, entity_id, key, value) DO UPDATE
       SET state = 'accepted', decided_by = EXCLUDED.decided_by, decided_at = now(),
           updated_at = now(),
           display = CASE WHEN ros_tags.display = '' THEN EXCLUDED.display ELSE ros_tags.display END
     RETURNING ${TAG_COLUMNS}`,
    [input.entityType, entityId, key, value, display, decidedBy, input.reason ?? ''],
  )
  return rowToTag(rows[0])
}

/**
 * Accepted tags for a set of conversations, keyed by conversation id. One
 * query; used to enrich search/browse hits and the hub drawer.
 */
export async function tagsForConversations(
  db: Queryable,
  conversationIds: string[],
  states: TagState[] = ['accepted'],
  opts: {
    /**
     * Also return tags that sit on a summary of the conversation, under the
     * conversation's id. Hit enrichment wants this (a `tag=` filter matches
     * summary-only tags, and the hit should show the tag that selected it);
     * callers asking "what is tagged on the session itself" do not.
     */
    includeSummaryTags?: boolean
  } = {},
): Promise<Map<string, Tag[]>> {
  const out = new Map<string, Tag[]>()
  const ids = [...new Set(conversationIds.filter(Boolean))]
  if (ids.length === 0) return out
  const cols = TAG_COLUMNS.split(', ')
    .map((c) => `t.${c}`)
    .join(', ')
  const { rows } = await db.query<TagRow & { conversation_id: string }>(
    opts.includeSummaryTags
      ? `SELECT ${cols}, COALESCE(c.id, s.conversation_id) AS conversation_id
           FROM ros_tags t
           LEFT JOIN ros_conversations c ON t.entity_type = 'conversation' AND c.id = t.entity_id
           LEFT JOIN ros_summaries s ON t.entity_type = 'summary' AND s.id = t.entity_id
          WHERE COALESCE(c.id, s.conversation_id) = ANY($1::uuid[]) AND t.state = ANY($2::text[])
          ORDER BY (t.entity_type = 'conversation') DESC, t.key, t.value`
      : `SELECT ${cols}, t.entity_id AS conversation_id FROM ros_tags t
          WHERE t.entity_type = 'conversation' AND t.entity_id = ANY($1::uuid[])
            AND t.state = ANY($2::text[])
          ORDER BY t.key, t.value`,
    [ids, states],
  )
  for (const r of rows) {
    const list = out.get(r.conversation_id) ?? []
    // A session tag and a summary tag with the same key:value are one chip.
    if (!list.some((t) => t.key === r.key && t.value === r.value)) list.push(rowToTag(r))
    out.set(r.conversation_id, list)
  }
  return out
}

// The matching rule is shared with the SQLite backend; it lives in @rivetos/types.
export { sessionKeyMatchers }

/**
 * Tags by session key (what the hub has), including suggestions. A session
 * may be captured under an alias of the key the caller holds (the bare
 * native id for den-spawned harnesses, Claude's path-fallback form — see
 * sessionKeyAliases), so every alias is matched and the tags come back under
 * the key that was asked for.
 */
export async function tagsForSessionKeys(
  db: Queryable,
  sessionKeys: string[],
  states: TagState[] = ['suggested', 'accepted'],
): Promise<Map<string, Tag[]>> {
  const out = new Map<string, Tag[]>()
  const keys = [...new Set(sessionKeys.filter(Boolean))]
  if (keys.length === 0) return out
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
  const { rows } = await db.query<TagRow & { session_key: string }>(
    `SELECT ${TAG_COLUMNS.split(', ')
      .map((c) => `t.${c}`)
      .join(', ')}, c.session_key
       FROM ros_tags t
       JOIN ros_conversations c ON c.id = t.entity_id AND t.entity_type = 'conversation'
      WHERE (c.session_key = ANY($1::text[]) OR c.session_key LIKE ANY($3::text[]))
        AND t.state = ANY($2::text[])
      ORDER BY t.state = 'accepted' DESC, t.key, t.value`,
    [[...exact], states, [...like]],
  )
  for (const r of rows) {
    // A stored key answers for every requested key that shares an alias with
    // it: the stored key's own aliases cover the path-form → canonical → bare
    // direction the request could not derive.
    const answers = new Set<string>()
    for (const alias of sessionKeyAliases(r.session_key)) {
      for (const key of requestedBy.get(alias) ?? []) answers.add(key)
    }
    for (const key of answers) {
      const list = out.get(key) ?? []
      // Two stored conversations (canonical + bare) can carry the same tag;
      // the chip shows once, and deciding it decides the row that surfaced.
      if (!list.some((t) => t.key === r.key && t.value === r.value)) list.push(rowToTag(r))
      out.set(key, list)
    }
  }
  return out
}

/**
 * Subquery selecting the conversations that carry an accepted `key:value`,
 * whether the tag sits on the session or on one of its summaries. The one
 * definition of "tagged" for search, browse and the MCP tools: use as
 * `m.conversation_id IN ${taggedConversationsSql(i, j)}` with the key bound
 * at `$i` and the value at `$j`.
 */
export function taggedConversationsSql(keyIdx: number, valueIdx: number): string {
  return `(SELECT COALESCE(tc.id, ts.conversation_id)
             FROM ros_tags tt
             LEFT JOIN ros_conversations tc ON tt.entity_type = 'conversation' AND tc.id = tt.entity_id
             LEFT JOIN ros_summaries ts ON tt.entity_type = 'summary' AND ts.id = tt.entity_id
            WHERE tt.key = $${String(keyIdx)} AND tt.value = $${String(valueIdx)} AND tt.state = 'accepted')`
}

/** Conversation ids carrying an accepted `key:value` (session tag or any of its summaries' tags). */
export async function conversationIdsWithTag(
  db: Queryable,
  key: string,
  value: string,
): Promise<string[]> {
  const { rows } = await db.query<{ id: string }>(
    `SELECT DISTINCT COALESCE(c.id, s.conversation_id) AS id
       FROM ros_tags t
       LEFT JOIN ros_conversations c ON t.entity_type = 'conversation' AND c.id = t.entity_id
       LEFT JOIN ros_summaries s ON t.entity_type = 'summary' AND s.id = t.entity_id
      WHERE t.key = $1 AND t.value = $2 AND t.state = 'accepted'
        AND COALESCE(c.id, s.conversation_id) IS NOT NULL`,
    [normalizeTagKey(key), normalizeTagValue(value)],
  )
  return rows.map((r) => r.id)
}

export interface TagCount {
  key: string
  value: string
  display: string
  conversations: number
}

/**
 * Accepted tag usage across conversations, most used first. Feeds
 * group-by-tag. A conversation counts when the tag sits on the session or on
 * any of its summaries — the same definition `tag=` filters use, so a count
 * matches what the filter returns.
 */
export async function tagCounts(db: Queryable, key?: string, limit = 200): Promise<TagCount[]> {
  const params: unknown[] = []
  let where = `WHERE t.state = 'accepted' AND COALESCE(c.id, s.conversation_id) IS NOT NULL`
  if (key) {
    params.push(normalizeTagKey(key))
    where += ` AND t.key = $${String(params.length)}`
  }
  params.push(Math.min(Math.max(limit, 1), 1000))
  const { rows } = await db.query<{ key: string; value: string; display: string; n: string }>(
    `SELECT t.key, t.value, max(t.display) AS display,
            count(DISTINCT COALESCE(c.id, s.conversation_id))::text AS n
       FROM ros_tags t
       LEFT JOIN ros_conversations c ON t.entity_type = 'conversation' AND c.id = t.entity_id
       LEFT JOIN ros_summaries s ON t.entity_type = 'summary' AND s.id = t.entity_id
       ${where}
      GROUP BY t.key, t.value
      ORDER BY count(DISTINCT COALESCE(c.id, s.conversation_id)) DESC, t.key, t.value
      LIMIT $${String(params.length)}`,
    params,
  )
  return rows.map((r) => ({
    key: r.key,
    value: r.value,
    display: r.display,
    conversations: Number(r.n),
  }))
}

// ---------------------------------------------------------------------------
// Taxonomy
// ---------------------------------------------------------------------------

interface TaxonomyRow {
  key: string
  value: string
  display: string
  parent_value: string | null
  aliases: string[]
  state: TagState
  source: string
  reason: string
  decided_at: Date | null
  created_at: Date
  updated_at: Date
}

function rowToTaxonomy(r: TaxonomyRow): TagTaxonomyEntry {
  return {
    key: r.key,
    value: r.value,
    display: r.display,
    ...(r.parent_value === null ? {} : { parentValue: r.parent_value }),
    aliases: r.aliases,
    state: r.state,
    source: r.source,
    reason: r.reason,
    ...(r.decided_at === null ? {} : { decidedAt: r.decided_at }),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

export async function listTaxonomy(
  db: Queryable,
  opts: { key?: string; states?: TagState[]; limit?: number } = {},
): Promise<TagTaxonomyEntry[]> {
  const params: unknown[] = []
  const conds: string[] = []
  if (opts.key) {
    params.push(normalizeTagKey(opts.key))
    conds.push(`key = $${String(params.length)}`)
  }
  const states = opts.states && opts.states.length > 0 ? opts.states : ['suggested', 'accepted']
  params.push(states)
  conds.push(`state = ANY($${String(params.length)}::text[])`)
  params.push(Math.min(Math.max(opts.limit ?? 500, 1), 5000))
  const { rows } = await db.query<TaxonomyRow>(
    `SELECT key, value, display, parent_value, aliases, state, source, reason, decided_at, created_at, updated_at
       FROM ros_tag_taxonomy
      WHERE ${conds.join(' AND ')}
      ORDER BY key, parent_value NULLS FIRST, value
      LIMIT $${String(params.length)}`,
    params,
  )
  return rows.map(rowToTaxonomy)
}

export interface UpsertTaxonomyInput {
  key: string
  value: string
  display?: string
  /** Same-key parent; `null` clears. */
  parentValue?: string | null
  aliases?: string[]
  state?: TagState
  reason?: string
}

/** Advisory lock name for structural edits to one key's vocabulary tree. */
function taxonomyLock(key: string): string {
  return `ros_tag_taxonomy:${key}`
}

/** Create or update one vocabulary entry. User edits are accepted unless told otherwise. */
export function upsertTaxonomy(
  db: Queryable,
  input: UpsertTaxonomyInput,
  source = 'user',
): Promise<TagTaxonomyEntry> {
  // The ancestor walk and the write are one unit: two concurrent edits must
  // not each pass the walk and together close a cycle. One transaction is not
  // enough for that (both walks could read before either writes), so edits to
  // one key's tree also take that key's lock.
  return inTransaction(
    db,
    (q) => upsertTaxonomyIn(q, input, source),
    taxonomyLock(normalizeTagKey(input.key)),
  )
}

async function upsertTaxonomyIn(
  db: Queryable,
  input: UpsertTaxonomyInput,
  source: string,
): Promise<TagTaxonomyEntry> {
  const key = normalizeTagKey(input.key)
  const value = normalizeTagValue(input.value)
  if (!key || !value) throw new Error('key and value are required')
  const parentRaw =
    input.parentValue === undefined || input.parentValue === null
      ? input.parentValue
      : normalizeTagValue(input.parentValue)
  // A parent that normalizes to nothing is "no parent", not a parent named ''.
  const parent = parentRaw === '' ? null : parentRaw
  if (parent === value) throw new Error('a value cannot be its own parent')
  if (typeof parent === 'string' && parent !== '') {
    // Walk up from the proposed parent: reaching `value` would close a loop.
    let cursor: string | null = parent
    for (let depth = 0; cursor !== null && depth < TAXONOMY_MAX_DEPTH; depth += 1) {
      const up: { rows: Array<{ parent_value: string | null }> } = await db.query(
        `SELECT parent_value FROM ros_tag_taxonomy WHERE key = $1 AND value = $2`,
        [key, cursor],
      )
      // The parent itself must be a vocabulary entry under the same key: a
      // dangling parent would orphan this value in any tree rendering.
      if (depth === 0 && up.rows.length === 0) {
        throw new Error(`invalid parent: ${key}:${cursor} is not in the vocabulary`)
      }
      cursor = up.rows.at(0)?.parent_value ?? null
      if (cursor === value) throw new Error('invalid parent: it would create a cycle')
    }
    if (cursor !== null) throw new Error('invalid parent: taxonomy is nested too deeply')
  }
  const aliases = input.aliases?.map(normalizeTagValue).filter((a) => a && a !== value)
  const state = input.state ?? 'accepted'
  const { rows } = await db.query<TaxonomyRow>(
    `INSERT INTO ros_tag_taxonomy (key, value, display, parent_value, aliases, state, source, reason, decided_at)
     VALUES ($1, $2, $3, $4, COALESCE($5::text[], '{}'), $6, $7, $8,
             CASE WHEN $6 = 'suggested' THEN NULL ELSE now() END)
     ON CONFLICT (key, value) DO UPDATE SET
       display      = CASE WHEN $3 <> '' THEN $3 ELSE ros_tag_taxonomy.display END,
       parent_value = CASE WHEN $9 THEN $4 ELSE ros_tag_taxonomy.parent_value END,
       aliases      = COALESCE($5::text[], ros_tag_taxonomy.aliases),
       state        = $6,
       source       = $7,
       reason       = CASE WHEN $8 <> '' THEN $8 ELSE ros_tag_taxonomy.reason END,
       decided_at   = CASE WHEN $6 = 'suggested' THEN ros_tag_taxonomy.decided_at ELSE now() END,
       updated_at   = now()
     RETURNING key, value, display, parent_value, aliases, state, source, reason, decided_at, created_at, updated_at`,
    [
      key,
      value,
      input.display ?? '',
      parent ?? null,
      aliases ?? null,
      state,
      source,
      input.reason ?? '',
      input.parentValue !== undefined,
    ],
  )
  return rowToTaxonomy(rows[0])
}

/** Accept or reject vocabulary entries. */
export async function decideTaxonomy(
  db: Queryable,
  entries: Array<{ key: string; value: string }>,
  state: 'accepted' | 'rejected',
): Promise<number> {
  if (entries.length > 500) throw new Error('invalid request: at most 500 entries')
  let changed = 0
  for (const e of entries) {
    const { rowCount } = await db.query(
      `UPDATE ros_tag_taxonomy SET state = $3, decided_at = now(), updated_at = now()
        WHERE key = $1 AND value = $2 AND state <> $3`,
      [normalizeTagKey(e.key), normalizeTagValue(e.value), state],
    )
    changed += rowCount ?? 0
  }
  return changed
}

/**
 * Merge `from` into `into` under one key: `into` gains `from` as an alias,
 * every tag row on `from` is re-pointed at `into` (skipping entities that
 * already carry `into`), and the `from` vocabulary row is rejected. This is
 * the "consolidation" the tagger proposes and the user ratifies.
 */
export async function mergeTaxonomyValue(
  db: Queryable,
  key: string,
  from: string,
  into: string,
): Promise<{ moved: number; dropped: number; into: string }> {
  const k = normalizeTagKey(key)
  const f = normalizeTagValue(from)
  const requested = normalizeTagValue(into)
  if (!k || !f || !requested || f === requested) {
    throw new Error('merge needs one key and two different values')
  }
  return inTransaction(
    db,
    async (q) => {
      // `into` may itself have been merged away: follow it to the survivor so
      // tags never land on a value the vocabulary says resolves elsewhere.
      const alias = await q.query<{ value: string }>(
        `SELECT value FROM ros_tag_taxonomy
        WHERE key = $1 AND $2 = ANY(aliases) AND state = 'accepted'
        ORDER BY value LIMIT 1`,
        [k, requested],
      )
      const i = alias.rows.at(0)?.value ?? requested
      if (i === f) throw new Error('invalid merge: the target resolves to the value being merged')

      // `from` must be something: a vocabulary entry or a value in use. A typo
      // would otherwise mint an alias for a value that never existed.
      const known = await q.query(
        `SELECT 1 FROM ros_tag_taxonomy WHERE key = $1 AND value = $2
       UNION ALL
       SELECT 1 FROM ros_tags WHERE key = $1 AND value = $2
       LIMIT 1`,
        [k, f],
      )
      if (known.rows.length === 0) {
        throw new Error(`invalid merge: ${k}:${f} is not in the vocabulary or in use`)
      }

      // The survivor must not sit under the value being merged: re-homing
      // `from`'s children onto it would close a loop.
      let cursor: string | null = i
      for (let depth = 0; cursor !== null && depth < TAXONOMY_MAX_DEPTH; depth += 1) {
        const up: { rows: Array<{ parent_value: string | null }> } = await q.query(
          `SELECT parent_value FROM ros_tag_taxonomy WHERE key = $1 AND value = $2`,
          [k, cursor],
        )
        cursor = up.rows.at(0)?.parent_value ?? null
        if (cursor === f) throw new Error(`invalid merge: ${k}:${i} is nested under ${k}:${f}`)
      }
      if (cursor !== null) throw new Error('invalid merge: taxonomy is nested too deeply')

      // Survivor takes `from` and everything `from` had absorbed as aliases.
      await q.query(
        `INSERT INTO ros_tag_taxonomy (key, value, display, aliases, state, source, reason, decided_at)
       VALUES ($1, $2, '', ARRAY[$3]::text[], 'accepted', 'user', 'merge target', now())
       ON CONFLICT (key, value) DO UPDATE SET
         aliases = (
           SELECT COALESCE(array_agg(DISTINCT a), '{}') FROM unnest(
             ros_tag_taxonomy.aliases || ARRAY[$3]::text[] ||
             COALESCE((SELECT t.aliases FROM ros_tag_taxonomy t WHERE t.key = $1 AND t.value = $3), '{}')
           ) AS a WHERE a <> $2
         ),
         state = 'accepted', decided_at = now(), updated_at = now()`,
        [k, i, f],
      )
      // Re-point tags that have no survivor row yet. display is cleared: it
      // held the merged-away casing, and an empty display renders as the value.
      const moved = await q.query(
        `UPDATE ros_tags t SET value = $3, display = '', updated_at = now()
        WHERE t.key = $1 AND t.value = $2
          AND NOT EXISTS (SELECT 1 FROM ros_tags o
                           WHERE o.entity_type = t.entity_type AND o.entity_id = t.entity_id
                             AND o.key = $1 AND o.value = $3)`,
        [k, f, i],
      )
      // Entities that carry both: the two rows are now the same tag, so the
      // review decision must survive. A decided `from` row wins over an
      // undecided survivor, and between two decisions the later one wins —
      // an accepted tag is never silently replaced by a mere suggestion.
      await q.query(
        `UPDATE ros_tags o
          SET state = t.state, decided_by = t.decided_by, decided_at = t.decided_at,
              updated_at = now()
         FROM ros_tags t
        WHERE t.key = $1 AND t.value = $2
          AND o.key = $1 AND o.value = $3
          AND o.entity_type = t.entity_type AND o.entity_id = t.entity_id
          AND t.state <> 'suggested'
          AND (o.state = 'suggested'
               OR COALESCE(t.decided_at, t.updated_at) > COALESCE(o.decided_at, o.updated_at))`,
        [k, f, i],
      )
      const dropped = await q.query(`DELETE FROM ros_tags WHERE key = $1 AND value = $2`, [k, f])
      // Vocabulary bookkeeping: retire `from`, hand its children to the
      // survivor, and make sure no other entry still claims it as an alias.
      await q.query(
        `UPDATE ros_tag_taxonomy
          SET state = 'rejected', reason = $3, aliases = '{}', parent_value = NULL,
              decided_at = now(), updated_at = now()
        WHERE key = $1 AND value = $2`,
        [k, f, `merged into ${k}:${i}`],
      )
      await q.query(
        `UPDATE ros_tag_taxonomy SET parent_value = $3, updated_at = now()
        WHERE key = $1 AND parent_value = $2 AND value <> $3`,
        [k, f, i],
      )
      await q.query(
        `UPDATE ros_tag_taxonomy SET aliases = array_remove(aliases, $2), updated_at = now()
        WHERE key = $1 AND value <> $3 AND $2 = ANY(aliases)`,
        [k, f, i],
      )
      return { moved: moved.rowCount ?? 0, dropped: dropped.rowCount ?? 0, into: i }
    },
    taxonomyLock(k),
  )
}
