/**
 * Session tags view-model: pure helpers over the `/api/memory/tags` wire
 * shapes so the sessions index, the session header, the drawer and the
 * memory views all read tags the same way. No React, no fetch.
 */

import { parseTagLiteral, type PendingTagWire, type Tag, type TagWire } from '@rivetos/types'
import type { SessionListRow } from './session-list.js'

/** Either wire or domain tag — the hub only reads these fields. */
export type AnyTag = Pick<TagWire | Tag, 'id' | 'key' | 'value' | 'display' | 'state' | 'source'>

/** `key:value` with display casing. */
export function tagLabel(tag: Pick<AnyTag, 'key' | 'value' | 'display'>): string {
  return `${tag.key}:${tag.display || tag.value}`
}

/** Review-queue label. A removal stays on the entity until a person accepts it. */
export function chipLabel(
  tag: Pick<AnyTag, 'key' | 'value' | 'display'> & { action?: 'add' | 'remove' },
): string {
  const label = tagLabel(tag)
  return tag.action === 'remove' ? `suggest remove ${label}` : label
}

/** Identity for a tag independent of the row: `key:value` normalized. */
export function tagIdentity(tag: Pick<AnyTag, 'key' | 'value'>): string {
  return `${tag.key}:${tag.value}`
}

/** Accepted first, then suggested; within a state by key then value. Rejected dropped. */
export function sortTagsForChips<T extends AnyTag>(tags: readonly T[]): T[] {
  const rank = (t: AnyTag): number => (t.state === 'accepted' ? 0 : t.state === 'suggested' ? 1 : 2)
  return tags
    .filter((t) => t.state !== 'rejected')
    .slice()
    .sort(
      (a, b) => rank(a) - rank(b) || a.key.localeCompare(b.key) || a.value.localeCompare(b.value),
    )
}

/** Lookup response → map keyed by session key, chip-sorted. */
export function tagsBySession(
  sessions: Record<string, AnyTag[]> | undefined,
): Map<string, AnyTag[]> {
  const out = new Map<string, AnyTag[]>()
  if (!sessions) return out
  for (const [k, v] of Object.entries(sessions)) out.set(k, sortTagsForChips(v))
  return out
}

/** The session keys a list of rows can be looked up by (canonical id, else row key). */
export function sessionKeysOf(rows: readonly SessionListRow[]): string[] {
  const keys = new Set<string>()
  for (const r of rows) keys.add(r.sessionId ?? r.key)
  return [...keys]
}

export function tagsForRow(map: Map<string, AnyTag[]>, row: SessionListRow): AnyTag[] {
  return map.get(row.sessionId ?? row.key) ?? []
}

/** Distinct keys across all accepted tags in the map, for the group-by Select. */
export function tagKeyOptions(map: Map<string, AnyTag[]>): string[] {
  const keys = new Set<string>()
  for (const tags of map.values()) for (const t of tags) if (t.state === 'accepted') keys.add(t.key)
  return [...keys].sort()
}

export interface TagGroup {
  /** Group label (`key:value` with display casing) or `(untagged)`. */
  label: string
  /** `key:value` identity, '' for untagged. */
  identity: string
  rows: SessionListRow[]
}

/**
 * Group rows by the accepted values of one key. A row with two values for
 * the key appears in both groups (two `project:` tags when integrating two
 * projects). Rows with none land in `(untagged)` last. Groups keep the
 * incoming row order and are sorted by size, then label.
 */
export function groupRowsByTag(
  rows: readonly SessionListRow[],
  map: Map<string, AnyTag[]>,
  key: string,
): TagGroup[] {
  const groups = new Map<string, TagGroup>()
  const untagged: SessionListRow[] = []
  for (const row of rows) {
    const values = tagsForRow(map, row).filter((t) => t.state === 'accepted' && t.key === key)
    if (values.length === 0) {
      untagged.push(row)
      continue
    }
    for (const t of values) {
      const id = tagIdentity(t)
      const g = groups.get(id) ?? { label: tagLabel(t), identity: id, rows: [] }
      g.rows.push(row)
      groups.set(id, g)
    }
  }
  const out = [...groups.values()].sort(
    (a, b) => b.rows.length - a.rows.length || a.label.localeCompare(b.label),
  )
  if (untagged.length > 0) out.push({ label: '(untagged)', identity: '', rows: untagged })
  return out
}

/** Rows whose accepted tags include `identity` (`key:value`). '' means all rows. */
export function filterRowsByTag(
  rows: readonly SessionListRow[],
  map: Map<string, AnyTag[]>,
  identity: string,
): SessionListRow[] {
  if (!identity) return [...rows]
  return rows.filter((row) =>
    tagsForRow(map, row).some((t) => t.state === 'accepted' && tagIdentity(t) === identity),
  )
}

/** Pending queue grouped by session for the review view: newest session first. */
export interface PendingSessionGroup {
  /** Unique per group (the conversation id when known): use as the list key. */
  id: string
  /** Capture session key, or a conversation/entity id when the session is unknown. */
  sessionKey: string
  /** True when `sessionKey` is a real session key the hub can open. */
  openable: boolean
  title: string | null
  agent: string | null
  tags: PendingTagWire[]
}

export function groupPendingBySession(tags: readonly PendingTagWire[]): PendingSessionGroup[] {
  // A session's own suggestions carry its session key; its summaries'
  // suggestions carry only the conversation id. Both belong to one group, so
  // the conversation id is the grouping key whenever it is known.
  const groups = new Map<string, PendingSessionGroup>()
  for (const t of tags) {
    const id = t.conversationId ?? t.sessionKey ?? t.entityId
    const hasKey = typeof t.sessionKey === 'string' && t.sessionKey !== ''
    const g = groups.get(id) ?? {
      id,
      sessionKey: id,
      openable: false,
      title: null,
      agent: null,
      tags: [],
    }
    // Whichever tag knows the session key makes the whole group openable.
    if (hasKey && !g.openable) {
      g.sessionKey = t.sessionKey as string
      g.openable = true
    }
    g.title ??= t.title ?? null
    g.agent ??= t.agent ?? null
    g.tags.push(t)
    groups.set(id, g)
  }
  return [...groups.values()]
}

/**
 * Whether typed text is a `key:value` literal the server will accept: both
 * sides present after normalization, split at `:` or a full-width colon.
 */
export function isTagLiteral(text: string): boolean {
  return parseTagLiteral(text) !== null
}

/** Only an accepted tag is a filter: filters match accepted tags. */
export function isFilterableChip(tag: Pick<AnyTag, 'state'>): boolean {
  return tag.state === 'accepted'
}

/** "N pending", or "first N pending" when the list filled the page it was asked for. */
export function pendingCountLabel(count: number, pageSize: number): string {
  return count >= pageSize ? `first ${String(count)} pending` : `${String(count)} pending`
}

/**
 * Whether the previous lookup's tags may stand in while a new one loads:
 * only across a change of the session set on the same datahub — never across
 * an endpoint change, and never once the endpoint is gone.
 */
export function keepLookupPlaceholder(
  previousBaseUrl: unknown,
  baseUrl: string | undefined,
): boolean {
  return baseUrl !== undefined && previousBaseUrl === baseUrl
}

/** True while a lookup for the current session set is in flight (first load or stand-in). */
export function lookupInFlight(q: {
  isLoading: boolean
  isPlaceholderData: boolean
  isFetching: boolean
}): boolean {
  return q.isLoading || (q.isPlaceholderData && q.isFetching)
}

/**
 * The Tag filter and Group-by a sessions list should hold, given what the
 * lookup knows. A value whose tag no longer exists would leave an empty list:
 * it is cleared — but only on an answer. Without a datahub the controls are
 * hidden, so both are cleared; while a lookup is in flight nothing is.
 */
export function settleTagFilters(input: {
  hasEndpoint: boolean
  lookupInFlight: boolean
  tagFilter: string
  groupKey: string
  /** Identities (`key:value`) of the accepted tags on the listed rows. */
  filterIdentities: readonly string[]
  /** Keys that have at least one accepted tag. */
  keyChoices: readonly string[]
}): { tagFilter: string; groupKey: string } {
  const { tagFilter, groupKey } = input
  if (!input.hasEndpoint) return { tagFilter: '', groupKey: '' }
  if (input.lookupInFlight) return { tagFilter, groupKey }
  return {
    tagFilter: tagFilter !== '' && !input.filterIdentities.includes(tagFilter) ? '' : tagFilter,
    groupKey: groupKey !== '' && !input.keyChoices.includes(groupKey) ? '' : groupKey,
  }
}

/** Session keys per lookup request (the server caps a request at 500). */
export const TAG_LOOKUP_CHUNK = 500

/** Split a key list into request-sized chunks: every key is looked up, none dropped. */
export function chunkKeys(keys: readonly string[], size = TAG_LOOKUP_CHUNK): string[][] {
  const out: string[][] = []
  for (let i = 0; i < keys.length; i += size) out.push(keys.slice(i, i + size))
  return out
}

/** Merge chunked lookup responses back into one session → tags record. */
export function mergeLookups(
  parts: ReadonlyArray<{ sessions: Record<string, AnyTag[]> }>,
): Record<string, AnyTag[]> {
  const out: Record<string, AnyTag[]> = {}
  for (const part of parts) {
    for (const [key, tags] of Object.entries(part.sessions)) out[key] = tags
  }
  return out
}
