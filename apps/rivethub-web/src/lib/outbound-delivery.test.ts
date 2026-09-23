import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HarnessEvent, SessionId } from '@rivetos/types'
import type { OutboundItem } from '../stores/chat.js'
import type { DeliveryGateway } from './outbound-delivery.js'
import {
  createOutboundPumpRegistry,
  DELIVERY_WINDOW_MS,
  type OutboundPumpStore,
  type ThreadLifecycleEvent,
} from './outbound-pump.js'

const SID: SessionId = 'claude-code:a'

function fixture(opens = true) {
  const queues: Record<string, OutboundItem[]> = {
    [SID]: [{ id: 'a', text: 'hello', status: 'queued' }],
  }
  let move!: (event: ThreadLifecycleEvent) => void
  let emit!: (event: HarnessEvent) => void
  let status!: (value: 'connecting' | 'open' | 'closed') => void
  let deliveryId = ''
  const close = vi.fn()
  const gateway: DeliveryGateway = {
    config: { baseUrl: 'http://den' },
    watchHarnessSession: (_sid, listener, opts) => {
      emit = listener
      status = opts!.onStatus!
      if (opens) status('open')
      return { close, send: () => true }
    },
  }
  const store: OutboundPumpStore = {
    queue: (sid) => queues[sid],
    liveIsBusy: () => false,
    markSending: () => {},
    dequeue: (sid, id) => {
      queues[sid] = queues[sid].filter((item) => item.id !== id)
    },
    requeue: () => {},
    fail: () => {},
    restoreFailed: (sid, item, note) => {
      queues[sid] = [{ ...item, status: 'failed', note }, ...(queues[sid] ?? [])]
    },
    beginLive: () => {},
    clearLive: () => {},
    awaitBusy: () => new Promise((resolve) => setTimeout(resolve, 6_000)),
  }
  const registry = createOutboundPumpRegistry(
    store,
    () => false,
    (listener) => {
      move = listener
      return () => {}
    },
  )
  const entry = registry(SID)
  const unmount = entry.mount()
  const post = vi.fn()
  const inject = vi.fn(async (_text, _interrupt, _attachments, _bypass, id) => {
    await entry.observe(gateway, SID, id)
    post()
    deliveryId = id
  })
  entry.sink.current = inject
  return {
    queues,
    gateway,
    unmount,
    post,
    store,
    registry,
    entry,
    inject,
    close,
    emit: (event: HarnessEvent) => emit(event),
    status: (value: 'connecting' | 'open' | 'closed') => status(value),
    move: (event: ThreadLifecycleEvent) => move(event),
    failure: (): HarnessEvent => ({
      type: 'error',
      sessionId: SID,
      code: 'turn_undelivered',
      message: 'private pane text',
      deliveryId,
    }),
  }
}

describe('registry delivery observation', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())
  it.each(['undelivered', 'disconnect'] as const)(
    'preserves %s after the sending view unmounts',
    async (edge) => {
      const f = fixture()
      void f.entry.pump.pump()
      await vi.advanceTimersByTimeAsync(0)
      f.unmount()
      // A new conversation has its own pump; the old view no longer supplies a sink.
      f.entry.sink.current = async () => {
        throw new Error('unmounted')
      }
      f.registry('claude-code:other')
      if (edge === 'undelivered') f.emit(f.failure())
      else f.status('closed')
      expect(f.queues[SID][0]).toMatchObject({ id: 'a', status: 'failed' })
      expect(f.queues[SID][0].note).not.toContain('private pane text')
      expect(f.queues['claude-code:other']).toBeUndefined()
      void f.entry.pump.pump()
      await vi.advanceTimersByTimeAsync(0)
      expect(f.inject).toHaveBeenCalledTimes(1)
      f.registry.dispose()
      await vi.advanceTimersByTimeAsync(0)
      expect(f.close).toHaveBeenCalledTimes(1)
    },
  )

  it('restores to the adopted key across rekey and disposes the watcher on removal', async () => {
    const f = fixture()
    void f.entry.pump.pump()
    await vi.advanceTimersByTimeAsync(0)
    f.queues['claude-code:adopted'] = f.queues[SID]
    delete f.queues[SID]
    f.move({ type: 'move', from: SID, to: 'claude-code:adopted' })
    expect(f.registry('claude-code:adopted')).toBe(f.entry)
    f.emit(f.failure())
    expect(f.queues['claude-code:adopted'][0]).toMatchObject({ id: 'a', status: 'failed' })
    expect(f.queues[SID]).toBeUndefined()
    f.move({ type: 'remove', keys: new Set(['claude-code:adopted']) })
    await vi.advanceTimersByTimeAsync(0)
    expect(f.close).toHaveBeenCalledTimes(1)
    f.registry.dispose()
  })

  it('clears ownership on completion and ignores later failures from another producer', async () => {
    const f = fixture()
    void f.entry.pump.pump()
    await vi.advanceTimersByTimeAsync(0)
    f.emit({ type: 'turn-complete', sessionId: SID })
    f.emit(f.failure())
    expect(f.queues[SID]).toEqual([])
    f.registry.dispose()
  })

  it('treats initial idle as a snapshot, not a turn edge', async () => {
    const f = fixture()
    void f.entry.pump.pump()
    await vi.advanceTimersByTimeAsync(0)
    f.emit({ type: 'status', sessionId: SID, status: 'idle', since: 1 })
    f.emit(f.failure())
    expect(f.queues[SID][0]?.status).toBe('failed')
    f.registry.dispose()
  })
  it('sends over HTTP when the observer never opens', async () => {
    const f = fixture(false)
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    void f.entry.pump.pump()
    await vi.advanceTimersByTimeAsync(750)
    expect(f.post).toHaveBeenCalledTimes(1)
    expect(f.queues[SID]).toEqual([])
    f.status('open')
    f.emit(f.failure())
    expect(f.queues[SID]).toEqual([])
    expect(warning).toHaveBeenCalled()
    warning.mockRestore()
    f.registry.dispose()
  })
  it('reuses the observer across sends with fresh clients for the same base and session', async () => {
    const f = fixture()
    const watch = vi.spyOn(f.gateway, 'watchHarnessSession')
    void f.entry.pump.pump()
    await vi.advanceTimersByTimeAsync(6_000)
    f.queues[SID].push({ id: 'b', text: 'again', status: 'queued' })
    f.entry.sink.current = async (_text, _interrupt, _attachments, _bypass, id) => {
      await f.entry.observe({ ...f.gateway }, SID, id)
    }
    void f.entry.pump.pump()
    await vi.advanceTimersByTimeAsync(0)
    expect(watch).toHaveBeenCalledTimes(1)
    expect(f.close).not.toHaveBeenCalled()
    f.registry.dispose()
  })
  it('closes after an unmounted delivery window expires and reopens on demand', async () => {
    const f = fixture()
    void f.entry.pump.pump()
    await vi.advanceTimersByTimeAsync(0)
    f.unmount()
    expect(f.close).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(DELIVERY_WINDOW_MS - 1)
    expect(f.close).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(f.close).toHaveBeenCalledTimes(1)
    f.status('closed')
    expect(f.queues[SID]).toEqual([])
    const unmount = f.entry.mount()
    await f.entry.observe(f.gateway, SID)
    unmount()
    await vi.advanceTimersByTimeAsync(0)
    expect(f.close).toHaveBeenCalledTimes(2)
    f.registry.dispose()
  })
  it.each(['unknown_session', 'invalid_session_id', 'capability_unsupported'])(
    'stops reconnecting for %s',
    async (code) => {
      const f = fixture()
      await f.entry.observe(f.gateway, SID)
      f.emit({ type: 'error', sessionId: SID, code, message: 'gone' })
      await vi.advanceTimersByTimeAsync(0)
      expect(f.close).toHaveBeenCalledTimes(1)
      f.registry.dispose()
    },
  )

  it('does not treat a blocked frame as delivery proof', async () => {
    const f = fixture()
    void f.entry.pump.pump()
    await vi.advanceTimersByTimeAsync(0)
    f.emit({ type: 'status', sessionId: SID, status: 'blocked', since: 1 })
    f.emit(f.failure())
    expect(f.queues[SID][0]?.status).toBe('failed')
    f.registry.dispose()
  })
  it('warns once for old den without assigning an uncorrelated failure', async () => {
    const f = fixture()
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    void f.entry.pump.pump()
    await vi.advanceTimersByTimeAsync(0)
    const failure = { ...f.failure(), deliveryId: undefined }
    f.emit(failure)
    f.emit(failure)
    expect(warning).toHaveBeenCalledTimes(1)
    expect(f.queues[SID]).toEqual([])
    warning.mockRestore()
    f.registry.dispose()
  })
})
