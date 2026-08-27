import { describe, it, expect, vi } from 'vitest'
import type { HarnessEvent, HarnessTranscriptTurn, SessionId } from '@rivetos/types'
import type { Subscription } from '@rivetos/gateway-client'
import { attachHarnessSession, type HarnessAttachGateway } from './harness-attach.js'
import type { LiveTurn } from './fold-stream.js'
import { markSystemPromptSent, wasSystemPromptSent } from './system-prompt-sent.js'

const SID = 'claude-code:a1b2c3d4-1111-4222-8333-444455556666' as SessionId

interface Harness {
  gateway: HarnessAttachGateway
  /** Push a frame as the server would. */
  emit(event: HarnessEvent): void
  /** Drive the reconnect lifecycle the ws helper reports. */
  status(s: 'connecting' | 'open' | 'closed'): void
  transcripts: HarnessTranscriptTurn[][]
  calls: { transcript: string[]; closed: number }
  turns: HarnessTranscriptTurn[]
  failTranscript?: Error
}

function fakeGateway(): Harness {
  const h: Harness = {
    transcripts: [],
    calls: { transcript: [], closed: 0 },
    turns: [{ role: 'user', text: 'hi' }],
    emit: () => {},
    status: () => {},
    gateway: {
      harnessSessionTranscript: (sessionId) => {
        h.calls.transcript.push(sessionId)
        return h.failTranscript
          ? Promise.reject(h.failTranscript)
          : Promise.resolve({ turns: h.turns })
      },
      watchHarnessSession: (_sessionId, onEvent, opts): Subscription => {
        h.emit = onEvent
        h.status = (s) => opts?.onStatus?.(s)
        return {
          close: () => {
            h.calls.closed += 1
          },
          send: () => true,
        }
      },
    },
  }
  return h
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

describe('attachHarnessSession', () => {
  it('hard-resyncs the transcript on the FIRST open, not on subscribe', async () => {
    const h = fakeGateway()
    const seen: HarnessTranscriptTurn[][] = []
    const att = attachHarnessSession({
      gateway: h.gateway,
      sessionId: SID,
      onTranscript: (turns) => seen.push(turns),
      onLive: () => {},
    })
    expect(h.calls.transcript).toEqual([])
    h.status('open')
    await flush()
    expect(h.calls.transcript).toEqual([SID])
    expect(seen).toEqual([[{ role: 'user', text: 'hi' }]])
    att.close()
  })

  it('re-resyncs on every reconnect and drops the stale live turn', async () => {
    // The contract: the tail is at-most-once from attach time with no replay,
    // so a reconnect MUST rebuild from the transcript, not resume folding.
    const h = fakeGateway()
    const live: (LiveTurn | undefined)[] = []
    const att = attachHarnessSession({
      gateway: h.gateway,
      sessionId: SID,
      onTranscript: () => {},
      onLive: (t) => live.push(t),
    })
    h.status('open')
    await flush()
    h.emit({ type: 'assistant-delta', sessionId: SID, text: 'half a rep' })
    expect(live.at(-1)?.text).toBe('half a rep')

    h.status('closed')
    h.status('open') // the ws helper reconnected under us
    await flush()
    expect(live.at(-1)).toBeUndefined()
    expect(h.calls.transcript).toEqual([SID, SID])
    att.close()
  })

  it('resyncs again after turn-complete, once the store has settled', async () => {
    vi.useFakeTimers()
    try {
      const h = fakeGateway()
      const att = attachHarnessSession({
        gateway: h.gateway,
        sessionId: SID,
        onTranscript: () => {},
        onLive: () => {},
        settleMs: 50,
      })
      h.status('open')
      await vi.advanceTimersByTimeAsync(1)
      expect(h.calls.transcript).toHaveLength(1)
      h.emit({ type: 'turn-complete', sessionId: SID, stopReason: 'end-turn' })
      expect(h.calls.transcript).toHaveLength(1) // still settling
      await vi.advanceTimersByTimeAsync(60)
      expect(h.calls.transcript).toHaveLength(2)
      att.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it('routes approvals out of the fold and never into the live turn', async () => {
    const h = fakeGateway()
    const approvals: string[] = []
    const live: (LiveTurn | undefined)[] = []
    const att = attachHarnessSession({
      gateway: h.gateway,
      sessionId: SID,
      onTranscript: () => {},
      onLive: (t) => live.push(t),
      onApproval: (e) => approvals.push(e.type),
    })
    h.status('open')
    await flush()
    h.emit({
      type: 'approval-request',
      sessionId: SID,
      requestId: 'r1',
      name: 'Bash',
      input: {},
    })
    h.emit({ type: 'approval-resolved', sessionId: SID, requestId: 'r1', decision: 'allow' })
    expect(approvals).toEqual(['approval-request', 'approval-resolved'])
    expect(live).toEqual([undefined]) // the attach-time clear, nothing more
    att.close()
  })

  it('clears the live slot on open even when it folded nothing itself', async () => {
    // The bubble showing at attach time may have been folded by the
    // all-sessions socket before the handover. With no replay, nothing else
    // will ever supersede it — so the clear is unconditional.
    const h = fakeGateway()
    const live: (LiveTurn | undefined)[] = []
    const att = attachHarnessSession({
      gateway: h.gateway,
      sessionId: SID,
      onTranscript: () => {},
      onLive: (t) => live.push(t),
    })
    h.status('open')
    await flush()
    expect(live).toEqual([undefined])
    att.close()
  })

  it('stops for good on a terminal attach error instead of reconnect-looping', async () => {
    const h = fakeGateway()
    const fatal: string[] = []
    attachHarnessSession({
      gateway: h.gateway,
      sessionId: SID,
      onTranscript: () => {},
      onLive: () => {},
      onFatal: (m) => fatal.push(m),
    })
    h.emit({
      type: 'error',
      sessionId: SID,
      code: 'invalid_session_id',
      message: 'no such session',
    })
    expect(fatal).toEqual(['no such session'])
    expect(h.calls.closed).toBe(1) // the ws helper can no longer reconnect
    // A late open (already in flight when we stopped) must not resync.
    h.status('open')
    await flush()
    expect(h.calls.transcript).toEqual([])
  })

  it('treats a 404 resync as terminal but a 503 as retryable', async () => {
    const h = fakeGateway()
    h.failTranscript = Object.assign(new Error('unknown session'), { status: 404 })
    const fatal: string[] = []
    const errors: unknown[] = []
    attachHarnessSession({
      gateway: h.gateway,
      sessionId: SID,
      onTranscript: () => {},
      onLive: () => {},
      onError: (e) => errors.push(e),
      onFatal: (m) => fatal.push(m),
    })
    h.status('open')
    await flush()
    expect(fatal).toEqual(['unknown session'])
    expect(errors).toEqual([])

    const h2 = fakeGateway()
    h2.failTranscript = Object.assign(new Error('node restarting'), { status: 503 })
    const fatal2: string[] = []
    const errors2: unknown[] = []
    const att2 = attachHarnessSession({
      gateway: h2.gateway,
      sessionId: SID,
      onTranscript: () => {},
      onLive: () => {},
      onError: (e) => errors2.push(e),
      onFatal: (m) => fatal2.push(m),
    })
    h2.status('open')
    await flush()
    expect(fatal2).toEqual([])
    expect(errors2).toHaveLength(1)
    att2.close()
  })

  it('reports a resync failure and stops writing after close', async () => {
    const h = fakeGateway()
    h.failTranscript = new Error('gateway 501 no transcript source')
    const errors: string[] = []
    const seen: HarnessTranscriptTurn[][] = []
    const att = attachHarnessSession({
      gateway: h.gateway,
      sessionId: SID,
      onTranscript: (t) => seen.push(t),
      onLive: () => {},
      onError: (e) => errors.push((e as Error).message),
    })
    h.status('open')
    await flush()
    expect(errors).toHaveLength(1)
    expect(seen).toEqual([])

    h.failTranscript = undefined
    att.close()
    expect(h.calls.closed).toBe(1)
    // A late frame or a manual resync after close must not touch the store.
    att.resync()
    h.emit({ type: 'assistant-delta', sessionId: SID, text: 'ghost' })
    await flush()
    expect(seen).toEqual([])
  })

  it('clears the system-prompt-sent flag on turn error so the prompt can retry', async () => {
    const h = fakeGateway()
    const att = attachHarnessSession({
      gateway: h.gateway,
      sessionId: SID,
      onTranscript: () => {},
      onLive: () => {},
    })
    markSystemPromptSent(SID)
    h.emit({ type: 'error', sessionId: SID, code: 'turn_failed', message: 'driver died' })
    expect(wasSystemPromptSent(SID)).toBe(false)
    att.close()
  })
})
