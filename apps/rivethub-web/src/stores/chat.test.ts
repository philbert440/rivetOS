// Instant-resume pointer (lastActive): the reducer writes/moves/drops it,
// the lastActiveFor selector node-matches it, and the persist middleware
// round-trips it. Connection store mocked away (it touches
// window/localStorage at import time); localStorage stubbed for persist.

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  createOutboundPumpRegistry,
  INJECT_LATCH_MS,
  type OutboundPumpStore,
} from '../lib/outbound-pump.js'

const BASE = 'http://gateway.test'

// createJSONStorage(() => localStorage) runs at store-module evaluation.
// Stub before that import (vi.hoisted runs before ESM imports).
vi.hoisted(() => {
  const m = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    get length() {
      return m.size
    },
    clear: () => m.clear(),
    getItem: (k: string) => m.get(k) ?? null,
    key: (i: number) => [...m.keys()][i] ?? null,
    removeItem: (k: string) => void m.delete(k),
    setItem: (k: string, v: string) => void m.set(k, String(v)),
  } satisfies Storage)
})

vi.mock('./connection.js', () => ({
  isValidGatewayUrl: () => true,
  useConnection: {
    getState: () => ({
      baseUrl: BASE,
      gateway: {
        watchSessions: () => ({ close: () => undefined, send: () => true }),
      },
    }),
  },
}))

afterAll(() => vi.unstubAllGlobals())

const { useChat, lastActiveFor } = await import('./chat.js')
const { outboundPumpFor } = await import('../lib/chat-outbound.js')
afterEach(() => {
  for (const key of useChat.getState().opened) useChat.getState().removeDraft(key)
})

beforeEach(() => {
  useChat.setState({
    messages: {},
    transcripts: {},
    live: {},
    liveTs: {},
    ask: {},
    outbound: {},
    sessionAliases: {},
    harnessBound: {},
    approvals: {},
    agentStatus: {},
    prompts: {},
    liveSource: {},
    opened: [],
    drafts: [],
    draftCreatedAt: {},
    active: undefined,
    lastActive: undefined,
  })
  localStorage.removeItem('rivethub.chat')
})

describe('lastActive reducer', () => {
  it('setActive writes the resume pointer (key + node) and persists it', () => {
    useChat.getState().setActive('claude-code:abc')
    expect(useChat.getState().lastActive).toEqual({ sessionId: 'claude-code:abc', baseUrl: BASE })
    const raw = localStorage.getItem('rivethub.chat')
    expect(raw).toBeTruthy()
    const parsed = JSON.parse(raw ?? '') as {
      state: Record<string, unknown>
      version: number
    }
    expect(parsed.state.lastActive).toEqual({ sessionId: 'claude-code:abc', baseUrl: BASE })
    expect(parsed.version).toBe(1)
    // Only the pointer persists — live socket state never does.
    expect(parsed.state.messages).toBeUndefined()
    expect(parsed.state.active).toBeUndefined()
    expect(parsed.state.opened).toBeUndefined()
  })

  it('deselecting keeps the pointer (it is for resume, not selection)', () => {
    useChat.getState().setActive('claude-code:abc')
    useChat.getState().setActive(undefined)
    expect(useChat.getState().active).toBeUndefined()
    expect(useChat.getState().lastActive?.sessionId).toBe('claude-code:abc')
  })

  it('rekey moves the pointer onto the new key', () => {
    useChat.getState().setActive('bare-uuid')
    useChat.getState().rekey('bare-uuid', 'claude-code:bare-uuid')
    expect(useChat.getState().lastActive?.sessionId).toBe('claude-code:bare-uuid')
  })

  it('rekey of an unrelated key leaves the pointer alone', () => {
    useChat.getState().setActive('claude-code:abc')
    useChat.getState().rekey('someone-else', 'claude-code:someone-else')
    expect(useChat.getState().lastActive?.sessionId).toBe('claude-code:abc')
  })

  it('removeDraft drops a pointer at the discarded draft', () => {
    useChat.getState().addDraft('draft-1')
    useChat.getState().setActive('draft-1')
    expect(useChat.getState().lastActive?.sessionId).toBe('draft-1')
    useChat.getState().removeDraft('draft-1')
    expect(useChat.getState().lastActive).toBeUndefined()
  })

  it('clearLastActive forgets the pointer (stale resume fallback)', () => {
    useChat.getState().setActive('claude-code:abc')
    useChat.getState().clearLastActive()
    expect(useChat.getState().lastActive).toBeUndefined()
    const parsed = JSON.parse(localStorage.getItem('rivethub.chat') ?? '') as {
      state: Record<string, unknown>
    }
    expect(parsed.state.lastActive).toBeUndefined()
  })

  it('persists across a rehydrate (reload resumes the same session)', async () => {
    useChat.getState().setActive('claude-code:abc')
    const raw = localStorage.getItem('rivethub.chat')
    // Simulate a fresh reload: only the persisted slice (lastActive) is on
    // disk; the in-memory store starts blank (active undefined, lastActive
    // undefined) before rehydrate restores the pointer.
    useChat.setState({ lastActive: undefined, active: undefined })
    localStorage.setItem('rivethub.chat', raw ?? '')
    await useChat.persist.rehydrate()
    expect(useChat.getState().lastActive).toEqual({ sessionId: 'claude-code:abc', baseUrl: BASE })
    // The selection itself is NOT restored — resolving it is the launch
    // effect's job (the row may be gone after a reload).
    expect(useChat.getState().active).toBeUndefined()
  })
})

describe('lastActiveFor', () => {
  it('returns the key only for the node it was written on', () => {
    const pointer = { sessionId: 'claude-code:abc', baseUrl: BASE }
    expect(lastActiveFor(pointer, BASE)).toBe('claude-code:abc')
    expect(lastActiveFor(pointer, 'http://other.test')).toBeUndefined()
    expect(lastActiveFor(undefined, BASE)).toBeUndefined()
  })
})

// Real store + production pump registry: the inject pauses exactly where
// ensurePty permits adoption/rotation before the HTTP send has settled.
describe('outbound sends across rekey', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  const to = 'claude-code:draft'
  const turnInFlight = new Error('turn_in_flight')
  const state = () => useChat.getState()
  const store: OutboundPumpStore = {
    resolveSessionKey: (sid) => state().resolveSessionKey(sid),
    queue: (sid) => state().outbound[sid],
    liveIsBusy: (sid) => state().liveIsBusy(sid),
    markSending: (sid, id) => state().markOutboundSending(sid, id),
    dequeue: (sid, id) => state().dequeueOutbound(sid, id),
    requeue: (sid, id) => state().requeueOutbound(sid, id),
    fail: (sid, id) => state().failOutbound(sid, id),
    beginLive: (sid, activity) => state().beginLive(sid, activity),
    clearLive: (sid) => state().clearLive(sid),
    awaitBusy: (_sid, ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  }

  function setup(
    from = 'draft',
    registry = createOutboundPumpRegistry(store, (err) => err === turnInFlight),
  ) {
    state().addDraft(from)
    state().setActive(from)
    const id = state().enqueueOutbound(from, 'first')
    let resolve!: () => void
    let reject!: (err: Error) => void
    const inject = vi.fn(
      () =>
        new Promise<void>((res, rej) => {
          resolve = res
          reject = rej
        }),
    )
    const entry = registry(from)
    entry.sink.current = inject
    const pending = entry.pump.pump()
    return { id, resolve, reject, inject, registry, entry, pending }
  }

  it('uses the module registry across chained moves and destination remounts', async () => {
    const t = setup('A', outboundPumpFor)
    state().rekey('A', 'B')
    state().rekey('B', 'C')
    const destination = outboundPumpFor('C')
    expect(destination).toBe(t.entry)
    const next = vi.fn((_text: string) => Promise.resolve())
    destination.sink.current = next
    await destination.pump.pump()
    expect(next).not.toHaveBeenCalled()
    t.resolve()
    await vi.advanceTimersByTimeAsync(INJECT_LATCH_MS)
    await t.pending
    expect(state().outbound.C).toEqual([])
    expect(state().outbound.A).toBeUndefined()
    expect(state().outbound.B).toBeUndefined()
  })

  it('keeps a running module pump routed after its oldest alias is capped', async () => {
    const t = setup('key-0', outboundPumpFor)
    for (let i = 0; i < 300; i++) state().rekey(`key-${i}`, `key-${i + 1}`)
    expect(state().sessionAliases['key-0']).toBeUndefined()
    expect(outboundPumpFor('key-300')).toBe(t.entry)
    t.resolve()
    await vi.advanceTimersByTimeAsync(INJECT_LATCH_MS)
    await t.pending
    expect(state().outbound['key-300']).toEqual([])
    expect(state().live['key-300']).toBeUndefined()
    expect(state().outbound['key-0']).toBeUndefined()
  })

  it.each(['resolve', 'reject'] as const)(
    'discards a moved thread mid-send before %s',
    async (outcome) => {
      const t = setup('A', outboundPumpFor)
      state().rekey('A', 'B')
      state().removeDraft('B')
      expect(state().sessionAliases).toEqual({})
      if (outcome === 'resolve') t.resolve()
      else t.reject(new Error('offline'))
      await t.pending
      expect(state().outbound).toEqual({})
      expect(state().messages).toEqual({})
      expect(state().live).toEqual({})
      state().addDraft('B')
      expect(outboundPumpFor('B')).not.toBe(t.entry)
      state().removeDraft('B')
      state().addDraft('A')
      expect(outboundPumpFor('A')).not.toBe(t.entry)
    },
  )

  it('clears aliases and the pending module pump when a thread is cleared', async () => {
    const t = setup('A', outboundPumpFor)
    state().rekey('A', 'B')
    state().replace('B', [])
    expect(state().sessionAliases).toEqual({})
    expect(outboundPumpFor('B')).not.toBe(t.entry)
    t.resolve()
    await t.pending
    expect(state().outbound.A).toBeUndefined()
    expect(state().messages.A).toBeUndefined()
  })

  it('retries a retained failure after a later queued turn has drained', async () => {
    const t = setup()
    state().enqueueOutbound('draft', 'second')
    state().rekey('draft', to)
    const next = vi.fn((_text: string) => Promise.resolve())
    t.registry(to).sink.current = next
    const failed = expect(t.pending).rejects.toThrow('offline')
    t.reject(new Error('offline'))
    await failed
    await vi.advanceTimersByTimeAsync(INJECT_LATCH_MS)
    expect(next).toHaveBeenCalledExactlyOnceWith('second', false, undefined)
    expect(state().outbound[to]).toEqual([{ id: t.id, text: 'first', status: 'failed' }])
    const retry = t.registry(to).pump.pump({ forceId: t.id })
    await vi.advanceTimersByTimeAsync(INJECT_LATCH_MS)
    await retry
    expect(next.mock.calls.map((call) => call[0])).toEqual(['second', 'first'])
  })

  it('keeps a failing source send separate from a live destination collision', async () => {
    const t = setup()
    state().addOptimisticUser(to, 'existing', 'existing')
    const destinationMessages = state().messages[to]
    expect(state().rekey('draft', to)).toBe(false)
    const failed = expect(t.pending).rejects.toThrow('offline')
    t.reject(new Error('offline'))
    await failed
    expect(state().outbound.draft?.[0].status).toBe('failed')
    expect(state().messages[to]).toBe(destinationMessages)
    expect(state().outbound[to]).toBeUndefined()
  })

  it.each(['draft', 'claude-code:previous-native'])(
    'settles a successful send after adoption/rotation from %s',
    async (from) => {
      const t = setup(from)
      expect(state().adoptSessionKey(to, from === 'draft' ? undefined : from)).toEqual([from])
      expect(state().outbound[to]).toEqual([{ id: t.id, text: 'first', status: 'sending' }])
      expect(state().live[to]?.activity).toBe('working…')
      expect(t.registry(to)).toBe(t.entry)
      t.resolve()
      await vi.advanceTimersByTimeAsync(INJECT_LATCH_MS)
      await t.pending
      expect(state().outbound[to]).toEqual([])
      expect(state().outbound[from]).toBeUndefined()
      expect(state().messages[from]).toBeUndefined()
      expect(state().live[from]).toBeUndefined()
      expect(state().live[to]).toBeUndefined()
      expect(state().messages[to]?.map((m) => m.id)).toEqual([t.id])
    },
  )

  it('keeps a rejected send visibly failed and retries through the destination sink', async () => {
    const t = setup()
    state().adoptSessionKey(to)
    const result = expect(t.pending).rejects.toThrow('offline')
    t.reject(new Error('offline'))
    await result
    expect(state().outbound[to]?.[0]).toMatchObject({ id: t.id, status: 'failed' })
    expect(state().messages[to]?.map((m) => m.id)).toEqual([t.id])
    expect(state().live[to]).toBeUndefined()
    expect(state().outbound.draft).toBeUndefined()
    const retry = vi.fn(() => Promise.resolve())
    const adopted = t.registry(to)
    adopted.sink.current = retry
    const pending = adopted.pump.pump({ forceId: t.id })
    expect(state().outbound[to]?.[0].status).toBe('sending')
    await vi.advanceTimersByTimeAsync(INJECT_LATCH_MS)
    await pending
    expect(retry).toHaveBeenCalledWith('first', false, undefined)
    expect(state().outbound[to]).toEqual([])
    expect(state().messages[to]?.map((m) => m.id)).toEqual([t.id])
  })

  it('requeues turn_in_flight and retries on the destination idle edge', async () => {
    const t = setup()
    state().adoptSessionKey(to)
    t.reject(turnInFlight)
    await t.pending
    expect(state().outbound[to]?.[0]).toMatchObject({ id: t.id, status: 'queued' })
    expect(state().messages[to]).toEqual([])
    expect(state().live[to]).toBeUndefined()
    expect(state().outbound.draft).toBeUndefined()
    const retry = vi.fn(() => Promise.resolve())
    t.registry(to).sink.current = retry
    await vi.advanceTimersByTimeAsync(60_000)
    expect(retry).not.toHaveBeenCalled()
    t.registry(to).pump.onIdle()
    await vi.advanceTimersByTimeAsync(INJECT_LATCH_MS)
    expect(retry).toHaveBeenCalledOnce()
    expect(state().outbound[to]).toEqual([])
  })

  it('holds the second quick send through rekey and the first send latch', async () => {
    const t = setup()
    const second = state().enqueueOutbound('draft', 'second')
    state().adoptSessionKey(to)
    const next = vi.fn((_text: string) => Promise.resolve())
    t.registry(to).sink.current = next
    await t.registry(to).pump.pump()
    expect(next).not.toHaveBeenCalled()
    expect(state().outbound[to]?.map((o) => o.status)).toEqual(['sending', 'queued'])
    t.resolve()
    await vi.advanceTimersByTimeAsync(1)
    await t.registry(to).pump.pump()
    expect(next).not.toHaveBeenCalled()
    expect(state().outbound[to]?.map((o) => o.id)).toEqual([second])
    await vi.advanceTimersByTimeAsync(2 * INJECT_LATCH_MS)
    await t.pending
    expect(t.inject).toHaveBeenCalledOnce()
    expect(next).toHaveBeenCalledExactlyOnceWith('second', false, undefined)
    expect(state().outbound[to]).toEqual([])
  })

  it('follows another rotation during the post-inject live latch', async () => {
    const t = setup()
    state().adoptSessionKey(to)
    t.resolve()
    await vi.advanceTimersByTimeAsync(1)
    state().adoptSessionKey('claude-code:rotated', to)
    expect(t.registry('claude-code:rotated')).toBe(t.entry)
    await vi.advanceTimersByTimeAsync(INJECT_LATCH_MS)
    await t.pending
    expect(state().live['claude-code:rotated']).toBeUndefined()
    expect(Object.hasOwn(state().live, 'draft')).toBe(false)
    expect(Object.hasOwn(state().live, to)).toBe(false)
  })

  it('preserves the collision rule and settles only the unmoved source records', async () => {
    const t = setup()
    state().addOptimisticUser(to, 'existing', 'existing')
    const existing = state().enqueueOutbound(to, 'destination queued')
    const destinationMessages = state().messages[to]
    expect(state().rekey('draft', to)).toBe(false)
    expect(state().active).toBe(to)
    expect(state().resolveSessionKey('draft')).toBe('draft')
    expect(t.registry(to)).not.toBe(t.entry)
    expect(state().outbound.draft?.[0].status).toBe('sending')
    t.resolve()
    await vi.advanceTimersByTimeAsync(INJECT_LATCH_MS)
    await t.pending
    expect(state().outbound.draft).toEqual([])
    expect(state().messages[to]).toBe(destinationMessages)
    expect(state().outbound[to]?.map((o) => o.id)).toEqual([existing])
  })
})

describe('session alias lifetime', () => {
  const state = () => useChat.getState()

  it.each(['dequeueOutbound', 'requeueOutbound', 'failOutbound', 'cancelOutbound'] as const)(
    '%s resolves a retired key, then the thread can move back',
    (settle) => {
      state().addDraft('A')
      state().setActive('A')
      const first = state().enqueueOutbound('A', 'first')
      const second = state().enqueueOutbound('A', 'still in flight')
      state().markOutboundSending('A', first)
      state().rekey('A', 'B')
      state()[settle]('A', first)
      expect(Object.hasOwn(state().outbound, 'A')).toBe(false)
      expect(Object.hasOwn(state().messages, 'A')).toBe(false)
      state().markOutboundSending('B', second)
      // Older reducers/resyncs may have left empty destination records.
      useChat.setState({
        messages: { ...state().messages, A: [] },
        transcripts: { A: { rev: 0, turns: [], command: '', offset: 0 } },
        outbound: { ...state().outbound, A: [] },
      })
      expect(state().rekey('B', 'A')).toBe(true)
      expect(state().active).toBe('A')
      expect(state().outbound.A?.find((o) => o.id === second)?.status).toBe('sending')
      expect(state().sessionAliases).toEqual({ B: 'A' })
      expect(Object.hasOwn(state().messages, 'B')).toBe(false)
      expect(Object.hasOwn(state().outbound, 'B')).toBe(false)
    },
  )

  it('settles on C through a chain and flattens every predecessor on a move', () => {
    state().addDraft('A')
    const id = state().enqueueOutbound('A', 'first')
    state().markOutboundSending('A', id)
    state().rekey('A', 'B')
    state().rekey('B', 'C')
    expect(state().sessionAliases).toEqual({ A: 'C', B: 'C' })
    state().failOutbound('A', id)
    expect(state().outbound.C?.[0].status).toBe('failed')
    expect(state().outbound.A).toBeUndefined()
    // Defensive resolver must handle a non-flattened map too.
    useChat.setState({ sessionAliases: { A: 'B', B: 'C' } })
    expect(state().resolveSessionKey('A')).toBe('C')
    state().rekey('C', 'D')
    expect(state().sessionAliases).toEqual({ A: 'D', B: 'D', C: 'D' })
  })

  it('stops at the last non-repeating key and logs a cycle only once', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      useChat.setState({ sessionAliases: { A: 'B', B: 'A' } })
      expect(state().resolveSessionKey('A')).toBe('B')
      expect(state().resolveSessionKey('A')).toBe('B')
      expect(state().resolveSessionKey('B')).toBe('A')
      expect(warn).toHaveBeenCalledTimes(1)
    } finally {
      warn.mockRestore()
    }
  })

  it.each(['A', 'C'])('removes all aliases and records when discarded through %s', (key) => {
    state().addDraft('A')
    const id = state().enqueueOutbound('A', 'first')
    state().rekey('A', 'B')
    state().rekey('B', 'C')
    state().removeDraft(key)
    expect(state().sessionAliases).toEqual({})
    for (const settle of [
      'dequeueOutbound',
      'requeueOutbound',
      'failOutbound',
      'cancelOutbound',
      'markOutboundSending',
    ] as const) {
      state()[settle]('A', id)
      state()[settle]('C', id)
    }
    expect(state().outbound).toEqual({})
    expect(state().messages).toEqual({})
  })

  it('never persists aliases (including through partialize)', () => {
    state().addDraft('A')
    state().setActive('A')
    state().rekey('A', 'B')
    expect(state().sessionAliases).toEqual({ A: 'B' })
    expect(useChat.persist.getOptions().partialize?.(state())).toEqual({
      lastActive: state().lastActive,
    })
    const snapshot = JSON.parse(localStorage.getItem('rivethub.chat') ?? '')
    expect(snapshot.state).not.toHaveProperty('sessionAliases')
  })

  it('caps aliases at 256, dropping the oldest first', () => {
    for (let i = 0; i < 300; i++) state().rekey(`key-${i}`, `key-${i + 1}`)
    expect(Object.keys(state().sessionAliases)).toHaveLength(256)
    expect(state().sessionAliases['key-0']).toBeUndefined()
    expect(state().sessionAliases['key-44']).toBe('key-300')
    expect(state().sessionAliases['key-299']).toBe('key-300')
  })

  it.each(['outbound', 'live'] as const)(
    'treats destination %s content as a collision',
    (slice) => {
      state().addDraft('A')
      const id = state().enqueueOutbound('A', 'first')
      state().markOutboundSending('A', id)
      if (slice === 'outbound') state().enqueueOutbound('B', 'existing')
      else state().beginLive('B')
      expect(state().rekey('A', 'B')).toBe(false)
      state().failOutbound('A', id)
      expect(state().outbound.A?.[0].status).toBe('failed')
      expect(state().sessionAliases).toEqual({})
    },
  )
})
