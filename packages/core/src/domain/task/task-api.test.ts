/**
 * /api/tasks route family (G1) — driven end-to-end over a bare http server
 * with the InMemoryTaskStore, the real createTaskHandler, and the real
 * completion waiter (poll mode). The gateway mounts this same handler behind
 * its bearer gate (den-server tests cover the gate itself).
 */

import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { describe, it, expect, afterEach } from 'vitest'
import type {
  HarnessExecutor,
  HarnessExecutorCapabilities,
  TaskResult,
  TaskSpec,
} from '@rivetos/types'
import { InMemoryTaskStore } from './store.js'
import { createExecutorRegistry, createTaskHandler } from './runner.js'
import { createTaskCompletionWaiter, type TaskCompletionWaiter } from './completion-waiter.js'
import { createTaskApiRoute } from './task-api.js'

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

function fakeExecutor(opts?: { hang?: boolean; interactive?: boolean }): HarnessExecutor {
  return {
    name: 'fake',
    capabilities: () => caps,
    start(spec: TaskSpec, { signal }) {
      const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2, turns: 1, wallClockMs: 1 }
      const result: Promise<TaskResult> = opts?.hang
        ? new Promise((resolve) =>
            signal.addEventListener('abort', () =>
              resolve({ verdict: 'killed', summary: 'aborted', artifacts: [], usage }),
            ),
          )
        : Promise.resolve({
            verdict: 'completed',
            summary: `did: ${spec.resumeMessage ?? spec.goal}`,
            output: `did: ${spec.resumeMessage ?? spec.goal}`,
            artifacts: [],
            usage,
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

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn()
})

async function startApi(opts?: { hang?: boolean }): Promise<{
  base: string
  store: InMemoryTaskStore
  waiter: TaskCompletionWaiter
}> {
  const executors = createExecutorRegistry()
  executors.register('chat-loop', fakeExecutor(opts))
  let handler: (taskId: string) => Promise<void>
  const store = new InMemoryTaskStore((taskId) => {
    void handler(taskId)
  })
  handler = createTaskHandler({ store, executors, nodeId: 'test-node' })
  const waiter = createTaskCompletionWaiter({ store, pollFallbackMs: 10 })
  const route = createTaskApiRoute({ store, waiter })

  const server: Server = createServer((req, res) => {
    void route.handler(req, res)
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as AddressInfo).port
  cleanups.push(async () => {
    await waiter.stop()
    await new Promise((r) => server.close(r))
  })
  return { base: `http://127.0.0.1:${port}`, store, waiter }
}

const create = (base: string, body: unknown, query = '') =>
  fetch(`${base}/api/tasks${query}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

describe('/api/tasks', () => {
  it('POST creates a queued task (201) and GET /:id reads it back', async () => {
    const { base } = await startApi({ hang: true })
    const res = await create(base, { goal: 'do the thing', agentId: 'opus' })
    expect(res.status).toBe(201)
    const { task } = (await res.json()) as { task: { id: string; origin: string } }
    expect(task.origin).toBe('api')

    const read = await fetch(`${base}/api/tasks/${task.id}`)
    expect(read.status).toBe(200)
  })

  it('POST ?wait=1 returns the terminal row', async () => {
    const { base } = await startApi()
    const res = await create(base, { goal: 'quick one', agentId: 'opus' }, '?wait=1&timeoutMs=5000')
    expect(res.status).toBe(200)
    const { task } = (await res.json()) as {
      task: { status: string; result: { output: string } }
    }
    expect(task.status).toBe('completed')
    expect(task.result.output).toBe('did: quick one')
  })

  it('POST ?wait=1 deadline kills the task and answers 504 with the row', async () => {
    const { base, store } = await startApi({ hang: true })
    const res = await create(base, { goal: 'never ends', agentId: 'opus' }, '?wait=1&timeoutMs=50')
    expect(res.status).toBe(504)
    const { task } = (await res.json()) as { task: { id: string } }
    expect((await store.get(task.id))?.status).toBe('killed')
  })

  it('validates create bodies (400) and unknown statuses on list', async () => {
    const { base } = await startApi()
    expect((await create(base, { agentId: 'opus' })).status).toBe(400)
    expect((await create(base, { goal: 'x', agentId: 'opus', executor: 'wat' })).status).toBe(400)
    expect((await fetch(`${base}/api/tasks?status=wat`)).status).toBe(400)
  })

  it('GET lists with filters', async () => {
    const { base } = await startApi()
    await (await create(base, { goal: 'a', agentId: 'opus' }, '?wait=1&timeoutMs=5000')).json()
    const res = await fetch(`${base}/api/tasks?status=completed&agentId=opus`)
    const { tasks } = (await res.json()) as { tasks: unknown[] }
    expect(tasks).toHaveLength(1)
  })

  it('steer rejects terminal tasks (409); kill is idempotent (prior null)', async () => {
    const { base } = await startApi()
    const made = (await (
      await create(base, { goal: 'done fast', agentId: 'opus' }, '?wait=1&timeoutMs=5000')
    ).json()) as { task: { id: string } }
    const id = made.task.id

    const steer = await fetch(`${base}/api/tasks/${id}/steer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'more' }),
    })
    expect(steer.status).toBe(409)

    const kill = await fetch(`${base}/api/tasks/${id}/kill`, { method: 'POST' })
    expect(kill.status).toBe(200)
    expect(((await kill.json()) as { prior: string | null }).prior).toBeNull()
  })

  it('404 on unknown ids, 405 on unsupported methods', async () => {
    const { base } = await startApi()
    expect((await fetch(`${base}/api/tasks/nope`)).status).toBe(404)
    expect((await fetch(`${base}/api/tasks`, { method: 'DELETE' })).status).toBe(405)
  })
})
