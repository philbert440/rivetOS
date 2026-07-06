/**
 * Heartbeat-as-task integration tests (cutover step (f)) — the poll →
 * terminal → delivery loop driven end-to-end against InMemoryTaskStore and
 * the real createTaskHandler, per the #265 review ask.
 */

import { describe, it, expect, vi } from 'vitest'
import type { HeartbeatConfig } from '@rivetos/types'
import { InMemoryTaskStore } from './store.js'
import { createExecutorRegistry, createTaskHandler } from './runner.js'
import { runHeartbeatViaTasks } from './heartbeat-task.js'
import type {
  HarnessExecutor,
  HarnessExecutorCapabilities,
  TaskResult,
  TaskSpec,
} from '@rivetos/types'

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

function fakeExecutor(opts?: {
  verdict?: TaskResult['verdict']
  response?: string
  hang?: boolean
}): HarnessExecutor & { specs: TaskSpec[] } {
  const specs: TaskSpec[] = []
  return {
    name: 'fake',
    specs,
    capabilities: () => caps,
    start(spec, { signal }) {
      specs.push(spec)
      const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2, turns: 1, wallClockMs: 1 }
      const result: Promise<TaskResult> = opts?.hang
        ? new Promise((resolve) => {
            // Resolve only on abort — a hung turn that honors kill.
            signal.addEventListener('abort', () =>
              resolve({
                verdict: 'killed',
                summary: 'aborted',
                artifacts: [],
                usage,
                error: 'aborted',
              }),
            )
          })
        : Promise.resolve({
            verdict: opts?.verdict ?? 'completed',
            summary: opts?.response ?? 'tick response',
            output: opts?.response ?? 'tick response',
            artifacts: [],
            usage,
            error: opts?.verdict === 'failed' ? 'boom' : undefined,
          })
      return {
        events: (async function* () {
          await Promise.resolve()
        })(),
        steer: () => Promise.resolve(),
        kill: () => Promise.resolve(),
        result,
      }
    },
  }
}

function wire(executor: HarnessExecutor) {
  const executors = createExecutorRegistry()
  executors.register('chat-loop', executor)
  let handler: (taskId: string) => Promise<void>
  const store = new InMemoryTaskStore((taskId) => {
    void handler(taskId)
  })
  handler = createTaskHandler({ store, executors, nodeId: 'test-node' })
  return store
}

const hb: HeartbeatConfig = {
  agent: 'opus',
  prompt: 'daily tick',
  outputChannel: 'chan-1',
} as HeartbeatConfig

describe('runHeartbeatViaTasks', () => {
  it('creates the row, waits for terminal, delivers the output', async () => {
    const executor = fakeExecutor({ response: 'all quiet' })
    const store = wire(executor)
    const deliver = vi.fn(async () => {})

    await runHeartbeatViaTasks(hb, {
      store,
      turnTimeoutMs: 5_000,
      deliver,
      pollIntervalMs: 10,
    })

    expect(deliver).toHaveBeenCalledWith(hb, 'all quiet')
    const rows = await store.list()
    expect(rows).toHaveLength(1)
    expect(rows[0].origin).toBe('heartbeat')
    expect(rows[0].status).toBe('completed')
    expect(rows[0].spec.promptMode).toBe('heartbeat')
    expect(rows[0].maxAttempts).toBe(1)
    expect(executor.specs[0].promptMode).toBe('heartbeat')
  })

  it('failed run: no delivery, row records the failure', async () => {
    const store = wire(fakeExecutor({ verdict: 'failed' }))
    const deliver = vi.fn(async () => {})
    await runHeartbeatViaTasks(hb, { store, turnTimeoutMs: 5_000, deliver, pollIntervalMs: 10 })
    expect(deliver).not.toHaveBeenCalled()
    expect((await store.list())[0].status).toBe('failed')
  })

  it('deadline: kills the row before releasing the slot — no overlap window', async () => {
    const store = wire(fakeExecutor({ hang: true }))
    const deliver = vi.fn(async () => {})
    await runHeartbeatViaTasks(hb, {
      store,
      // Deadline = turnTimeoutMs + 60s; use a negative bound so the first
      // poll is already past it while the fake turn hangs.
      turnTimeoutMs: -61_000,
      deliver,
      pollIntervalMs: 10,
    })
    expect(deliver).not.toHaveBeenCalled()
    const row = (await store.list())[0]
    expect(row.status).toBe('killed')
  })
})
