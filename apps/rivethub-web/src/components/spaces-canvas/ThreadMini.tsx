/**
 * Read-only live transcript for one tile at space altitude.
 * No composer, no pickers, no approval card. Pointer events are off so a
 * pan never types into a mini. Terminal-mode sessions still render this
 * transcript — XtermAttach mounts only inside the focused thread.
 *
 * The stream hook is ref-counted: this mount and a focused ActiveSession
 * for the same session share one watch or attach. A row with no stream
 * after the shared target resolution is seeded from sessionMessages.
 */

import { useEffect, useMemo, useRef, useState, type JSX } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { HarnessDescriptor } from '@rivetos/types'
import { Transcript } from '../transcript.js'
import { useChat, type OutboundItem } from '../../stores/chat.js'
import { useConnection } from '../../stores/connection.js'
import { accentFor } from '../../lib/agent-accent.js'
import { harnessGate, type ChatItem } from '../../lib/harness-chat.js'
import { statusActivity } from '../../lib/harness-fold.js'
import { deriveReplyWait, nextWaitClock, type ReplyWaitClock } from '../../lib/harness-turns.js'
import { getSessionMode } from '../../lib/session-mode.js'
import { storageKey } from '../../lib/session-rekey.js'
import { bindSessionStream, useSessionStream } from '../../lib/use-session-stream.js'
import { useSessionTarget } from '../../lib/use-session-target.js'

const EMPTY_OUTBOUND: OutboundItem[] = []

function useTileTarget(item: ChatItem, descriptors: HarnessDescriptor[] | undefined) {
  const baseUrl = useConnection((s) => s.baseUrl)
  const roster = useConnection((s) => s.roster)
  const epoch = useConnection((s) => s.transportEpoch)
  const rosterUrls = useMemo(() => roster.map((r) => r.baseUrl), [roster])
  const target = useSessionTarget({
    sessionId: item.key,
    item,
    gate: harnessGate(item, descriptors),
    harnessCommand: item.command,
    baseUrl,
    rosterUrls,
    epoch,
  })
  return { epoch, target }
}

export function ThreadMini(props: {
  item: ChatItem
  descriptors?: HarnessDescriptor[]
}): JSX.Element {
  const id = props.item.key
  const { target } = useTileTarget(props.item, props.descriptors)
  const { streamError } = useSessionStream({
    sessionId: id,
    item: target.item,
    streamId: target.streamId,
    isRemote: target.isRemote,
    sessionBase: target.sessionBase,
  })
  const sessionsDirty = useChat((s) => s.sessionsDirty)
  // No control-plane stream (remote summary still closed, or a legacy row):
  // one HTTP backfill, refreshed when the session list is marked dirty.
  useEffect(() => {
    if (target.streamId !== undefined) return
    const ctrl = new AbortController()
    let gone = false
    void target
      .sessionGateway()
      .then((gw) => gw.sessionMessages(id, ctrl.signal))
      .then((data) => {
        if (!gone) useChat.getState().seed(id, data.messages)
      })
      .catch(() => undefined)
    return () => {
      gone = true
      ctrl.abort()
    }
  }, [target.streamId, target.sessionGateway, id, sessionsDirty])

  // Remembered terminal mode still shows the transcript tail. The value is
  // read so a later slice can badge it; the mini never mounts a PTY.
  const remembered = getSessionMode(storageKey(target.sessionBase, id), 'chat')

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
      {streamError ? (
        <p className="truncate px-3 py-1 text-xs text-ink-dim">{streamError}</p>
      ) : null}
    </div>
  )
}

/** Holds a space tile's lease while the mini itself is not painted. */
export function WarmLease(props: { item: ChatItem; descriptors?: HarnessDescriptor[] }): null {
  const { target } = useTileTarget(props.item, props.descriptors)
  useSessionStream({
    sessionId: props.item.key,
    item: target.item,
    streamId: target.streamId,
    isRemote: target.isRemote,
    sessionBase: target.sessionBase,
  })
  return null
}

/**
 * At Everything, warm the selected tile during idle time and release it
 * immediately so the lease lingers. The focused thread holds its own ref.
 */
export function SelectedPrewarm(props: {
  item: ChatItem
  descriptors?: HarnessDescriptor[]
}): null {
  const { epoch, target } = useTileTarget(props.item, props.descriptors)
  const queryClient = useQueryClient()
  const id = props.item.key
  const item = target.item
  const harnessId = item?.harnessId
  const streamId = target.streamId
  const isRemote = target.isRemote
  const sessionBase = target.sessionBase
  const sessionGateway = target.sessionGateway
  useEffect(() => {
    let cancelled = false
    const run = (): void => {
      if (cancelled) return
      const release = bindSessionStream({
        sessionId: id,
        item,
        streamId,
        isRemote,
        sessionBase,
        harnessId,
        transportEpoch: epoch,
        sessionGateway,
        queryClient,
        onStreamError: () => undefined,
      })
      release()
    }
    const idleHost = window as Window & {
      requestIdleCallback?: (cb: () => void) => number
      cancelIdleCallback?: (handle: number) => void
    }
    if (typeof idleHost.requestIdleCallback === 'function') {
      const handle = idleHost.requestIdleCallback(run)
      return () => {
        cancelled = true
        idleHost.cancelIdleCallback(handle)
      }
    }
    const timer = setTimeout(run, 0)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [id, item, streamId, isRemote, sessionBase, harnessId, epoch, sessionGateway, queryClient])
  return null
}
