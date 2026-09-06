import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LiveTurn, OutboundItem } from '../stores/chat.js'
import {
  createOutboundPump,
  INJECT_LATCH_MS,
  TURN_RETRY_ATTEMPTS,
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
    awaitBusy: (_sid, ms) => {
      if (s.busy) return Promise.resolve()
      return new Promise((r) => setTimeout(r, ms))
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
    await vi.advanceTimersByTimeAsync(INJECT_LATCH_MS + 1_000)
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

  it('retries a turn_in_flight rejection on the next idle edge', async () => {
    const s = fakeStore()
    s.items = [queued('a')]
    const injected: string[] = []
    let failures = 0
    const pump = createOutboundPump({
      sessionId: SID,
      store: s,
      inject: (text) => {
        if (failures < 1) {
          failures += 1
          return Promise.reject(TURN_IN_FLIGHT)
        }
        injected.push(text)
        return Promise.resolve()
      },
      isTurnInFlight: (err) => err === TURN_IN_FLIGHT,
    })
    await pump.pump()
    expect(s.calls).toContain('requeue:a')
    expect(injected).toEqual([])
    expect(failures).toBe(1)
    // A timer must NOT retry — only the idle edge.
    await vi.advanceTimersByTimeAsync(60_000)
    expect(failures).toBe(1)
    pump.onIdle()
    await vi.advanceTimersByTimeAsync(INJECT_LATCH_MS + 1_000)
    expect(injected).toEqual(['a'])
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
    for (let i = 0; i < TURN_RETRY_ATTEMPTS + 2; i++) {
      pump.onIdle()
      await vi.advanceTimersByTimeAsync(0)
    }
    expect(injects).toBe(TURN_RETRY_ATTEMPTS + 1)
    expect(s.items).toEqual([queued('a')])
  })

  it('keeps the inject latch when a DIFFERENT queued item is cancelled mid-latch', async () => {
    const s = fakeStore()
    s.items = [queued('a'), queued('b'), queued('c')]
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
    await vi.advanceTimersByTimeAsync(1_000)
    expect(injected).toEqual(['a'])
    s.items = s.items.filter((o) => o.id !== 'b')
    pump.reset('b')
    void pump.pump().catch(() => undefined)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(injected).toEqual(['a'])
    await vi.advanceTimersByTimeAsync(20_000)
    await p
    expect(injected).toEqual(['a', 'c'])
    expect(s.items).toEqual([])
  })

  it('reset() of the in-flight id frees the pump and orphans its trailing writes', async () => {
    const s = fakeStore()
    s.items = [queued('a'), queued('b')]
    const injected: string[] = []
    let resolveA!: () => void
    const pump = createOutboundPump({
      sessionId: SID,
      store: s,
      inject: (text) => {
        injected.push(text)
        if (text === 'a') {
          return new Promise<void>((r) => {
            resolveA = r
          })
        }
        return Promise.resolve()
      },
      isTurnInFlight: () => false,
    })
    const p = pump.pump()
    expect(injected).toEqual(['a'])
    s.items = s.items.filter((o) => o.id !== 'a')
    pump.reset('a')
    void pump.pump().catch(() => undefined)
    expect(injected).toEqual(['a', 'b'])
    resolveA()
    await vi.advanceTimersByTimeAsync(20_000)
    await p
    expect(s.calls).not.toContain('dequeue:a')
    expect(injected).toEqual(['a', 'b'])
    expect(s.items).toEqual([])
  })

  it('dispose() aborts the latch wait — no trailing clearLive, no drain — and is terminal', async () => {
    const s = fakeStore()
    s.items = [queued('a'), queued('b')]
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
    await vi.advanceTimersByTimeAsync(1_000)
    expect(injected).toEqual(['a'])
    pump.dispose()
    await vi.advanceTimersByTimeAsync(20_000)
    await p
    expect(injected).toEqual(['a'])
    expect(s.calls).not.toContain('clearLive')
    expect(s.items).toEqual([queued('b')])
    await pump.pump()
    expect(injected).toEqual(['a'])
  })

  it('dispose() cancels a pending turn_in_flight idle-retry', async () => {
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
    expect(injects).toBe(1)
    pump.dispose()
    pump.onIdle()
    await Promise.resolve()
    expect(injects).toBe(1)
    expect(s.items).toEqual([queued('a')])
  })
})
