import { describe, expect, it } from 'vitest'
import type { NewTaskInput, TaskResult } from './store.js'
import { InMemoryTaskStore } from './store.js'
import { createPollingTaskRunner, type PollingTaskRunner } from './polling-runner.js'

function input(overrides?: Partial<NewTaskInput>): NewTaskInput {
  return {
    goal: 'run',
    executor: 'chat-loop',
    agentId: 'opus',
    origin: 'tool',
    ...overrides,
  }
}

const done: TaskResult = {
  verdict: 'completed',
  summary: 'ok',
  artifacts: [],
  usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, turns: 1, wallClockMs: 1 },
}

async function waitFor(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

describe('createPollingTaskRunner', () => {
  it('runs a queued row once', async () => {
    const seen: string[] = []
    let runner: PollingTaskRunner | undefined
    const store = new InMemoryTaskStore((id) => runner?.wake())
    runner = createPollingTaskRunner({
      store,
      nodeId: 'n1',
      concurrency: 2,
      pollIntervalMs: 60_000,
      handler: async (id) => {
        const row = await store.claim(id, 'n1')
        if (!row) return
        seen.push(id)
        await store.finish(id, 'completed', done)
      },
    })
    await runner.start()
    const task = await store.create(input())
    await waitFor(() => seen.length === 1)
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(seen).toEqual([task.id])
    expect((await store.get(task.id))?.status).toBe('completed')
    await runner.stop()
  })

  it('holds the concurrency cap', async () => {
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let started = 0
    let runner: PollingTaskRunner | undefined
    const store = new InMemoryTaskStore((id) => runner?.wake())
    runner = createPollingTaskRunner({
      store,
      nodeId: 'n1',
      concurrency: 2,
      pollIntervalMs: 60_000,
      handler: async (id) => {
        const row = await store.claim(id, 'n1')
        if (!row) return
        started += 1
        await gate
        await store.finish(id, 'completed', done)
      },
    })
    await runner.start()
    await store.create(input())
    await store.create(input())
    await store.create(input())
    await store.create(input())
    await waitFor(() => started === 2)
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(started).toBe(2)
    release()
    await waitFor(() => started === 4)
    await runner.stop()
  })

  it('stop waits for the in-flight handler', async () => {
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let entered = false
    let runner: PollingTaskRunner | undefined
    const store = new InMemoryTaskStore((id) => runner?.wake())
    runner = createPollingTaskRunner({
      store,
      nodeId: 'n1',
      pollIntervalMs: 60_000,
      handler: async (id) => {
        await store.claim(id, 'n1')
        entered = true
        await gate
        await store.finish(id, 'completed', done)
      },
    })
    await runner.start()
    await store.create(input())
    await waitFor(() => entered)
    let stopped = false
    const stopping = runner.stop().then(() => {
      stopped = true
    })
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(stopped).toBe(false)
    release()
    await stopping
    expect(stopped).toBe(true)
  })

  it('leaves another node’s row alone', async () => {
    const seen: string[] = []
    let runner: PollingTaskRunner | undefined
    const store = new InMemoryTaskStore((id) => runner?.wake())
    runner = createPollingTaskRunner({
      store,
      nodeId: 'n1',
      pollIntervalMs: 60_000,
      handler: async (id) => {
        seen.push(id)
        await store.claim(id, 'n1')
      },
    })
    await runner.start()
    const foreign = await store.create(input({ nodeAffinity: 'other' }))
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(seen).toEqual([])
    expect((await store.get(foreign.id))?.status).toBe('queued')
    await runner.stop()
  })

  it('dispatches awaiting-input only when a pending message is set', async () => {
    const seen: string[] = []
    let runner: PollingTaskRunner | undefined
    const store = new InMemoryTaskStore((id) => runner?.wake())
    runner = createPollingTaskRunner({
      store,
      nodeId: 'n1',
      pollIntervalMs: 60_000,
      handler: async (id) => {
        const row = await store.claim(id, 'n1')
        if (!row) return
        seen.push(id)
        await store.finish(id, 'completed', done)
      },
    })
    const task = await store.create(input())
    await store.claim(task.id, 'n1')
    await store.markAwaitingInput(task.id)
    await runner.start()
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(seen).toEqual([])
    expect((await store.get(task.id))?.status).toBe('awaiting-input')

    await store.send(task.id, 'go on')
    await waitFor(() => seen.length === 1)
    expect(seen).toEqual([task.id])
    expect((await store.get(task.id))?.status).toBe('completed')
    await runner.stop()
  })

  it('backs off after a handler rejection instead of spinning', async () => {
    const unhandled: unknown[] = []
    const onUnhandled = (err: unknown): void => {
      unhandled.push(err)
    }
    process.on('unhandledRejection', onUnhandled)
    const starts: number[] = []
    let runner: PollingTaskRunner | undefined
    const store = new InMemoryTaskStore((id) => runner?.wake())
    runner = createPollingTaskRunner({
      store,
      nodeId: 'n1',
      pollIntervalMs: 80,
      handler: async () => {
        starts.push(Date.now())
        throw new Error('boom')
      },
    })
    try {
      await runner.start()
      await store.create(input())
      await waitFor(() => starts.length >= 2, 2_000)
      expect(starts[1]! - starts[0]!).toBeGreaterThanOrEqual(50)
      expect(unhandled).toEqual([])
    } finally {
      process.off('unhandledRejection', onUnhandled)
      await runner.stop()
    }
  })

  it('keeps polling after a list failure', async () => {
    let runner: PollingTaskRunner | undefined
    const store = new InMemoryTaskStore((id) => runner?.wake())
    const list = store.list.bind(store)
    let failList = true
    store.list = (filter) => {
      if (failList) return Promise.reject(new Error('list broke'))
      return list(filter)
    }
    const seen: string[] = []
    runner = createPollingTaskRunner({
      store,
      nodeId: 'n1',
      pollIntervalMs: 30,
      handler: async (id) => {
        const row = await store.claim(id, 'n1')
        if (!row) return
        seen.push(id)
        await store.finish(id, 'completed', done)
      },
    })
    await runner.start()
    failList = false
    const task = await store.create(input())
    await waitFor(() => seen.length === 1)
    expect(seen).toEqual([task.id])
    await runner.stop()
  })
})
