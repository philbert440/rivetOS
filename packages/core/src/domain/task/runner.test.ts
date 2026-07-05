/**
 * Task runner tests — createTaskHandler driven with a fake executor and the
 * in-memory store (the graphile-worker glue is exercised by the PG-gated
 * store tests; the handler is the interesting logic).
 */

import { describe, it, expect } from 'vitest'
import type {
  HarnessExecutor,
  HarnessExecutorCapabilities,
  TaskEvent,
  TaskResult,
  TaskSpec,
  TaskUsage,
} from '@rivetos/types'
import { InMemoryTaskStore, type NewTaskInput } from './store.js'
import { createExecutorRegistry, createTaskHandler } from './runner.js'

const caps: HarnessExecutorCapabilities = {
  steerable: true,
  multiTurn: true,
  structuredStream: true,
  usageInResult: true,
  sessionIdCapture: false,
  slashCommands: false,
  effortSelection: false,
  mcpInjection: 'none',
}

function usageFor(turn: number): TaskUsage {
  return {
    inputTokens: 10 * turn,
    outputTokens: 5 * turn,
    totalTokens: 15 * turn,
    turns: turn,
    wallClockMs: 100 * turn,
  }
}

interface FakeExecutorOptions {
  turns?: number
  verdict?: TaskResult['verdict']
}

/** Fake executor: emits `turns` turn.start/turn.end pairs, honoring abort
 *  between turns (→ verdict 'killed'), then resolves. Records steers. */
function makeFakeExecutor(opts?: FakeExecutorOptions): HarnessExecutor & {
  steers: string[]
  specs: TaskSpec[]
} {
  const turns = opts?.turns ?? 1
  const steers: string[] = []
  const specs: TaskSpec[] = []

  return {
    name: 'fake',
    steers,
    specs,
    capabilities: () => caps,
    start(spec, { signal }) {
      specs.push(spec)
      let resolveDone!: (r: TaskResult) => void
      const result = new Promise<TaskResult>((res) => (resolveDone = res))
      const queue: TaskEvent[] = []
      let notify: (() => void) | undefined
      let closed = false

      const push = (e: TaskEvent): void => {
        queue.push(e)
        notify?.()
      }

      void (async () => {
        let ranTurns = 0
        for (let t = 1; t <= turns; t++) {
          if (signal.aborted) break
          push({ ts: Date.now(), type: 'turn.start', turn: t })
          await new Promise((r) => setTimeout(r, 5))
          ranTurns = t
          push({ ts: Date.now(), type: 'turn.end', turn: t, usage: usageFor(t) })
          // Give the runner's event pump a beat to enforce the budget
          // between turns before we start the next one.
          await new Promise((r) => setTimeout(r, 10))
        }
        const aborted = signal.aborted
        closed = true
        notify?.()
        resolveDone({
          verdict: aborted ? 'killed' : (opts?.verdict ?? 'completed'),
          summary: aborted ? 'aborted' : 'all done',
          artifacts: [],
          usage: usageFor(ranTurns),
          error: aborted ? String(signal.reason) : undefined,
        })
      })()

      return {
        events: {
          [Symbol.asyncIterator](): AsyncIterator<TaskEvent> {
            return {
              async next(): Promise<IteratorResult<TaskEvent>> {
                for (;;) {
                  const e = queue.shift()
                  if (e) return { value: e, done: false }
                  if (closed) return { value: undefined, done: true }
                  await new Promise<void>((r) => (notify = r))
                }
              },
            }
          },
        },
        steer: (m: string) => {
          steers.push(m)
          return Promise.resolve()
        },
        kill: () => Promise.resolve(),
        result,
      }
    },
  }
}

function taskInput(overrides?: Partial<NewTaskInput>): NewTaskInput {
  return {
    goal: 'Do the thing',
    executor: 'chat-loop',
    agentId: 'opus',
    origin: 'tool',
    ...overrides,
  }
}

function wire(executor: HarnessExecutor): {
  store: InMemoryTaskStore
  handler: (taskId: string) => Promise<void>
} {
  const store = new InMemoryTaskStore()
  const executors = createExecutorRegistry()
  executors.register('chat-loop', executor)
  const handler = createTaskHandler({ store, executors, nodeId: 'test-node' })
  return { store, handler }
}

describe('createTaskHandler', () => {
  it('happy path: claim → execute → finish completed with usage', async () => {
    const fake = makeFakeExecutor({ turns: 2 })
    const { store, handler } = wire(fake)
    const task = await store.create(taskInput({ budget: { maxTurns: 10 } }))

    await handler(task.id)

    const row = await store.get(task.id)
    expect(row?.status).toBe('completed')
    expect(row?.result?.verdict).toBe('completed')
    expect(row?.result?.summary).toBe('all done')
    expect(row?.usage?.turns).toBe(2)
    expect(row?.lastHeartbeatAt).toBeDefined()
    expect(fake.specs[0].goal).toBe('Do the thing')
    expect(fake.specs[0].session.agentId).toBe('opus')
  })

  it('is a no-op for a task that is already terminal (claim CAS loses)', async () => {
    const fake = makeFakeExecutor()
    const { store, handler } = wire(fake)
    const task = await store.create(taskInput())
    await store.claim(task.id, 'someone-else')
    await handler(task.id)
    expect(fake.specs).toHaveLength(0)
  })

  it('fails the task when no executor is registered for its kind', async () => {
    const store = new InMemoryTaskStore()
    const handler = createTaskHandler({
      store,
      executors: createExecutorRegistry(),
      nodeId: 'test-node',
    })
    const task = await store.create(taskInput())
    await handler(task.id)
    const row = await store.get(task.id)
    expect(row?.status).toBe('failed')
    expect(row?.error).toBe('executor_not_registered')
  })

  it('budget exceeded between turns: aborts, verdict budget-exceeded, status killed', async () => {
    const fake = makeFakeExecutor({ turns: 5 })
    const { store, handler } = wire(fake)
    const task = await store.create(taskInput({ budget: { maxTurns: 2 } }))

    await handler(task.id)

    const row = await store.get(task.id)
    expect(row?.status).toBe('killed')
    expect(row?.result?.verdict).toBe('budget-exceeded')
    expect(row?.result?.error).toMatch(/budget-exceeded/)
    // The executor was aborted before running all 5 turns.
    expect(row?.usage?.turns).toBeLessThan(5)
  })

  it('interactive task flips to awaiting-input, send resumes via steer', async () => {
    const fake = makeFakeExecutor()
    const { store, handler } = wire(fake)
    const task = await store.create(taskInput({ spec: { interactive: true } }))

    await handler(task.id)
    expect((await store.get(task.id))?.status).toBe('awaiting-input')

    await store.send(task.id, 'now do the next bit')
    await handler(task.id)

    const row = await store.get(task.id)
    expect(row?.status).toBe('awaiting-input') // still interactive — parks again
    expect(fake.steers).toEqual(['now do the next bit'])
    expect(fake.specs).toHaveLength(2)
  })
})
