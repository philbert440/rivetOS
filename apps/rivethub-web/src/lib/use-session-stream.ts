/**
 * One watch or harness attach per session, shared by every mounted reader.
 *
 * A space mini and the focused ActiveSession for the same session must not
 * open two sockets, and the mini→focus handoff must not close the socket in
 * the gap. Callers acquire on mount and release on unmount; the last release
 * is the one that unwatches or closes. Sinks write the shared chat store
 * (same calls, same order as ActiveSession used to make inline). The error
 * string is the only per-mount state: each acquirer registers a listener.
 *
 * Ref-counting the attach path is safe here because the attachment's sinks
 * do not close over a component instance — they read the store at event
 * time, and a second acquirer only joins the listener set. A signature
 * change (stream id, node, harness) is a different lease, so a stale attach
 * is closed by the last holder of the old signature rather than reused.
 */

import { useCallback, useEffect, useState } from 'react'
import type { QueryClient } from '@tanstack/react-query'
import { useQueryClient } from '@tanstack/react-query'
import { attachHarnessSession, type HarnessAttachGateway } from './harness-attach.js'
import { outboundPumpFor } from './chat-outbound.js'
import { gatewayFor } from './agent-gateway.js'
import type { ChatItem } from './harness-chat.js'
import { useConnection } from '../stores/connection.js'
import { useChat } from '../stores/chat.js'

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
  sessionGateway: () => Promise<HarnessAttachGateway>
  queryClient: QueryClient
  onStreamError: (message: string | undefined) => void
}

interface Lease {
  refs: number
  error: string | undefined
  listeners: Set<(message: string | undefined) => void>
  stop: () => void
}

const leases = new Map<string, Lease>()

function streamKey(args: {
  sessionId: string
  streamId: string | undefined
  isRemote: boolean
  sessionBase: string
  harnessId: string | undefined
}): string {
  return [
    args.sessionId,
    args.streamId ?? '',
    args.isRemote ? 'r' : 'l',
    args.sessionBase,
    args.harnessId ?? '',
  ].join('\0')
}

function report(lease: Lease, message: string | undefined): void {
  lease.error = message
  for (const listener of lease.listeners) listener(message)
}

function startLease(args: LeaseArgs): Lease {
  const lease: Lease = {
    refs: 0,
    error: undefined,
    listeners: new Set(),
    stop: () => undefined,
  }
  const { sessionId } = args
  if (args.streamId === undefined) {
    // Cross-node threads have no legacy watch on this node's socket. The
    // focused view attaches once its remote summary resolves; until then
    // both readers hold an idle lease.
    if (!args.isRemote) {
      useChat.getState().watchTranscript(sessionId)
      lease.stop = () => {
        useChat.getState().unwatchTranscript(sessionId)
      }
    }
    return lease
  }

  const streamId = args.streamId
  let disposed = false
  let attachment: { close: () => void } | undefined
  useChat.getState().bindHarness(sessionId, args.harnessId ?? 'harness')
  void args.sessionGateway().then((gw) => {
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
  lease.stop = () => {
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
    leases.set(key, lease)
  }
  lease.refs += 1
  lease.listeners.add(args.onStreamError)
  if (lease.error !== undefined) args.onStreamError(lease.error)
  let released = false
  return () => {
    if (released) return
    released = true
    const held = leases.get(key)
    if (!held) return
    held.listeners.delete(args.onStreamError)
    held.refs -= 1
    if (held.refs <= 0) {
      held.stop()
      if (leases.get(key) === held) leases.delete(key)
    }
  }
}

/** Drop every lease. Tests only — a leaked ref would make the next case lie. */
export function resetSessionStreams(): void {
  for (const lease of leases.values()) lease.stop()
  leases.clear()
}

export function useSessionStream(args: SessionStreamArgs): {
  streamError: string | undefined
  setStreamError: (message: string | undefined) => void
} {
  const [streamError, setStreamErrorState] = useState<string | undefined>()
  const setStreamError = useCallback((message: string | undefined) => {
    setStreamErrorState(message)
  }, [])
  const epoch = useConnection((s) => s.transportEpoch)
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
    sessionGateway,
    queryClient,
    setStreamError,
  ])
  return { streamError, setStreamError }
}
