/**
 * Memory home — pure helpers for the combined Sessions + Search screen.
 * Rows come from the node (useSessionRows), hits from datahub search. They
 * join on the native session id: rows carry the canonical id
 * (`claude-code:<native>`) while datahub hits carry either form.
 */

import type { MemorySearchHit } from '@rivetos/types'
import { nativeIdOf } from '../lib/harness-chat.js'
import type { SessionListRow } from '../lib/session-list.js'

export type DayBucket = 'Active now' | 'Today' | 'Yesterday' | 'This week' | 'Older'

export const DAY_BUCKETS: readonly DayBucket[] = [
  'Active now',
  'Today',
  'Yesterday',
  'This week',
  'Older',
]

export function rowSessionKey(row: SessionListRow): string {
  return row.sessionId ?? row.key
}

/** Native id for either id form, so a canonical row key meets a bare hit id. */
export function joinKey(sessionKey: string): string {
  return nativeIdOf(sessionKey) ?? sessionKey
}

/** A tool row whose content is only the `[tool call] Name` stub — no excerpt worth showing. */
export function isToolStub(hit: MemorySearchHit): boolean {
  return /^\[tool( call)?\]\s*\S*\s*$/i.test(hit.content.trim())
}

/** Working or waiting on the user — pinned above the day groups. */
export function isActiveRow(row: SessionListRow): boolean {
  return row.status === 'active' || row.blocked === true
}

/** Local-calendar day bucket; "This week" is the five days before yesterday. */
export function dayBucket(row: SessionListRow, now = Date.now()): DayBucket {
  if (isActiveRow(row)) return 'Active now'
  const d = new Date(now)
  const startOf = (daysBack: number): number =>
    new Date(d.getFullYear(), d.getMonth(), d.getDate() - daysBack).getTime()
  if (row.updatedAt >= startOf(0)) return 'Today'
  if (row.updatedAt >= startOf(1)) return 'Yesterday'
  if (row.updatedAt >= startOf(6)) return 'This week'
  return 'Older'
}

export interface DayGroup {
  bucket: DayBucket
  rows: SessionListRow[]
}

/** Rows grouped by day, newest first inside each group; empty groups dropped. */
export function groupRowsByDay(rows: readonly SessionListRow[], now = Date.now()): DayGroup[] {
  const sorted = [...rows].sort((a, b) => b.updatedAt - a.updatedAt)
  return DAY_BUCKETS.map((bucket) => ({
    bucket,
    rows: sorted.filter((r) => dayBucket(r, now) === bucket),
  })).filter((g) => g.rows.length > 0)
}

export interface SessionResult {
  /** Native session id, or `hit:<source>:<id>` for a hit with no session. */
  key: string
  row?: SessionListRow
  /** Hits in search rank order; empty for a title-only match. */
  hits: MemorySearchHit[]
}

/**
 * Search hits grouped under their session, in the rank order of each
 * session's best hit, followed by title/cwd matches that had no hit.
 * With `onlyKnownRows` (a harness or status filter is set) a session the
 * node does not list is dropped, since the filter cannot be checked for it.
 */
export function sessionResults(
  hits: readonly MemorySearchHit[],
  rows: readonly SessionListRow[],
  titleMatches: readonly SessionListRow[],
  opts: { onlyKnownRows: boolean },
): SessionResult[] {
  const rowByKey = new Map(rows.map((r) => [joinKey(rowSessionKey(r)), r]))
  const out: SessionResult[] = []
  const byKey = new Map<string, SessionResult>()
  for (const h of hits) {
    const key = h.sessionId ? joinKey(h.sessionId) : `hit:${h.source}:${h.id}`
    let group = byKey.get(key)
    if (!group) {
      const row = h.sessionId ? rowByKey.get(key) : undefined
      if (opts.onlyKnownRows && !row) continue
      group = { key, row, hits: [] }
      byKey.set(key, group)
      out.push(group)
    }
    group.hits.push(h)
  }
  for (const row of titleMatches) {
    const key = joinKey(rowSessionKey(row))
    if (byKey.has(key)) continue
    byKey.set(key, { key, row, hits: [] })
    out.push({ key, row, hits: [] })
  }
  return out
}

function queryTerms(query: string): string[] {
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length >= 2)
}

/** A window of `text` around the first query term, flattened to one line. */
export function excerpt(text: string, query: string, max = 220): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  if (flat.length <= max) return flat
  const low = flat.toLowerCase()
  const found = queryTerms(query)
    .map((t) => low.indexOf(t))
    .filter((i) => i >= 0)
  const at = found.length > 0 ? Math.min(...found) : 0
  const start = Math.max(0, at - 60)
  const end = Math.min(flat.length, start + max)
  return `${start > 0 ? '…' : ''}${flat.slice(start, end)}${end < flat.length ? '…' : ''}`
}

export interface TextPart {
  text: string
  match: boolean
}

/** Split `text` into runs that do / do not match a query term (case-insensitive). */
export function highlightParts(text: string, query: string): TextPart[] {
  const terms = queryTerms(query).sort((a, b) => b.length - a.length)
  if (terms.length === 0) return [{ text, match: false }]
  const re = new RegExp(
    `(${terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`,
    'gi',
  )
  return text
    .split(re)
    .filter((s) => s !== '')
    .map((s) => ({ text: s, match: terms.includes(s.toLowerCase()) }))
}
