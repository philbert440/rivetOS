// Store half of the harness binding: who owns a session's transcript, how a
// hard resync reconciles the optimistic send queue, and the approval slice.
// The connection store is mocked away — it touches window/localStorage at
// import time and none of this needs a real gateway.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { HarnessTranscriptTurn, SessionId } from '@rivetos/types'

/** Captured all-sessions socket — the store's only outside dependency. */
const socket = vi.hoisted(() => ({
  onFrame: undefined as ((frame: unknown) => void) | undefined,
  onStatus: undefined as ((status: 'connecting' | 'open' | 'closed') => void) | undefined,
  sent: [] as unknown[],
}))

vi.mock('./connection.js', () => ({
  isValidGatewayUrl: () => true,
  useConnection: {
    getState: () => ({
      baseUrl: 'http://gateway.test',
      token: undefined,
      gateway: {
        watchSessions: (
          onFrame: (frame: unknown) => void,
          _sessionId: string | undefined,
          opts: { onStatus?: (status: 'connecting' | 'open' | 'closed') => void },
        ) => {
          socket.onFrame = onFrame
          socket.onStatus = opts.onStatus
          return {
            close: () => undefined,
            send: (data: unknown) => {
              socket.sent.push(data)
              return true
            },
          }
        },
      },
    }),
  },
}))

const { useChat } = await import('./chat.js')

const KEY = 'a1b2c3d4-1111-4222-8333-444455556666'
const SID = `claude-code:${KEY}` as SessionId

const turn = (role: 'user' | 'assistant', text: string): HarnessTranscriptTurn => ({ role, text })

beforeEach(() => {
  useChat.setState({
    messages: {},
    transcripts: {},
    live: {},
    liveTs: {},
    ask: {},
    outbound: {},
    harnessBound: {},
    approvals: {},
    opened: [],
    drafts: [],
    active: undefined,
  })
})

describe('bindHarness', () => {
  it('claims the session, opens it, and marks it store-backed', () => {
    useChat.getState().bindHarness(KEY, 'claude-code')
    const s = useChat.getState()
    expect(s.harnessBound[KEY]).toBe(true)
    expect(s.opened).toContain(KEY)
    // A non-empty `command` is what stops other writers appending solid turns.
    expect(s.transcripts[KEY]).toEqual({ rev: 0, turns: [], command: 'claude-code' })
  })

  it('releases the session and its pending approvals on unbind', () => {
    useChat.getState().bindHarness(KEY, 'claude-code')
    useChat.getState().applyApprovalEvent(KEY, {
      type: 'approval-request',
      sessionId: SID,
      requestId: 'r1',
      name: 'Bash',
      input: {},
    })
    useChat.getState().unbindHarness(KEY)
    expect(useChat.getState().harnessBound[KEY]).toBeUndefined()
    expect(useChat.getState().approvals[KEY]).toBeUndefined()
  })
})

describe('syncHarnessTranscript', () => {
  it('replaces the transcript wholesale and supersedes matching bubbles', () => {
    const chat = useChat.getState()
    chat.bindHarness(KEY, 'claude-code')
    const optimId = chat.addOptimisticUser(KEY, 'ship it')

    chat.syncHarnessTranscript(KEY, [turn('user', 'ship it'), turn('assistant', 'shipped')])

    const s = useChat.getState()
    expect(s.messages[KEY]?.map((m) => m.text)).toEqual(['ship it', 'shipped'])
    expect(s.messages[KEY]?.some((m) => m.id === optimId)).toBe(false)
    expect(s.transcripts[KEY]?.turns).toHaveLength(2)
  })

  it('keeps a still-queued bubble even when the text matches (TUI twin)', () => {
    const chat = useChat.getState()
    chat.bindHarness(KEY, 'claude-code')
    const id = chat.enqueueOutbound(KEY, 'ship it')

    chat.syncHarnessTranscript(KEY, [turn('user', 'ship it')])

    const s = useChat.getState()
    // The queued turn has not been sent yet: the store row is someone else's
    // (typed in the TUI), so eating the bubble would lose the user's message.
    expect(s.messages[KEY]?.filter((m) => m.id === id)).toHaveLength(1)
    expect(s.outbound[KEY]).toHaveLength(1)
  })

  it('reconciles against the tail, not the whole history', () => {
    // "ok" said an hour ago must not retire the "ok" the user just sent: the
    // resync carries no changed-window, so it is derived from the prefix we
    // already hold.
    const chat = useChat.getState()
    chat.bindHarness(KEY, 'claude-code')
    chat.syncHarnessTranscript(KEY, [turn('user', 'ok'), turn('assistant', 'done')])
    const optimId = chat.addOptimisticUser(KEY, 'ok')

    // The harness commits an unrelated assistant turn.
    chat.syncHarnessTranscript(KEY, [
      turn('user', 'ok'),
      turn('assistant', 'done'),
      turn('assistant', 'and one more thing'),
    ])
    expect(useChat.getState().messages[KEY]?.some((m) => m.id === optimId)).toBe(true)

    // Once the user's turn actually commits at the tail, the bubble retires.
    chat.syncHarnessTranscript(KEY, [
      turn('user', 'ok'),
      turn('assistant', 'done'),
      turn('assistant', 'and one more thing'),
      turn('user', 'ok'),
    ])
    expect(useChat.getState().messages[KEY]?.some((m) => m.id === optimId)).toBe(false)
  })

  it('is idempotent — a repeated resync does not duplicate turns', () => {
    const chat = useChat.getState()
    chat.bindHarness(KEY, 'claude-code')
    const turns = [turn('user', 'a'), turn('assistant', 'b')]
    chat.syncHarnessTranscript(KEY, turns)
    chat.syncHarnessTranscript(KEY, turns)
    expect(useChat.getState().messages[KEY]).toHaveLength(2)
  })
})

describe('approvals slice', () => {
  it('queues requests oldest-first, dedupes, and retires on resolution', () => {
    const chat = useChat.getState()
    const request = (requestId: string): void =>
      chat.applyApprovalEvent(KEY, {
        type: 'approval-request',
        sessionId: SID,
        requestId,
        name: 'Bash',
        input: {},
      })
    request('r1')
    request('r2')
    request('r1') // a re-delivered request must not stack
    expect(useChat.getState().approvals[KEY]?.map((p) => p.requestId)).toEqual(['r1', 'r2'])

    chat.applyApprovalEvent(KEY, {
      type: 'approval-resolved',
      sessionId: SID,
      requestId: 'r1',
      decision: 'allow',
    })
    expect(useChat.getState().approvals[KEY]?.map((p) => p.requestId)).toEqual(['r2'])

    chat.clearApproval(KEY, 'r2')
    expect(useChat.getState().approvals[KEY]).toEqual([])
  })
})

describe('outbound queue', () => {
  it('requeues a turn the driver rejected as turn_in_flight, bubble intact', () => {
    const chat = useChat.getState()
    const id = chat.enqueueOutbound(KEY, 'next please')
    chat.markOutboundSending(KEY, id)
    expect(useChat.getState().outbound[KEY]?.[0].status).toBe('sending')

    chat.requeueOutbound(KEY, id)
    const s = useChat.getState()
    expect(s.outbound[KEY]?.[0].status).toBe('queued')
    expect(s.messages[KEY]?.some((m) => m.id === id)).toBe(true)
  })
})

describe('setLive', () => {
  it('replaces the live slot and stamps liveTs', () => {
    const chat = useChat.getState()
    chat.setLive(KEY, { text: 'streaming', reasoning: false, reasoningText: '', tools: [] })
    expect(useChat.getState().live[KEY]?.text).toBe('streaming')
    expect(useChat.getState().liveTs[KEY]).toBeGreaterThan(0)
    chat.setLive(KEY, undefined)
    expect(useChat.getState().live[KEY]).toBeUndefined()
  })

  it('stashes an AskUserQuestion so the card survives the turn ending', () => {
    // Headless ask tools don't block: the question outlives its turn as the
    // composer's ask card. Without the stash a control-plane session would
    // show the card mid-turn and lose it the instant the turn completed.
    const chat = useChat.getState()
    chat.setLive(KEY, {
      text: '',
      reasoning: false,
      reasoningText: '',
      tools: [
        {
          id: 't1',
          name: 'AskUserQuestion',
          title: 'asked',
          status: 'done',
          args: {
            questions: [
              { question: 'Which auth?', header: 'Auth', options: [{ label: 'JWT' }, { label: 'session' }] },
            ],
          },
        },
      ],
    })
    expect(useChat.getState().ask[KEY]).toBeUndefined()

    chat.setLive(KEY, undefined) // turn-complete
    expect(useChat.getState().ask[KEY]?.[0].options.map((o) => o.label)).toEqual([
      'JWT',
      'session',
    ])
  })

  it('retires the ask card once a user turn commits (answered in the TUI)', () => {
    const chat = useChat.getState()
    chat.bindHarness(KEY, 'claude-code')
    chat.setLive(KEY, {
      text: '',
      reasoning: false,
      reasoningText: '',
      tools: [
        {
          id: 't1',
          name: 'AskUserQuestion',
          title: 'asked',
          status: 'done',
          args: { questions: [{ question: 'Which auth?', options: [{ label: 'JWT' }] }] },
        },
      ],
    })
    chat.setLive(KEY, undefined)
    expect(useChat.getState().ask[KEY]).toBeDefined()

    chat.syncHarnessTranscript(KEY, [turn('assistant', 'which auth?'), turn('user', 'JWT')])
    expect(useChat.getState().ask[KEY]).toBeUndefined()
  })
})

describe('all-sessions socket ownership (the mutex)', () => {
  const OTHER = 'unbound-session'
  const streaming = (text: string): { text: string; reasoning: boolean; reasoningText: string; tools: [] } => ({
    text,
    reasoning: false,
    reasoningText: '',
    tools: [],
  })

  beforeEach(() => {
    socket.onFrame = undefined
    socket.onStatus = undefined
    socket.sent = []
    useChat.getState().connect('http://gateway.test|')
  })

  it('ignores stream and message frames for a bound session', () => {
    const chat = useChat.getState()
    chat.bindHarness(KEY, 'claude-code')
    chat.setActive(OTHER) // opens the unbound one too

    socket.onFrame?.({ kind: 'stream', session: KEY, event: { type: 'text', content: 'ghost' } })
    socket.onFrame?.({
      kind: 'message',
      id: 'm1',
      sessionId: KEY,
      role: 'assistant',
      text: 'double',
      ts: 1,
    })
    expect(useChat.getState().live[KEY]).toBeUndefined()
    expect(useChat.getState().messages[KEY]).toBeUndefined()

    // …while an unbound session on the same socket still folds normally.
    socket.onFrame?.({ kind: 'stream', session: OTHER, event: { type: 'text', content: 'real' } })
    expect(useChat.getState().live[OTHER]?.text).toBe('real')
  })

  it('a reconnect keeps a bound session live turn and clears everyone else', () => {
    // The all-sessions socket is not the bound session's owner: its reconnect
    // must not blank a bubble that is mid-stream on the control-plane socket
    // (which never dropped), nor hand the queue pump a false idle mid-turn.
    const chat = useChat.getState()
    chat.bindHarness(KEY, 'claude-code')
    chat.setLive(KEY, streaming('streaming'))
    chat.setLive(OTHER, streaming('bridge turn'))

    socket.onStatus?.('open')

    expect(useChat.getState().live[KEY]?.text).toBe('streaming')
    expect(useChat.getState().live[OTHER]).toBeUndefined()
    expect(useChat.getState().wsStatus).toBe('open')
  })
})
