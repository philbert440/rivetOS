/**
 * TaskDoneBroadcaster — hook-only mode plus a stubbed LISTEN client.
 * A live Postgres NOTIFY is not required here.
 */

import { describe, expect, it, vi } from 'vitest'
import type { Client } from 'pg'
import type { NotificationFrame } from '@rivetos/types'
import { InMemoryTaskStore } from './store.js'
import { createTaskDoneBroadcaster } from './task-done-broadcaster.js'

const input = {
  goal: 'finish me',
  executor: 'chat-loop' as const,
  agentId: 'opus',
  origin: 'tool' as const,
}

const usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0, turns: 1, wallClockMs: 1 }

class FakeClient {
  readonly connect = vi.fn(async () => undefined)
  readonly query = vi.fn(async () => ({ rows: [] }))
  readonly end = vi.fn(async () => undefined)
  private listeners = new Map<string, (arg: never) => void>()

  on(event: string, cb: (arg: never) => void): this {
    this.listeners.set(event, cb)
    return this
  }

  notify(payload: string, channel = 'ros_task_done'): void {
    this.listeners.get('notification')?.({ channel, payload } as never)
  }

  fail(err: Error): void {
    this.listeners.get('error')?.(err as never)
  }
}

function asClient(fake: FakeClient): Client {
  return fake as unknown as Client
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve))
}

describe('createTaskDoneBroadcaster', () => {
  it('emits once for a terminal row via onTaskFinished', async () => {
    const store = new InMemoryTaskStore()
    const task = await store.create(input)
    await store.finish(task.id, 'completed', {
      verdict: 'completed',
      summary: 'done',
      artifacts: [],
      usage,
    })
    const frames: NotificationFrame[] = []
    const broadcaster = createTaskDoneBroadcaster({
      store,
      broadcast: (frame) => {
        frames.push(frame)
      },
      now: () => 42,
    })

    await broadcaster.onTaskFinished(task.id)

    expect(frames).toEqual([{ kind: 'task.done', taskId: task.id, status: 'completed', ts: 42 }])
    await broadcaster.stop()
  })

  it('ignores unknown ids and non-terminal rows', async () => {
    const store = new InMemoryTaskStore()
    const queued = await store.create(input)
    const frames: NotificationFrame[] = []
    const broadcaster = createTaskDoneBroadcaster({
      store,
      broadcast: (frame) => {
        frames.push(frame)
      },
      now: () => 1,
    })

    await broadcaster.onTaskFinished('missing')
    await broadcaster.onTaskFinished(queued.id)
    await store.claim(queued.id, 'n')
    await broadcaster.onTaskFinished(queued.id)

    expect(frames).toEqual([])
    await broadcaster.stop()
  })

  it('dedupes a second call', async () => {
    const store = new InMemoryTaskStore()
    const task = await store.create(input)
    await store.finish(task.id, 'failed', {
      verdict: 'failed',
      summary: 'nope',
      artifacts: [],
      usage,
    })
    const frames: NotificationFrame[] = []
    const broadcaster = createTaskDoneBroadcaster({
      store,
      broadcast: (frame) => {
        frames.push(frame)
      },
      now: () => 7,
    })

    await broadcaster.onTaskFinished(task.id)
    await broadcaster.onTaskFinished(task.id)

    expect(frames).toEqual([{ kind: 'task.done', taskId: task.id, status: 'failed', ts: 7 }])
    await broadcaster.stop()
  })

  it('broadcast throwing does not reject', async () => {
    const store = new InMemoryTaskStore()
    const task = await store.create(input)
    await store.finish(task.id, 'killed', {
      verdict: 'killed',
      summary: 'stopped',
      artifacts: [],
      usage,
    })
    const broadcaster = createTaskDoneBroadcaster({
      store,
      broadcast: () => {
        throw new Error('ws down')
      },
      now: () => 1,
    })

    await expect(broadcaster.onTaskFinished(task.id)).resolves.toBeUndefined()
    await broadcaster.stop()
  })

  it('stop() is idempotent', async () => {
    const store = new InMemoryTaskStore()
    const broadcaster = createTaskDoneBroadcaster({
      store,
      broadcast: () => undefined,
    })
    await broadcaster.start()
    await broadcaster.stop()
    await expect(broadcaster.stop()).resolves.toBeUndefined()
  })

  it('does not create a pg client when pgUrl is omitted', async () => {
    const store = new InMemoryTaskStore()
    const clientFactory = vi.fn((): Client => {
      throw new Error('pg.Client should not be constructed')
    })
    const broadcaster = createTaskDoneBroadcaster({
      store,
      broadcast: () => undefined,
      clientFactory,
    })

    await broadcaster.start()
    await broadcaster.onTaskFinished('nope')

    expect(clientFactory).not.toHaveBeenCalled()
    await broadcaster.stop()
  })

  it('emits a LISTEN notification and dedupes the runner hook', async () => {
    const store = new InMemoryTaskStore()
    const task = await store.create(input)
    await store.finish(task.id, 'timeout', {
      verdict: 'timeout',
      summary: 'too slow',
      artifacts: [],
      usage,
    })
    const fake = new FakeClient()
    const frames: NotificationFrame[] = []
    const broadcaster = createTaskDoneBroadcaster({
      store,
      broadcast: (frame) => {
        frames.push(frame)
      },
      pgUrl: 'postgres://localhost/unused',
      now: () => 9,
      clientFactory: () => asClient(fake),
    })

    await broadcaster.start()
    expect(fake.connect).toHaveBeenCalledOnce()
    expect(fake.query).toHaveBeenCalledWith('LISTEN ros_task_done')

    fake.notify(task.id)
    await broadcaster.onTaskFinished(task.id)
    fake.notify('other', 'not_the_channel')
    await settle()

    expect(frames).toEqual([{ kind: 'task.done', taskId: task.id, status: 'timeout', ts: 9 }])
    await broadcaster.stop()
    expect(fake.end).toHaveBeenCalledOnce()
    await broadcaster.stop()
    expect(fake.end).toHaveBeenCalledOnce()
  })

  it('start() does not throw when connect fails and retries with backoff until stop', async () => {
    vi.useFakeTimers()
    try {
      const factory = vi.fn((): Client => {
        throw new Error('connect refused')
      })
      const broadcaster = createTaskDoneBroadcaster({
        store: new InMemoryTaskStore(),
        broadcast: () => undefined,
        pgUrl: 'postgres://localhost/nope',
        clientFactory: factory,
      })

      await expect(broadcaster.start()).resolves.toBeUndefined()
      expect(factory).toHaveBeenCalledTimes(1)

      await vi.advanceTimersByTimeAsync(999)
      expect(factory).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(1)
      expect(factory).toHaveBeenCalledTimes(2)

      await broadcaster.stop()
      await broadcaster.stop()
      await vi.advanceTimersByTimeAsync(30_000)
      expect(factory).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('stop() ends a client whose connect() never settles and does not reconnect', async () => {
    vi.useFakeTimers()
    try {
      const fake = new FakeClient()
      fake.connect.mockImplementation(() => new Promise<void>(() => undefined))
      const factory = vi.fn(() => asClient(fake))
      const broadcaster = createTaskDoneBroadcaster({
        store: new InMemoryTaskStore(),
        broadcast: () => undefined,
        pgUrl: 'postgres://localhost/unused',
        clientFactory: factory,
      })

      void broadcaster.start()
      const stopped = broadcaster.stop()
      expect(fake.end).toHaveBeenCalledOnce()

      await vi.advanceTimersByTimeAsync(1_000)
      await stopped
      await vi.advanceTimersByTimeAsync(60_000)
      expect(factory).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('stop() ends a client whose LISTEN query never settles and does not reconnect', async () => {
    vi.useFakeTimers()
    try {
      const fake = new FakeClient()
      fake.query.mockImplementation(() => new Promise(() => undefined))
      const factory = vi.fn(() => asClient(fake))
      const broadcaster = createTaskDoneBroadcaster({
        store: new InMemoryTaskStore(),
        broadcast: () => undefined,
        pgUrl: 'postgres://localhost/unused',
        clientFactory: factory,
      })

      void broadcaster.start()
      await Promise.resolve()
      await Promise.resolve()
      expect(fake.connect).toHaveBeenCalledOnce()
      expect(fake.query).toHaveBeenCalledWith('LISTEN ros_task_done')

      const stopped = broadcaster.stop()
      expect(fake.end).toHaveBeenCalledOnce()

      await vi.advanceTimersByTimeAsync(1_000)
      await stopped
      await vi.advanceTimersByTimeAsync(60_000)
      expect(factory).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not broadcast a lookup that resolves after stop()', async () => {
    const store = new InMemoryTaskStore()
    const task = await store.create(input)
    await store.finish(task.id, 'completed', {
      verdict: 'completed',
      summary: 'done',
      artifacts: [],
      usage,
    })
    const row = await store.get(task.id)
    let release: (value: typeof row) => void = () => undefined
    const get = vi.spyOn(store, 'get').mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve
        }),
    )
    const frames: NotificationFrame[] = []
    const broadcaster = createTaskDoneBroadcaster({
      store,
      broadcast: (frame) => {
        frames.push(frame)
      },
      now: () => 5,
    })

    const pending = broadcaster.onTaskFinished(task.id)
    await broadcaster.stop()
    release(row)
    await pending
    await broadcaster.onTaskFinished(task.id)

    expect(frames).toEqual([])
    expect(get).toHaveBeenCalledOnce()
  })

  it('reconnects after a live client error with backoff capped at 30s', async () => {
    vi.useFakeTimers()
    try {
      const live = new FakeClient()
      let created = 0
      const factory = vi.fn((): Client => {
        created += 1
        if (created === 1) return asClient(live)
        throw new Error('reconnect refused')
      })
      const broadcaster = createTaskDoneBroadcaster({
        store: new InMemoryTaskStore(),
        broadcast: () => undefined,
        pgUrl: 'postgres://localhost/unused',
        clientFactory: factory,
      })

      await broadcaster.start()
      expect(factory).toHaveBeenCalledTimes(1)

      live.fail(new Error('socket reset'))
      expect(live.end).toHaveBeenCalledOnce()
      expect(factory).toHaveBeenCalledTimes(1)

      // First retry is 1s after the drop; later failures double until 30s.
      const steps = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]
      let expected = 1
      for (const delay of steps) {
        await vi.advanceTimersByTimeAsync(delay - 1)
        expect(factory).toHaveBeenCalledTimes(expected)
        await vi.advanceTimersByTimeAsync(1)
        expected += 1
        expect(factory).toHaveBeenCalledTimes(expected)
      }

      await broadcaster.stop()
      await vi.advanceTimersByTimeAsync(60_000)
      expect(factory).toHaveBeenCalledTimes(expected)
    } finally {
      vi.useRealTimers()
    }
  })
})
