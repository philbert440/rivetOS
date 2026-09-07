/**
 * Attach one chat view to a driver-owned harness session.
 *
 * The contract's stream rule drives every line here: `subscribe` is an
 * **at-most-once live tail from attach time** — no replay buffer, no sequence
 * numbers — so a client that reconnects and picks up the tail has silently
 * lost whatever happened during the gap. The only correct recovery is a hard
 * resync from the transcript source of truth. This module therefore resyncs
 * on EVERY `open`, first connect and reconnect alike, and never assumes replay
 * (docs/ARCHITECTURE.md § HarnessDriver: control-plane contract).
 *
 * Live in-turn state comes from `transcript` / `status` / `prompt` frames on
 * this same socket. Hook deltas are folded only while the store has not
 * marked the session transcript-sourced. HTTP resync-after-turn-complete is
 * gone — the transcript watcher pushes the committed turn.
 *
 * Framework-free on purpose — the React layer supplies the sinks, so the
 * reconnect/resync ordering is unit-testable without a DOM.
 */

import type {
  HarnessEvent,
  HarnessPromptEvent,
  HarnessSessionTranscriptResponse,
  HarnessStatusFrame,
  HarnessTranscriptEvent,
  HarnessTranscriptTurn,
} from '@rivetos/types'
import type { Subscription } from '@rivetos/gateway-client'
import { foldHarnessEvent, isApprovalEvent, type HarnessApprovalEvent } from './harness-fold.js'
import type { LiveTurn } from './fold-stream.js'
import { clearSystemPromptSent } from './system-prompt-sent.js'

/** The slice of RivetGateway an attachment needs (also the test seam). */
export type SessionContextStamp = Pick<
  HarnessSessionTranscriptResponse,
  'contextWindow' | 'compactAt' | 'contextSource'
>

export interface HarnessAttachGateway {
  harnessSessionTranscript(
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<{ turns: HarnessTranscriptTurn[] } & SessionContextStamp>
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
  /** HTTP hard resync — replaces the transcript wholesale. Never merges. */
  onResync: (turns: HarnessTranscriptTurn[], ctx?: SessionContextStamp) => void
  /**
   * WS transcript frame. Return `false` so the attachment sends `{type:'sync'}`
   * (rev gap / splice mismatch). Absent → frames are ignored.
   */
  onTranscript?: (event: HarnessTranscriptEvent) => boolean
  onAgentStatus?: (event: HarnessStatusFrame) => void
  onPrompt?: (event: HarnessPromptEvent) => void
  /**
   * Socket just opened (first attach or reconnect). den then replays
   * still-open prompts; drop stale cards first so a prompt resolved while
   * we were gone cannot linger (answering it 404s).
   */
  onControlReset?: () => void
  /** Live turn state, `undefined` when the slot should clear. */
  onLive: (turn: LiveTurn | undefined) => void
  /** Approval request/resolution — outlives the turn, so not part of the fold. */
  onApproval?: (event: HarnessApprovalEvent) => void
  onTurnComplete?: () => void
  onSessionUpdated?: () => void
  /**
   * Store's live-turn source for this session. Hook deltas fold only while
   * this is not `'transcript'`.
   */
  liveSource?: () => 'transcript' | 'hooks' | undefined
  onStatus?: (status: 'connecting' | 'open' | 'closed') => void
  /** Transient resync failure (node offline, node restarting). */
  onError?: (err: unknown) => void
  /**
   * The session cannot be attached at all — deleted, unknown to the registry,
   * or a driver that cannot serve this stream. The attachment stops itself
   * first (no reconnect loop against a session that will never answer).
   */
  onFatal?: (message: string) => void
}

export interface HarnessAttachment {
  close(): void
  /** Force a hard resync (mode switch back into chat, manual refresh). */
  resync(): void
  /** Ask the server to re-send a from:0 snapshot on this socket. */
  sync(): void
}

/**
 * Typed harness codes that will never succeed on retry: the session is gone,
 * malformed, or the driver has no such capability. Anything else (a node
 * restarting, a transient 5xx) is worth reconnecting for.
 */
const FATAL_CODES = new Set(['invalid_session_id', 'capability_unsupported'])
const SYNC_REARM_MS = 3_000
/** Same, on the resync side: gone / malformed / unsupported. */
const FATAL_STATUS = new Set([400, 404, 501])

function fatalResyncMessage(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null) return undefined
  const { status, message } = err as { status?: unknown; message?: unknown }
  if (typeof status !== 'number' || !FATAL_STATUS.has(status)) return undefined
  return typeof message === 'string' && message ? message : `transcript unavailable (${status})`
}

function isHookDelta(event: HarnessEvent): boolean {
  return (
    event.type === 'assistant-delta' ||
    event.type === 'reasoning-delta' ||
    event.type === 'tool-use' ||
    event.type === 'tool-result'
  )
}

export function attachHarnessSession(opts: HarnessAttachOptions): HarnessAttachment {
  let closed = false
  let live: LiveTurn | undefined
  /** Bumped per resync so a slow in-flight fetch can't overwrite a newer one. */
  let generation = 0
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
        opts.onResync(res.turns, {
          contextWindow: res.contextWindow,
          compactAt: res.compactAt,
          contextSource: res.contextSource,
        })
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
  // den drops a `sync` that lands within 2 s of the previous one, silently —
  // re-arm ONCE after a short wait unless a snapshot arrived meanwhile (one-shot
  // timeout re-armed by frames, not a poll).
  let syncTimer: ReturnType<typeof setTimeout> | undefined
  const sync = (): boolean => {
    const ok = socket.sub?.send({ type: 'sync' }) ?? false
    if (syncTimer) clearTimeout(syncTimer)
    syncTimer = setTimeout(() => {
      syncTimer = undefined
      if (!closed) socket.sub?.send({ type: 'sync' })
    }, SYNC_REARM_MS)
    return ok
  }
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
      if (event.type === 'session-updated') {
        opts.onSessionUpdated?.()
        if (event.status === 'error') {
          clearSystemPromptSent(opts.sessionId)
          if (event.previousSessionId) clearSystemPromptSent(event.previousSessionId)
        }
      }
      if (event.type === 'transcript') {
        // First snapshot (and later from:0) owns the live slot — do not clear
        // on socket open, or a reconnect blanks a mid-turn bubble the
        // transcript frame is about to rebuild.
        if (event.from === 0) {
          live = undefined
          opts.onLive(undefined)
          if (syncTimer) {
            clearTimeout(syncTimer)
            syncTimer = undefined
          }
        }
        const ok = opts.onTranscript?.(event)
        if (ok === false) sync()
        return
      }
      if (event.type === 'status') {
        opts.onAgentStatus?.(event)
        if (opts.liveSource?.() === 'transcript') return
      } else if (event.type === 'prompt') {
        opts.onPrompt?.(event)
        return
      } else if (event.type === 'turn-complete') {
        opts.onTurnComplete?.()
        if (opts.liveSource?.() === 'transcript') return
      } else if (isHookDelta(event) && opts.liveSource?.() === 'transcript') {
        return
      }
      const next = foldHarnessEvent(live, event)
      if (next !== live) {
        live = next
        opts.onLive(live)
      }
    },
    {
      onStatus: (status) => {
        if (closed) return
        if (status === 'open') {
          // Replay of still-open prompts follows this open. Clear first so a
          // card resolved while disconnected does not linger (POST 404s).
          opts.onControlReset?.()
        }
        opts.onStatus?.(status)
        if (status !== 'open') return
        // Fresh attach (first or Nth): everything between the drop and now is
        // gone from the tail forever. Rebuild from the transcript — the
        // contract's hard-resync rule. Do NOT clear `live` here: the first
        // transcript snapshot does that, so a reconnect does not blank the
        // bubble the snapshot is about to restore.
        resync()
      },
    },
  )

  /** Release every resource without reporting anything. */
  function stop(): void {
    closed = true
    abort?.abort()
    if (syncTimer) clearTimeout(syncTimer)
    socket.sub?.close()
  }

  return {
    close: stop,
    resync,
    sync,
  }
}
