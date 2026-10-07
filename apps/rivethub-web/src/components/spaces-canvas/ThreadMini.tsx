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

import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type JSX } from 'react'
import { useQueryClient, type QueryClient } from '@tanstack/react-query'
import type { HarnessDescriptor, HarnessSessionResponse, HarnessesResponse } from '@rivetos/types'
import { Transcript } from '../transcript.js'
import { useChat, type OutboundItem } from '../../stores/chat.js'
import { useConnection } from '../../stores/connection.js'
import { harnessAccentKey } from '../../lib/agent-accent.js'
import { gatewayFor } from '../../lib/agent-gateway.js'
import type { HarnessAttachGateway } from '../../lib/harness-attach.js'
import { chatItemFromSummary, harnessGate, type ChatItem } from '../../lib/harness-chat.js'
import { statusActivity } from '../../lib/harness-fold.js'
import { deriveReplyWait, nextWaitClock, type ReplyWaitClock } from '../../lib/harness-turns.js'
import { getSessionMode } from '../../lib/session-mode.js'
import { storageKey } from '../../lib/session-rekey.js'
import { sessionNodeFor } from '../../lib/session-node.js'
import { bindSessionStream, useSessionStream } from '../../lib/use-session-stream.js'
import { useSessionTarget } from '../../lib/use-session-target.js'

/**
 * `sessions-dirty` is global. A no-stream mini waits this long after the
 * latest bump so a busy agent does not refetch every tile on every frame.
 * The first seed for a session is immediate. Bumps closer than the debounce
 * cannot postpone the refetch past the max wait.
 */
export const MINI_BACKFILL_DEBOUNCE_MS = 2_000
export const MINI_BACKFILL_MAX_WAIT_MS = 5_000

const EMPTY_OUTBOUND: OutboundItem[] = []

/** Frozen target of a mounted tile reader, keyed by row id. */
interface PaintedTarget {
  item: ChatItem | undefined
  streamId: string | undefined
  isRemote: boolean
  sessionBase: string
  harnessId: string | undefined
  transportEpoch: number
  sessionGateway: () => Promise<HarnessAttachGateway>
}

const paintedTargets = new Map<string, PaintedTarget>()

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
  // Layout, not render: a discarded or StrictMode render must not be the
  // publisher. A click hold runs after the previous commit's layout effect,
  // so the record is already there. Children layout effects run before the
  // parent's holdOpening, and before this mount's passive cleanup.
  const published = useRef<{ key: string; record: PaintedTarget } | undefined>(undefined)
  const record = useMemo<PaintedTarget>(
    () => ({
      item: target.item,
      streamId: target.streamId,
      isRemote: target.isRemote,
      sessionBase: target.sessionBase,
      harnessId: target.item?.harnessId,
      transportEpoch: epoch,
      sessionGateway: target.sessionGateway,
    }),
    [
      target.item,
      target.streamId,
      target.isRemote,
      target.sessionBase,
      target.item?.harnessId,
      epoch,
      target.sessionGateway,
    ],
  )
  useLayoutEffect(() => {
    const previous = published.current
    if (
      previous !== undefined &&
      previous.key !== item.key &&
      paintedTargets.get(previous.key) === previous.record
    ) {
      paintedTargets.delete(previous.key)
    }
    published.current = { key: item.key, record }
    paintedTargets.set(item.key, record)
    return () => {
      const current = published.current
      if (current !== undefined && paintedTargets.get(current.key) === current.record) {
        paintedTargets.delete(current.key)
      }
    }
  }, [item.key, record])
  return { epoch, target }
}

let miniCommitProbe: ((id: string) => void) | undefined

/** Test hook. Unset in production. */
export function setMiniCommitProbe(probe: ((id: string) => void) | undefined): void {
  miniCommitProbe = probe
}

export const ThreadMini = memo(function ThreadMini(props: {
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
    linger: true,
  })
  // No control-plane stream (remote summary still closed, or a legacy row):
  // seed once, then refetch on a dirty bump. The effect does not depend on
  // the counter, so a bump cannot abort the seed. A burst of bumps waits out
  // the debounce but never longer than the max wait.
  const dirtySeen = useRef<number | null>(null)
  const waitStarted = useRef(0)
  useEffect(() => {
    if (target.streamId !== undefined) return
    const ctrl = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const run = (): void => {
      if (timer !== undefined) {
        clearTimeout(timer)
        timer = undefined
      }
      waitStarted.current = 0
      void target
        .sessionGateway()
        .then((gw) => gw.sessionMessages(id, ctrl.signal))
        .then((data) => {
          if (!ctrl.signal.aborted) useChat.getState().seed(id, data.messages)
        })
        .catch(() => undefined)
    }
    const arm = (now: number): void => {
      if (waitStarted.current === 0) waitStarted.current = now
      const elapsed = now - waitStarted.current
      const remaining = MINI_BACKFILL_MAX_WAIT_MS - elapsed
      const delay = Math.max(0, Math.min(MINI_BACKFILL_DEBOUNCE_MS, remaining))
      if (timer !== undefined) clearTimeout(timer)
      timer = setTimeout(run, delay)
    }
    // Same counter as last time covers the first seed and a StrictMode replay.
    // Only a real bump waits.
    const dirtyNow = useChat.getState().sessionsDirty
    if (dirtySeen.current === null || dirtySeen.current === dirtyNow) {
      dirtySeen.current = dirtyNow
      run()
    } else {
      dirtySeen.current = dirtyNow
      arm(Date.now())
    }
    const unsubscribe = useChat.subscribe((state, prev) => {
      if (state.sessionsDirty === prev.sessionsDirty) return
      dirtySeen.current = state.sessionsDirty
      arm(Date.now())
    })
    return () => {
      unsubscribe()
      if (timer !== undefined) clearTimeout(timer)
      ctrl.abort()
    }
  }, [target.streamId, target.sessionGateway, id])

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

  const accent = `var(--harness-accent-${harnessAccentKey({
    harnessId: props.item.harnessId,
    command: props.item.command,
  })})`
  useEffect(() => {
    miniCommitProbe?.(id)
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
})

/**
 * Same signature the painted reader resolved, including the base
 * `useSessionTarget` froze for that mount. Recomputing node and base from
 * the live binding would miss that freeze after an eviction and open a
 * second socket. Nothing painted yet: there is no frozen target, so resolve
 * from the current binding the same way a fresh mount would.
 */
export function holdTileLease(
  item: ChatItem,
  descriptors: HarnessDescriptor[] | undefined,
  queryClient: QueryClient,
): () => void {
  const painted = paintedTargets.get(item.key)
  if (painted) {
    return bindSessionStream({
      sessionId: item.key,
      item: painted.item,
      streamId: painted.streamId,
      isRemote: painted.isRemote,
      sessionBase: painted.sessionBase,
      harnessId: painted.harnessId,
      transportEpoch: painted.transportEpoch,
      linger: true,
      sessionGateway: painted.sessionGateway,
      queryClient,
      onStreamError: () => undefined,
    })
  }
  const connection = useConnection.getState()
  const rosterUrls = connection.roster.map((node) => node.baseUrl)
  const sessionBase = sessionNodeFor(item.key, connection.baseUrl, rosterUrls)
  const isRemote = sessionBase !== connection.baseUrl
  const epoch = connection.transportEpoch
  let gateItem: ChatItem | undefined = item
  let gateDescriptors = descriptors
  if (isRemote) {
    const summary = queryClient.getQueryData<HarnessSessionResponse>([
      'remote-session',
      sessionBase,
      item.key,
      epoch,
    ])
    const registry = queryClient.getQueryData<HarnessesResponse>(['harnesses', sessionBase, epoch])
    gateItem = summary ? chatItemFromSummary(summary) : undefined
    gateDescriptors = registry?.harnesses
  }
  const gate = harnessGate(gateItem, gateDescriptors)
  const streamId = gate.stream ? gateItem?.sessionId : undefined
  const sessionGateway = (): Promise<HarnessAttachGateway> =>
    isRemote ? gatewayFor(sessionBase) : Promise.resolve(useConnection.getState().gateway)
  return bindSessionStream({
    sessionId: item.key,
    item: gateItem,
    streamId,
    isRemote,
    sessionBase,
    harnessId: gateItem?.harnessId,
    transportEpoch: epoch,
    linger: true,
    sessionGateway,
    queryClient,
    onStreamError: () => undefined,
  })
}

/** Holds a space tile's lease while the mini itself is not painted. */
export const WarmLease = memo(function WarmLease(props: {
  item: ChatItem
  descriptors?: HarnessDescriptor[]
}): null {
  const { target } = useTileTarget(props.item, props.descriptors)
  useSessionStream({
    sessionId: props.item.key,
    item: target.item,
    streamId: target.streamId,
    isRemote: target.isRemote,
    sessionBase: target.sessionBase,
    linger: true,
  })
  return null
})

/**
 * At Everything, warm the selected tile during idle time and release it
 * immediately so the lease lingers. The focused thread holds its own ref.
 */
export const SelectedPrewarm = memo(function SelectedPrewarm(props: {
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
  const itemRef = useRef(item)
  const gatewayRef = useRef(sessionGateway)
  itemRef.current = item
  gatewayRef.current = sessionGateway
  useEffect(() => {
    let cancelled = false
    const run = (): void => {
      if (cancelled) return
      const release = bindSessionStream({
        sessionId: id,
        item: itemRef.current,
        streamId,
        isRemote,
        sessionBase,
        harnessId,
        transportEpoch: epoch,
        linger: true,
        sessionGateway: gatewayRef.current,
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
  }, [id, streamId, isRemote, sessionBase, harnessId, epoch, queryClient])
  return null
})
