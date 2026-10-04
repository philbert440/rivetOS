/**
 * The tag vocabulary on SQLite (`ros_tag_taxonomy`): reading it, the edits a
 * person makes to it (add, decide, merge), what the tagger is shown, and the
 * rule-based project tag written at capture. Same rules as the Postgres
 * store (`plugins/memory/postgres/src/tags/store.ts`, `rule-project.ts`);
 * list columns are JSON arrays here.
 */

import { randomUUID } from 'node:crypto'
import type { DatabaseSync, SQLInputValue } from 'node:sqlite'
import {
  PROJECT_RULE_NAME,
  formatTag,
  normalizeTagKey,
  normalizeTagValue,
  type ProjectRuleResult,
  type TagProposal,
  type TagState,
  type TagTaxonomyEntry,
} from '@rivetos/types'

/** Ancestor walk bound for the vocabulary tree. */
const TAXONOMY_MAX_DEPTH = 32
/** Sources a person or a model reviewed; a rule tag is not one. */
const REVIEWED_TAG_SOURCES = ['user', 'model', 'import'] as const

interface TaxonomyRow {
  key: string
  value: string
  display: string
  parent_value: string | null
  aliases: string
  state: TagState
  source: TagTaxonomyEntry['source']
  reason: string
  decided_at: string | null
  created_at: string
  updated_at: string
}

const COLUMNS =
  'key, value, display, parent_value, aliases, state, source, reason, decided_at, created_at, updated_at'

function aliasList(json: string): string[] {
  try {
    const parsed: unknown = JSON.parse(json)
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

function toEntry(r: TaxonomyRow): TagTaxonomyEntry {
  return {
    key: r.key,
    value: r.value,
    display: r.display,
    ...(r.parent_value === null ? {} : { parentValue: r.parent_value }),
    aliases: aliasList(r.aliases),
    state: r.state,
    source: r.source,
    reason: r.reason,
    ...(r.decided_at === null ? {} : { decidedAt: new Date(r.decided_at) }),
    createdAt: new Date(r.created_at),
    updatedAt: new Date(r.updated_at),
  }
}

export interface SqliteTaxonomyInput {
  key: string
  value: string
  display?: string
  /** Same-key parent; `null` clears. */
  parentValue?: string | null
  aliases?: string[]
  state?: TagState
  reason?: string
}

export class SqliteTagVocabulary {
  constructor(
    private readonly db: DatabaseSync,
    /** Runs a function in one write transaction. */
    private readonly tx: <T>(fn: () => T) => T,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  private row(key: string, value: string): TaxonomyRow | undefined {
    return this.db
      .prepare(`SELECT ${COLUMNS} FROM ros_tag_taxonomy WHERE key = ? AND value = ?`)
      .get(key, value) as unknown as TaxonomyRow | undefined
  }

  list(filter: { key?: string; states?: TagState[]; limit?: number } = {}): TagTaxonomyEntry[] {
    const states =
      filter.states && filter.states.length > 0 ? filter.states : ['suggested', 'accepted']
    const conds = [`state IN (${states.map(() => '?').join(', ')})`]
    const params: SQLInputValue[] = [...states]
    if (filter.key) {
      conds.push('key = ?')
      params.push(normalizeTagKey(filter.key))
    }
    const limit = Math.min(Math.max(Math.trunc(filter.limit ?? 500), 1), 5000)
    const rows = this.db
      .prepare(
        `SELECT ${COLUMNS} FROM ros_tag_taxonomy
          WHERE ${conds.join(' AND ')}
          ORDER BY key, parent_value IS NOT NULL, parent_value, value
          LIMIT ?`,
      )
      .all(...params, limit) as unknown as TaxonomyRow[]
    return rows.map(toEntry)
  }

  /** Create or update one entry. A person's edit is accepted unless told otherwise. */
  upsert(input: SqliteTaxonomyInput, source = 'user'): TagTaxonomyEntry {
    const key = normalizeTagKey(input.key)
    const value = normalizeTagValue(input.value)
    if (!key || !value) throw new Error('key and value are required')
    const parentRaw =
      input.parentValue === undefined || input.parentValue === null
        ? input.parentValue
        : normalizeTagValue(input.parentValue)
    const parent = parentRaw === '' ? null : parentRaw
    if (parent === value) throw new Error('a value cannot be its own parent')
    return this.tx(() => {
      if (typeof parent === 'string') {
        let cursor: string | null = parent
        for (let depth = 0; cursor !== null && depth < TAXONOMY_MAX_DEPTH; depth += 1) {
          const up = this.row(key, cursor)
          if (depth === 0 && !up) {
            throw new Error(`invalid parent: ${key}:${cursor} is not in the vocabulary`)
          }
          cursor = up?.parent_value ?? null
          if (cursor === value) throw new Error('invalid parent: it would create a cycle')
        }
        if (cursor !== null) throw new Error('invalid parent: taxonomy is nested too deeply')
      }
      const aliases = input.aliases?.map(normalizeTagValue).filter((a) => a && a !== value)
      const state = input.state ?? 'accepted'
      const now = this.now()
      const prior = this.row(key, value)
      if (!prior) {
        this.db
          .prepare(
            `INSERT INTO ros_tag_taxonomy
               (key, value, display, parent_value, aliases, state, source, reason, decided_at,
                created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            key,
            value,
            input.display ?? '',
            parent ?? null,
            JSON.stringify([...new Set(aliases ?? [])]),
            state,
            source,
            input.reason ?? '',
            state === 'suggested' ? null : now,
            now,
            now,
          )
      } else {
        this.db
          .prepare(
            `UPDATE ros_tag_taxonomy
                SET display = ?, parent_value = ?, aliases = ?, state = ?, source = ?, reason = ?,
                    decided_at = ?, updated_at = ?
              WHERE key = ? AND value = ?`,
          )
          .run(
            input.display ? input.display : prior.display,
            input.parentValue !== undefined ? (parent ?? null) : prior.parent_value,
            aliases ? JSON.stringify([...new Set(aliases)]) : prior.aliases,
            state,
            source,
            input.reason ? input.reason : prior.reason,
            state === 'suggested' ? prior.decided_at : now,
            now,
            key,
            value,
          )
      }
      const row = this.row(key, value)
      if (!row) throw new Error('vocabulary entry was not written')
      return toEntry(row)
    })
  }

  /** Accept or reject entries. Returns how many changed. */
  decide(entries: Array<{ key: string; value: string }>, state: 'accepted' | 'rejected'): number {
    if (entries.length > 500) throw new Error('invalid request: at most 500 entries')
    const now = this.now()
    const update = this.db.prepare(
      `UPDATE ros_tag_taxonomy SET state = ?, decided_at = ?, updated_at = ?
        WHERE key = ? AND value = ? AND state <> ?`,
    )
    return this.tx(() => {
      let changed = 0
      for (const e of entries) {
        changed += Number(
          update.run(state, now, now, normalizeTagKey(e.key), normalizeTagValue(e.value), state)
            .changes,
        )
      }
      return changed
    })
  }

  /**
   * Merge `from` into `into` under one key: `into` gains `from` (and its
   * aliases) as aliases, every tag on `from` moves to `into` (an entity that
   * already carries `into` keeps one row, with the later decision), and the
   * `from` entry is rejected.
   */
  merge(key: string, from: string, into: string): { moved: number; dropped: number; into: string } {
    const k = normalizeTagKey(key)
    const f = normalizeTagValue(from)
    const requested = normalizeTagValue(into)
    if (!k || !f || !requested || f === requested) {
      throw new Error('merge needs one key and two different values')
    }
    return this.tx(() => {
      const now = this.now()
      // The target may itself be an alias of an accepted value.
      const alias = this.db
        .prepare(
          `SELECT t.value FROM ros_tag_taxonomy t
            WHERE t.key = ? AND t.state = 'accepted'
              AND EXISTS (SELECT 1 FROM json_each(t.aliases) WHERE value = ?)
            ORDER BY t.value LIMIT 1`,
        )
        .get(k, requested) as { value: string } | undefined
      const i = alias?.value ?? requested
      if (i === f) throw new Error('invalid merge: the target resolves to the value being merged')

      const known = this.db
        .prepare(
          `SELECT 1 AS ok FROM ros_tag_taxonomy WHERE key = ? AND value = ?
           UNION ALL
           SELECT 1 FROM ros_tags WHERE key = ? AND value = ?
           LIMIT 1`,
        )
        .get(k, f, k, f)
      if (!known) throw new Error(`invalid merge: ${k}:${f} is not in the vocabulary or in use`)

      let cursor: string | null = i
      for (let depth = 0; cursor !== null && depth < TAXONOMY_MAX_DEPTH; depth += 1) {
        cursor = this.row(k, cursor)?.parent_value ?? null
        if (cursor === f) throw new Error(`invalid merge: ${k}:${i} is nested under ${k}:${f}`)
      }
      if (cursor !== null) throw new Error('invalid merge: taxonomy is nested too deeply')

      // The target gains `from` and everything `from` was known as.
      const target = this.row(k, i)
      const fromRow = this.row(k, f)
      const merged = [
        ...new Set([
          ...(target ? aliasList(target.aliases) : []),
          f,
          ...(fromRow ? aliasList(fromRow.aliases) : []),
        ]),
      ].filter((a) => a !== i)
      if (target) {
        this.db
          .prepare(
            `UPDATE ros_tag_taxonomy
                SET aliases = ?, state = 'accepted', decided_at = ?, updated_at = ?
              WHERE key = ? AND value = ?`,
          )
          .run(JSON.stringify(merged), now, now, k, i)
      } else {
        this.db
          .prepare(
            `INSERT INTO ros_tag_taxonomy
               (key, value, display, aliases, state, source, reason, decided_at, created_at, updated_at)
             VALUES (?, ?, '', ?, 'accepted', 'user', 'merge target', ?, ?, ?)`,
          )
          .run(k, i, JSON.stringify(merged), now, now, now)
      }

      // Where an entity carries both, the surviving row takes the later
      // decision, and a reviewed tag is not left looking like a rule tag.
      const both = this.db
        .prepare(
          `SELECT o.id AS keep_id, t.state, t.decided_by, t.decided_at, t.source,
                  o.state AS keep_state, o.source AS keep_source,
                  coalesce(t.decided_at, t.updated_at) AS t_when,
                  coalesce(o.decided_at, o.updated_at) AS o_when
             FROM ros_tags t
             JOIN ros_tags o ON o.entity_type = t.entity_type AND o.entity_id = t.entity_id
                            AND o.key = t.key AND o.value = ?
            WHERE t.key = ? AND t.value = ?`,
        )
        .all(i, k, f) as unknown as Array<{
        keep_id: string
        state: TagState
        decided_by: string | null
        decided_at: string | null
        source: string
        keep_state: TagState
        keep_source: string
        t_when: string
        o_when: string
      }>
      for (const r of both) {
        if (r.state !== 'suggested' && (r.keep_state === 'suggested' || r.t_when > r.o_when)) {
          this.db
            .prepare(
              `UPDATE ros_tags SET state = ?, decided_by = ?, decided_at = ?, updated_at = ? WHERE id = ?`,
            )
            .run(r.state, r.decided_by, r.decided_at, now, r.keep_id)
        }
        if (
          r.keep_source === 'rule' &&
          r.state === 'accepted' &&
          (REVIEWED_TAG_SOURCES as readonly string[]).includes(r.source)
        ) {
          this.db
            .prepare(`UPDATE ros_tags SET source = ?, updated_at = ? WHERE id = ?`)
            .run(r.source, now, r.keep_id)
        }
      }
      const moved = Number(
        this.db
          .prepare(
            `UPDATE ros_tags SET value = ?, display = '', updated_at = ?
              WHERE key = ? AND value = ?
                AND NOT EXISTS (SELECT 1 FROM ros_tags o
                                 WHERE o.entity_type = ros_tags.entity_type
                                   AND o.entity_id = ros_tags.entity_id
                                   AND o.key = ? AND o.value = ?)`,
          )
          .run(i, now, k, f, k, i).changes,
      )
      const dropped = Number(
        this.db.prepare(`DELETE FROM ros_tags WHERE key = ? AND value = ?`).run(k, f).changes,
      )
      this.db
        .prepare(
          `UPDATE ros_tag_taxonomy
              SET state = 'rejected', reason = ?, aliases = '[]', parent_value = NULL,
                  decided_at = ?, updated_at = ?
            WHERE key = ? AND value = ?`,
        )
        .run(`merged into ${k}:${i}`, now, now, k, f)
      // Children of the merged value move under the target.
      this.db
        .prepare(
          `UPDATE ros_tag_taxonomy SET parent_value = ?, updated_at = ?
            WHERE key = ? AND parent_value = ? AND value <> ?`,
        )
        .run(i, now, k, f, i)
      // No other entry keeps the merged value as an alias.
      const holders = this.db
        .prepare(
          `SELECT t.value, t.aliases FROM ros_tag_taxonomy t
            WHERE t.key = ? AND t.value <> ?
              AND EXISTS (SELECT 1 FROM json_each(t.aliases) WHERE value = ?)`,
        )
        .all(k, i, f) as unknown as Array<{ value: string; aliases: string }>
      for (const h of holders) {
        this.db
          .prepare(
            `UPDATE ros_tag_taxonomy SET aliases = ?, updated_at = ? WHERE key = ? AND value = ?`,
          )
          .run(JSON.stringify(aliasList(h.aliases).filter((a) => a !== f)), now, k, h.value)
      }
      return { moved, dropped, into: i }
    })
  }

  /** What the tagger is shown: accepted vocabulary first, then accepted tags by use. */
  forTagger(limit = 80): string[] {
    const rows = this.db
      .prepare(
        `SELECT key, value, display FROM (
           SELECT key, value, display, 0 AS rank, 0 AS uses
             FROM ros_tag_taxonomy WHERE state = 'accepted'
           UNION ALL
           SELECT key, value, max(display) AS display, 1 AS rank, count(*) AS uses
             FROM ros_tags WHERE state = 'accepted' GROUP BY key, value
         )
         ORDER BY rank, uses DESC, key, value
         LIMIT ?`,
      )
      .all(limit) as unknown as Array<{ key: string; value: string; display: string }>
    const seen = new Set<string>()
    const out: string[] = []
    for (const r of rows) {
      const id = `${r.key}:${r.value}`
      if (seen.has(id)) continue
      seen.add(id)
      out.push(formatTag(r))
    }
    return out
  }

  /** New values a model proposed go into the vocabulary as suggestions. */
  propose(proposals: readonly TagProposal[], proposedBy: string): number {
    const now = this.now()
    const insert = this.db.prepare(
      `INSERT INTO ros_tag_taxonomy (key, value, display, state, source, reason, created_at, updated_at)
       VALUES (?, ?, ?, 'suggested', 'model', ?, ?, ?)
       ON CONFLICT (key, value) DO NOTHING`,
    )
    let inserted = 0
    for (const p of proposals) {
      const key = normalizeTagKey(p.key)
      const value = normalizeTagValue(p.value)
      if (!key || !value) continue
      inserted += Number(
        insert.run(key, value, p.display ?? '', `proposed by ${proposedBy}`, now, now).changes,
      )
    }
    return inserted
  }

  /**
   * The rule-based project tag for a conversation, born accepted. Written
   * once: a conversation that already has a rule tag for the key (in any
   * state, a rejected one included) keeps what it has. A value the
   * vocabulary merged away is written as its target; a value the vocabulary
   * rejected is not written. Call inside the capture transaction.
   */
  applyRuleTag(conversationId: string, hit: ProjectRuleResult): boolean {
    const key = normalizeTagKey(hit.key)
    const value = normalizeTagValue(hit.value)
    if (!key || !value) return false
    const existing = this.db
      .prepare(
        `SELECT 1 AS ok FROM ros_tags
          WHERE entity_type = 'conversation' AND entity_id = ? AND key = ?
            AND (source = 'rule' OR proposed_by = ?)
          LIMIT 1`,
      )
      .get(conversationId, key, PROJECT_RULE_NAME)
    if (existing) return false
    const entry = this.db
      .prepare(
        `SELECT t.value, t.display, t.state FROM ros_tag_taxonomy t
          WHERE t.key = ?
            AND (t.value = ? OR EXISTS (SELECT 1 FROM json_each(t.aliases) WHERE value = ?))
          ORDER BY (t.state = 'accepted') DESC, (t.value = ?) DESC, t.value
          LIMIT 1`,
      )
      .get(key, value, value, value) as
      { value: string; display: string; state: string } | undefined
    if (entry?.state === 'rejected') return false
    const moved = entry !== undefined && entry.value !== value
    const now = this.now()
    const r = this.db
      .prepare(
        `INSERT INTO ros_tags
           (id, entity_type, entity_id, key, value, display, source, state, proposed_by, reason,
            decided_by, decided_at, created_at, updated_at)
         VALUES (?, 'conversation', ?, ?, ?, ?, 'rule', 'accepted', ?, ?, ?, ?, ?, ?)
         ON CONFLICT (entity_type, entity_id, key, value) DO NOTHING`,
      )
      .run(
        randomUUID(),
        conversationId,
        key,
        moved ? entry.value : value,
        moved ? entry.display : (hit.display ?? ''),
        PROJECT_RULE_NAME,
        hit.reason ?? '',
        PROJECT_RULE_NAME,
        now,
        now,
        now,
      )
    return Number(r.changes) > 0
  }
}
