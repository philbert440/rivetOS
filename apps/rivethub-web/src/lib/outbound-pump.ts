/**
 * Outbound queue pump for one conversation's harness.
 *
 * Chat sends enqueue and the pump injects them serially: only auto-inject the
 * next turn when the previous agent turn is truly streaming (tools/text) —
 * a pre-inject "working…" placeholder must not stall the queue forever
 * (Hermes often never bridges a done event).
 *
 * Three policies live here, all unit-tested without a DOM:
 *
 *   - **Inject latch.** After a successful inject the pump holds until the
 *     harness's stream latches busy. The hook chain (UserPromptSubmit → den →
 *     bridge) is normally sub-second, but a big context can take seconds to
 *     first frame — draining the next queued message in that window
 *     double-injects into a working harness. Only if nothing EVER latches
 *     (no hooks / dead bridge) do we drop the placeholder and let the queue
 *     flow.
 *   - **`turn_in_flight` backoff.** v1 drivers never queue, so a mid-turn send
 *     is simply "not yet": the turn goes back on the queue (bubble intact) and
 *     a bounded exponential backoff retries it. A harness parked on a TUI
 *     permission prompt is mid-turn indefinitely, and hammering it forever is
 *     worse than leaving the message queued with its inject button — after
 *     the attempt cap the user's inject button is the (interrupting) manual
 *     retry.
 *   - **Stale-turn release.** turn.end (Stop hook) ends Claude/grok turns
 *     properly, but a harness that never bridges done would leave the live
 *     slot busy forever and starve the queue. If no stream frame lands for
 *     STALE_TURN_MS with no tool running (a silent long Bash is still a real
 *     turn), the turn is declared over so queued messages flow.
 *
 * Framework-free on purpose — the React layer supplies the store adapter and
 * the inject sink, so the ordering is unit-testable (see harness-attach.ts).
 */

import type { LiveTurn, OutboundItem } from '../stores/chat.js'

/** How long the queue pump waits for an injected turn's first stream frame
 *  before deciding the harness isn't bridging and letting the queue flow. */
export const INJECT_LATCH_MS = 6_000
/** A busy live turn with no frames for this long and no tool running is
 *  treated as ended (harnesses that never bridge done — see stale-release).
 *  Generous on purpose: the bridge is BLOCK-granular for claude (a long
 *  no-tool generation is silent between blocks), so short windows
 *  false-positive on healthy turns (grok review, PR #338). */
export const STALE_TURN_MS = 120_000
/** First backoff after a `turn_in_flight` rejection; doubles per attempt. */
export const TURN_RETRY_MS = 1_500
export const TURN_RETRY_MAX_MS = 30_000
/**
 * Give up auto-retrying after this many rejections. A harness parked on a TUI
 * permission prompt is mid-turn indefinitely, and hammering it forever is
 * worse than leaving the message queued with its inject button.
 */
export const TURN_RETRY_ATTEMPTS = 6
/** Poll cadence of the stale-turn watcher and the inject latch. */
const STALE_POLL_MS = 5_000
const LATCH_POLL_MS = 250

/** The slice of the chat store the pump drives (also the test seam). */
export interface OutboundPumpStore {
  queue(sessionId: string): OutboundItem[] | undefined
  liveIsBusy(sessionId: string): boolean
  live(sessionId: string): LiveTurn | undefined
  /** ms timestamp of the last stream frame — the stale-turn clock. */
  liveTs(sessionId: string): number | undefined
  markSending(sessionId: string, id: string): void
  dequeue(sessionId: string, id: string): void
  requeue(sessionId: string, id: string): void
  fail(sessionId: string, id: string): void
  beginLive(sessionId: string, activity: string): void
  clearLive(sessionId: string): void
}

export interface OutboundPumpOptions {
  sessionId: string
  store: OutboundPumpStore
  /** Inject one user turn into the harness (control-plane or PTY path). */
  inject: (text: string, interrupt: boolean) => Promise<void>
  /** The driver's "a turn is already running" rejection. */
  isTurnInFlight: (err: unknown) => boolean
}

export interface OutboundPump {
  pump(opts?: { forceId?: string; interrupt?: boolean }): Promise<void>
  /**
   * Drop the single-flight latch. The latch is what stops a cancelled
   * in-flight item's settled promise from double-pumping — the cancel path
   * clears it and re-pumps for the rest of the queue.
   */
  reset(): void
  /** Release the pending retry timer (unmount). */
  dispose(): void
}

export function createOutboundPump(opts: OutboundPumpOptions): OutboundPump {
  const { sessionId, store } = opts
  let pumping = false
  /** `turn_in_flight` attempts per queued turn, and the one pending retry. */
  const turnRetries = new Map<string, number>()
  let retryTimer: ReturnType<typeof setTimeout> | undefined

  const pump = async (pumpOpts?: { forceId?: string; interrupt?: boolean }): Promise<void> => {
    if (pumping) return
    const q = store.queue(sessionId) ?? []
    if (!pumpOpts?.forceId && q.some((o) => o.status === 'sending')) return
    // Real stream in flight → wait (unless user force-injects a specific id).
    if (!pumpOpts?.forceId && store.liveIsBusy(sessionId)) return
    const next = pumpOpts?.forceId
      ? q.find((o) => o.id === pumpOpts.forceId)
      : q.find((o) => o.status === 'queued')
    if (!next) return

    pumping = true
    store.markSending(sessionId, next.id)
    store.beginLive(sessionId, 'working…')
    try {
      await opts.inject(next.text, pumpOpts?.interrupt === true)
      store.dequeue(sessionId, next.id)
      turnRetries.delete(next.id)
      // Hold the pump until the harness's stream latches busy (see header).
      const deadline = Date.now() + INJECT_LATCH_MS
      while (Date.now() < deadline && !store.liveIsBusy(sessionId)) {
        await new Promise((r) => setTimeout(r, LATCH_POLL_MS))
      }
      if (!store.liveIsBusy(sessionId)) {
        store.clearLive(sessionId)
      }
    } catch (err) {
      pumping = false
      if (opts.isTurnInFlight(err)) {
        // Not a failure: put the turn back in the queue (bubble intact) and
        // let the retry timer / next live change pick it up.
        store.requeue(sessionId, next.id)
        // Only the pre-inject placeholder goes: a real streaming turn is
        // exactly WHY the driver said no, and dropping its bubble would blank
        // the reply the user is watching.
        if (!store.liveIsBusy(sessionId)) store.clearLive(sessionId)
        // Backoff, bounded (see header).
        const attempts = (turnRetries.get(next.id) ?? 0) + 1
        turnRetries.set(next.id, attempts)
        if (attempts <= TURN_RETRY_ATTEMPTS) {
          const delay = Math.min(TURN_RETRY_MS * 2 ** (attempts - 1), TURN_RETRY_MAX_MS)
          if (retryTimer) clearTimeout(retryTimer)
          retryTimer = setTimeout(() => {
            retryTimer = undefined
            void pump().catch(() => undefined)
          }, delay)
        }
        return
      }
      turnRetries.delete(next.id)
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
    reset: () => {
      pumping = false
    },
    dispose: () => {
      if (retryTimer) clearTimeout(retryTimer)
    },
  }
}

/**
 * Arm the stale-turn release watcher; returns the disarm. Only armed while
 * something is actually queued — releasing is for the pump, not the view, and
 * a false positive on an idle queue would just kill a healthy bubble.
 */
export function startStaleTurnRelease(store: OutboundPumpStore, sessionId: string): () => void {
  const timer = setInterval(() => {
    const L = store.live(sessionId)
    if (!L) return
    // Placeholder-only turns are the pump's latch window, not ours — and
    // liveTs may still be the PREVIOUS turn's last frame, which would
    // release instantly.
    if (!(L.text || L.tools.length > 0 || L.reasoningText)) return
    const last = store.liveTs(sessionId) ?? 0
    const toolRunning = L.tools.some((t) => t.status === 'running')
    if (!toolRunning && last > 0 && Date.now() - last > STALE_TURN_MS) {
      store.clearLive(sessionId)
    }
  }, STALE_POLL_MS)
  return () => clearInterval(timer)
}
