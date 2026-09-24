import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HarnessEvent, SessionId } from '@rivetos/types'
import type { DeliveryGateway } from './outbound-delivery.js'
import type { LiveTurn, OutboundItem } from '../stores/chat.js'
import { DIALOG_NOTE } from './send-block-note.js'
import {
  createOutboundPump,
  createOutboundPumpRegistry,
  INJECT_LATCH_MS,
  DELIVERY_WINDOW_MS,
  TURN_RETRY_ATTEMPTS,
  TURN_RETRY_BACKOFF_MS,
  turnRetryDelayMs,
  type OutboundPumpStore,
} from './outbound-pump.js'

const SID = 'claude-code:a1b2c3d4-1111-4222-8333-444455556666'
const DELIVERY_ID = '11111111-1111-4111-8111-111111111111'
beforeEach(() => vi.spyOn(crypto, 'randomUUID').mockReturnValue(DELIVERY_ID))
afterEach(() => vi.restoreAllMocks())

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
    markSending: (_sid, id) => {
      s.calls.push(`mark:${id}`)
      const it = s.items.find((o) => o.id === id)
      if (it) it.status = 'sending'
    },
    dequeue: (_sid, id) => {
      s.calls.push(`dequeue:${id}`)
      s.items = s.items.filter((o) => o.id !== id)
    },
    requeue: (_sid, id, note) => {
      s.calls.push(`requeue:${id}`)
      const it = s.items.find((o) => o.id === id)
      if (it) Object.assign(it, { status: 'queued', note })
    },
    fail: (_sid, id, note) => {
      s.calls.push(`fail:${id}`)
      const item = s.items.find((o) => o.id === id)
      if (item) Object.assign(item, { status: 'failed', note })
    },
    restoreFailed: (_sid, item, note) => {
      s.calls.push(`restoreFailed:${item.id}`)
      if (!s.items.some((o) => o.id === item.id)) {
        s.items = [{ ...item, status: 'failed', note }, ...s.items]
      }
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

  it('keeps staged image inputs attached to their queued turn', async () => {
    const s = fakeStore()
    const attachments = [{ mime: 'image/png', pathOrUri: '/node/uploads/image.png' }]
    s.items = [{ ...queued('caption'), attachments }]
    const inject = vi.fn(() => Promise.resolve())
    const pump = createOutboundPump({
      sessionId: SID,
      store: s,
      inject,
      isTurnInFlight: () => false,
    })
    const pending = pump.pump()
    await vi.advanceTimersByTimeAsync(INJECT_LATCH_MS + 1_000)
    await pending
    expect(inject).toHaveBeenCalledWith('caption', false, attachments, false, DELIVERY_ID)
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
    // Backoff has not elapsed — the idle edge retries immediately and cancels the timer.
    await vi.advanceTimersByTimeAsync(TURN_RETRY_BACKOFF_MS[0] - 1)
    expect(failures).toBe(1)
    pump.onIdle()
    await vi.advanceTimersByTimeAsync(INJECT_LATCH_MS + 1_000)
    expect(injected).toEqual(['a'])
    expect(s.items).toEqual([])
    await vi.advanceTimersByTimeAsync(60_000)
    expect(failures).toBe(1)
    expect(injected).toEqual(['a'])
  })

  it('sets bypassDialogGate on a forced inject and not on an automatic retry', async () => {
    const s = fakeStore()
    s.items = [queued('a')]
    const calls: boolean[] = []
    let failures = 0
    const pump = createOutboundPump({
      sessionId: SID,
      store: s,
      inject: (_text, _interrupt, _attachments, bypass) => {
        calls.push(bypass === true)
        if (failures < 1) {
          failures += 1
          return Promise.reject(TURN_IN_FLIGHT)
        }
        return Promise.resolve()
      },
      isTurnInFlight: (err) => err === TURN_IN_FLIGHT,
    })
    await pump.pump()
    expect(calls).toEqual([false])
    await vi.advanceTimersByTimeAsync(TURN_RETRY_BACKOFF_MS[0] + INJECT_LATCH_MS)
    expect(calls).toEqual([false, false])
    s.items = [queued('b')]
    const forced = pump.pump({ forceId: 'b' })
    expect(calls.at(-1)).toBe(true)
    await vi.advanceTimersByTimeAsync(INJECT_LATCH_MS)
    await forced
    expect(calls).toEqual([false, false, true])
  })

  it('retries a turn_in_flight rejection on the backoff timer without an idle edge', async () => {
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
    expect(failures).toBe(1)
    expect(injected).toEqual([])
    await vi.advanceTimersByTimeAsync(TURN_RETRY_BACKOFF_MS[0] - 1)
    expect(injected).toEqual([])
    await vi.advanceTimersByTimeAsync(1 + INJECT_LATCH_MS)
    expect(injected).toEqual(['a'])
    expect(s.items).toEqual([])
  })

  it('an idle edge cancels the turn_in_flight backoff timer', async () => {
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
    pump.onIdle()
    await vi.advanceTimersByTimeAsync(INJECT_LATCH_MS)
    expect(injected).toEqual(['a'])
    await vi.advanceTimersByTimeAsync(TURN_RETRY_BACKOFF_MS[0] + TURN_RETRY_BACKOFF_MS[1])
    expect(injected).toEqual(['a'])
    expect(failures).toBe(1)
  })

  it('a new send cancels the turn_in_flight backoff timer', async () => {
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
    expect(failures).toBe(1)
    const pending = pump.pump()
    await vi.advanceTimersByTimeAsync(INJECT_LATCH_MS + TURN_RETRY_BACKOFF_MS[0])
    await pending
    expect(injected).toEqual(['a'])
    expect(failures).toBe(1)
  })

  it('stops turn_in_flight timer retries after TURN_RETRY_ATTEMPTS', async () => {
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
    for (let attempt = 1; attempt <= TURN_RETRY_ATTEMPTS; attempt++) {
      const delay = turnRetryDelayMs(attempt)
      await vi.advanceTimersByTimeAsync(delay - 1)
      expect(injects).toBe(attempt)
      await vi.advanceTimersByTimeAsync(1)
      expect(injects).toBe(attempt + 1)
    }
    await vi.advanceTimersByTimeAsync(120_000)
    expect(injects).toBe(TURN_RETRY_ATTEMPTS + 1)
    expect(s.items).toEqual([queued('a')])
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
    await vi.advanceTimersByTimeAsync(60_000)
    expect(injects).toBe(1)
    expect(s.items).toEqual([queued('a')])
  })
})

describe('mounted delivery observer recovery', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it.each(['forbidden', 'unknown_session', 'invalid_session_id', 'capability_unsupported'])(
    'opens a fresh observer on the next send after %s',
    async (code) => {
      const store = fakeStore()
      const registry = createOutboundPumpRegistry(store, () => false)
      const entry = registry(SID)
      entry.mount()
      const listeners: Array<(event: HarnessEvent) => void> = []
      const closes: Array<ReturnType<typeof vi.fn>> = []
      const gateway: DeliveryGateway = {
        config: { baseUrl: 'http://den' },
        watchHarnessSession: vi.fn((_sid, listener, options) => {
          listeners.push(listener)
          const close = vi.fn()
          closes.push(close)
          options?.onStatus?.('open')
          return { close, send: () => true }
        }),
      }
      const correlated: boolean[] = []
      entry.sink.current = async (_text, _interrupt, _attachments, _bypass, id) => {
        correlated.push(await entry.observe(gateway, SID, id))
      }
      store.items = [queued('first')]
      const first = entry.pump.pump()
      await vi.advanceTimersByTimeAsync(INJECT_LATCH_MS)
      await first
      listeners[0]({ type: 'error', sessionId: SID as SessionId, code, message: 'gone' })
      await vi.advanceTimersByTimeAsync(0)
      expect(closes[0]).toHaveBeenCalledTimes(1)
      expect(gateway.watchHarnessSession).toHaveBeenCalledTimes(1)

      store.items = [queued('second')]
      const second = entry.pump.pump()
      await vi.advanceTimersByTimeAsync(INJECT_LATCH_MS)
      await second
      expect(gateway.watchHarnessSession).toHaveBeenCalledTimes(2)
      expect(correlated).toEqual([true, true])
      expect(closes[1]).not.toHaveBeenCalled()
      // Frames from the retired subscription cannot close its replacement.
      listeners[0]({ type: 'error', sessionId: SID as SessionId, code, message: 'gone' })
      expect(await entry.observe(gateway, SID)).toBe(true)
      expect(gateway.watchHarnessSession).toHaveBeenCalledTimes(2)
      registry.dispose()
    },
  )

  it('recovers when a terminal frame arrives synchronously during subscription setup', async () => {
    const registry = createOutboundPumpRegistry(fakeStore(), () => false)
    const entry = registry(SID)
    entry.mount()
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const close = vi.fn()
    let refused = true
    const gateway: DeliveryGateway = {
      config: { baseUrl: 'http://den' },
      watchHarnessSession: vi.fn((_sid, listener, options) => {
        options?.onStatus?.('open')
        if (refused) {
          listener({
            type: 'error',
            sessionId: SID as SessionId,
            code: 'forbidden',
            message: 'gone',
          })
        }
        return { close, send: () => true }
      }),
    }
    expect(await entry.observe(gateway, SID)).toBe(false)
    refused = false
    expect(await entry.observe(gateway, SID)).toBe(true)
    expect(gateway.watchHarnessSession).toHaveBeenCalledTimes(2)
    expect(close).toHaveBeenCalledTimes(1)
    expect(warning).toHaveBeenCalledTimes(1)
    registry.dispose()
  })
})

describe('pump registry rekey ownership', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it.each(['resolved', 'failed', 'turn_in_flight'])(
    'settles %s at the current key and reuses the pump',
    async (outcome) => {
      const s = fakeStore()
      let key = SID
      s.resolveSessionKey = () => key
      s.items = [queued('first'), queued('second')]
      const dequeue = vi.spyOn(s, 'dequeue')
      const fail = vi.spyOn(s, 'fail')
      const requeue = vi.spyOn(s, 'requeue')
      const clearLive = vi.spyOn(s, 'clearLive')
      const beginLive = vi.spyOn(s, 'beginLive')
      const registry = createOutboundPumpRegistry(s, (err) => err === TURN_IN_FLIGHT)
      const old = registry(SID)
      let resolve!: () => void
      let reject!: (err: Error) => void
      old.sink.current = () =>
        new Promise<void>((res, rej) => {
          resolve = res
          reject = rej
        })
      const pending = old.pump.pump()
      expect(beginLive).toHaveBeenCalledWith(SID, 'working…')
      key = 'claude-code:rotated'
      const adopted = registry(key)
      expect(adopted).toBe(old)
      const next = vi.fn((_text: string) => Promise.resolve())
      adopted.sink.current = next
      await adopted.pump.pump()
      expect(next).not.toHaveBeenCalled()
      if (outcome === 'resolved') {
        resolve()
        await vi.advanceTimersByTimeAsync(1)
        expect(dequeue).toHaveBeenCalledWith(key, 'first')
        await adopted.pump.pump()
        expect(next).not.toHaveBeenCalled()
      } else if (outcome === 'failed') {
        const failure = expect(pending).rejects.toThrow('offline')
        reject(new Error('offline'))
        await failure
        expect(fail).toHaveBeenCalledWith(key, 'first', undefined)
        expect(s.items.find((o) => o.id === 'first')?.status).toBe('failed')
      } else {
        reject(TURN_IN_FLIGHT)
        await pending
        expect(requeue).toHaveBeenCalledWith(key, 'first', undefined)
        expect(next).not.toHaveBeenCalled()
        adopted.pump.onIdle()
      }
      await vi.advanceTimersByTimeAsync(3 * INJECT_LATCH_MS)
      if (outcome !== 'failed') await pending
      expect(clearLive).toHaveBeenCalledWith(key)
      expect(clearLive).not.toHaveBeenCalledWith(SID)
      expect(next.mock.calls.map((call) => call[0])).toEqual(
        outcome === 'turn_in_flight' ? ['first', 'second'] : ['second'],
      )
      expect(s.items).toEqual(
        outcome === 'failed' ? [{ ...queued('first'), status: 'failed' }] : [],
      )
      if (outcome === 'failed') {
        const retried = adopted.pump.pump({ forceId: 'first' })
        await vi.advanceTimersByTimeAsync(INJECT_LATCH_MS)
        await retried
        expect(next.mock.calls.map((call) => call[0])).toEqual(['second', 'first'])
        expect(s.items).toEqual([])
      }
    },
  )
})

describe('onUndelivered', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('sends without crypto.randomUUID on insecure-context heads', async () => {
    vi.stubGlobal('crypto', {
      randomUUID: undefined,
      getRandomValues: (b: Uint8Array) => b.fill(1),
    })
    try {
      const s = fakeStore()
      s.items = [queued('a')]
      const inject = vi.fn(async () => {})
      const pump = createOutboundPump({
        sessionId: SID,
        store: s,
        inject,
        isTurnInFlight: () => false,
      })
      const pending = pump.pump()
      await vi.advanceTimersByTimeAsync(INJECT_LATCH_MS)
      await pending
      expect(inject).toHaveBeenCalledWith(
        'a',
        false,
        undefined,
        false,
        '01010101-0101-4101-8101-010101010101',
      )
      expect(s.items).toEqual([])
    } finally {
      vi.unstubAllGlobals()
    }
  })
  it('restores a cold-spawn failure at 24s after the inject latch expires', async () => {
    const s = fakeStore()
    s.items = [queued('a')]
    const onDeliveryWindowChange = vi.fn()
    const pump = createOutboundPump({
      sessionId: SID,
      store: s,
      inject: async () => {},
      isTurnInFlight: () => false,
      onDeliveryWindowChange,
    })
    const pending = pump.pump()
    await vi.advanceTimersByTimeAsync(INJECT_LATCH_MS)
    await pending
    expect(s.calls).toContain('clearLive')
    expect(s.items).toEqual([])
    expect(onDeliveryWindowChange).toHaveBeenLastCalledWith(true)
    await vi.advanceTimersByTimeAsync(24_000 - INJECT_LATCH_MS)
    pump.onUndelivered(DELIVERY_ID)
    expect(s.items).toEqual([{ ...queued('a'), status: 'failed', note: 'not delivered' }])
    expect(onDeliveryWindowChange).toHaveBeenLastCalledWith(false)
    pump.dispose()
  })

  it('restores unconfirmed delivery on a socket gap after latch expiry', async () => {
    const s = fakeStore()
    s.items = [queued('a')]
    const pump = createOutboundPump({
      sessionId: SID,
      store: s,
      inject: async () => {},
      isTurnInFlight: () => false,
    })
    const pending = pump.pump()
    await vi.advanceTimersByTimeAsync(INJECT_LATCH_MS)
    await pending
    pump.onDeliveryLost()
    expect(s.items).toEqual([
      {
        ...queued('a'),
        status: 'failed',
        note: 'delivery unconfirmed: connection lost; check the conversation before retrying',
      },
    ])
    pump.dispose()
  })

  it('drops the handle at 30s and ignores a later reconnect or correlated failure', async () => {
    const s = fakeStore()
    s.items = [queued('a')]
    const onDeliveryWindowChange = vi.fn()
    const pump = createOutboundPump({
      sessionId: SID,
      store: s,
      inject: async () => {},
      isTurnInFlight: () => false,
      onDeliveryWindowChange,
    })
    const pending = pump.pump()
    expect(DELIVERY_WINDOW_MS).toBe(30_000)
    await vi.advanceTimersByTimeAsync(29_999)
    await pending
    expect(onDeliveryWindowChange).toHaveBeenLastCalledWith(true)
    await vi.advanceTimersByTimeAsync(1)
    expect(onDeliveryWindowChange).toHaveBeenLastCalledWith(false)
    await vi.advanceTimersByTimeAsync(1_000)
    pump.onDeliveryLost()
    pump.onUndelivered(DELIVERY_ID)
    expect(s.items).toEqual([])
    expect(s.calls).not.toContain('restoreFailed:a')
    pump.dispose()
  })
  it('restores a correlated failure while transcript status is blocked', async () => {
    const s = fakeStore()
    s.items = [{ ...queued('a'), status: 'failed' }]
    s.busy = true
    const pump = createOutboundPump({
      sessionId: SID,
      store: s,
      inject: async () => {},
      isTurnInFlight: () => false,
    })
    void pump.pump({ forceId: 'a' })
    await vi.advanceTimersByTimeAsync(0)
    s.busy = true // Transcript blocked maps to liveIsBusy=true.
    pump.onUndelivered(DELIVERY_ID)
    expect(s.items[0]).toMatchObject({ id: 'a', status: 'failed' })
    pump.dispose()
  })
  it('does not restore an unaccepted request on a socket gap', () => {
    const s = fakeStore()
    s.items = [queued('a')]
    const pump = createOutboundPump({
      sessionId: SID,
      store: s,
      inject: () => new Promise(() => {}),
      isTurnInFlight: () => false,
    })
    void pump.pump()
    pump.onDeliveryLost()
    expect(s.items[0].status).toBe('sending')
    expect(s.calls).not.toContain('restoreFailed:a')
    pump.dispose()
  })
  it('restores the last accepted item as failed', async () => {
    const s = fakeStore()
    s.items = [queued('a')]
    const pump = createOutboundPump({
      sessionId: SID,
      store: s,
      inject: () => Promise.resolve(),
      isTurnInFlight: () => false,
    })
    const p = pump.pump()
    await vi.advanceTimersByTimeAsync(0)
    await Promise.resolve()
    pump.onUndelivered(DELIVERY_ID)
    expect(s.calls.filter((c) => c.startsWith('restoreFailed'))).toEqual(['restoreFailed:a'])
    await vi.advanceTimersByTimeAsync(INJECT_LATCH_MS)
    await p
  })

  it('does not restore after the turn went busy', async () => {
    const s = fakeStore()
    s.items = [queued('a')]
    const pump = createOutboundPump({
      sessionId: SID,
      store: s,
      inject: () => Promise.resolve(),
      isTurnInFlight: () => false,
    })
    const pending = pump.pump()
    await vi.advanceTimersByTimeAsync(0)
    expect(s.calls).toContain('dequeue:a')
    s.busy = true
    pump.onBusy()
    await vi.advanceTimersByTimeAsync(INJECT_LATCH_MS)
    await pending
    pump.onUndelivered(DELIVERY_ID)
    expect(s.calls.filter((c) => c.startsWith('restoreFailed'))).toEqual([])
  })

  it.each(['dispose', 'idle', 'busy'] as const)(
    'clears the accepted handle on %s',
    async (edge) => {
      const s = fakeStore()
      s.items = [queued('a')]
      const pump = createOutboundPump({
        sessionId: SID,
        store: s,
        inject: async () => {},
        isTurnInFlight: () => false,
      })
      const pending = pump.pump()
      await vi.advanceTimersByTimeAsync(0)
      expect(s.calls).toContain('dequeue:a')
      if (edge === 'dispose') pump.dispose()
      else if (edge === 'idle') pump.onIdle()
      else pump.onBusy()
      pump.onUndelivered(DELIVERY_ID)
      expect(s.items).toEqual([])
      await vi.advanceTimersByTimeAsync(INJECT_LATCH_MS)
      await pending
    },
  )

  it('ignores another attempt and restores once without automatic retry', async () => {
    const s = fakeStore()
    s.items = [queued('a')]
    const inject = vi.fn(async () => {})
    const pump = createOutboundPump({
      sessionId: SID,
      store: s,
      inject,
      isTurnInFlight: () => false,
    })
    const pending = pump.pump()
    await vi.advanceTimersByTimeAsync(0)
    pump.onUndelivered('another-client')
    expect(s.items).toEqual([])
    pump.onUndelivered(DELIVERY_ID)
    pump.onUndelivered(DELIVERY_ID)
    await vi.advanceTimersByTimeAsync(INJECT_LATCH_MS)
    await pending
    pump.onIdle()
    await pump.pump()
    expect(inject).toHaveBeenCalledTimes(1)
    expect(s.calls.filter((c) => c.startsWith('restoreFailed'))).toEqual(['restoreFailed:a'])
  })

  it('retains the accepted delivery when a subsequent queued send is refused', async () => {
    vi.mocked(crypto.randomUUID)
      .mockReturnValueOnce(DELIVERY_ID)
      .mockReturnValueOnce('22222222-2222-4222-8222-222222222222')
    const s = fakeStore()
    s.items = [queued('a'), queued('b')]
    const inject = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(TURN_IN_FLIGHT)
    const pump = createOutboundPump({
      sessionId: SID,
      store: s,
      inject,
      isTurnInFlight: () => true,
    })
    const pending = pump.pump()
    await vi.advanceTimersByTimeAsync(INJECT_LATCH_MS)
    await pending
    expect(inject).toHaveBeenCalledTimes(2)
    pump.onUndelivered(DELIVERY_ID)
    expect(s.items.find((item) => item.id === 'a')).toMatchObject({
      status: 'failed',
      note: 'not delivered',
    })
    pump.dispose()
  })

  it('preserves a failure that beats HTTP acceptance', async () => {
    const s = fakeStore()
    s.items = [queued('a')]
    let accept!: () => void
    const pump = createOutboundPump({
      sessionId: SID,
      store: s,
      inject: () =>
        new Promise<void>((r) => {
          accept = r
        }),
      isTurnInFlight: () => false,
    })
    const pending = pump.pump()
    pump.onUndelivered(DELIVERY_ID, 'not delivered')
    pump.onIdle()
    accept()
    await vi.advanceTimersByTimeAsync(INJECT_LATCH_MS)
    await pending
    expect(s.items[0]).toMatchObject({ id: 'a', status: 'failed', note: 'not delivered' })
  })

  it('a busy refusal of a manual failed retry stays failed on idle and timer edges', async () => {
    const s = fakeStore()
    s.items = [{ ...queued('a'), status: 'failed' }]
    const inject = vi.fn(() => Promise.reject(TURN_IN_FLIGHT))
    const pump = createOutboundPump({
      sessionId: SID,
      store: s,
      inject,
      isTurnInFlight: () => true,
    })
    await pump.pump({ forceId: 'a' })
    expect(s.items[0]).toMatchObject({
      status: 'failed',
      note: 'not sent: a turn is still running',
    })
    pump.onIdle()
    await vi.advanceTimersByTimeAsync(60_000)
    await pump.pump()
    expect(inject).toHaveBeenCalledTimes(1)
    expect(s.calls).not.toContain('requeue:a')
  })

  it('is a no-op with nothing accepted', () => {
    const s = fakeStore()
    const pump = createOutboundPump({
      sessionId: SID,
      store: s,
      inject: () => Promise.resolve(),
      isTurnInFlight: () => false,
    })
    pump.onUndelivered(DELIVERY_ID)
    expect(s.calls.filter((c) => c.startsWith('restoreFailed'))).toEqual([])
  })

  it('replaces the pending handle on the next accepted send', async () => {
    const s = fakeStore()
    s.items = [queued('a'), queued('b')]
    const pump = createOutboundPump({
      sessionId: SID,
      store: s,
      inject: () => Promise.resolve(),
      isTurnInFlight: () => false,
    })
    const p1 = pump.pump()
    await vi.advanceTimersByTimeAsync(INJECT_LATCH_MS)
    await p1
    s.items = [queued('b')]
    const p2 = pump.pump()
    await vi.advanceTimersByTimeAsync(0)
    await Promise.resolve()
    pump.onUndelivered(DELIVERY_ID)
    expect(s.calls.filter((c) => c.startsWith('restoreFailed'))).toEqual(['restoreFailed:b'])
    await vi.advanceTimersByTimeAsync(INJECT_LATCH_MS)
    await p2
  })
})

describe('failure notes', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  const dialogRefusal = Object.assign(new Error('harness is showing a dialog'), {
    status: 409,
    body: { error: 'harness is showing a dialog', reason: 'harness_dialog' },
  })

  it('fails a send refused for an open dialog with the dialog note', async () => {
    const s = fakeStore()
    s.items = [queued('a')]
    const pump = createOutboundPump({
      sessionId: SID,
      store: s,
      inject: () => Promise.reject(dialogRefusal),
      isTurnInFlight: () => false,
    })
    await expect(pump.pump()).rejects.toThrow('dialog')
    expect(s.items[0]).toMatchObject({ id: 'a', status: 'failed', note: DIALOG_NOTE })
  })

  it('requeues a turn_in_flight refused for an open dialog with the dialog note', async () => {
    const s = fakeStore()
    s.items = [queued('a')]
    const pump = createOutboundPump({
      sessionId: SID,
      store: s,
      inject: () => Promise.reject(dialogRefusal),
      isTurnInFlight: () => true,
    })
    await pump.pump()
    expect(s.items[0]).toMatchObject({ id: 'a', status: 'queued', note: DIALOG_NOTE })
  })

  it('a plain failure carries no note', async () => {
    const s = fakeStore()
    s.items = [queued('a')]
    const pump = createOutboundPump({
      sessionId: SID,
      store: s,
      inject: () => Promise.reject(new Error('offline')),
      isTurnInFlight: () => false,
    })
    await expect(pump.pump()).rejects.toThrow('offline')
    expect(s.items[0]?.note).toBeUndefined()
  })

  it('onUndelivered passes its note to the restored item', async () => {
    const s = fakeStore()
    s.items = [queued('a')]
    const pump = createOutboundPump({
      sessionId: SID,
      store: s,
      inject: () => Promise.resolve(),
      isTurnInFlight: () => false,
    })
    const p = pump.pump()
    await vi.advanceTimersByTimeAsync(0)
    await Promise.resolve()
    pump.onUndelivered(DELIVERY_ID, 'not delivered: Claude Code is showing a dialog')
    expect(s.items[0]).toMatchObject({
      id: 'a',
      status: 'failed',
      note: 'not delivered: Claude Code is showing a dialog',
    })
    await vi.advanceTimersByTimeAsync(INJECT_LATCH_MS)
    await p
  })
})
