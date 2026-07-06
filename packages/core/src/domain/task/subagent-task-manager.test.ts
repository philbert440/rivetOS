/**
 * TaskBackedSubagentManager — behavior-equivalence tests for cutover step (d).
 *
 * Drives the manager end-to-end against the InMemoryTaskStore with the real
 * createTaskHandler and a fake chat-loop executor, asserting the legacy
 * SubagentManager semantics hold: spawn validation errors, status mapping,
 * send guards, resume-without-goal-replay, kill-discards-result, list
 * filtering.
 */

import { describe, it, expect, vi } from 'vitest'
import type {
  HarnessExecutor,
  HarnessExecutorCapabilities,
  TaskEvent,
  TaskResult,
  TaskSpec,
} from '@rivetos/types'
import { InMemoryTaskStore } from './store.js'
import { createExecutorRegistry, createTaskHandler } from './runner.js'
import { TaskBackedSubagentManager } from './subagent-task-manager.js'
import type { Router } from '../router.js'

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

/** One-turn fake executor: responds with `response`, records the spec. */
function makeFakeExecutor(response = 'sub-agent says hi'): HarnessExecutor & {
  specs: TaskSpec[]
} {
  const specs: TaskSpec[] = []
  return {
    name: 'fake',
    specs,
    capabilities: () => caps,
    start(spec) {
      specs.push(spec)
      const usage = {
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
        turns: 1,
        wallClockMs: 5,
      }
      const events: TaskEvent[] = [
        { ts: Date.now(), type: 'turn.start', turn: 1 },
        { ts: Date.now(), type: 'turn.end', turn: 1, usage },
      ]
      const result: TaskResult = {
        verdict: 'completed',
        summary: response,
        output: response,
        artifacts: [],
        usage,
      }
      return {
        events: (async function* () {
          for (const e of events) yield e
          await Promise.resolve()
        })(),
        steer: () => Promise.resolve(),
        kill: () => Promise.resolve(),
        result: Promise.resolve(result),
      }
    },
  }
}

function mockRouter(): Router {
  return {
    getAgents: () => [{ id: 'opus', name: 'opus', provider: 'anthropic' }],
    getProviders: () => [{ id: 'anthropic' }],
    registerAgent: vi.fn(),
    registerProvider: vi.fn(),
  } as unknown as Router
}

/**
 * Wire manager + store + handler. The store's enqueue callback runs the
 * handler on a microtask, standing in for graphile-worker; `settle()` waits
 * for all queued runs to finish.
 */
function wire(executor: HarnessExecutor = makeFakeExecutor()) {
  const pending: Promise<void>[] = []
  const executors = createExecutorRegistry()
  executors.register('chat-loop', executor)
  let handler: (taskId: string) => Promise<void>
  const store = new InMemoryTaskStore((taskId) => {
    pending.push(handler(taskId))
  })
  handler = createTaskHandler({ store, executors, nodeId: 'test-node' })
  const manager = new TaskBackedSubagentManager({ router: mockRouter(), store })
  const settle = async (): Promise<void> => {
    while (pending.length > 0) {
      await pending.splice(0).reduce((p, c) => p.then(() => c), Promise.resolve())
    }
  }
  return { manager, store, settle }
}

describe('TaskBackedSubagentManager', () => {
  it('spawn validates agent and provider like the legacy manager', async () => {
    const { manager } = wire()
    await expect(manager.spawn({ agent: 'nope', task: 'x' })).rejects.toThrow(/Unknown agent/)
  })

  it('spawn returns a running session; turn end parks it as completed with lastResponse', async () => {
    const { manager, settle } = wire(makeFakeExecutor('all wrapped up'))
    const session = await manager.spawn({ agent: 'opus', task: 'do the thing' })
    expect(session.status).toBe('running')
    expect(session.childAgent).toBe('opus')
    expect(session.provider).toBe('anthropic')

    await settle()
    const status = await manager.status(session.id)
    expect(status.status).toBe('completed')
    expect(status.lastResponse).toBe('all wrapped up')
    expect(status.iterations).toBe(1)
    expect(status.usage).toEqual({ promptTokens: 10, completionTokens: 5 })
  })

  it('send on a parked session resumes with the message, never replaying the goal', async () => {
    const executor = makeFakeExecutor()
    const { manager, settle } = wire(executor)
    const session = await manager.spawn({ agent: 'opus', task: 'THE GOAL' })
    await settle()

    await manager.send(session.id, 'follow-up question')
    await settle()

    expect(executor.specs).toHaveLength(2)
    expect(executor.specs[0].resumeMessage).toBeUndefined()
    expect(executor.specs[1].resumeMessage).toBe('follow-up question')
    const status = await manager.status(session.id)
    expect(status.status).toBe('completed')
  })

  it('send guards: running rejects, failed rejects, missing rejects', async () => {
    const failing: HarnessExecutor = {
      ...makeFakeExecutor(),
      start(spec) {
        const handle = makeFakeExecutor().start(spec, {
          signal: new AbortController().signal,
        })
        return {
          ...handle,
          result: handle.result.then((r) => ({ ...r, verdict: 'failed' as const, error: 'boom' })),
        }
      },
    }
    const { manager, settle } = wire(failing)
    const session = await manager.spawn({ agent: 'opus', task: 'x' })
    // Queued (not yet claimed) maps to running — send must reject.
    await expect(manager.send(session.id, 'too soon')).rejects.toThrow(/still running/)
    await settle()
    await expect(manager.send(session.id, 'after failure')).rejects.toThrow(/has failed/)
    await expect(manager.send('missing', 'x')).rejects.toThrow(/not found/)
  })

  it('kill on a parked session flips it to failed (killed) and send rejects', async () => {
    const { manager, settle } = wire()
    const session = await manager.spawn({ agent: 'opus', task: 'x' })
    await settle()
    await manager.kill(session.id)
    const status = await manager.status(session.id)
    expect(status.status).toBe('failed')
    await expect(manager.send(session.id, 'zombie')).rejects.toThrow(/has failed/)
  })

  it('kill during a running turn discards the outcome (row stays killed)', async () => {
    // The kill lands while the turn is in flight: the executor itself flips
    // the row via requestKill before resolving, mimicking a concurrent
    // subagent_kill racing the turn.
    let storeRef: InMemoryTaskStore | undefined
    const executor = makeFakeExecutor()
    const slow: HarnessExecutor = {
      ...executor,
      start(spec, opts) {
        const handle = executor.start(spec, opts)
        return {
          ...handle,
          result: (async () => {
            await storeRef?.requestKill(spec.taskId)
            return handle.result
          })(),
        }
      },
    }
    const { manager, store, settle } = wire(slow)
    storeRef = store
    const session = await manager.spawn({ agent: 'opus', task: 'x' })
    await settle()
    const row = await store.get(session.id)
    expect(row?.status).toBe('killed')
    expect(row?.result?.verdict).toBe('killed')
    const status = await manager.status(session.id)
    expect(status.status).toBe('failed')
  })

  it('kill on a terminal session is a no-op, kill on missing throws', async () => {
    const { manager, settle } = wire()
    const session = await manager.spawn({ agent: 'opus', task: 'x' })
    await settle()
    await manager.kill(session.id)
    await expect(manager.kill(session.id)).resolves.toBeUndefined()
    await expect(manager.kill('missing')).rejects.toThrow(/not found/)
  })

  it('list returns only subagent-marker tasks', async () => {
    const { manager, store, settle } = wire()
    await manager.spawn({ agent: 'opus', task: 'mine' })
    await store.create({
      goal: 'not a subagent',
      executor: 'chat-loop',
      agentId: 'opus',
      origin: 'tool',
    })
    await settle()
    const sessions = await manager.list()
    expect(sessions).toHaveLength(1)
    expect(sessions[0].childAgent).toBe('opus')
  })

  it('kill stamps the legacy error text and status surfaces it', async () => {
    const { manager, settle } = wire()
    const session = await manager.spawn({ agent: 'opus', task: 'x' })
    await settle()
    await manager.kill(session.id)
    const status = await manager.status(session.id)
    expect(status.error).toBe('Killed by parent')
  })

  it('elapsed freezes when a session parks', async () => {
    const { manager, store, settle } = wire()
    const session = await manager.spawn({ agent: 'opus', task: 'x' })
    await settle()
    const row = await store.get(session.id)
    expect(row?.status).toBe('awaiting-input')
    expect(row?.durationMs).toBeDefined()
    const status = await manager.status(session.id)
    expect(status.elapsedMs).toBe(row?.durationMs)
    await new Promise((r) => setTimeout(r, 15))
    const later = await manager.status(session.id)
    expect(later.elapsedMs).toBe(status.elapsedMs)
  })

  it('list hydrates history from the task memory conversation', async () => {
    const memory = {
      getSessionHistory: vi.fn(async (key: string) =>
        key.startsWith('task:')
          ? [
              { role: 'user' as const, content: 'q' },
              { role: 'assistant' as const, content: 'a' },
            ]
          : [],
      ),
    }
    const executors = createExecutorRegistry()
    executors.register('chat-loop', makeFakeExecutor())
    const store = new InMemoryTaskStore()
    const manager = new TaskBackedSubagentManager({ router: mockRouter(), store, memory })
    await manager.spawn({ agent: 'opus', task: 'x' })
    const sessions = await manager.list()
    expect(sessions[0].history).toHaveLength(2)
  })

  it('spawn stamps timeoutMs as budget.maxWallClockMs and the subagent marker', async () => {
    const { manager, store } = wire()
    const session = await manager.spawn({ agent: 'opus', task: 'x', timeoutMs: 5000 })
    const row = await store.get(session.id)
    expect(row?.budget.maxWallClockMs).toBe(5000)
    expect(row?.spec).toMatchObject({ interactive: true, subagent: true })
    expect(row?.maxAttempts).toBe(1)
  })
})
