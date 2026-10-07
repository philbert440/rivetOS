/**
 * Read-only live transcript for one tile at space altitude.
 * No composer, no pickers, no approval card. Pointer events are off so a
 * pan never types into a mini. Terminal-mode sessions still render this
 * transcript — XtermAttach mounts only inside the focused thread.
 *
 * The stream hook is ref-counted: this mount and a focused ActiveSession
 * for the same session share one watch or attach.
 */

import { useEffect, useMemo, useRef, useState, type JSX } from 'react'
import type { HarnessDescriptor } from '@rivetos/types'
import { Transcript } from '../transcript.js'
import { useChat, type OutboundItem } from '../../stores/chat.js'
import { useConnection } from '../../stores/connection.js'
import { accentFor } from '../../lib/agent-accent.js'
import { harnessGate, type ChatItem } from '../../lib/harness-chat.js'
import { statusActivity } from '../../lib/harness-fold.js'
import { deriveReplyWait, nextWaitClock, type ReplyWaitClock } from '../../lib/harness-turns.js'
import { getSessionMode } from '../../lib/session-mode.js'
import { sessionNodeFor } from '../../lib/session-node.js'
import { storageKey } from '../../lib/session-rekey.js'
import { useSessionStream } from '../../lib/use-session-stream.js'

const EMPTY_OUTBOUND: OutboundItem[] = []

export function ThreadMini(props: {
  item: ChatItem
  descriptors?: HarnessDescriptor[]
}): JSX.Element {
  const id = props.item.key
  const baseUrl = useConnection((s) => s.baseUrl)
  const roster = useConnection((s) => s.roster)
  const rosterUrls = useMemo(() => roster.map((r) => r.baseUrl), [roster])
  const sessionBase = sessionNodeFor(id, baseUrl, rosterUrls)
  const isRemote = sessionBase !== baseUrl
  const gate = harnessGate(props.item, props.descriptors)
  const streamId = gate.stream ? props.item.sessionId : undefined
  useSessionStream({ sessionId: id, item: props.item, streamId, isRemote, sessionBase })

  // Remembered terminal mode still shows the transcript tail. The value is
  // read so a later slice can badge it; the mini never mounts a PTY.
  const remembered = getSessionMode(storageKey(sessionBase, id), 'chat')

  const messages = useChat((s) => s.messages[s.resolveSessionKey(id)])
  const liveRaw = useChat((s) => s.live[s.resolveSessionKey(id)])
  const agentStatus = useChat((s) => s.agentStatus[s.resolveSessionKey(id)])
  const outbound = useChat((s) => s.outbound[s.resolveSessionKey(id)] ?? EMPTY_OUTBOUND)
  const acceptedReply = useChat((s) => {
    const marker = s.replyAcceptance[s.resolveSessionKey(id)]
    return marker?.accepted ? marker.id : undefined
  })
  const live = useMemo(() => {
    if (!liveRaw) return undefined
    if (!agentStatus) return liveRaw
    const activity = statusActivity(agentStatus)
    return activity !== undefined ? { ...liveRaw, activity } : liveRaw
  }, [liveRaw, agentStatus])

  const [waitClock, setWaitClock] = useState<ReplyWaitClock>()
  const [, setWaitTick] = useState(0)
  const replyWait = deriveReplyWait({
    outbound,
    acceptedReply,
    live,
    status: agentStatus,
    clock: waitClock,
    now: Date.now(),
  })
  const waitKey = replyWait.waitKey
  const previousWaitStatus = useRef(agentStatus)
  useEffect(() => {
    const next = nextWaitClock(
      waitClock,
      waitKey,
      previousWaitStatus.current !== agentStatus,
      Date.now(),
    )
    previousWaitStatus.current = agentStatus
    if (next !== waitClock) setWaitClock(next)
  }, [waitKey, agentStatus, waitClock])
  const deadline = replyWait.deadline
  useEffect(() => {
    if (deadline === undefined) return
    let timer: ReturnType<typeof setTimeout>
    const fire = (): void => {
      const remaining = deadline - Date.now()
      if (remaining > 0) timer = setTimeout(fire, remaining)
      else setWaitTick((n) => n + 1)
    }
    timer = setTimeout(fire, Math.max(0, deadline - Date.now()))
    return () => clearTimeout(timer)
  }, [deadline])

  const accent = accentFor({
    presetColor: props.item.accent,
    harnessId: props.item.harnessId,
    command: props.item.command,
  })

  return (
    <div
      data-face="mini"
      data-remembered={remembered}
      className="pointer-events-none absolute inset-0 flex min-h-0 flex-col overflow-hidden bg-panel"
      style={{ opacity: 'var(--live, 0)' }}
    >
      <Transcript
        messages={messages ?? []}
        live={replyWait.displayLive}
        statusLine={replyWait.statusLine}
        accent={accent}
      />
    </div>
  )
}
