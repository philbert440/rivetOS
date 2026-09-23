import { describe, expect, it, vi } from 'vitest'
import type { HarnessEvent, SessionId } from '@rivetos/types'
import type { OutboundItem } from '../stores/chat.js'
import type { DeliveryGateway } from './outbound-delivery.js'
import {
  createOutboundPumpRegistry,
  type OutboundPumpStore,
  type ThreadLifecycleEvent,
} from './outbound-pump.js'

const SID: SessionId = 'claude-code:a'

function fixture() {
  const queues: Record<string, OutboundItem[]> = {
    [SID]: [{ id: 'a', text: 'hello', status: 'queued' }],
  }
  let move!: (event: ThreadLifecycleEvent) => void
  let emit!: (event: HarnessEvent) => void
  let status!: (value: 'connecting' | 'open' | 'closed') => void
  let deliveryId = ''
  const close = vi.fn()
  const gateway: DeliveryGateway = {
    watchHarnessSession: (_sid, listener, opts) => {
      emit = listener
      status = opts!.onStatus!
      status('open')
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
    awaitBusy: async () => {},
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
  const inject = vi.fn(async (_text, _interrupt, _attachments, _bypass, id) => {
    await entry.observe(gateway, SID)
    deliveryId = id
  })
  entry.sink.current = inject
  return {
    queues,
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
  it.each(['undelivered', 'disconnect'] as const)(
    'preserves %s after the sending view unmounts',
    async (edge) => {
      const f = fixture()
      await f.entry.pump.pump()
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
      await f.entry.pump.pump()
      expect(f.inject).toHaveBeenCalledTimes(1)
      f.registry.dispose()
      expect(f.close).toHaveBeenCalledTimes(1)
    },
  )

  it('restores to the adopted key across rekey and disposes the watcher on removal', async () => {
    const f = fixture()
    await f.entry.pump.pump()
    f.queues['claude-code:adopted'] = f.queues[SID]
    delete f.queues[SID]
    f.move({ type: 'move', from: SID, to: 'claude-code:adopted' })
    expect(f.registry('claude-code:adopted')).toBe(f.entry)
    f.emit(f.failure())
    expect(f.queues['claude-code:adopted'][0]).toMatchObject({ id: 'a', status: 'failed' })
    expect(f.queues[SID]).toBeUndefined()
    f.move({ type: 'remove', keys: new Set(['claude-code:adopted']) })
    expect(f.close).toHaveBeenCalledTimes(1)
    f.registry.dispose()
  })

  it('clears ownership on completion and ignores later failures from another producer', async () => {
    const f = fixture()
    await f.entry.pump.pump()
    f.emit({ type: 'turn-complete', sessionId: SID })
    f.emit(f.failure())
    expect(f.queues[SID]).toEqual([])
    f.registry.dispose()
  })

  it('treats initial idle as a snapshot, not a turn edge', async () => {
    const f = fixture()
    await f.entry.pump.pump()
    f.emit({ type: 'status', sessionId: SID, status: 'idle', since: 1 })
    f.emit(f.failure())
    expect(f.queues[SID][0]?.status).toBe('failed')
    f.registry.dispose()
  })
})
