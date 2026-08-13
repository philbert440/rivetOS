import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LiveTurn, OutboundItem } from '../stores/chat.js'
import {
  createOutboundPump,
  startStaleTurnRelease,
  TURN_RETRY_ATTEMPTS,
  TURN_RETRY_MAX_MS,
  TURN_RETRY_MS,
  type OutboundPumpStore,
} from './outbound-pump.js'

const SID = 'claude-code:a1b2c3d4-1111-4222-8333-444455556666'
const TURN_IN_FLIGHT = new Error('turn_in_flight')

interface FakeStore extends OutboundPumpStore {
  items: OutboundItem[]
  busy: boolean
  liveTurn: LiveTurn | undefined
  lastFrame: number | undefined
  calls: string[]
}

function fakeStore(): FakeStore {
  const s: FakeStore = {
    items: [],
    busy: false,
    liveTurn: undefined,
    lastFrame: undefined,
    calls: [],
    queue: () => s.items,
    liveIsBusy: () => s.busy,
    live: () => s.liveTurn,
    liveTs: () => s.lastFrame,
    markSending: (_sid, id) => {
      s.calls.push(`mark:${id}`)
      const it = s.items.find((o) => o.id === id)
      if (it) it.status = 'sending'
    },
    dequeue: (_sid, id) => {
      s.calls.push(`dequeue:${id}`)
      s.items = s.items.filter((o) => o.id !== id)
    },
    requeue: (_sid, id) => {
      s.calls.push(`requeue:${id}`)
      const it = s.items.find((o) => o.id === id)
      if (it) it.status = 'queued'
    },
    fail: (_sid, id) => {
      s.calls.push(`fail:${id}`)
      s.items = s.items.filter((o) => o.id !== id)
    },
    beginLive: () => {
      s.calls.push('beginLive')
    },
    clearLive: () => {
      s.calls.push('clearLive')
      s.liveTurn = undefined
      s.busy = false
    },
  }
  return s
}

const queued = (id: string, text = id): OutboundItem => ({ id, text, status: 'queued' })

describe('createOutboundPump', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('injects the next queued turn, dequeues it, and drops an unlatched placeholder', async () => {
    const s = fakeStore()
    s.items = [queued('a')]
    const injected: string[] = []
    const pump = createOutboundPump({
      sessionId: SID,
      store: s,
      inject: (text) => {
        injected.push(text)
        return Promise.resolve()
      },
      isTurnInFlight: () => false,
    })
    const p = pump.pump()
    // Nothing ever latches busy → the latch window expires and the
    // placeholder live turn is dropped so the queue can flow.
    await vi.advanceTimersByTimeAsync(10_000)
    await p
    expect(injected).toEqual(['a'])
    expect(s.items).toEqual([])
    expect(s.calls).toContain('dequeue:a')
    expect(s.calls).toContain('clearLive')
  })

  it('waits out a busy live turn instead of double-injecting', async () => {
    const s = fakeStore()
    s.items = [queued('a')]
    s.busy = true
    let injects = 0
    const pump = createOutboundPump({
      sessionId: SID,
      store: s,
      inject: () => {
        injects += 1
        return Promise.resolve()
      },
      isTurnInFlight: () => false,
    })
    await pump.pump()
    expect(injects).toBe(0)
    expect(s.items[0].status).toBe('queued')
  })

  it('backs off exponentially on turn_in_flight and succeeds on a later retry', async () => {
    const s = fakeStore()
    s.items = [queued('a')]
    const injected: string[] = []
    let failures = 0
    const pump = createOutboundPump({
      sessionId: SID,
      store: s,
      inject: (text) => {
        if (failures < 2) {
          failures += 1
          return Promise.reject(TURN_IN_FLIGHT)
        }
        injected.push(text)
        return Promise.resolve()
      },
      isTurnInFlight: (err) => err === TURN_IN_FLIGHT,
    })
    // Attempt 1 rejects instantly; retry 1 lands after TURN_RETRY_MS.
    await pump.pump()
    expect(s.calls).toContain('requeue:a')
    expect(injected).toEqual([])
    await vi.advanceTimersByTimeAsync(TURN_RETRY_MS - 1)
    expect(failures).toBe(1)
    // Retry fires at 1500ms, rejects (attempt 2 → 3000ms backoff)…
    await vi.advanceTimersByTimeAsync(1)
    expect(failures).toBe(2)
    // …retry 2 at +3000ms succeeds, then the latch window expires.
    await vi.advanceTimersByTimeAsync(TURN_RETRY_MS * 2)
    expect(injected).toEqual(['a'])
    await vi.advanceTimersByTimeAsync(10_000)
    expect(s.items).toEqual([])
  })

  it('gives up after TURN_RETRY_ATTEMPTS and leaves the turn queued', async () => {
    const s = fakeStore()
    s.items = [queued('a')]
    let injects = 0
    const pump = createOutboundPump({
      sessionId: SID,
      store: s,
      inject: () => {
        injects += 1
        return Promise.reject(TURN_IN_FLIGHT)
      },
      isTurnInFlight: (err) => err === TURN_IN_FLIGHT,
    })
    await pump.pump()
    // Backoff schedule after each rejection: 1.5s, 3s, 6s, 12s, 24s, 30s
    // (capped) — TURN_RETRY_ATTEMPTS retries on top of the first attempt.
    const delays = [1, 2, 3, 4, 5, 6].map((n) =>
      Math.min(TURN_RETRY_MS * 2 ** (n - 1), TURN_RETRY_MAX_MS),
    )
    for (const d of delays) await vi.advanceTimersByTimeAsync(d)
    expect(injects).toBe(TURN_RETRY_ATTEMPTS + 1)
    // Past the cap nothing more is scheduled — the turn stays queued for the
    // user's manual inject button.
    await vi.advanceTimersByTimeAsync(TURN_RETRY_MAX_MS * 4)
    expect(injects).toBe(TURN_RETRY_ATTEMPTS + 1)
    expect(s.items).toEqual([queued('a')])
  })
})

describe('startStaleTurnRelease', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  const liveWith = (over: Partial<LiveTurn>): LiveTurn => ({
    text: '',
    reasoning: false,
    reasoningText: '',
    tools: [],
    ...over,
  })

  it('clears a live turn with no frames for STALE_TURN_MS and no tool running', () => {
    const s = fakeStore()
    s.liveTurn = liveWith({ text: 'partial reply' })
    s.lastFrame = Date.now() - 121_000
    const stop = startStaleTurnRelease(s, SID)
    vi.advanceTimersByTime(5_000)
    expect(s.calls).toContain('clearLive')
    stop()
  })

  it('keeps a silent turn alive while a tool is still running', () => {
    const s = fakeStore()
    s.liveTurn = liveWith({
      tools: [{ id: 't1', name: 'Bash', title: 'Bash', status: 'running' }],
    })
    s.lastFrame = Date.now() - 121_000
    const stop = startStaleTurnRelease(s, SID)
    vi.advanceTimersByTime(20_000)
    expect(s.calls).not.toContain('clearLive')
    stop()
  })

  it('never releases a placeholder-only turn (the pump latch window)', () => {
    const s = fakeStore()
    s.liveTurn = liveWith({})
    s.lastFrame = Date.now() - 121_000
    const stop = startStaleTurnRelease(s, SID)
    vi.advanceTimersByTime(20_000)
    expect(s.calls).not.toContain('clearLive')
    stop()
  })

  it('never releases a turn whose frames are still fresh', () => {
    const s = fakeStore()
    s.liveTurn = liveWith({ text: 'streaming' })
    s.lastFrame = Date.now() - 1_000
    const stop = startStaleTurnRelease(s, SID)
    vi.advanceTimersByTime(20_000)
    expect(s.calls).not.toContain('clearLive')
    stop()
  })
})
