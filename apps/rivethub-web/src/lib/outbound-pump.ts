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
 *
 * Stale-turn release is den's job (server-side timer re-armed per frame).
 *
 * Framework-free on purpose — the React layer supplies the store adapter and
 * the inject sink, so the ordering is unit-testable (see harness-attach.ts).
 */

import type { LiveTurn, OutboundItem } from '../stores/chat.js'

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
  queue(sessionId: string): OutboundItem[] | undefined
  liveIsBusy(sessionId: string): boolean
  live(sessionId: string): LiveTurn | undefined
  /** ms timestamp of the last stream frame. */
  liveTs(sessionId: string): number | undefined
  markSending(sessionId: string, id: string): void
  dequeue(sessionId: string, id: string): void
  requeue(sessionId: string, id: string): void
  fail(sessionId: string, id: string): void
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
}

export function createOutboundPump(opts: OutboundPumpOptions): OutboundPump {
  const { sessionId, store } = opts
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

  const pump = async (pumpOpts?: { forceId?: string; interrupt?: boolean }): Promise<void> => {
    if (disposed || pumping) return
    const q = store.queue(sessionId) ?? []
    if (!pumpOpts?.forceId && q.some((o) => o.status === 'sending')) return
    // Real stream in flight → wait (unless user force-injects a specific id).
    if (!pumpOpts?.forceId && store.liveIsBusy(sessionId)) return
    const next = pumpOpts?.forceId
      ? q.find((o) => o.id === pumpOpts.forceId)
      : q.find((o) => o.status === 'queued')
    if (!next) return

    pumping = true
    inFlight = next.id
    const gen = generation
    const superseded = (): boolean => gen !== generation
    store.markSending(sessionId, next.id)
    store.beginLive(sessionId, 'working…')
    try {
      await opts.inject(next.text, pumpOpts?.interrupt === true, next.attachments)
      // Cancelled/disposed mid-inject: a newer generation owns `pumping` and
      // the live slot — leave both alone.
      if (superseded()) return
      store.dequeue(sessionId, next.id)
      turnRetries.delete(next.id)
      inFlight = undefined
      awaitingIdle = false
      // Hold the pump until the harness's stream latches busy (see header).
      await store.awaitBusy(sessionId, INJECT_LATCH_MS)
      if (superseded()) return
      if (!store.liveIsBusy(sessionId)) {
        store.clearLive(sessionId)
      }
    } catch (err) {
      // Superseded first: `pumping` / `inFlight` may be a newer pump()'s.
      if (superseded()) return
      pumping = false
      inFlight = undefined
      if (opts.isTurnInFlight(err)) {
        // Not a failure: put the turn back in the queue and retry on the
        // next idle / turn-complete edge.
        store.requeue(sessionId, next.id)
        // Only the pre-inject placeholder goes: a real streaming turn is
        // exactly WHY the driver said no, and dropping its bubble would blank
        // the reply the user is watching.
        if (!store.liveIsBusy(sessionId)) store.clearLive(sessionId)
        const attempts = (turnRetries.get(next.id) ?? 0) + 1
        turnRetries.set(next.id, attempts)
        awaitingIdle = attempts <= TURN_RETRY_ATTEMPTS
        return
      }
      turnRetries.delete(next.id)
      awaitingIdle = false
      store.fail(sessionId, next.id)
      store.clearLive(sessionId)
      // Try the next queued message after a failure.
      void pump().catch(() => undefined)
      throw err
    }
    pumping = false
    // Drain further queued turns when not blocked by a real stream.
    if (!store.liveIsBusy(sessionId)) {
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
    },
    onIdle: () => {
      if (disposed || !awaitingIdle) return
      awaitingIdle = false
      void pump().catch(() => undefined)
    },
  }
}
