/** Pure half of lib/turn-finished: which sessions just finished a reply. */

import type { HarnessSessionSummary } from '@rivetos/types'

export type SessionStatus = HarnessSessionSummary['status']

/** Sessions that went `active` → `idle` since `prev`, and the new status map. */
export function finishedTurns(
  prev: ReadonlyMap<string, SessionStatus>,
  sessions: readonly HarnessSessionSummary[],
): { finished: HarnessSessionSummary[]; next: Map<string, SessionStatus> } {
  const next = new Map<string, SessionStatus>()
  const finished: HarnessSessionSummary[] = []
  for (const s of sessions) {
    next.set(s.sessionId, s.status)
    if (prev.get(s.sessionId) === 'active' && s.status === 'idle') finished.push(s)
  }
  return { finished, next }
}

export function finishedNotice(s: HarnessSessionSummary): { title: string; body: string } {
  return { title: 'Agent finished replying', body: s.title?.trim() || s.sessionId }
}
