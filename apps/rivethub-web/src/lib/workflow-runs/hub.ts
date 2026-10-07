/**
 * Pure helpers for the Workflows home: run naming, timing, def search.
 */

import type { WorkflowDefSummary, WorkflowRunStatus, WorkflowRunSummary } from '@rivetos/types'

/** Run-list status filter chips → wire statuses (undefined = all). */
export type RunStatusFilter = 'all' | 'live' | 'waiting' | 'failed' | 'done'

export const RUN_STATUS_FILTERS: Record<RunStatusFilter, WorkflowRunStatus[] | undefined> = {
  all: undefined,
  live: ['running', 'paused_human'],
  waiting: ['paused_human'],
  failed: ['failed', 'killed'],
  done: ['done'],
}

/** "just now" / "5m ago" / "3h ago" / "2d ago"; "—" when unknown. */
export function relativeTime(iso: string | undefined, now: number = Date.now()): string {
  const ms = iso ? Date.parse(iso) : NaN
  if (Number.isNaN(ms)) return '—'
  const ago = now - ms
  if (ago < 90_000) return 'just now'
  if (ago < 3_600_000) return `${String(Math.round(ago / 60_000))}m ago`
  if (ago < 86_400_000) return `${String(Math.round(ago / 3_600_000))}h ago`
  return `${String(Math.round(ago / 86_400_000))}d ago`
}

/** Wall time of a run; live runs measure to `now`. "—" when unstarted. */
export function formatRunDuration(
  startedAt: string | undefined,
  finishedAt: string | undefined,
  now: number = Date.now(),
): string {
  const start = startedAt ? Date.parse(startedAt) : NaN
  if (Number.isNaN(start)) return '—'
  const endParsed = finishedAt ? Date.parse(finishedAt) : NaN
  const sec = Math.max(0, Math.round(((Number.isNaN(endParsed) ? now : endParsed) - start) / 1000))
  if (sec < 60) return `${String(sec)}s`
  const min = Math.floor(sec / 60)
  if (min < 60) return `${String(min)}m ${String(sec % 60)}s`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${String(hr)}h ${String(min % 60)}m`
  return `${String(Math.floor(hr / 24))}d ${String(hr % 24)}h`
}

/** What a run is called in lists: its label, else its workflow's name, else the id. */
export function runDisplayName(
  run: Pick<WorkflowRunSummary, 'label' | 'workflowId'>,
  defNameById: ReadonlyMap<string, string>,
): string {
  return run.label ?? defNameById.get(run.workflowId) ?? run.workflowId
}

/** Case-insensitive substring over def name, id, and description. */
export function matchesWorkflowQuery(
  def: Pick<WorkflowDefSummary, 'id' | 'name' | 'description'>,
  query: string,
): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  return [def.name, def.id, def.description ?? ''].some((s) => s.toLowerCase().includes(q))
}

/**
 * Client preview of the server's `runLabel` rendering (packages/workflows
 * run-meta.ts) over raw form strings — placeholder text only; the server's
 * render against parsed input is authoritative.
 */
export function previewRunLabel(
  template: string | undefined,
  values: Readonly<Record<string, string>>,
): string | undefined {
  if (!template) return undefined
  const out = template
    .replace(/\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g, (_m, key: string) => values[key] ?? '')
    .replace(/\s+/g, ' ')
    .trim()
  return out || undefined
}

/**
 * Suggested workflow id from a display name — mirrors `slugifyWorkflowId` in
 * packages/workflows create.ts (the server validates; this only pre-fills).
 */
export function slugifyWorkflowId(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/, '')
}
