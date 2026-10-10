/**
 * "Agent finished replying" notifications. Watches the control-plane
 * session lists (`harness-plane-sessions`, kept live by the registry
 * stream) and notifies on each `active` → `idle` edge.
 *
 * A session seen for the first time never notifies, so a reload or a node
 * switch does not replay old turns. The conversation you are looking at, in
 * a focused window, is skipped: the transcript already shows the reply.
 */

import type { QueryClient } from '@tanstack/react-query'
import type { HarnessSessionSummary } from '@rivetos/types'
import { finishedNotice, finishedTurns, type SessionStatus } from './finished-turns.js'
import { osNotify, windowInFront } from './os-notify.js'
import { useChat } from '../stores/chat.js'
import { usePreferences } from '../stores/preferences.js'

function inView(sessionId: string): boolean {
  if (!windowInFront()) return false
  const chat = useChat.getState()
  const active = chat.active
  return (
    active !== undefined && chat.resolveSessionKey(active) === chat.resolveSessionKey(sessionId)
  )
}

/** Install once at boot. Returns the unsubscribe. */
export function watchFinishedTurns(queryClient: QueryClient): () => void {
  const byNode = new Map<string, Map<string, SessionStatus>>()
  return queryClient.getQueryCache().subscribe((event) => {
    if (event.type !== 'updated' && event.type !== 'added') return
    const key = event.query.queryKey as readonly unknown[]
    if (key[0] !== 'harness-plane-sessions') return
    const data = event.query.state.data as HarnessSessionSummary[] | undefined
    if (!Array.isArray(data)) return
    const node = String(key[1])
    const { finished, next } = finishedTurns(byNode.get(node) ?? new Map(), data)
    byNode.set(node, next)
    if (!usePreferences.getState().notifyAgentFinished) return
    for (const s of finished) {
      if (!inView(s.sessionId)) osNotify(finishedNotice(s))
    }
  })
}
