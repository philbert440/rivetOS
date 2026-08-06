import { describe, it, expect, vi } from 'vitest'
import {
  createTaskAgentExecutor,
  mapTaskResultToOut,
  reportTaskUsage,
} from './agent-executor.js'
import type { TaskStore } from '../task/store.js'
import type { TaskCompletionWaiter } from '../task/completion-waiter.js'

describe('mapTaskResultToOut', () => {
  it('maps declared keys from an object output', () => {
    expect(mapTaskResultToOut(['a', 'b'], { a: 1, b: 2, extra: 3 })).toEqual({ a: 1, b: 2 })
  })

  it('missing keys stay null (never the whole blob)', () => {
    expect(mapTaskResultToOut(['a', 'b'], { a: 1 }, 'summary')).toEqual({ a: 1, b: null })
  })

  it('single declared key may fall back to summary', () => {
    expect(mapTaskResultToOut(['verdict'], {}, 'looks good')).toEqual({ verdict: 'looks good' })
    expect(mapTaskResultToOut(['verdict'], 'raw text')).toEqual({ verdict: 'raw text' })
  })

  it('empty out passes the object through / wraps scalars', () => {
    expect(mapTaskResultToOut([], { x: 1 })).toEqual({ x: 1 })
    expect(mapTaskResultToOut([], undefined, 'sum')).toEqual({ result: 'sum' })
  })
})

describe('createTaskAgentExecutor', () => {
  function harness(waitResult: unknown) {
    const store = {
      create: vi.fn().mockResolvedValue({ id: 'task-1' }),
      requestKill: vi.fn().mockResolvedValue('killed'),
    } as unknown as TaskStore
    const waiter = {
      wait: vi.fn().mockResolvedValue(waitResult),
    } as unknown as TaskCompletionWaiter
    const exec = createTaskAgentExecutor({ store, waiter, defaultAgentId: 'rivet' })
    return { store, waiter, exec }
  }

  const stepOpts = {
    label: 'work',
    stepId: 'work#1',
    out: ['result'],
    caseDir: '/tmp/nowhere',
    workflow: { manifest: { id: 'wf' }, dir: '', runPath: '', agents: {} },
  } as Parameters<ReturnType<typeof createTaskAgentExecutor>['execute']>[0]

  it('completed task maps output to out fields', async () => {
    const { exec } = harness({ status: 'completed', result: { output: { result: 'done!' } } })
    await expect(exec.execute(stepOpts)).resolves.toEqual({ result: 'done!' })
  })

  it('timeout requests a task kill before throwing', async () => {
    const { exec, store } = harness(undefined)
    await expect(exec.execute({ ...stepOpts, timeoutMs: 5 })).rejects.toThrow(/timed out/)
    expect(store.requestKill).toHaveBeenCalledWith('task-1')
  })

  it('failed task throws with the task error', async () => {
    const { exec } = harness({ status: 'failed', error: 'boom' })
    await expect(exec.execute(stepOpts)).rejects.toThrow(/boom/)
  })

  it('reports usage via reportUsage when the terminal task carries it', async () => {
    const reported: Array<{ tokens?: number; costUsd?: number }> = []
    const { exec } = harness({
      status: 'completed',
      result: { output: { result: 'ok' }, usage: { totalTokens: 42, costUsd: 0.01 } },
      usage: { totalTokens: 42, costUsd: 0.01 },
    })
    await expect(
      exec.execute({
        ...stepOpts,
        reportUsage: (u) => reported.push(u),
      }),
    ).resolves.toEqual({ result: 'ok' })
    expect(reported).toEqual([{ tokens: 42, costUsd: 0.01 }])
  })
})

describe('reportTaskUsage', () => {
  it('prefers row.usage and no-ops when nothing is present', () => {
    const calls: unknown[] = []
    reportTaskUsage((u) => calls.push(u), {
      usage: { totalTokens: 10, costUsd: 0.5 },
      result: { usage: { totalTokens: 99, costUsd: 9 } },
    })
    expect(calls).toEqual([{ tokens: 10, costUsd: 0.5 }])

    reportTaskUsage((u) => calls.push(u), {})
    expect(calls).toHaveLength(1)
  })
})

describe('mapTaskResultToOut — chat-loop string output (live path)', () => {
  it('parses a JSON-object string output into declared out fields', () => {
    expect(
      mapTaskResultToOut(
        ['verdict', 'summary'],
        '{"verdict":"approve","summary":"looks good"}',
      ),
    ).toEqual({ verdict: 'approve', summary: 'looks good' })
  })

  it('parses fenced / surrounded JSON and falls back to summary carrier', () => {
    expect(
      mapTaskResultToOut(
        ['pr', 'summary'],
        'Done!\n```json\n{"pr":"https://x/pull/9","summary":"opened"}\n```',
      ),
    ).toEqual({ pr: 'https://x/pull/9', summary: 'opened' })
    expect(
      mapTaskResultToOut(['plan'], 'no json here', '{"plan":"touch foo"}'),
    ).toEqual({ plan: 'touch foo' })
  })

  it('non-JSON string with multi-field out stays null-filled (no blob poisoning)', () => {
    expect(mapTaskResultToOut(['verdict', 'summary'], 'just prose')).toEqual({
      verdict: null,
      summary: null,
    })
  })
})
