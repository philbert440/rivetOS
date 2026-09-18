/**
 * Sessions index view-model: enrich ChatItems with plane cwd/blocked, then
 * filter + sort. Merge still comes from chatItems() — this layer only shapes
 * the list UI.
 */

import type { HarnessId, HarnessSessionSummary } from '@rivetos/types'
import { sortByRecency, type ChatItem, type ChatItemKind } from './harness-chat.js'

export type SessionListStatus = NonNullable<ChatItem['status']>

export interface SessionListRow {
  key: string
  kind: ChatItemKind
  title: string
  sessionId?: string
  harnessId?: HarnessId
  command?: string
  status?: SessionListStatus
  blocked?: boolean
  updatedAt: number
  cwd?: string
}

export type SessionStatusFilter = 'all' | 'live' | 'ended'

export interface SessionListFilters {
  /** Empty string = every harness. */
  harnessId: string
  status: SessionStatusFilter
  /** Case-insensitive match against title + cwd. */
  text: string
}

export function cwdBasename(cwd: string | undefined): string | undefined {
  if (!cwd) return undefined
  const trimmed = cwd.replace(/[/\\]+$/, '')
  if (!trimmed) return cwd
  const parts = trimmed.split(/[/\\]/)
  return parts[parts.length - 1] || cwd
}

/** Join drawer items with plane summaries for cwd / blocked chips. */
export function sessionListRows(
  items: ChatItem[],
  planeSessions: HarnessSessionSummary[],
): SessionListRow[] {
  const byId = new Map(planeSessions.map((s) => [s.sessionId, s] as const))
  return items.map((it) => {
    const summary = it.sessionId ? byId.get(it.sessionId) : undefined
    return {
      key: it.key,
      kind: it.kind,
      title: it.title,
      sessionId: it.sessionId,
      harnessId: it.harnessId,
      command: it.command,
      status: it.status ?? summary?.status,
      blocked: summary?.blocked,
      updatedAt: it.updatedAt,
      cwd: summary?.cwd,
    }
  })
}

function matchesStatus(row: SessionListRow, filter: SessionStatusFilter): boolean {
  if (filter === 'all') return true
  const status = row.status
  if (filter === 'ended') return status === 'ended'
  // Live: still on the node (active / idle / error). Drafts with no status count.
  return status !== 'ended'
}

function matchesText(row: SessionListRow, text: string): boolean {
  const q = text.trim().toLowerCase()
  if (!q) return true
  const hay = `${row.title} ${row.cwd ?? ''} ${row.key}`.toLowerCase()
  return hay.includes(q)
}

/**
 * Filter then newest-first. Stable on ties via sortByRecency.
 */
export function filterSessionList(
  rows: SessionListRow[],
  filters: SessionListFilters,
): SessionListRow[] {
  const filtered = rows.filter((row) => {
    if (filters.harnessId && row.harnessId !== filters.harnessId) return false
    if (!matchesStatus(row, filters.status)) return false
    if (!matchesText(row, filters.text)) return false
    return true
  })
  return sortByRecency(filtered)
}

/** Distinct harness ids present in the list, sorted for the filter Select. */
export function harnessFilterOptions(rows: SessionListRow[]): HarnessId[] {
  const seen = new Set<HarnessId>()
  for (const row of rows) {
    if (row.harnessId) seen.add(row.harnessId)
  }
  return [...seen].sort()
}
