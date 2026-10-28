/**
 * Delete session + clean up trash — the pure half (wire calls and dialogs
 * live in components/session-delete.tsx).
 *
 * Delete removes the session's conversation from the node's memory and drops
 * it from the session list; the harness's own transcript on disk is kept.
 * Everything here leans cautious: a row only offers Delete when it maps onto
 * a canonical id the connected node owns, and a trash candidate the user ever
 * renamed is treated as wanted and never shown for clean-up.
 */

import {
  formatSessionId,
  harnessForRosterCommand,
  type SessionDeleteResult,
  type SessionTrashCandidate,
} from '@rivetos/types'
import { GatewayError } from '@rivetos/gateway-client'
import type { ChatItem } from './harness-chat.js'

/** Bulk delete cap per request (the endpoint takes 1..=200). */
export const DELETE_BATCH_MAX = 200

/**
 * The canonical id DELETE /api/sessions/{id} takes for a drawer row, or
 * undefined when the row cannot be deleted here:
 *
 * - drafts are local (they keep Discard);
 * - agent-pin rows may live on another node, and the drawer deletes through
 *   the connected gateway only;
 * - a legacy row whose roster command maps to no harness has no canonical id.
 */
export function deleteTargetFor(item: ChatItem): string | undefined {
  if (item.kind === 'draft' || item.pin || item.pinNodeBaseUrl) return undefined
  if (item.kind === 'harness') return item.sessionId ?? item.key
  const harnessId = item.harnessId ?? harnessForRosterCommand(item.command)
  if (!harnessId) return undefined
  try {
    return formatSessionId(harnessId, item.key)
  } catch {
    return undefined
  }
}

/** “a”, “b”, “c” and 2 more — the confirm names what it deletes. */
export function quotedList(labels: readonly string[], max = 3): string {
  const shown = labels.slice(0, max).map((l) => `“${l}”`)
  const rest = labels.length - shown.length
  return rest > 0 ? `${shown.join(', ')} and ${rest} more` : shown.join(', ')
}

/** Confirm text: says plainly what goes (memory, the list row) and what stays. */
export function deleteConfirmMessage(labels: readonly string[]): string {
  if (labels.length === 1) {
    return (
      `Delete ${quotedList(labels)}? Its conversation is removed from memory and the ` +
      `session leaves this list. The harness's own transcript on disk is kept. ` +
      `This can't be undone.`
    )
  }
  return (
    `Delete ${labels.length} sessions (${quotedList(labels)})? Their conversations are ` +
    `removed from memory and they leave this list. Each harness's own transcript on ` +
    `disk is kept. This can't be undone.`
  )
}

export type DeleteFailure = 'live' | 'not-found' | 'error'

/** Map a per-item bulk error string onto the cases the UI words differently. */
export function failureKind(error: string): DeleteFailure {
  if (error === 'session is live') return 'live'
  if (error === 'not found') return 'not-found'
  return 'error'
}

/** Same mapping for a thrown single-delete error (409 live, 404 not visible). */
export function failureFromError(err: unknown): { kind: DeleteFailure; message: string } {
  if (err instanceof GatewayError) {
    if (err.status === 409) return { kind: 'live', message: err.message }
    if (err.status === 404) return { kind: 'not-found', message: err.message }
    return { kind: 'error', message: err.message }
  }
  return { kind: 'error', message: err instanceof Error ? err.message : String(err) }
}

/** Short per-row reason shown beside a session that was left alone. */
export function failureText(kind: DeleteFailure, message?: string): string {
  switch (kind) {
    case 'live':
      return 'running — left alone'
    case 'not-found':
      return 'not found on this gateway'
    case 'error':
      return message ? `failed: ${message}` : 'failed'
  }
}

export interface DeleteOutcome {
  deleted: string[]
  failed: Array<{ session: string; kind: DeleteFailure; message: string }>
}

/**
 * Fold bulk results into deleted / failed. An id the response does not
 * mention counts as failed — treating silence as success would clear local
 * state for a session that may still exist.
 */
export function foldDeleteResults(
  requested: readonly string[],
  results: readonly SessionDeleteResult[],
): DeleteOutcome {
  const byId = new Map(results.map((r) => [r.session, r] as const))
  const out: DeleteOutcome = { deleted: [], failed: [] }
  for (const session of requested) {
    const r = byId.get(session)
    if (!r) out.failed.push({ session, kind: 'error', message: 'no result from the gateway' })
    else if (r.ok) out.deleted.push(session)
    else out.failed.push({ session, kind: failureKind(r.error), message: r.error })
  }
  return out
}

/** One line for the drawer notice after a delete attempt. */
export function outcomeNotice(outcome: DeleteOutcome, labelOf: (id: string) => string): string {
  const parts: string[] = []
  const n = outcome.deleted.length
  if (n === 1 && outcome.failed.length === 0) {
    parts.push(`Deleted ${quotedList([labelOf(outcome.deleted[0] ?? '')])}.`)
  } else if (n > 0) {
    parts.push(`Deleted ${n} session${n === 1 ? '' : 's'}.`)
  }
  const live = outcome.failed.filter((f) => f.kind === 'live')
  const missing = outcome.failed.filter((f) => f.kind === 'not-found')
  const other = outcome.failed.filter((f) => f.kind === 'error')
  if (live.length > 0) {
    parts.push(
      `${quotedList(live.map((f) => labelOf(f.session)))} ${live.length === 1 ? 'is' : 'are'} ` +
        `running, so ${live.length === 1 ? 'it was' : 'they were'} left alone.`,
    )
  }
  if (missing.length > 0) {
    parts.push(
      `${quotedList(missing.map((f) => labelOf(f.session)))} ` +
        `${missing.length === 1 ? 'was' : 'were'} not found on this gateway; nothing was removed.`,
    )
  }
  if (other.length > 0) {
    parts.push(
      `${quotedList(other.map((f) => labelOf(f.session)))} could not be deleted` +
        (other.length === 1 && other[0]?.message ? ` (${other[0].message}).` : '.'),
    )
  }
  return parts.join(' ')
}

/**
 * Candidates to show in the clean-up review. Drops anything the user renamed
 * locally (a custom name says they care about it), anything in `exclude`
 * (the open conversation), and malformed rows.
 */
export function reviewableCandidates(
  candidates: readonly SessionTrashCandidate[],
  isRenamed: (session: string) => boolean,
  exclude: ReadonlySet<string> = new Set(),
): SessionTrashCandidate[] {
  return candidates.filter(
    (c) =>
      typeof c.session === 'string' &&
      c.session.length > 0 &&
      !exclude.has(c.session) &&
      !isRenamed(c.session),
  )
}

/**
 * Whether a trash read says the gateway predates the endpoint: 404 / 405 /
 * 501, or a 200 that is not the trash shape (an older router matching
 * `/api/sessions/:id` with something else).
 */
export function trashUnsupported(err: unknown): boolean {
  return (
    err instanceof GatewayError && (err.status === 404 || err.status === 405 || err.status === 501)
  )
}

export function isTrashResponse(value: unknown): value is { candidates: SessionTrashCandidate[] } {
  return (
    typeof value === 'object' &&
    value !== null &&
    Array.isArray((value as { candidates?: unknown }).candidates)
  )
}

export function trashReasonLabel(reason: string): string {
  switch (reason) {
    case 'empty':
      return 'empty'
    case 'one-word-reply':
      return 'one-word reply'
    default:
      return reason
  }
}

/** Coarse age for the review list: 2h, 3d, 5w. */
export function ageLabel(updatedAt: string, now = Date.now()): string {
  const t = Date.parse(updatedAt)
  if (!Number.isFinite(t)) return ''
  const mins = Math.max(0, Math.round((now - t) / 60_000))
  if (mins < 60) return `${mins}m`
  const hours = Math.round(mins / 60)
  if (hours < 48) return `${hours}h`
  const days = Math.round(hours / 24)
  if (days < 14) return `${days}d`
  return `${Math.round(days / 7)}w`
}
