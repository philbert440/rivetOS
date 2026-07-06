/**
 * TaskCompletionWaiter — pure-poll mode tests (LISTEN is exercised by the
 * PG-gated suite; here the in-memory store drives the poll path).
 */

import { describe, it, expect } from 'vitest'
import { InMemoryTaskStore } from './store.js'
import { createTaskCompletionWaiter } from './completion-waiter.js'

const input = {
  goal: 'wait for me',
  executor: 'chat-loop' as const,
  agentId: 'opus',
  origin: 'mesh' as const,
}

describe('createTaskCompletionWaiter (poll mode)', () => {
  it('resolves with the terminal row once it finishes', async () => {
    const store = new InMemoryTaskStore()
    const waiter = createTaskCompletionWaiter({ store, pollFallbackMs: 10 })
    const row = await store.create(input)

    const wait = waiter.wait(row.id, { deadlineMs: 5_000 })
    await store.claim(row.id, 'node-b')
    await store.finish(row.id, 'completed', {
      verdict: 'completed',
      summary: 'done remotely',
      artifacts: [],
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, turns: 1, wallClockMs: 1 },
    })

    const terminal = await wait
    expect(terminal?.status).toBe('completed')
    expect(terminal?.result?.summary).toBe('done remotely')
    await waiter.stop()
  })

  it('returns undefined on deadline while the row is still queued', async () => {
    const store = new InMemoryTaskStore()
    const waiter = createTaskCompletionWaiter({ store, pollFallbackMs: 10 })
    const row = await store.create(input)
    const terminal = await waiter.wait(row.id, { deadlineMs: 50 })
    expect(terminal).toBeUndefined()
    expect((await store.get(row.id))?.status).toBe('queued')
    await waiter.stop()
  })

  it('stop() cancels an in-flight wait immediately', async () => {
    const store = new InMemoryTaskStore()
    const waiter = createTaskCompletionWaiter({ store, pollFallbackMs: 60_000 })
    const row = await store.create(input)
    const started = Date.now()
    const wait = waiter.wait(row.id, { deadlineMs: 600_000 })
    await new Promise((r) => setTimeout(r, 20))
    await waiter.stop()
    expect(await wait).toBeUndefined()
    expect(Date.now() - started).toBeLessThan(5_000)
  })

  it('two concurrent waits on the same task both resolve', async () => {
    const store = new InMemoryTaskStore()
    const waiter = createTaskCompletionWaiter({ store, pollFallbackMs: 10 })
    const row = await store.create(input)
    const waits = [
      waiter.wait(row.id, { deadlineMs: 5_000 }),
      waiter.wait(row.id, { deadlineMs: 5_000 }),
    ]
    await store.claim(row.id, 'node-b')
    await store.finish(row.id, 'completed', {
      verdict: 'completed',
      summary: 'both should see this',
      artifacts: [],
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, turns: 1, wallClockMs: 1 },
    })
    const [a, b] = await Promise.all(waits)
    expect(a?.status).toBe('completed')
    expect(b?.status).toBe('completed')
    await waiter.stop()
  })

  it('returns undefined for a missing row', async () => {
    const store = new InMemoryTaskStore()
    const waiter = createTaskCompletionWaiter({ store, pollFallbackMs: 10 })
    expect(await waiter.wait('nope', { deadlineMs: 100 })).toBeUndefined()
    await waiter.stop()
  })
})
