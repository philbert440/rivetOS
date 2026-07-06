/**
 * Task runner tests — createTaskHandler driven with a fake executor and the
 * in-memory store (the graphile-worker glue is exercised by the PG-gated
 * store tests; the handler is the interesting logic).
 */

import { describe, it, expect, vi } from 'vitest'
import type {
  HarnessExecutor,
  HarnessExecutorCapabilities,
  TaskEvent,
  TaskResult,
  TaskSpec,
  TaskUsage,
} from '@rivetos/types'
import { InMemoryTaskStore, type NewTaskInput, type TaskStore } from './store.js'
import { createExecutorRegistry, createTaskHandler, createTaskRunner } from './runner.js'

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
  /** Called at each start() — lets tests interleave store writes mid-run. */
  onStart?: (spec: TaskSpec, callIndex: number) => void | Promise<void>
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
        await opts?.onStart?.(spec, specs.length - 1)
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

function wire(
  executor: HarnessExecutor,
  store = new InMemoryTaskStore(),
): {
  store: InMemoryTaskStore
  handler: (taskId: string) => Promise<void>
} {
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

  it('interactive task flips to awaiting-input; send resumes with resumeMessage, not goal', async () => {
    const fake = makeFakeExecutor()
    const { store, handler } = wire(fake)
    const task = await store.create(taskInput({ spec: { interactive: true } }))

    await handler(task.id)
    expect((await store.get(task.id))?.status).toBe('awaiting-input')
    expect(fake.specs[0].resumeMessage).toBeUndefined()

    await store.send(task.id, 'now do the next bit')
    await handler(task.id)

    const row = await store.get(task.id)
    expect(row?.status).toBe('awaiting-input') // still interactive — parks again
    expect(row?.pendingMessage).toBeUndefined() // consumed, not replayed
    expect(fake.specs).toHaveLength(2)
    // P3: the stashed message drives the resumed run INSTEAD of the goal.
    expect(fake.specs[1].resumeMessage).toBe('now do the next bit')
  })

  it('a send racing the park attempt is consumed, not lost (P2)', async () => {
    const store = new InMemoryTaskStore()
    let taskId = ''
    const fake = makeFakeExecutor({
      // First run: a steer lands while the executor is still working —
      // after this run completes, the park attempt must refuse and the
      // handler must continue with the raced message.
      onStart: async (_spec, callIndex) => {
        if (callIndex === 0) await store.send(taskId, 'raced steer')
      },
    })
    const { handler } = wire(fake, store)
    const task = await store.create(taskInput({ spec: { interactive: true } }))
    taskId = task.id

    await handler(task.id)

    const row = await store.get(task.id)
    expect(row?.status).toBe('awaiting-input') // second run parked cleanly
    expect(row?.pendingMessage).toBeUndefined()
    expect(fake.specs).toHaveLength(2)
    expect(fake.specs[1].resumeMessage).toBe('raced steer')
  })

  it('a store failure after claim fails the task instead of stranding it running (P4)', async () => {
    const fake = makeFakeExecutor()
    const store = new InMemoryTaskStore()
    store.updateUsage = () => Promise.reject(new Error('pg blipped'))
    const { handler } = wire(fake, store)
    const task = await store.create(taskInput())

    await handler(task.id) // must not throw

    const row = await store.get(task.id)
    expect(row?.status).toBe('failed')
    expect(row?.error).toBe('pg blipped')
  })

  it('heartbeats periodically while a task executes (P5)', async () => {
    const fake = makeFakeExecutor({ turns: 4 }) // ~60ms of work
    const store = new InMemoryTaskStore()
    const heartbeats: string[] = []
    const realHeartbeat = store.heartbeat.bind(store)
    store.heartbeat = (id) => {
      heartbeats.push(id)
      return realHeartbeat(id)
    }
    const executors = createExecutorRegistry()
    executors.register('chat-loop', fake)
    const handler = createTaskHandler({
      store,
      executors,
      nodeId: 'test-node',
      heartbeatIntervalMs: 10,
    })
    const task = await store.create(taskInput())

    await handler(task.id)

    expect(heartbeats.length).toBeGreaterThanOrEqual(2)
    expect(heartbeats.every((id) => id === task.id)).toBe(true)
  })
})

describe('createTaskRunner start() guards (P1)', () => {
  function stubStore(overrides: Partial<TaskStore>): TaskStore {
    const base = new InMemoryTaskStore()
    return Object.assign(base, overrides) as TaskStore
  }

  it('no-ops (never throws) when sweep reports the relation missing', async () => {
    const relationMissing = Object.assign(
      new Error('relation "ros_tasks" does not exist'),
      { code: '42P01' },
    )
    const store = stubStore({ sweep: () => Promise.reject(relationMissing) })
    const runner = createTaskRunner({
      // Unreachable on purpose — start() must return before connecting.
      pgUrl: 'postgres://nobody:nope@127.0.0.1:1/does-not-exist',
      store,
      executors: createExecutorRegistry(),
      nodeId: 'test-node',
    })

    await expect(runner.start()).resolves.toBeUndefined()
    await runner.stop()
  })

  it('no-ops when isReady() reports the table missing', async () => {
    const sweep = vi.fn()
    const store = stubStore({
      isReady: () => Promise.resolve(false),
      sweep: sweep as unknown as TaskStore['sweep'],
    })
    const runner = createTaskRunner({
      pgUrl: 'postgres://nobody:nope@127.0.0.1:1/does-not-exist',
      store,
      executors: createExecutorRegistry(),
      nodeId: 'test-node',
    })

    await expect(runner.start()).resolves.toBeUndefined()
    expect(sweep).not.toHaveBeenCalled() // disabled before sweeping
    await runner.stop()
  })
})

describe('stranding interim (Appendix E)', () => {
  it('claim refusal on a foreign-affinity row re-enqueues it per-node', async () => {
    const reenqueued: string[] = []
    const store = new InMemoryTaskStore()
    store.reenqueue = (id: string) => {
      reenqueued.push(id)
      return Promise.resolve()
    }
    const { handler } = wire(makeFakeExecutor(), store)
    const pinned = await store.create(taskInput({ nodeAffinity: 'other-node' }))

    await handler(pinned.id) // this runner is 'test-node' — claim refuses
    expect(reenqueued).toEqual([pinned.id])
    expect((await store.get(pinned.id))?.status).toBe('queued')
  })
})
