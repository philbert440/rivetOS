/**
 * One watch or harness attach per session, shared by every mounted reader.
 *
 * A space mini and the focused ActiveSession for the same session must not
 * open two sockets. Canvas readers pass `linger: true`: the last release
 * does not close, so a mini↔thread jump reuses the live attachment (no
 * resync, no unbind, store state untouched). Idle leases linger, then stop.
 * Past the cap, the least-recently-released idle lease is stopped. Held
 * leases are never evicted and do not count toward the cap. The drawer and
 * the narrow layout omit linger and stop on the last release.
 *
 * The pool key is the resolved session id (`resolveSessionKey`) plus the
 * stream signature, not the raw view id. A rekey moves that lease onto the
 * new id only when the destination has no lease yet. A lease already at the
 * destination on a different stream is the live session: the moved lease is
 * closed and must not unwatch or unbind the destination (`rekey` has aliased
 * the old id there). A different stream for the same resolved session closes
 * the other socket. Stopping a lease never unwatches or unbinds a key that
 * another lease of the same kind, held or idle, still owns. A superseded
 * promise cannot attach, and a promise cannot replace a socket the surviving
 * lease already holds.
 *
 * A signature change (stream id, node, harness, transport epoch) is a
 * different lease. Gaining a stream id retires the legacy watch for that
 * session so the two never run together. An epoch bump or a gateway
 * identity change stops every lease; the next acquire opens fresh.
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
import { registerSessionStreamReset, subscribeChatThreads, useChat } from '../stores/chat.js'
import { useConnection } from '../stores/connection.js'

/** How long an unreferenced canvas lease keeps its socket. Altitude jumps must not resync. */
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
  /** Canvas keeps the socket warm. Drawer and narrow omit this and stop immediately. */
  linger?: boolean
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
  identity: string
  streamId: string | undefined
  isRemote: boolean
  sessionBase: string
  harnessId: string | undefined
  transportEpoch: number
  refs: number
  error: string | undefined
  listeners: Set<(message: string | undefined) => void>
  /** Monotonic stamp of the last release. Zero while held. */
  releasedOrder: number
  idleTimer?: ReturnType<typeof setTimeout>
  superseded: boolean
  /** Releases of a merged-away lease decrement this one. */
  survivor?: Lease
  /** Bumped so an in-flight sessionGateway() cannot attach after supersede. */
  attachGen: number
  attachment?: { close: () => void }
  mode: 'watch' | 'attach' | 'none'
  watched: boolean
  /** Identity we last passed to watchTranscript. Rekey changes `identity` only. */
  watchedIdentity?: string
  bound: boolean
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

function resolvedId(sessionId: string): string {
  return useChat.getState().resolveSessionKey(sessionId)
}

function streamKey(args: {
  sessionId: string
  streamId: string | undefined
  isRemote: boolean
  sessionBase: string
  harnessId: string | undefined
  transportEpoch: number
}): string {
  return signatureKey(resolvedId(args.sessionId), args)
}

function signatureKey(
  identity: string,
  args: {
    streamId: string | undefined
    isRemote: boolean
    sessionBase: string
    harnessId: string | undefined
    transportEpoch: number
  },
): string {
  return [
    identity,
    args.streamId ?? '',
    args.isRemote ? 'r' : 'l',
    args.sessionBase,
    args.harnessId ?? '',
    String(args.transportEpoch),
  ].join('\0')
}

function report(lease: Lease, message: string | undefined): void {
  const current = activeLease(lease)
  if (!current) return
  current.error = message
  for (const listener of current.listeners) listener(message)
}

function currentLease(lease: Lease): Lease {
  let cursor = lease
  const seen = new Set<Lease>()
  while (cursor.survivor && !seen.has(cursor)) {
    seen.add(cursor)
    cursor = cursor.survivor
  }
  return cursor
}

/** The lease readers should hear. Undefined once it has been retired. */
function activeLease(lease: Lease): Lease | undefined {
  const current = currentLease(lease)
  return current.superseded ? undefined : current
}

function liveIdentity(lease: Lease): string | undefined {
  return activeLease(lease)?.identity
}

/** Another lease of this kind still owns the resolved id, held or idle. */
function heldSameMode(identity: string, mode: 'watch' | 'attach', except: Lease): boolean {
  const resolved = resolvedId(identity)
  for (const other of leases.values()) {
    if (other === except || other.superseded || other.mode !== mode) continue
    if (resolvedId(other.identity) !== resolved) continue
    if (mode === 'watch' && !other.watched) continue
    if (mode === 'attach' && !other.bound) continue
    return true
  }
  return false
}

function closeAttachment(lease: Lease): void {
  lease.attachGen += 1
  const attachment = lease.attachment
  lease.attachment = undefined
  attachment?.close()
}

function releaseBinding(lease: Lease): void {
  if (lease.mode === 'watch' && lease.watched) {
    lease.watched = false
    if (!heldSameMode(lease.identity, 'watch', lease)) {
      useChat.getState().unwatchTranscript(lease.identity)
    }
  }
  if (lease.mode === 'attach' && lease.bound) {
    lease.bound = false
    if (!heldSameMode(lease.identity, 'attach', lease)) {
      useChat.getState().unbindHarness(lease.identity)
    }
  }
  lease.mode = 'none'
}

function retire(lease: Lease): void {
  if (lease.superseded) return
  lease.superseded = true
  if (lease.idleTimer !== undefined) {
    clearTimeout(lease.idleTimer)
    lease.idleTimer = undefined
  }
  closeAttachment(lease)
  releaseBinding(lease)
  if (leases.get(lease.key) === lease) leases.delete(lease.key)
}

function evictIdle(): void {
  const idle = [...leases.values()].filter((lease) => lease.refs <= 0 && !lease.superseded)
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
    if (lease.refs > 0 || lease.superseded) return
    if (leases.get(lease.key) !== lease) return
    retire(lease)
  }, LINGER_MS)
  evictIdle()
}

function attachOwns(identity: string): boolean {
  const resolved = resolvedId(identity)
  for (const other of leases.values()) {
    if (other.superseded || other.mode !== 'attach') continue
    if (resolvedId(other.identity) === resolved) return true
  }
  return false
}

/** A stream replaces the legacy watch. They must not both push into one session. */
function retireWatches(identity: string): void {
  const resolved = resolvedId(identity)
  for (const other of [...leases.values()]) {
    if (other.superseded || other.mode !== 'watch') continue
    if (resolvedId(other.identity) !== resolved) continue
    retire(other)
  }
}

function sameStreamSignature(a: Lease, b: Lease): boolean {
  return (
    (a.streamId ?? '') === (b.streamId ?? '') &&
    a.isRemote === b.isRemote &&
    a.sessionBase === b.sessionBase &&
    (a.harnessId ?? '') === (b.harnessId ?? '') &&
    a.transportEpoch === b.transportEpoch
  )
}

/**
 * One socket per resolved session. The lease that just attached, or that was
 * just re-pointed onto this id, closes every other stream. A watch (no
 * stream id) must not take down an attach. A still-mounted holder of a
 * retired lease is not told: `report` drops once the lease is superseded,
 * and its later release is a no-op. No current path keeps two differently
 * signed holders mounted, so that stays latent.
 */
function retireDifferentSignatures(keeper: Lease): void {
  if (keeper.superseded || keeper.streamId === undefined) return
  const resolved = resolvedId(keeper.identity)
  for (const other of [...leases.values()]) {
    if (other === keeper || other.superseded) continue
    if (resolvedId(other.identity) !== resolved) continue
    if (sameStreamSignature(other, keeper)) continue
    retire(other)
  }
}

/**
 * True when this lease was released and a newer lease owns the same stream,
 * so its gateway promise must not open a second socket.
 */
function blockedAttach(lease: Lease): boolean {
  if (lease.superseded) return true
  if (lease.refs > 0) return false
  const resolved = resolvedId(lease.identity)
  for (const other of leases.values()) {
    if (other === lease || other.superseded) continue
    if (resolvedId(other.identity) !== resolved) continue
    if ((other.streamId ?? '') !== (lease.streamId ?? '')) continue
    if (other.sessionBase !== lease.sessionBase || other.isRemote !== lease.isRemote) continue
    if ((other.harnessId ?? '') !== (lease.harnessId ?? '')) continue
    if (other.transportEpoch !== lease.transportEpoch) continue
    if (other.refs > 0 || other.attachment) return true
  }
  return false
}

function startLease(args: LeaseArgs, key: string): Lease {
  const identity = resolvedId(args.sessionId)
  const lease: Lease = {
    key,
    identity,
    streamId: args.streamId,
    isRemote: args.isRemote,
    sessionBase: args.sessionBase,
    harnessId: args.harnessId,
    transportEpoch: args.transportEpoch,
    refs: 0,
    error: undefined,
    listeners: new Set(),
    releasedOrder: 0,
    superseded: false,
    attachGen: 0,
    mode: 'none',
    watched: false,
    bound: false,
  }
  if (args.streamId === undefined) {
    // Cross-node threads have no legacy watch on this node's socket. The
    // focused view attaches once its remote summary resolves; until then
    // both readers hold an idle lease. A session that already has an attach
    // must not also watch.
    if (!args.isRemote && !attachOwns(identity)) {
      useChat.getState().watchTranscript(identity)
      lease.mode = 'watch'
      lease.watched = true
      lease.watchedIdentity = identity
    }
    return lease
  }

  retireWatches(identity)
  const streamId = args.streamId
  useChat.getState().bindHarness(identity, args.harnessId ?? 'harness')
  lease.mode = 'attach'
  lease.bound = true
  const gen = lease.attachGen
  void args
    .sessionGateway()
    .then((gw) => {
      if (gen !== lease.attachGen || lease.superseded) return
      if (leases.get(lease.key) !== lease) return
      // Folding may have handed this lease a live socket. Do not open another.
      if (lease.attachment) return
      if (blockedAttach(lease)) return
      lease.attachment = attachHarnessSession({
        gateway: gw,
        sessionId: streamId,
        onResync: (turns, ctx) => {
          const identity = liveIdentity(lease)
          if (identity === undefined) return
          useChat.getState().syncHarnessTranscript(identity, turns, ctx)
        },
        onTranscript: (ev) => {
          const identity = liveIdentity(lease)
          if (identity === undefined) return false
          return useChat.getState().applyHarnessTranscriptEvent(identity, ev)
        },
        onAgentStatus: (ev) => {
          const identity = liveIdentity(lease)
          if (identity === undefined) return
          useChat.getState().applyAgentStatus(identity, ev)
          if (ev.status === 'working') outboundPumpFor(identity).pump.onBusy()
        },
        onPrompt: (ev) => {
          const identity = liveIdentity(lease)
          if (identity === undefined) return
          useChat.getState().applyPromptEvent(identity, ev)
        },
        onControlReset: () => {
          const identity = liveIdentity(lease)
          if (identity === undefined) return
          useChat.getState().clearHarnessPrompts(identity)
        },
        onLive: (turn, reason) => {
          const identity = liveIdentity(lease)
          if (identity === undefined) return
          if (reason === 'resync') {
            useChat.getState().clearLive(identity)
            return
          }
          if (!turn) useChat.getState().clearAcceptedReply(identity)
          useChat.getState().setLive(identity, turn)
        },
        onApproval: (event) => {
          const identity = liveIdentity(lease)
          if (identity === undefined) return
          useChat.getState().applyApprovalEvent(identity, event)
        },
        onTurnComplete: () => {
          const identity = liveIdentity(lease)
          if (identity === undefined) return
          useChat.getState().clearAcceptedReply(identity)
          outboundPumpFor(identity).pump.onIdle()
        },
        onSessionUpdated: () => {
          const identity = liveIdentity(lease)
          if (identity === undefined) return
          void args.queryClient.invalidateQueries({
            queryKey: ['remote-session', args.sessionBase, identity],
          })
        },
        liveSource: () => {
          const identity = liveIdentity(lease)
          if (identity === undefined) return undefined
          return useChat.getState().liveSource[useChat.getState().resolveSessionKey(identity)]
        },
        onError: (err) => {
          const identity = liveIdentity(lease)
          if (identity !== undefined) useChat.getState().clearAcceptedReply(identity)
          report(lease, err instanceof Error ? err.message : String(err))
        },
        onFatal: (message) => {
          const identity = liveIdentity(lease)
          if (identity !== undefined) {
            outboundPumpFor(identity).pump.onDeliveryLost()
            outboundPumpFor(identity).closeObserver()
            useChat.getState().clearAcceptedReply(identity)
            useChat.getState().setLive(identity, undefined)
          }
          report(lease, `${message} — this session is no longer attachable`)
        },
        onStatus: (status) => {
          if (status === 'open') report(lease, undefined)
        },
      })
    })
    .catch((err: unknown) => {
      if (gen !== lease.attachGen || lease.superseded) return
      report(lease, err instanceof Error ? err.message : String(err))
    })
  return lease
}

function foldLease(preferred: Lease, incoming: Lease): void {
  if (preferred === incoming || incoming.superseded || preferred.superseded) return
  // The open socket is the survivor. Listeners move onto it; the other
  // lease's pending gateway promise is cancelled so it cannot attach again.
  const keep = incoming.attachment && !preferred.attachment ? incoming : preferred
  const drop = keep === preferred ? incoming : preferred
  keep.refs += drop.refs
  for (const listener of drop.listeners) keep.listeners.add(listener)
  if (drop.error !== undefined && keep.error === undefined) keep.error = drop.error
  drop.refs = 0
  drop.listeners.clear()
  drop.superseded = true
  drop.survivor = keep
  drop.attachGen += 1
  if (drop.idleTimer !== undefined) {
    clearTimeout(drop.idleTimer)
    drop.idleTimer = undefined
  }
  if (drop.attachment) {
    drop.attachment.close()
    drop.attachment = undefined
  }
  if (drop.bound && !keep.bound) {
    keep.bound = true
    keep.mode = 'attach'
  }
  if (drop.watched && keep.mode !== 'attach') {
    keep.watched = true
    if (keep.mode === 'none') keep.mode = 'watch'
    if (keep.watchedIdentity === undefined) keep.watchedIdentity = drop.watchedIdentity
  } else if (drop.watched) {
    drop.watched = false
    if (!heldSameMode(drop.identity, 'watch', drop)) {
      useChat.getState().unwatchTranscript(drop.identity)
    }
  }
  drop.bound = false
  drop.watched = false
  drop.mode = 'none'
  if (leases.get(drop.key) === drop) leases.delete(drop.key)
  leases.set(keep.key, keep)
}

/**
 * Close a predecessor that lost to a lease already living at the destination.
 * `rekey` has aliased `from` onto `to` and moved the store binding, so the
 * normal retire path would unwatch or unbind the live session.
 */
function retireMovedLease(lease: Lease): void {
  if (lease.superseded) return
  lease.superseded = true
  if (lease.idleTimer !== undefined) {
    clearTimeout(lease.idleTimer)
    lease.idleTimer = undefined
  }
  closeAttachment(lease)
  lease.bound = false
  lease.watched = false
  lease.mode = 'none'
  if (leases.get(lease.key) === lease) leases.delete(lease.key)
}

function migrateIdentity(from: string, to: string): void {
  if (from === to) return
  const moving = [...leases.values()].filter((lease) => {
    if (lease.superseded || lease.identity === to) return false
    return lease.identity === from || resolvedId(lease.identity) === to
  })
  const movingSet = new Set(moving)
  // Already at `to` before this move (session-created can beat the rotation).
  // That lease is the live session when its stream differs from the one moving in.
  const staying = [...leases.values()].filter((lease) => {
    if (lease.superseded || movingSet.has(lease)) return false
    return lease.identity === to || resolvedId(lease.identity) === to
  })
  for (const lease of moving) {
    // An earlier iteration may have retired this member. Do not write it back.
    if (lease.superseded) continue
    const nextKey = signatureKey(to, lease)
    const existing = leases.get(nextKey)
    if (existing && existing !== lease) {
      if (leases.get(lease.key) === lease) leases.delete(lease.key)
      lease.identity = to
      lease.key = nextKey
      foldLease(existing, lease)
      continue
    }
    const destinationOwnsOtherStream = staying.some(
      (other) => !other.superseded && !sameStreamSignature(other, lease),
    )
    if (destinationOwnsOtherStream) {
      retireMovedLease(lease)
      continue
    }
    if (leases.get(lease.key) === lease) leases.delete(lease.key)
    lease.identity = to
    lease.key = nextKey
    leases.set(nextKey, lease)
    retireDifferentSignatures(lease)
  }
}

/** Acquire the shared stream. The returned function releases one reference. */
export function bindSessionStream(args: LeaseArgs): () => void {
  const key = streamKey(args)
  let lease = leases.get(key)
  let reacquired = false
  if (!lease) {
    lease = startLease(args, key)
    leases.set(key, lease)
    // In the map first, so the retired peer sees this binding and does not
    // unbind the session out from under the socket we just started.
    if (lease.mode === 'attach') retireDifferentSignatures(lease)
  } else if (lease.idleTimer !== undefined) {
    // Re-acquire of an idle-warm lease: keep the live attach.
    reacquired = true
    clearTimeout(lease.idleTimer)
    lease.idleTimer = undefined
    lease.releasedOrder = 0
  }
  // A sibling expiry or rekey can clear the store while this lease still
  // thinks it owns the binding. watchTranscript is idempotent. bindHarness
  // resets the live floor, so it runs only when the store binding is gone.
  if (lease.mode === 'watch' && (reacquired || lease.watchedIdentity !== lease.identity)) {
    useChat.getState().watchTranscript(lease.identity)
    lease.watchedIdentity = lease.identity
    lease.watched = true
  } else if (
    lease.mode === 'attach' &&
    !useChat.getState().harnessBound[resolvedId(lease.identity)]
  ) {
    useChat.getState().bindHarness(lease.identity, lease.harnessId ?? 'harness')
    lease.bound = true
  }
  lease.refs += 1
  lease.listeners.add(args.onStreamError)
  if (lease.error !== undefined) args.onStreamError(lease.error)
  const linger = args.linger === true
  let released = false
  return () => {
    if (released) return
    released = true
    const current = currentLease(lease)
    if (leases.get(current.key) !== current) return
    current.listeners.delete(args.onStreamError)
    current.refs -= 1
    if (current.refs <= 0) {
      current.refs = 0
      if (linger) park(current)
      else retire(current)
    }
  }
}

function dropAll(notify: boolean): void {
  const held = [...leases.values()]
  leases.clear()
  for (const lease of held) {
    if (lease.superseded) continue
    lease.superseded = true
    if (lease.idleTimer !== undefined) {
      clearTimeout(lease.idleTimer)
      lease.idleTimer = undefined
    }
    closeAttachment(lease)
    // The map is empty, so every binding is released. Epoch/gateway reset
    // stops held leases too — sessions are per gateway.
    if (lease.mode === 'watch' && lease.watched) {
      lease.watched = false
      useChat.getState().unwatchTranscript(lease.identity)
    }
    if (lease.mode === 'attach' && lease.bound) {
      lease.bound = false
      useChat.getState().unbindHarness(lease.identity)
    }
    lease.mode = 'none'
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

subscribeChatThreads((event) => {
  if (event.type === 'move') migrateIdentity(event.from, event.to)
  else if (event.type === 'remove') {
    for (const lease of [...leases.values()]) {
      if (event.keys.has(lease.identity) || event.keys.has(resolvedId(lease.identity))) {
        retire(lease)
      }
    }
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
  const linger = args.linger === true
  useEffect(() => {
    return bindSessionStream({
      sessionId: args.sessionId,
      streamId: args.streamId,
      isRemote: args.isRemote,
      sessionBase: args.sessionBase,
      harnessId,
      transportEpoch: epoch,
      linger,
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
    linger,
    sessionGateway,
    queryClient,
    setStreamError,
  ])
  return { streamError, setStreamError }
}
