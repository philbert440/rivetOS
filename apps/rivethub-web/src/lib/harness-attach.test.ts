import { describe, it, expect, vi } from 'vitest'
import type {
  HarnessEvent,
  HarnessPromptEvent,
  HarnessStatusFrame,
  HarnessTranscriptEvent,
  HarnessTranscriptTurn,
  SessionId,
} from '@rivetos/types'
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
  sent: unknown[]
  turns: HarnessTranscriptTurn[]
  failTranscript?: Error
}

function fakeGateway(): Harness {
  const h: Harness = {
    transcripts: [],
    calls: { transcript: [], closed: 0 },
    sent: [],
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
          send: (data: unknown) => {
            h.sent.push(data)
            return true
          },
        }
      },
    },
  }
  return h
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

const snapshot = (
  extra: Partial<HarnessTranscriptEvent> = {},
): HarnessTranscriptEvent => ({
  type: 'transcript',
  sessionId: SID,
  rev: 1,
  from: 0,
  total: 1,
  turns: [{ role: 'user', text: 'hi' }],
  command: 'claude',
  ...extra,
})

describe('attachHarnessSession', () => {
  it('hard-resyncs the transcript on the FIRST open, not on subscribe', async () => {
    const h = fakeGateway()
    const seen: HarnessTranscriptTurn[][] = []
    const att = attachHarnessSession({
      gateway: h.gateway,
      sessionId: SID,
      onResync: (turns) => seen.push(turns),
      onLive: () => {},
    })
    expect(h.calls.transcript).toEqual([])
    h.status('open')
    await flush()
    expect(h.calls.transcript).toEqual([SID])
    expect(seen).toEqual([[{ role: 'user', text: 'hi' }]])
    att.close()
  })

  it('re-resyncs on every reconnect and does not drop live on open', async () => {
    const h = fakeGateway()
    const live: (LiveTurn | undefined)[] = []
    const att = attachHarnessSession({
      gateway: h.gateway,
      sessionId: SID,
      onResync: () => {},
      onLive: (t) => live.push(t),
    })
    h.status('open')
    await flush()
    h.emit({ type: 'assistant-delta', sessionId: SID, text: 'half a rep' })
    expect(live.at(-1)?.text).toBe('half a rep')

    h.status('closed')
    h.status('open')
    await flush()
    expect(live.at(-1)?.text).toBe('half a rep')
    expect(h.calls.transcript).toEqual([SID, SID])
    att.close()
  })

  it('does not HTTP-resync after turn-complete', async () => {
    vi.useFakeTimers()
    try {
      const h = fakeGateway()
      const idle: number[] = []
      const att = attachHarnessSession({
        gateway: h.gateway,
        sessionId: SID,
        onResync: () => {},
        onLive: () => {},
        onTurnComplete: () => idle.push(1),
      })
      h.status('open')
      await vi.advanceTimersByTimeAsync(1)
      expect(h.calls.transcript).toHaveLength(1)
      h.emit({ type: 'turn-complete', sessionId: SID, stopReason: 'end-turn' })
      await vi.advanceTimersByTimeAsync(1_000)
      expect(h.calls.transcript).toHaveLength(1)
      expect(idle).toEqual([1])
      att.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it('sends sync when onTranscript returns false (rev gap)', async () => {
    const h = fakeGateway()
    const att = attachHarnessSession({
      gateway: h.gateway,
      sessionId: SID,
      onResync: () => {},
      onLive: () => {},
      onTranscript: () => false,
    })
    h.status('open')
    await flush()
    h.emit(snapshot({ from: 3, rev: 9, total: 4, turns: [{ role: 'assistant', text: 'gap' }] }))
    expect(h.sent).toEqual([{ type: 'sync' }])
    att.close()
  })

  it('snapshot clears a stale live turn', async () => {
    const h = fakeGateway()
    const live: (LiveTurn | undefined)[] = []
    const att = attachHarnessSession({
      gateway: h.gateway,
      sessionId: SID,
      onResync: () => {},
      onLive: (t) => live.push(t),
      onTranscript: () => true,
    })
    h.status('open')
    await flush()
    h.emit({ type: 'assistant-delta', sessionId: SID, text: 'stale' })
    expect(live.at(-1)?.text).toBe('stale')
    h.emit(snapshot())
    expect(live.at(-1)).toBeUndefined()
    att.close()
  })

  it('routes status and prompt to their sinks', async () => {
    const h = fakeGateway()
    const statuses: HarnessStatusFrame[] = []
    const prompts: HarnessPromptEvent[] = []
    const att = attachHarnessSession({
      gateway: h.gateway,
      sessionId: SID,
      onResync: () => {},
      onLive: () => {},
      onAgentStatus: (e) => statuses.push(e),
      onPrompt: (e) => prompts.push(e),
    })
    h.status('open')
    await flush()
    const status: HarnessStatusFrame = {
      type: 'status',
      sessionId: SID,
      status: 'working',
      since: 1,
      phase: 'thinking',
    }
    const prompt: HarnessPromptEvent = {
      type: 'prompt',
      sessionId: SID,
      promptId: 'p1',
      kind: 'ask-user',
      toolName: 'AskUserQuestion',
      questions: [{ multiSelect: false, options: [{ label: 'A' }] }],
    }
    h.emit(status)
    h.emit(prompt)
    expect(statuses).toEqual([status])
    expect(prompts).toEqual([prompt])
    att.close()
  })

  it('ignores hook deltas once a live-turn transcript frame arrived, still folds for a text-only store', async () => {
    const h = fakeGateway()
    const live: (LiveTurn | undefined)[] = []
    let source: 'transcript' | 'hooks' | undefined
    const att = attachHarnessSession({
      gateway: h.gateway,
      sessionId: SID,
      onResync: () => {},
      onLive: (t) => live.push(t),
      onTranscript: (ev) => {
        source = ev.command === 'claude' || ev.command === 'kimi' ? 'transcript' : 'hooks'
        return true
      },
      liveSource: () => source,
    })
    h.status('open')
    await flush()
    h.emit(snapshot({ command: 'dsh' }))
    live.length = 0
    h.emit({ type: 'assistant-delta', sessionId: SID, text: 'folded' })
    expect(live.at(-1)?.text).toBe('folded')

    h.emit(snapshot({ command: 'claude', rev: 2 }))
    live.length = 0
    h.emit({ type: 'assistant-delta', sessionId: SID, text: 'ignored' })
    expect(live).toEqual([])
    att.close()
  })

  it('routes approvals out of the fold and never into the live turn', async () => {
    const h = fakeGateway()
    const approvals: string[] = []
    const live: (LiveTurn | undefined)[] = []
    const att = attachHarnessSession({
      gateway: h.gateway,
      sessionId: SID,
      onResync: () => {},
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
    expect(live).toEqual([])
    att.close()
  })

  it('does not clear the live slot on open', async () => {
    const h = fakeGateway()
    const live: (LiveTurn | undefined)[] = []
    const att = attachHarnessSession({
      gateway: h.gateway,
      sessionId: SID,
      onResync: () => {},
      onLive: (t) => live.push(t),
    })
    h.status('open')
    await flush()
    expect(live).toEqual([])
    att.close()
  })

  it('stops for good on a terminal attach error instead of reconnect-looping', async () => {
    const h = fakeGateway()
    const fatal: string[] = []
    attachHarnessSession({
      gateway: h.gateway,
      sessionId: SID,
      onResync: () => {},
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
    expect(h.calls.closed).toBe(1)
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
      onResync: () => {},
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
      onResync: () => {},
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
      onResync: (t) => seen.push(t),
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
      onResync: () => {},
      onLive: () => {},
    })
    markSystemPromptSent(SID)
    h.emit({ type: 'error', sessionId: SID, code: 'turn_failed', message: 'driver died' })
    expect(wasSystemPromptSent(SID)).toBe(false)
    att.close()
  })
})

describe('sync re-arm', () => {
  it('re-sends {type:sync} once after the re-arm wait when no snapshot followed (den throttles syncs)', async () => {
    vi.useFakeTimers()
    try {
      const h = fakeGateway()
      attachHarnessSession({
        gateway: h.gateway,
        sessionId: SID,
        onResync: () => {},
        onLive: () => {},
        onTranscript: () => false, // rev gap every time
      })
      h.emit(snapshot({ from: 3, rev: 9, total: 4, turns: [{ role: 'user', text: 'x' }] }))
      expect(h.sent.filter((d) => (d as { type?: string }).type === 'sync')).toHaveLength(1)
      await vi.advanceTimersByTimeAsync(3_100)
      expect(h.sent.filter((d) => (d as { type?: string }).type === 'sync')).toHaveLength(2)
    } finally {
      vi.useRealTimers()
    }
  })
})
