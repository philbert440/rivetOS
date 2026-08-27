/**
 * Attach one chat view to a driver-owned harness session.
 *
 * The contract's stream rule drives every line here: `subscribe` is an
 * **at-most-once live tail from attach time** — no replay buffer, no sequence
 * numbers — so a client that reconnects and picks up the tail has silently
 * lost whatever happened during the gap. The only correct recovery is a hard
 * resync from the transcript source of truth. This module therefore resyncs
 * on EVERY `open`, first connect and reconnect alike, and never assumes replay
 * (docs/plans/harness-control-plane.md § Contract semantics).
 *
 * It also resyncs at `turn-complete`: the live tail carries text and tool
 * calls, but usage, thinking and the committed turn text come from the store.
 *
 * Framework-free on purpose — the React layer supplies the sinks, so the
 * reconnect/resync ordering is unit-testable without a DOM.
 */

import type { HarnessEvent, HarnessTranscriptTurn } from '@rivetos/types'
import type { Subscription } from '@rivetos/gateway-client'
import { foldHarnessEvent, isApprovalEvent, type HarnessApprovalEvent } from './harness-fold.js'
import type { LiveTurn } from './fold-stream.js'
import { clearSystemPromptSent } from './system-prompt-sent.js'

/** The slice of RivetGateway an attachment needs (also the test seam). */
export interface HarnessAttachGateway {
  harnessSessionTranscript(
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<{ turns: HarnessTranscriptTurn[] }>
  watchHarnessSession(
    sessionId: string,
    onEvent: (event: HarnessEvent) => void,
    opts?: { onStatus?: (status: 'connecting' | 'open' | 'closed') => void },
  ): Subscription
}

export interface HarnessAttachOptions {
  gateway: HarnessAttachGateway
  /** Canonical `<harness-id>:<native>`. */
  sessionId: string
  /** Hard resync — replaces the transcript wholesale. Never merges. */
  onTranscript: (turns: HarnessTranscriptTurn[]) => void
  /** Live turn state, `undefined` when the slot should clear. */
  onLive: (turn: LiveTurn | undefined) => void
  /** Approval request/resolution — outlives the turn, so not part of the fold. */
  onApproval?: (event: HarnessApprovalEvent) => void
  onStatus?: (status: 'connecting' | 'open' | 'closed') => void
  /** Transient resync failure (node offline, node restarting). */
  onError?: (err: unknown) => void
  /**
   * The session cannot be attached at all — deleted, unknown to the registry,
   * or a driver that cannot serve this stream. The attachment stops itself
   * first (no reconnect loop against a session that will never answer).
   */
  onFatal?: (message: string) => void
  /**
   * Grace before the post-turn resync: the harness store is written as the
   * turn commits, and `turn-complete` can beat the last flush to disk.
   */
  settleMs?: number
}

export interface HarnessAttachment {
  close(): void
  /** Force a hard resync (mode switch back into chat, manual refresh). */
  resync(): void
}

const DEFAULT_SETTLE_MS = 400

/**
 * Typed harness codes that will never succeed on retry: the session is gone,
 * malformed, or the driver has no such capability. Anything else (a node
 * restarting, a transient 5xx) is worth reconnecting for.
 */
const FATAL_CODES = new Set(['invalid_session_id', 'capability_unsupported'])
/** Same, on the resync side: gone / malformed / unsupported. */
const FATAL_STATUS = new Set([400, 404, 501])

function fatalResyncMessage(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null) return undefined
  const { status, message } = err as { status?: unknown; message?: unknown }
  if (typeof status !== 'number' || !FATAL_STATUS.has(status)) return undefined
  return typeof message === 'string' && message ? message : `transcript unavailable (${status})`
}

export function attachHarnessSession(opts: HarnessAttachOptions): HarnessAttachment {
  const settleMs = opts.settleMs ?? DEFAULT_SETTLE_MS
  let closed = false
  let live: LiveTurn | undefined
  /** Bumped per resync so a slow in-flight fetch can't overwrite a newer one. */
  let generation = 0
  let settle: ReturnType<typeof setTimeout> | undefined
  let abort: AbortController | undefined

  /** Stop for good — a session that will never answer must not be retried. */
  const fatal = (message: string): void => {
    if (closed) return
    stop()
    opts.onFatal?.(message)
  }

  const resync = (): void => {
    if (closed) return
    const mine = ++generation
    abort?.abort()
    const controller = new AbortController()
    abort = controller
    opts.gateway.harnessSessionTranscript(opts.sessionId, controller.signal).then(
      (res) => {
        if (closed || mine !== generation) return
        opts.onTranscript(res.turns)
      },
      (err: unknown) => {
        if (closed || mine !== generation) return
        if (err instanceof Error && err.name === 'AbortError') return
        const terminal = fatalResyncMessage(err)
        if (terminal !== undefined) {
          fatal(terminal)
          return
        }
        opts.onError?.(err)
      },
    )
  }

  // Held in a box, not a binding: a server that refuses the attach can answer
  // inside the subscribe call itself, and `stop()` running from there must not
  // hit the temporal dead zone of a `const` that has not been assigned yet.
  const socket: { sub?: Subscription } = {}
  socket.sub = opts.gateway.watchHarnessSession(
    opts.sessionId,
    (event) => {
      if (closed) return
      if (isApprovalEvent(event)) {
        opts.onApproval?.(event)
        return
      }
      if (event.type === 'error') {
        clearSystemPromptSent(opts.sessionId)
        if (FATAL_CODES.has(event.code)) {
          // The server's attach-failure frame: it closes the socket right after,
          // and the ws helper would otherwise reconnect into the same refusal
          // forever, each round trip re-arming a 404 resync.
          fatal(event.message || event.code)
          return
        }
      }
      if (event.type === 'session-updated' && event.status === 'error') {
        clearSystemPromptSent(opts.sessionId)
        if (event.previousSessionId) clearSystemPromptSent(event.previousSessionId)
      }
      const next = foldHarnessEvent(live, event)
      if (next !== live) {
        live = next
        opts.onLive(live)
      }
      if (event.type === 'turn-complete') {
        // The committed turn (usage, thinking, tool results) lands on disk;
        // read it back rather than trusting the tail we just folded.
        if (settle) clearTimeout(settle)
        settle = setTimeout(resync, settleMs)
      }
    },
    {
      onStatus: (status) => {
        if (closed) return
        opts.onStatus?.(status)
        if (status !== 'open') return
        // Fresh attach (first or Nth): everything between the drop and now is
        // gone from the tail forever. Drop the live turn and rebuild from the
        // transcript — the contract's hard-resync rule.
        //
        // Unconditionally, not just when WE folded one: the bubble showing on
        // open may have been folded by the all-sessions socket before this
        // session was handed over, and with no replay nothing will ever
        // supersede it. (Same reason a mid-turn attach can't recover the
        // turn's prefix — only the committed transcript can, at turn end.)
        live = undefined
        opts.onLive(undefined)
        resync()
      },
    },
  )

  /** Release every resource without reporting anything. */
  function stop(): void {
    closed = true
    if (settle) clearTimeout(settle)
    abort?.abort()
    socket.sub?.close()
  }

  return {
    close: stop,
    resync,
  }
}
