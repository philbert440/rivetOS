// Store half of the harness binding: who owns a session's transcript, how a
// hard resync reconciles the optimistic send queue, and the approval slice.
// The connection store is mocked away — it touches window/localStorage at
// import time and none of this needs a real gateway.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  HarnessPromptEvent,
  HarnessStatusFrame,
  HarnessTranscriptEvent,
  HarnessTranscriptTurn,
  SessionId,
} from '@rivetos/types'

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
    agentStatus: {},
    prompts: {},
    liveSource: {},
    liveFloor: {},
    opened: [],
    drafts: [],
    draftCreatedAt: {},
    active: undefined,
  })
})

describe('draftCreatedAt', () => {
  it('addDraft stamps a creation time and removeDraft clears it', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000)
    useChat.getState().addDraft(KEY)
    expect(useChat.getState().draftCreatedAt[KEY]).toBe(1_700_000_000_000)
    useChat.getState().removeDraft(KEY)
    expect(useChat.getState().draftCreatedAt[KEY]).toBeUndefined()
    vi.restoreAllMocks()
  })

  it('does not restamp an existing draft', () => {
    const now = vi.spyOn(Date, 'now')
    // mockReturnValue (not …Once): a single set() now makes >1 Date.now call
    // (the lastActive/persist path), so the stamp must be pinned across all of
    // them — the test asserts the SECOND addDraft doesn't restamp, not a call
    // count.
    now.mockReturnValue(100)
    useChat.getState().addDraft(KEY)
    now.mockReturnValue(200)
    useChat.getState().addDraft(KEY)
    expect(useChat.getState().draftCreatedAt[KEY]).toBe(100)
    vi.restoreAllMocks()
  })
})

describe('bindHarness', () => {
  it('claims the session, opens it, and marks it store-backed', () => {
    useChat.getState().bindHarness(KEY, 'claude-code')
    const s = useChat.getState()
    expect(s.harnessBound[KEY]).toBe(true)
    expect(s.opened).toContain(KEY)
    // A non-empty `command` is what stops other writers appending solid turns.
    expect(s.transcripts[KEY]).toEqual({ rev: 0, turns: [], command: 'claude-code', offset: 0 })
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

  it('keeps a still-sending bubble even when the text matches (TUI twin)', () => {
    const chat = useChat.getState()
    chat.bindHarness(KEY, 'claude-code')
    const id = chat.enqueueOutbound(KEY, 'ship it')
    chat.markOutboundSending(KEY, id)

    chat.syncHarnessTranscript(KEY, [turn('user', 'ship it')])

    const s = useChat.getState()
    // The sending turn has not been observed as committed: the store row is
    // someone else's (typed in the TUI), so eating the bubble would lose it.
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

describe('transcript tail pin (truncatedBefore)', () => {
  const frame = (
    rev: number,
    texts: string[],
    extra: { truncatedBefore?: true; from?: number; total?: number } = {},
  ) => ({
    kind: 'transcript' as const,
    session: KEY,
    rev,
    from: extra.from ?? 0,
    turns: texts.map((text, i) => turn(i % 2 === 0 ? 'user' : 'assistant', text)),
    total: extra.total ?? texts.length,
    command: 'claude',
    ...(extra.truncatedBefore ? { truncatedBefore: true as const } : {}),
  })

  beforeEach(() => {
    socket.onFrame = undefined
    socket.sent = []
    useChat.getState().addDraft(KEY)
    useChat.getState().connect('gw')
  })

  it('pins earlier turns when a truncated from=0 snapshot would wipe them', () => {
    socket.onFrame?.(frame(1, ['a', 'b', 'c', 'd', 'e']))
    expect(useChat.getState().transcripts[KEY]?.turns.map((t) => t.text)).toEqual([
      'a',
      'b',
      'c',
      'd',
      'e',
    ])

    socket.onFrame?.(frame(2, ['c', 'd', 'e', 'f'], { truncatedBefore: true, total: 4 }))
    expect(useChat.getState().transcripts[KEY]?.turns.map((t) => t.text)).toEqual([
      'a',
      'b',
      'c',
      'd',
      'e',
      'f',
    ])
  })

  it('still replaces on a non-truncated from=0 snapshot', () => {
    socket.onFrame?.(frame(1, ['a', 'b', 'c']))
    socket.onFrame?.(frame(2, ['only-window']))
    expect(useChat.getState().transcripts[KEY]?.turns.map((t) => t.text)).toEqual(['only-window'])
  })

  it('applies from>0 deltas in client space after pinning (Kimi repro)', () => {
    // The bug: after WS reconnect on a >8MiB session, the server re-watches
    // the tail only. The client pins a longer array. The next from>0 delta
    // splices at a server-relative index and silently deletes mid-conversation
    // turns.
    //
    // Repro:
    // 1. snapshot [a b c d e f]
    socket.onFrame?.(frame(1, ['a', 'b', 'c', 'd', 'e', 'f']))
    expect(useChat.getState().transcripts[KEY]?.turns.map((t) => t.text)).toEqual([
      'a',
      'b',
      'c',
      'd',
      'e',
      'f',
    ])

    // 2. reconnect truncated [c d e f] — client pins [a b c d e f]
    socket.onFrame?.(frame(2, ['c', 'd', 'e', 'f'], { truncatedBefore: true, total: 4 }))
    expect(useChat.getState().transcripts[KEY]?.turns.map((t) => t.text)).toEqual([
      'a',
      'b',
      'c',
      'd',
      'e',
      'f',
    ])
    expect(useChat.getState().transcripts[KEY]?.offset).toBe(2)

    // 3. server appends g as {from:4, turns:[g], total:5}
    // Without the fix: client renders [a b c d g]; e and f vanish
    // With the fix: client renders [a b c d e f g]
    socket.onFrame?.(frame(3, ['g'], { from: 4, total: 5 }))
    expect(useChat.getState().transcripts[KEY]?.turns.map((t) => t.text)).toEqual([
      'a',
      'b',
      'c',
      'd',
      'e',
      'f',
      'g',
    ])
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
  it('shows an image placeholder while an image-only turn is sending', () => {
    const chat = useChat.getState()
    const id = chat.enqueueOutbound(KEY, '', [{ mime: 'image/png', pathOrUri: '/uploads/image.png' }])
    chat.markOutboundSending(KEY, id)
    expect(useChat.getState().messages[KEY]?.find((m) => m.id === id)?.text).toBe('[Image]')
    expect(useChat.getState().outbound[KEY]?.[0].attachments).toEqual([
      { mime: 'image/png', pathOrUri: '/uploads/image.png' },
    ])
  })

  it('does not put a queued turn in messages until sending', () => {
    const chat = useChat.getState()
    const id = chat.enqueueOutbound(KEY, 'next please')
    expect(useChat.getState().messages[KEY]?.some((m) => m.id === id) ?? false).toBe(false)
    expect(useChat.getState().outbound[KEY]?.[0].status).toBe('queued')

    chat.markOutboundSending(KEY, id)
    expect(useChat.getState().messages[KEY]?.some((m) => m.id === id)).toBe(true)
    expect(useChat.getState().outbound[KEY]?.[0].status).toBe('sending')
  })

  it('requeues a turn the driver rejected as turn_in_flight back into the strip', () => {
    const chat = useChat.getState()
    const id = chat.enqueueOutbound(KEY, 'next please')
    chat.markOutboundSending(KEY, id)
    expect(useChat.getState().outbound[KEY]?.[0].status).toBe('sending')

    chat.requeueOutbound(KEY, id)
    const s = useChat.getState()
    expect(s.outbound[KEY]?.[0].status).toBe('queued')
    expect(s.messages[KEY]?.some((m) => m.id === id)).toBe(false)
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
              {
                question: 'Which auth?',
                header: 'Auth',
                options: [{ label: 'JWT' }, { label: 'session' }],
              },
            ],
          },
        },
      ],
    })
    expect(useChat.getState().ask[KEY]).toBeUndefined()

    chat.setLive(KEY, undefined) // turn-complete
    expect(useChat.getState().ask[KEY]?.[0].options.map((o) => o.label)).toEqual(['JWT', 'session'])
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
  const streaming = (
    text: string,
  ): { text: string; reasoning: boolean; reasoningText: string; tools: [] } => ({
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

describe('canonical thread keys (§ Session identity mapping)', () => {
  const streaming = (
    text: string,
  ): { text: string; reasoning: boolean; reasoningText: string; tools: [] } => ({
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

  it('den-bridge frames keyed on the room fold onto the canonical thread', () => {
    // The bridge keys on the den room (the native id); the thread is open
    // under `<harness-id>:<native>`. Without the mapping the frame matches
    // nothing and the conversation goes dark.
    useChat.getState().setActive(SID)
    socket.onFrame?.({ kind: 'stream', session: KEY, event: { type: 'text', content: 'live' } })
    expect(useChat.getState().live[SID]?.text).toBe('live')
    expect(useChat.getState().live[KEY]).toBeUndefined()

    socket.onFrame?.({
      kind: 'message',
      id: 'm1',
      sessionId: KEY,
      role: 'assistant',
      text: 'committed',
      ts: 1,
    })
    expect(useChat.getState().messages[SID]?.map((m) => m.text)).toEqual(['committed'])
    expect(useChat.getState().messages[KEY]).toBeUndefined()
  })

  it('no double-render: a bound canonical thread still suppresses room-keyed frames', () => {
    // The regression the mapping exists to avoid — a canonical `harnessBound`
    // entry that a bare frame id never matches would fold every delta twice,
    // once from each socket.
    useChat.getState().bindHarness(SID, 'claude-code')
    socket.onFrame?.({ kind: 'stream', session: KEY, event: { type: 'text', content: 'ghost' } })
    socket.onFrame?.({
      kind: 'message',
      id: 'm1',
      sessionId: KEY,
      role: 'assistant',
      text: 'double',
      ts: 1,
    })
    expect(useChat.getState().live[SID]).toBeUndefined()
    expect(useChat.getState().live[KEY]).toBeUndefined()
    expect(useChat.getState().messages[SID] ?? []).toEqual([])
    expect(useChat.getState().messages[KEY]).toBeUndefined()
  })
})

describe('rekey', () => {
  it('moves a draft onto the canonical id the plane adopted it under', () => {
    const chat = useChat.getState()
    chat.addDraft(KEY)
    chat.setActive(KEY)
    chat.addOptimisticUser(KEY, 'first turn')
    chat.setLive(KEY, { text: 'streaming', reasoning: false, reasoningText: '', tools: [] })

    useChat.getState().rekey(KEY, SID)

    const s = useChat.getState()
    expect(s.active).toBe(SID)
    expect(s.opened).toEqual([SID])
    expect(s.drafts).toEqual([]) // adopted — no longer a local-only row
    expect(s.messages[SID]?.map((m) => m.text)).toEqual(['first turn'])
    expect(s.live[SID]?.text).toBe('streaming')
    expect(s.messages[KEY]).toBeUndefined()
    expect(s.live[KEY]).toBeUndefined()
  })

  it('releases the retired watch and leaves the new subscription to the view', () => {
    // The server refcounts per socket. `rekey` changes `active`, which
    // remounts `ActiveSession` under the new key, and THAT mount subscribes —
    // so rekey must not also watch `to`, or the pair would take two refs and
    // the single unmount would give back only one.
    socket.sent = []
    useChat.getState().connect('http://gateway.test|')
    socket.sent = []
    useChat.getState().setActive(KEY)
    useChat.getState().watchTranscript(KEY)
    useChat.getState().rekey(KEY, SID)
    expect(socket.sent).toEqual([
      { type: 'watch', session: KEY },
      { type: 'unwatch', session: KEY },
    ])

    // the remounted view subscribes under the new key — exactly once
    useChat.getState().watchTranscript(SID)
    useChat.getState().watchTranscript(SID) // StrictMode double-effect / re-render
    expect(socket.sent).toEqual([
      { type: 'watch', session: KEY },
      { type: 'unwatch', session: KEY },
      { type: 'watch', session: SID },
    ])

    // …and one unmount fully releases it (no dangling ref)
    useChat.getState().unwatchTranscript(SID)
    useChat.getState().unwatchTranscript(SID) // idempotent
    expect(socket.sent.filter((f) => (f as { type: string }).type === 'unwatch')).toEqual([
      { type: 'unwatch', session: KEY },
      { type: 'unwatch', session: SID },
    ])
  })

  it('releases the retired watch on the collision path too', () => {
    socket.sent = []
    useChat.getState().connect('http://gateway.test|')
    socket.sent = []
    const chat = useChat.getState()
    chat.seed(SID, [{ id: 'b', sessionId: SID, role: 'user', text: 'to', ts: 1 }])
    chat.watchTranscript(KEY)
    expect(useChat.getState().rekey(KEY, SID)).toBe(false) // records stayed put
    expect(socket.sent).toEqual([
      { type: 'watch', session: KEY },
      { type: 'unwatch', session: KEY },
    ])
  })

  it('is a no-op onto itself', () => {
    const chat = useChat.getState()
    chat.seed(KEY, [{ id: 'a', sessionId: KEY, role: 'user', text: 'from', ts: 1 }])
    chat.setActive(KEY)
    useChat.getState().rekey(KEY, KEY)
    expect(useChat.getState().messages[KEY]?.map((m) => m.text)).toEqual(['from'])
    expect(useChat.getState().active).toBe(KEY)
  })

  it('refuses to clobber a live destination but still moves the selection', () => {
    // The send path keys on the ACTIVE id, and the effect that calls rekey
    // does not re-fire — so leaving `active` on the retired key would queue
    // every subsequent turn under an id no drawer row carries.
    const chat = useChat.getState()
    chat.seed(KEY, [{ id: 'a', sessionId: KEY, role: 'user', text: 'from', ts: 1 }])
    chat.seed(SID, [{ id: 'b', sessionId: SID, role: 'user', text: 'to', ts: 1 }])
    chat.addDraft(KEY)
    chat.setActive(KEY)
    chat.setActive(SID)
    chat.setActive(KEY)

    useChat.getState().rekey(KEY, SID)

    const s = useChat.getState()
    // neither transcript was merged or overwritten
    expect(s.messages[KEY]?.map((m) => m.text)).toEqual(['from'])
    expect(s.messages[SID]?.map((m) => m.text)).toEqual(['to'])
    // …but the user (and the composer) are pointed at the surviving row
    expect(s.active).toBe(SID)
    expect(s.opened).toEqual([SID])
    expect(s.drafts).toEqual([])
  })
})

describe('adoptSessionKey (registry-driven identity changes)', () => {
  const OTHER_NATIVE = 'b2c3d4e5-2222-4333-8444-555566667777'
  const ROTATED = `claude-code:${OTHER_NATIVE}` as SessionId

  beforeEach(() => {
    socket.onFrame = undefined
    socket.onStatus = undefined
    socket.sent = []
    useChat.getState().connect('http://gateway.test|')
  })

  it('follows a ROTATION, which nothing derivable from the new id could find', () => {
    // `previousSessionId` shares no native half with its successor — this is
    // the whole reason the rotation path has to be driven by the registry
    // event rather than by matching drawer rows.
    const chat = useChat.getState()
    chat.addOptimisticUser(SID, 'mid-conversation')
    chat.setActive(SID)
    chat.watchTranscript(SID)
    socket.sent = []

    const moved = useChat.getState().adoptSessionKey(ROTATED, SID)

    expect(moved).toEqual([SID])
    const s = useChat.getState()
    expect(s.active).toBe(ROTATED)
    expect(s.opened).toEqual([ROTATED])
    expect(s.messages[ROTATED]?.map((m) => m.text)).toEqual(['mid-conversation'])
    expect(s.messages[SID]).toBeUndefined()
    expect(socket.sent).toEqual([{ type: 'unwatch', session: SID }])
  })

  it('adopts a NON-ACTIVE opened draft, not just the active thread', () => {
    // Otherwise both shapes sit in `opened`, and bridge frames keep folding
    // into records keyed by an id no drawer row renders.
    const chat = useChat.getState()
    chat.addDraft(KEY) // opened, but never selected
    chat.addOptimisticUser(KEY, 'background turn')
    chat.setActive(OTHER_NATIVE)

    const moved = useChat.getState().adoptSessionKey(SID)

    expect(moved).toEqual([KEY])
    const s = useChat.getState()
    expect(s.opened).toEqual([SID, OTHER_NATIVE])
    expect(s.active).toBe(OTHER_NATIVE) // untouched — it was not the adopted one
    expect(s.messages[SID]?.map((m) => m.text)).toEqual(['background turn'])
    expect(s.drafts).toEqual([])
  })

  it('never adopts another harness sharing the native half', () => {
    // The dual-store collision `ownerKey` ranks for, seen by the adoption
    // sweep. A `session-created` for claude is the plane claiming CLAUDE's
    // row — it says nothing about grok. Folding grok's live thread onto it
    // would move a transcript, an inject queue and the selection out from
    // under a conversation the user is sitting in, and migrate its name too.
    const grok = `grok-build:${KEY}` as SessionId
    const chat = useChat.getState()
    chat.setActive(grok)
    chat.addOptimisticUser(grok, 'grok turn')
    chat.setActive(SID)
    chat.addOptimisticUser(SID, 'claude turn')

    expect(useChat.getState().adoptSessionKey(SID)).toEqual([])

    const s = useChat.getState()
    expect(s.messages[grok]?.map((m) => m.text)).toEqual(['grok turn'])
    expect(s.messages[SID]?.map((m) => m.text)).toEqual(['claude turn'])
    expect(s.opened).toEqual([grok, SID])
    expect(s.active).toBe(SID)
  })

  it('still adopts the BARE twin while leaving a foreign canonical alone', () => {
    const grok = `grok-build:${KEY}` as SessionId
    const chat = useChat.getState()
    chat.setActive(grok)
    chat.addOptimisticUser(grok, 'grok turn')
    chat.addDraft(KEY) // the bare draft — the real adoption candidate
    chat.addOptimisticUser(KEY, 'draft turn')

    expect(useChat.getState().adoptSessionKey(SID)).toEqual([KEY])

    const s = useChat.getState()
    expect(s.messages[SID]?.map((m) => m.text)).toEqual(['draft turn'])
    expect(s.messages[grok]?.map((m) => m.text)).toEqual(['grok turn'])
    expect(s.opened).toEqual([grok, SID])
  })

  it('ignores an identity change for a thread this client never opened', () => {
    expect(useChat.getState().adoptSessionKey(SID, ROTATED)).toEqual([])
    expect(useChat.getState().opened).toEqual([])
    expect(useChat.getState().active).toBeUndefined()
  })
})

describe('ownerKey affinity', () => {
  beforeEach(() => {
    socket.onFrame = undefined
    socket.onStatus = undefined
    socket.sent = []
    useChat.getState().connect('http://gateway.test|')
  })

  const stream = (session: string, content: string): void => {
    socket.onFrame?.({ kind: 'stream', session, event: { type: 'text', content } })
  }

  it('prefers the active canonical thread over a stale bare twin', () => {
    // Mid-adoption `opened` briefly holds both shapes. "First in opened" would
    // hand the frame to the retired draft and leave the row the user is
    // actually looking at silent.
    const chat = useChat.getState()
    chat.addDraft(KEY) // bare, opened first
    chat.setActive(SID) // canonical, opened second and selected
    stream(KEY, 'live')
    expect(useChat.getState().live[SID]?.text).toBe('live')
    expect(useChat.getState().live[KEY]).toBeUndefined()
  })

  it('prefers canonical over bare even when neither is selected', () => {
    const chat = useChat.getState()
    chat.addDraft(KEY)
    chat.watchTranscript(SID) // opens SID without selecting it
    chat.setActive('unrelated-session')
    stream(KEY, 'live')
    expect(useChat.getState().live[SID]?.text).toBe('live')
    expect(useChat.getState().live[KEY]).toBeUndefined()
  })

  it('breaks a two-harness native collision on control-plane ownership', () => {
    // Two canonical threads can share a native id across stores; the one the
    // control plane owns is the one the den room belongs to.
    const grok = `grok-build:${KEY}` as SessionId
    const chat = useChat.getState()
    chat.setActive(SID) // claude first in `opened`, unbound
    chat.setActive('unrelated-session') // deselect so `active` cannot decide it
    chat.watchTranscript(grok)
    chat.bindHarness(grok, 'grok-build')
    stream(KEY, 'live')
    // Discriminating assertion: claude is FIRST in `opened` and unbound, so
    // an unranked "first match wins" would have folded 'live' onto it. Ranking
    // routes the frame to grok instead, where `harnessBound` suppresses it.
    expect(useChat.getState().live[SID]).toBeUndefined()
    expect(useChat.getState().live[grok]).toBeUndefined()
  })
})

describe('applyHarnessTranscriptEvent', () => {
  const ev = (
    extra: Partial<HarnessTranscriptEvent> &
      Pick<HarnessTranscriptEvent, 'rev' | 'from' | 'total' | 'turns'>,
  ): HarnessTranscriptEvent => ({
    type: 'transcript',
    sessionId: SID,
    command: 'claude',
    ...extra,
  })

  it('applies a snapshot and stamps liveSource + ctx', () => {
    useChat.getState().bindHarness(KEY, 'claude-code')
    const ok = useChat.getState().applyHarnessTranscriptEvent(
      KEY,
      ev({
        rev: 1,
        from: 0,
        total: 2,
        turns: [turn('user', 'hi'), turn('assistant', 'hello')],
        contextWindow: 200_000,
        compactAt: 160_000,
        contextSource: 'spawn',
      }),
    )
    expect(ok).toBe(true)
    const s = useChat.getState()
    expect(s.liveSource[KEY]).toBe('transcript')
    expect(s.transcripts[KEY]?.turns.map((t) => t.text)).toEqual(['hi', 'hello'])
    expect(s.transcripts[KEY]?.contextWindow).toBe(200_000)
    expect(s.messages[KEY]?.map((m) => m.text)).toEqual(['hi', 'hello'])
  })

  it('applies a delta and returns false on a rev gap', () => {
    useChat.getState().bindHarness(KEY, 'claude-code')
    expect(
      useChat.getState().applyHarnessTranscriptEvent(
        KEY,
        ev({
          rev: 1,
          from: 0,
          total: 1,
          turns: [turn('user', 'hi')],
        }),
      ),
    ).toBe(true)
    expect(
      useChat.getState().applyHarnessTranscriptEvent(
        KEY,
        ev({
          rev: 2,
          from: 1,
          total: 2,
          turns: [turn('assistant', 'yo')],
        }),
      ),
    ).toBe(true)
    expect(useChat.getState().transcripts[KEY]?.turns.map((t) => t.text)).toEqual(['hi', 'yo'])
    expect(
      useChat.getState().applyHarnessTranscriptEvent(
        KEY,
        ev({
          rev: 9,
          from: 4,
          total: 5,
          turns: [turn('assistant', 'gap')],
        }),
      ),
    ).toBe(false)
  })

  it('builds live from a trailing incomplete assistant while working', () => {
    useChat.getState().bindHarness(KEY, 'claude-code')
    const status: HarnessStatusFrame = {
      type: 'status',
      sessionId: SID,
      status: 'working',
      since: 1,
      phase: 'thinking',
    }
    useChat.getState().applyAgentStatus(KEY, status)
    useChat.getState().applyHarnessTranscriptEvent(
      KEY,
      ev({
        rev: 1,
        from: 0,
        total: 2,
        turns: [
          turn('user', 'hi'),
          { role: 'assistant', text: 'partial', thinking: 'plan' },
        ],
      }),
    )
    const s = useChat.getState()
    expect(s.live[KEY]?.text).toBe('partial')
    expect(s.live[KEY]?.reasoningText).toBe('plan')
    expect(s.messages[KEY]?.map((m) => m.text)).toEqual(['hi'])
    expect(s.liveIsBusy(KEY)).toBe(true)

    useChat.getState().applyAgentStatus(KEY, { ...status, status: 'idle', phase: undefined })
    const idle = useChat.getState()
    expect(idle.live[KEY]).toBeUndefined()
    expect(idle.messages[KEY]?.map((m) => m.text)).toEqual(['hi', 'partial'])
    expect(idle.liveIsBusy(KEY)).toBe(false)
  })
})

describe('applyPromptEvent', () => {
  const open: HarnessPromptEvent = {
    type: 'prompt',
    sessionId: SID,
    promptId: 'p1',
    kind: 'ask-user',
    toolName: 'AskUserQuestion',
    questions: [{ multiSelect: false, options: [{ label: 'A' }] }],
  }

  it('adds on open (deduped) and removes on resolved', () => {
    const chat = useChat.getState()
    chat.applyPromptEvent(KEY, open)
    chat.applyPromptEvent(KEY, open)
    expect(useChat.getState().prompts[KEY]).toHaveLength(1)
    chat.applyPromptEvent(KEY, { ...open, resolved: { at: 2 } })
    expect(useChat.getState().prompts[KEY]).toEqual([])
  })

  it('is idempotent by promptId even when the payload differs', () => {
    const chat = useChat.getState()
    chat.applyPromptEvent(KEY, open)
    chat.applyPromptEvent(KEY, {
      ...open,
      questions: [{ multiSelect: false, options: [{ label: 'B' }] }],
      screen: { current: 1, total: 3 },
    })
    expect(useChat.getState().prompts[KEY]).toEqual([open])
  })

  it('keeps two open promptIds and preserves screen', () => {
    const second: HarnessPromptEvent = {
      ...open,
      promptId: 'p2',
      screen: { current: 1, total: 3 },
    }
    const chat = useChat.getState()
    chat.applyPromptEvent(KEY, open)
    chat.applyPromptEvent(KEY, second)
    expect(useChat.getState().prompts[KEY]?.map((p) => p.promptId)).toEqual(['p1', 'p2'])
    expect(useChat.getState().prompts[KEY]?.[1]?.screen).toEqual({ current: 1, total: 3 })
  })

  it('clearHarnessPrompts drops prompts and approvals so a replay can refill', () => {
    const chat = useChat.getState()
    chat.applyPromptEvent(KEY, open)
    chat.applyApprovalEvent(KEY, {
      type: 'approval-request',
      sessionId: SID,
      requestId: 'r1',
      name: 'Bash',
      input: {},
    })
    chat.clearHarnessPrompts(KEY)
    expect(useChat.getState().prompts[KEY]).toBeUndefined()
    expect(useChat.getState().approvals[KEY]).toBeUndefined()
    chat.applyPromptEvent(KEY, open)
    expect(useChat.getState().prompts[KEY]).toEqual([open])
  })
})

describe('transcript-sourced setLive does not stash ask', () => {
  it('skips the tool-stack stash once liveSource is transcript', () => {
    useChat.getState().bindHarness(KEY, 'claude-code')
    useChat.getState().applyHarnessTranscriptEvent(KEY, {
      type: 'transcript',
      sessionId: SID,
      rev: 1,
      from: 0,
      total: 1,
      turns: [turn('user', 'hi')],
      command: 'claude',
    })
    useChat.getState().setLive(KEY, {
      text: '',
      reasoning: false,
      reasoningText: '',
      tools: [
        {
          id: 't1',
          name: 'AskUserQuestion',
          title: 'asked',
          status: 'done',
          args: { questions: [{ question: 'Which?', options: [{ label: 'JWT' }] }] },
        },
      ],
    })
    useChat.getState().setLive(KEY, undefined)
    expect(useChat.getState().ask[KEY]).toBeUndefined()
  })
})

describe('transcript live overlay — settled turns stay solid; bubbles survive status frames', () => {
  const ev = (
    extra: Partial<HarnessTranscriptEvent> &
      Pick<HarnessTranscriptEvent, 'rev' | 'from' | 'total' | 'turns'>,
  ): HarnessTranscriptEvent => ({ type: 'transcript', sessionId: SID, command: 'claude', ...extra })
  const status = (s: 'working' | 'idle', extra: Record<string, unknown> = {}): HarnessStatusFrame =>
    ({ type: 'status', sessionId: SID, since: 1, status: s, ...extra }) as HarnessStatusFrame
  const interrupted = { role: 'assistant' as const, text: 'half an ans', lastBlock: 'text' as const, stopReason: 'tool_use' }

  it('an interrupted (never complete) turn is NOT re-lived by the next turn\'s working frame', () => {
    useChat.getState().bindHarness(KEY, 'claude-code')
    useChat.getState().applyHarnessTranscriptEvent(KEY, ev({ rev: 1, from: 0, total: 2, turns: [{ role: 'user', text: 'go' }, interrupted] }))
    useChat.getState().applyAgentStatus(KEY, status('working'))
    expect(useChat.getState().live[KEY]?.text).toBe('half an ans') // genuinely in flight
    useChat.getState().applyAgentStatus(KEY, status('idle')) // interrupted → settled solid
    expect(useChat.getState().live[KEY]).toBeUndefined()
    useChat.getState().applyAgentStatus(KEY, status('working')) // inject: next turn starts, store unchanged
    expect(useChat.getState().live[KEY]).toBeUndefined()
    expect(useChat.getState().messages[KEY]?.some((m) => m.text === 'half an ans')).toBe(true)
    // the new turn's assistant reply IS live
    useChat.getState().applyHarnessTranscriptEvent(
      KEY,
      ev({ rev: 2, from: 2, total: 4, turns: [{ role: 'user', text: 'again' }, { role: 'assistant', text: 'new', lastBlock: 'text', stopReason: 'tool_use' }] }),
    )
    expect(useChat.getState().live[KEY]?.text).toBe('new')
  })

  it('a transcript frame that lands while the cached status is still idle does not settle the floor', () => {
    useChat.getState().bindHarness(KEY, 'claude-code')
    useChat.getState().applyHarnessTranscriptEvent(KEY, ev({ rev: 1, from: 0, total: 2, turns: [{ role: 'user', text: 'go' }, { role: 'assistant', text: 'done', complete: true }] }))
    useChat.getState().applyAgentStatus(KEY, status('idle')) // floor = 2
    // den emits the transcript BEFORE the status it derives from it: user line +
    // first assistant block coalesced into one frame, cache still says idle.
    useChat.getState().applyHarnessTranscriptEvent(
      KEY,
      ev({ rev: 2, from: 2, total: 4, turns: [{ role: 'user', text: 'again' }, { role: 'assistant', text: 'new', lastBlock: 'text', stopReason: 'tool_use' }] }),
    )
    useChat.getState().applyAgentStatus(KEY, status('working'))
    expect(useChat.getState().live[KEY]?.text).toBe('new')
  })

  it('a status frame does not retire a sent bubble whose text repeats an earlier turn', () => {
    useChat.getState().bindHarness(KEY, 'claude-code')
    useChat.getState().applyHarnessTranscriptEvent(KEY, ev({ rev: 1, from: 0, total: 2, turns: [{ role: 'user', text: 'yes' }, { role: 'assistant', text: 'ok', complete: true }] }))
    const id = useChat.getState().enqueueOutbound(KEY, 'yes')
    useChat.getState().markOutboundSending(KEY, id)
    useChat.getState().dequeueOutbound(KEY, id)
    useChat.getState().applyAgentStatus(KEY, status('working', { phase: 'thinking' }))
    expect(useChat.getState().messages[KEY]?.some((m) => m.id === id)).toBe(true)
  })
})
