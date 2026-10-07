/**
 * One watch or harness attach per session, shared by every mounted reader.
 *
 * A space mini and the focused ActiveSession for the same session must not
 * open two sockets. The last release does not close: the lease stays
 * idle-warm so a mini↔thread jump reuses the live attachment (no resync,
 * no unbind, store state untouched). Idle leases linger, then stop. Past
 * the cap, the least-recently-released idle lease is stopped. Held leases
 * are never evicted and do not count toward the cap.
 *
 * A signature change (stream id, node, harness, transport epoch) is a
 * different lease, so a stale attach is not reused. An epoch bump or a
 * gateway identity change stops every lease; the next acquire opens fresh.
 * The error string sticks for the life of a lease — a late joiner hears it
 * until the next open.
 */

import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import type { QueryClient } from '@tanstack/react-query'
import { useQueryClient } from '@tanstack/react-query'
import { gatewayFor } from './agent-gateway.js'
import { attachHarnessSession, type HarnessAttachGateway } from './harness-attach.js'
import { outboundPumpFor } from './chat-outbound.js'
import type { ChatItem } from './harness-chat.js'
import { registerSessionStreamReset, useChat } from '../stores/chat.js'
import { useConnection } from '../stores/connection.js'

/** How long an unreferenced lease keeps its socket. Altitude jumps must not resync. */
export const LINGER_MS = 10 * 60_000
/** Idle-warm leases only. A held reader is never counted and never evicted. */
export const WARM_MAX = 24

export interface SessionStreamArgs {
  sessionId: string
  item?: ChatItem
  /** Canonical id when the control-plane stream is on; undefined → legacy watch. */
  streamId: string | undefined
  isRemote: boolean
  sessionBase: string
}

interface LeaseArgs extends SessionStreamArgs {
  harnessId: string | undefined
  /** Part of the signature: a replaced gateway client must not reuse the attach. */
  transportEpoch: number
  sessionGateway: () => Promise<HarnessAttachGateway>
  queryClient: QueryClient
  onStreamError: (message: string | undefined) => void
}

interface Lease {
  key: string
  refs: number
  error: string | undefined
  listeners: Set<(message: string | undefined) => void>
  stop: () => void
  /** Monotonic stamp of the last release. Zero while held. */
  releasedOrder: number
  idleTimer?: ReturnType<typeof setTimeout>
}

const leases = new Map<string, Lease>()
let releaseSeq = 0
let streamGeneration = 0
const generationListeners = new Set<() => void>()

function bumpGeneration(): void {
  streamGeneration += 1
  for (const listener of generationListeners) listener()
}

function subscribeGeneration(listener: () => void): () => void {
  generationListeners.add(listener)
  return () => {
    generationListeners.delete(listener)
  }
}

function generationSnapshot(): number {
  return streamGeneration
}

function streamKey(args: {
  sessionId: string
  streamId: string | undefined
  isRemote: boolean
  sessionBase: string
  harnessId: string | undefined
  transportEpoch: number
}): string {
  return [
    args.sessionId,
    args.streamId ?? '',
    args.isRemote ? 'r' : 'l',
    args.sessionBase,
    args.harnessId ?? '',
    String(args.transportEpoch),
  ].join('\0')
}

function report(lease: Lease, message: string | undefined): void {
  lease.error = message
  for (const listener of lease.listeners) listener(message)
}

function retire(lease: Lease): void {
  if (lease.idleTimer !== undefined) {
    clearTimeout(lease.idleTimer)
    lease.idleTimer = undefined
  }
  lease.stop()
  if (leases.get(lease.key) === lease) leases.delete(lease.key)
}

function evictIdle(): void {
  const idle = [...leases.values()].filter((lease) => lease.refs <= 0)
  idle.sort((a, b) => a.releasedOrder - b.releasedOrder)
  while (idle.length > WARM_MAX) {
    const oldest = idle.shift()
    if (oldest) retire(oldest)
  }
}

function park(lease: Lease): void {
  lease.releasedOrder = ++releaseSeq
  lease.idleTimer = setTimeout(() => {
    lease.idleTimer = undefined
    if (lease.refs > 0) return
    if (leases.get(lease.key) !== lease) return
    retire(lease)
  }, LINGER_MS)
  evictIdle()
}

function startLease(args: LeaseArgs): Lease {
  let stopped = false
  const lease: Lease = {
    key: '',
    refs: 0,
    error: undefined,
    listeners: new Set(),
    stop: () => {
      stopped = true
    },
    releasedOrder: 0,
  }
  const { sessionId } = args
  if (args.streamId === undefined) {
    // Cross-node threads have no legacy watch on this node's socket. The
    // focused view attaches once its remote summary resolves; until then
    // both readers hold an idle lease.
    if (!args.isRemote) {
      useChat.getState().watchTranscript(sessionId)
      lease.stop = () => {
        if (stopped) return
        stopped = true
        useChat.getState().unwatchTranscript(sessionId)
      }
    }
    return lease
  }

  const streamId = args.streamId
  let disposed = false
  let attachment: { close: () => void } | undefined
  useChat.getState().bindHarness(sessionId, args.harnessId ?? 'harness')
  void args
    .sessionGateway()
    .then((gw) => {
      if (disposed) return
      attachment = attachHarnessSession({
        gateway: gw,
        sessionId: streamId,
        onResync: (turns, ctx) => useChat.getState().syncHarnessTranscript(sessionId, turns, ctx),
        onTranscript: (ev) => useChat.getState().applyHarnessTranscriptEvent(sessionId, ev),
        onAgentStatus: (ev) => {
          useChat.getState().applyAgentStatus(sessionId, ev)
          if (ev.status === 'working') outboundPumpFor(sessionId).pump.onBusy()
        },
        onPrompt: (ev) => useChat.getState().applyPromptEvent(sessionId, ev),
        onControlReset: () => useChat.getState().clearHarnessPrompts(sessionId),
        onLive: (turn, reason) => {
          if (reason === 'resync') {
            useChat.getState().clearLive(sessionId)
            return
          }
          if (!turn) useChat.getState().clearAcceptedReply(sessionId)
          useChat.getState().setLive(sessionId, turn)
        },
        onApproval: (event) => useChat.getState().applyApprovalEvent(sessionId, event),
        onTurnComplete: () => {
          useChat.getState().clearAcceptedReply(sessionId)
          outboundPumpFor(sessionId).pump.onIdle()
        },
        onSessionUpdated: () => {
          void args.queryClient.invalidateQueries({
            queryKey: ['remote-session', args.sessionBase, sessionId],
          })
        },
        liveSource: () =>
          useChat.getState().liveSource[useChat.getState().resolveSessionKey(sessionId)],
        onError: (err) => {
          useChat.getState().clearAcceptedReply(sessionId)
          report(lease, err instanceof Error ? err.message : String(err))
        },
        onFatal: (message) => {
          outboundPumpFor(sessionId).pump.onDeliveryLost()
          outboundPumpFor(sessionId).closeObserver()
          useChat.getState().clearAcceptedReply(sessionId)
          useChat.getState().setLive(sessionId, undefined)
          report(lease, `${message} — this session is no longer attachable`)
        },
        onStatus: (status) => {
          if (status === 'open') report(lease, undefined)
        },
      })
    })
    .catch((err: unknown) => {
      if (disposed) return
      report(lease, err instanceof Error ? err.message : String(err))
    })
  lease.stop = () => {
    if (stopped) return
    stopped = true
    disposed = true
    attachment?.close()
    useChat.getState().unbindHarness(sessionId)
  }
  return lease
}

/** Acquire the shared stream. The returned function releases one reference. */
export function bindSessionStream(args: LeaseArgs): () => void {
  const key = streamKey(args)
  let lease = leases.get(key)
  if (!lease) {
    lease = startLease(args)
    lease.key = key
    leases.set(key, lease)
  } else if (lease.idleTimer !== undefined) {
    // Re-acquire of an idle-warm lease: keep the live attach.
    clearTimeout(lease.idleTimer)
    lease.idleTimer = undefined
    lease.releasedOrder = 0
  }
  lease.refs += 1
  lease.listeners.add(args.onStreamError)
  if (lease.error !== undefined) args.onStreamError(lease.error)
  let released = false
  return () => {
    if (released) return
    released = true
    const held = leases.get(key)
    if (held !== lease) return
    held.listeners.delete(args.onStreamError)
    held.refs -= 1
    if (held.refs <= 0) {
      held.refs = 0
      park(held)
    }
  }
}

function dropAll(notify: boolean): void {
  const held = [...leases.values()]
  leases.clear()
  for (const lease of held) {
    if (lease.idleTimer !== undefined) {
      clearTimeout(lease.idleTimer)
      lease.idleTimer = undefined
    }
    lease.stop()
  }
  if (notify) bumpGeneration()
}

/** Stop every lease, held or idle. Sessions are per gateway. */
export function stopAllSessionStreams(): void {
  dropAll(true)
}

/** Drop every lease without notifying hooks. Tests only. */
export function resetSessionStreams(): void {
  dropAll(false)
}

useConnection.subscribe((state, prev) => {
  if (state.transportEpoch !== prev.transportEpoch || state.baseUrl !== prev.baseUrl) {
    stopAllSessionStreams()
  }
})

registerSessionStreamReset(stopAllSessionStreams)

export function useSessionStream(args: SessionStreamArgs): {
  streamError: string | undefined
  setStreamError: (message: string | undefined) => void
} {
  const [streamError, setStreamErrorState] = useState<string | undefined>()
  const setStreamError = useCallback((message: string | undefined) => {
    setStreamErrorState(message)
  }, [])
  const epoch = useConnection((s) => s.transportEpoch)
  const generation = useSyncExternalStore(
    subscribeGeneration,
    generationSnapshot,
    generationSnapshot,
  )
  const queryClient = useQueryClient()
  const sessionGateway = useCallback(
    () =>
      args.isRemote
        ? gatewayFor(args.sessionBase)
        : Promise.resolve(useConnection.getState().gateway),
    [args.isRemote, args.sessionBase, epoch],
  )
  // harnessId only — the row object is a new identity whenever the drawer
  // recomputes, and restarting the lease on that would drop the socket.
  const harnessId = args.item?.harnessId
  useEffect(() => {
    return bindSessionStream({
      sessionId: args.sessionId,
      streamId: args.streamId,
      isRemote: args.isRemote,
      sessionBase: args.sessionBase,
      harnessId,
      transportEpoch: epoch,
      sessionGateway,
      queryClient,
      onStreamError: setStreamError,
    })
  }, [
    args.sessionId,
    args.streamId,
    args.isRemote,
    args.sessionBase,
    harnessId,
    epoch,
    generation,
    sessionGateway,
    queryClient,
    setStreamError,
  ])
  return { streamError, setStreamError }
}
