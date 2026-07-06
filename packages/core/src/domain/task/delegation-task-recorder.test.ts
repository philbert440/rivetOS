/**
 * Task-backed delegation recorder — cutover step (e) mapping tests.
 */

import { describe, it, expect } from 'vitest'
import type { DelegationResult } from '@rivetos/types'
import { InMemoryTaskStore } from './store.js'
import { createTaskDelegationRecorder } from './delegation-task-recorder.js'

const request = {
  fromAgent: 'opus',
  toAgent: 'grok',
  task: 'summarize the thing',
}

function result(overrides?: Partial<DelegationResult>): DelegationResult {
  return {
    status: 'completed',
    response: 'the summary',
    iterations: 3,
    usage: { promptTokens: 100, completionTokens: 40 },
    toolsUsed: ['memory_search'],
    durationMs: 1234,
    ...overrides,
  }
}

describe('createTaskDelegationRecorder', () => {
  it('records a completed delegation as a terminal ros_tasks row with NO job', async () => {
    const enqueued: string[] = []
    const store = new InMemoryTaskStore((id) => enqueued.push(id))
    const recorder = createTaskDelegationRecorder(store)

    await recorder.record(request, result(), { chainDepth: 1, cached: false, startedAt: 123 })

    expect(enqueued).toHaveLength(0) // audit row must never execute
    const rows = await store.list()
    expect(rows).toHaveLength(1)
    const row = rows[0]
    expect(row.status).toBe('completed')
    expect(row.goal).toBe('summarize the thing')
    expect(row.agentId).toBe('grok')
    expect(row.requestedBy).toBe('opus')
    expect(row.origin).toBe('tool')
    expect(row.chainDepth).toBe(1)
    expect(row.spec).toMatchObject({ delegation: true, cached: false, toolsUsed: ['memory_search'] })
    expect(row.result?.output).toBe('the summary')
    expect(row.result?.usage).toEqual({
      inputTokens: 100,
      outputTokens: 40,
      totalTokens: 140,
      turns: 3,
      wallClockMs: 1234,
    })
    expect(row.durationMs).toBe(1234)
    expect(row.startedAt).toBe(123)
  })

  it('maps failed and timeout statuses; cached records as completed', async () => {
    const store = new InMemoryTaskStore()
    const recorder = createTaskDelegationRecorder(store)
    const opts = { chainDepth: 0, cached: false, startedAt: 1 }

    await recorder.record(request, result({ status: 'failed', response: 'boom' }), opts)
    await recorder.record(request, result({ status: 'timeout' }), opts)
    await recorder.record(request, result(), { ...opts, cached: true })

    const rows = await store.list()
    const statuses = rows.map((r) => r.status).sort()
    expect(statuses).toEqual(['completed', 'failed', 'timeout'])
    const failed = rows.find((r) => r.status === 'failed')
    expect(failed?.error).toBe('boom')
    const cached = rows.find((r) => r.spec.cached === true)
    expect(cached?.status).toBe('completed')
  })

  it('is best-effort: a store failure is swallowed, not thrown', async () => {
    const store = new InMemoryTaskStore()
    store.recordTerminal = () => Promise.reject(new Error('pg down'))
    const recorder = createTaskDelegationRecorder(store)
    await expect(
      recorder.record(request, result(), { chainDepth: 0, cached: false, startedAt: 1 }),
    ).resolves.toBeUndefined()
  })
})
