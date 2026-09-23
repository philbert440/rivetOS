/**
 * Outbound queue pump for one conversation's harness.
 *
 * Chat sends enqueue and the pump injects them serially: only auto-inject the
 * next turn when the previous agent turn is truly streaming (tools/text) —
 * a pre-inject "working…" placeholder must not stall the queue forever
 * (Hermes often never bridges a done event).
 *
 * Two policies live here, all unit-tested without a DOM:
 *
 *   - **Inject latch.** After a successful inject the pump holds until the
 *     harness's stream latches busy. Resolved by a store subscription
 *     (`awaitBusy`) or a single timeout — never a poll loop. Only if nothing
 *     EVER latches (no hooks / dead bridge) do we drop the placeholder and
 *     let the queue flow.
 *   - **`turn_in_flight` retry.** v1 drivers never queue, so a mid-turn send
 *     is simply "not yet": the turn goes back on the queue and retries once
 *     per `status idle` / `turn-complete` edge (`onIdle()`). After the
 *     attempt cap the user's inject button is the (interrupting) manual retry.
 *   - **`turn_undelivered`.** den accepted the inject but the harness never
 *     took it. The pump keeps the last accepted item and `onUndelivered()`
 *     puts it back as failed (no auto-retry — a dialog may need answering).
 *
 * Stale-turn release is den's job (server-side timer re-armed per frame).
 *
 * Framework-free on purpose — the React layer supplies the store adapter and
 * the inject sink, so the ordering is unit-testable (see harness-attach.ts).
 */

import type { OutboundItem } from '../stores/chat.js'

/** How long the queue pump waits for an injected turn's first stream frame
 *  before deciding the harness isn't bridging and letting the queue flow. */
export const INJECT_LATCH_MS = 6_000
/**
 * Give up auto-retrying after this many rejections. A harness parked on a TUI
 * permission prompt is mid-turn indefinitely, and hammering it forever is
 * worse than leaving the message queued with its inject button.
 */
export const TURN_RETRY_ATTEMPTS = 6

/** The slice of the chat store the pump drives (also the test seam). */
export interface OutboundPumpStore {
  resolveSessionKey?(sessionId: string): string
  queue(sessionId: string): OutboundItem[] | undefined
  liveIsBusy(sessionId: string): boolean
  markSending(sessionId: string, id: string): void
  dequeue(sessionId: string, id: string): void
  requeue(sessionId: string, id: string): void
  fail(sessionId: string, id: string): void
  restoreFailed(sessionId: string, item: OutboundItem): void
  beginLive(sessionId: string, activity: string): void
  clearLive(sessionId: string): void
  /**
   * Resolve when the session latches busy, or when `ms` elapses — one-shot,
   * no poll loop. Implemented by the page's Zustand subscription.
   */
  awaitBusy(sessionId: string, ms: number): Promise<void>
}

export interface OutboundPumpOptions {
  sessionId: string
  /** Registry-owned identity survives defensive alias eviction. */
  currentSessionKey?: () => string
  store: OutboundPumpStore
  /** Inject one user turn into the harness (control-plane or PTY path). */
  inject: (
    text: string,
    interrupt: boolean,
    attachments?: OutboundItem['attachments'],
  ) => Promise<void>
  /** The driver's "a turn is already running" rejection. */
  isTurnInFlight: (err: unknown) => boolean
}

export interface OutboundPump {
  pump(opts?: { forceId?: string; interrupt?: boolean }): Promise<void>
  /**
   * Drop the single-flight latch — but only when `id` is the in-flight send.
   * The latch is what stops a second inject during the post-inject settle
   * window: by then the item is already dequeued, so a cancel of any OTHER
   * queued bubble must not clear it (that was the double-inject hole). When
   * the id IS the in-flight send, the generation bump orphans that pump()'s
   * trailing store writes so the cancel path's re-pump starts clean.
   */
  reset(id: string): void
  /**
   * Terminal teardown (the pump is never pumped again): abort the latch wait
   * and drop a pending idle-retry. A superseded pump() skips its trailing
   * clearLive / drain-pump — they belong to the generation that got torn down.
   */
  dispose(): void
  /**
   * `status idle` / `turn-complete` edge: retry a turn that was requeued for
   * `turn_in_flight`, once per edge, up to TURN_RETRY_ATTEMPTS.
   */
  onIdle(): void
  /** den reported `turn_undelivered` for the last accepted inject. */
  onUndelivered(): void
}

export function createOutboundPump(opts: OutboundPumpOptions): OutboundPump {
  const { store } = opts
  // Resolve at every read/write, including after latch waits and chained rekeys.
  const sessionId = (): string =>
    opts.currentSessionKey?.() ?? store.resolveSessionKey?.(opts.sessionId) ?? opts.sessionId
  let pumping = false
  /** Id of the send between markSending and inject resolution — the only
   *  item `reset(id)` will free the latch for. Undefined during the latch
   *  window (the item is dequeued by then; its bubble is gone). */
  let inFlight: string | undefined
  /** Bumped by reset/dispose. A pump() that finds its generation superseded
   *  aborts the latch wait and skips every trailing store write — `pumping`
   *  and `inFlight` may already belong to a NEWER pump() by then. */
  let generation = 0
  /** Terminal: a disposed pump never pumps again. */
  let disposed = false
  /** `turn_in_flight` attempts per queued turn. */
  const turnRetries = new Map<string, number>()
  /** Waiting for an idle/turn-complete edge to retry. */
  let awaitingIdle = false
  let lastAccepted: OutboundItem | undefined

  const pump = async (pumpOpts?: { forceId?: string; interrupt?: boolean }): Promise<void> => {
    if (disposed || pumping) return
    const q = store.queue(sessionId()) ?? []
    if (!pumpOpts?.forceId && q.some((o) => o.status === 'sending')) return
    // Real stream in flight → wait (unless user force-injects a specific id).
    if (!pumpOpts?.forceId && store.liveIsBusy(sessionId())) return
    const next = pumpOpts?.forceId
      ? q.find((o) => o.id === pumpOpts.forceId)
      : q.find((o) => o.status === 'queued')
    if (!next) return

    pumping = true
    inFlight = next.id
    const gen = generation
    const superseded = (): boolean => gen !== generation
    store.markSending(sessionId(), next.id)
    store.beginLive(sessionId(), 'working…')
    try {
      await opts.inject(next.text, pumpOpts?.interrupt === true, next.attachments)
      // Cancelled/disposed mid-inject: a newer generation owns `pumping` and
      // the live slot — leave both alone.
      if (superseded()) return
      lastAccepted = next
      store.dequeue(sessionId(), next.id)
      turnRetries.delete(next.id)
      inFlight = undefined
      awaitingIdle = false
      // Hold the pump until the harness's stream latches busy (see header).
      await store.awaitBusy(sessionId(), INJECT_LATCH_MS)
      if (superseded()) return
      if (store.liveIsBusy(sessionId())) lastAccepted = undefined
      if (!store.liveIsBusy(sessionId())) {
        store.clearLive(sessionId())
      }
    } catch (err) {
      // Superseded first: `pumping` / `inFlight` may be a newer pump()'s.
      if (superseded()) return
      pumping = false
      inFlight = undefined
      if (opts.isTurnInFlight(err)) {
        // Not a failure: put the turn back in the queue and retry on the
        // next idle / turn-complete edge.
        store.requeue(sessionId(), next.id)
        // Only the pre-inject placeholder goes: a real streaming turn is
        // exactly WHY the driver said no, and dropping its bubble would blank
        // the reply the user is watching.
        if (!store.liveIsBusy(sessionId())) store.clearLive(sessionId())
        const attempts = (turnRetries.get(next.id) ?? 0) + 1
        turnRetries.set(next.id, attempts)
        awaitingIdle = attempts <= TURN_RETRY_ATTEMPTS
        return
      }
      turnRetries.delete(next.id)
      awaitingIdle = false
      store.fail(sessionId(), next.id)
      store.clearLive(sessionId())
      // Try the next queued message after a failure.
      void pump().catch(() => undefined)
      throw err
    }
    pumping = false
    // Drain further queued turns when not blocked by a real stream.
    if (!store.liveIsBusy(sessionId())) {
      void pump().catch(() => undefined)
    }
  }

  return {
    pump,
    reset: (id) => {
      // Only the in-flight send's own cancel frees the latch — cancelling an
      // already-dequeued (latch-window) or never-started item must not, or a
      // cancel of a queued bubble would re-arm the pump inside the very
      // window the latch exists to protect.
      if (id !== inFlight) return
      generation += 1
      inFlight = undefined
      pumping = false
    },
    dispose: () => {
      disposed = true
      generation += 1
      inFlight = undefined
      pumping = false
      awaitingIdle = false
      lastAccepted = undefined
    },
    onIdle: () => {
      if (disposed || !awaitingIdle) return
      awaitingIdle = false
      void pump().catch(() => undefined)
    },
    onUndelivered: () => {
      if (disposed || !lastAccepted) return
      store.restoreFailed(sessionId(), lastAccepted)
      lastAccepted = undefined
    },
  }
}

export type ThreadLifecycleEvent =
  | { type: 'move'; from: string; to: string }
  | { type: 'remove'; keys: ReadonlySet<string> }
  | { type: 'clear' }

type PumpEntry = { pump: OutboundPump; sink: { current: OutboundPumpOptions['inject'] } }
export type OutboundPumpRegistry = ((sessionId: string) => PumpEntry) & { dispose(): void }

/** Preserve the latch across moves; release the pump and view sink on removal. */
export function createOutboundPumpRegistry(
  store: OutboundPumpStore,
  isTurnInFlight: OutboundPumpOptions['isTurnInFlight'],
  subscribe?: (listener: (event: ThreadLifecycleEvent) => void) => () => void,
): OutboundPumpRegistry {
  const entries = new Map<string, PumpEntry & { key: string }>()
  const noView: OutboundPumpOptions['inject'] = () =>
    Promise.reject(new Error('no mounted session view'))
  const drop = (key: string): void => {
    const entry = entries.get(key)
    if (!entry) return
    entry.pump.dispose()
    entry.sink.current = noView
    entries.delete(key)
  }
  const unsubscribe = subscribe?.((event) => {
    if (event.type === 'move') {
      const entry = entries.get(event.from)
      // An empty destination can have a mounted but idle pump of its own.
      drop(event.to)
      if (entry) {
        entries.delete(event.from)
        entry.key = event.to
        entries.set(event.to, entry)
      }
    } else if (event.type === 'remove') {
      for (const key of event.keys) drop(key)
    } else {
      for (const key of entries.keys()) drop(key)
    }
  })
  const registry = (sessionId: string): PumpEntry => {
    const key = store.resolveSessionKey?.(sessionId) ?? sessionId
    const existing = entries.get(key)
    if (existing) return existing
    // Framework-free callers can omit lifecycle events. Production moves are
    // indexed eagerly, so view renders take the constant-time path above.
    if (!subscribe) {
      for (const [original, entry] of entries) {
        if ((store.resolveSessionKey?.(original) ?? original) === key) {
          entries.delete(original)
          entry.key = key
          entries.set(key, entry)
          return entry
        }
      }
    }
    const sink = { current: noView }
    const entry: PumpEntry & { key: string } = {
      key,
      sink,
      pump: createOutboundPump({
        sessionId: key,
        currentSessionKey: () =>
          subscribe ? entry.key : (store.resolveSessionKey?.(entry.key) ?? entry.key),
        store,
        inject: (text, interrupt, attachments) => sink.current(text, interrupt, attachments),
        isTurnInFlight,
      }),
    }
    entries.set(key, entry)
    return entry
  }
  return Object.assign(registry, {
    dispose: () => {
      unsubscribe?.()
      for (const key of entries.keys()) drop(key)
    },
  })
}
