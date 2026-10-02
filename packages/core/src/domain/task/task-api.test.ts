/**
 * /api/tasks route family (G1) — driven end-to-end over a bare http server
 * with the InMemoryTaskStore, the real createTaskHandler, and the real
 * completion waiter (poll mode). The gateway mounts this same handler behind
 * its bearer gate (den-server tests cover the gate itself).
 */

import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect, afterEach, vi } from 'vitest'
import type {
  AgentPreset,
  HarnessExecutor,
  HarnessExecutorCapabilities,
  MeshNode,
  MeshRegistry,
  TaskResult,
  TaskSpec,
} from '@rivetos/types'
import { InMemoryTaskStore } from './store.js'
import { createExecutorRegistry, createTaskHandler } from './runner.js'
import { createNotImplementedHarnessExecutor } from './harness-executors.js'
import { createTaskCompletionWaiter, type TaskCompletionWaiter } from './completion-waiter.js'
import { createTaskApiRoute } from './task-api.js'
import { TaskPermissionBroker } from './permission-broker.js'
import type { PresetHostContext } from '../preset-delegation.js'

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

async function startApi(opts?: {
  hang?: boolean
  criteriaPolicy?: import('./criteria.js').CriteriaPolicy
  localQueueNode?: string
  /** When set, the route parks permission prompts on a broker over this store. */
  brokerTimeoutMs?: number
}): Promise<{
  base: string
  store: InMemoryTaskStore
  waiter: TaskCompletionWaiter
  broker?: TaskPermissionBroker
}> {
  const executors = createExecutorRegistry()
  executors.register('chat-loop', fakeExecutor(opts))
  let handler: (taskId: string) => Promise<void>
  const store = new InMemoryTaskStore((taskId) => {
    void handler(taskId)
  })
  handler = createTaskHandler({ store, executors, nodeId: 'test-node' })
  const waiter = createTaskCompletionWaiter({ store, pollFallbackMs: 10 })
  const broker =
    opts?.brokerTimeoutMs !== undefined
      ? new TaskPermissionBroker({ store, timeoutMs: opts.brokerTimeoutMs })
      : undefined
  const route = createTaskApiRoute({
    store,
    waiter,
    criteriaPolicy: opts?.criteriaPolicy,
    localQueueNode: opts?.localQueueNode,
    permissionBroker: broker,
  })

  const server: Server = createServer((req, res) => {
    void route.handler(req, res)
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as AddressInfo).port
  cleanups.push(async () => {
    await waiter.stop()
    await new Promise((r) => server.close(r))
  })
  return { base: `http://127.0.0.1:${port}`, store, waiter, broker }
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

  it('criteria policy (2b): require_criteria 400s empty creates, accepts explicit; malformed criteria 400 even with policy off', async () => {
    const { criteriaPolicyFromConfig } = await import('./criteria.js')
    const { base } = await startApi({ criteriaPolicy: criteriaPolicyFromConfig({ enabled: true }) })
    const empty = await create(base, { goal: 'g', agentId: 'a' })
    expect(empty.status).toBe(400)
    expect(((await empty.json()) as { error: string }).error).toContain('acceptanceCriteria')

    const ok = await create(base, {
      goal: 'g',
      agentId: 'a',
      acceptanceCriteria: [{ id: 'c1', description: 'done' }],
    })
    expect(ok.status).toBe(201)
    const { task } = (await ok.json()) as {
      task: { acceptanceCriteria: Array<{ id: string; kind: string }> }
    }
    expect(task.acceptanceCriteria).toEqual([{ id: 'c1', description: 'done', kind: 'manual' }])

    const { base: offBase } = await startApi()
    const malformed = await create(offBase, {
      goal: 'g',
      agentId: 'a',
      acceptanceCriteria: [{ id: '' }],
    })
    expect(malformed.status).toBe(400)
    const legacyEmpty = await create(offBase, { goal: 'g', agentId: 'a' })
    expect(legacyEmpty.status).toBe(201)
  })

  it('validates create bodies (400) and unknown statuses on list', async () => {
    const { base } = await startApi()
    expect((await create(base, { agentId: 'opus' })).status).toBe(400)
    expect((await create(base, { goal: 'x', agentId: 'opus', executor: 'wat' })).status).toBe(400)
    expect((await fetch(`${base}/api/tasks?status=wat`)).status).toBe(400)
  })

  it('stamps parent depth + 1 when the parent row exists', async () => {
    const { base, store } = await startApi({ hang: true })
    const parent = await store.create({
      goal: 'parent',
      agentId: 'opus',
      executor: 'chat-loop',
      origin: 'api',
      chainDepth: 2,
    })
    const res = await create(base, { goal: 'child', agentId: 'opus', parentTaskId: parent.id })
    expect(res.status).toBe(201)
    const { task } = (await res.json()) as { task: { chainDepth: number; parentTaskId?: string } }
    expect(task.chainDepth).toBe(3)
    expect(task.parentTaskId).toBe(parent.id)
  })

  it('stamps depth 1 and omits parentTaskId when the parent is missing', async () => {
    const { base } = await startApi({ hang: true })
    const res = await create(base, {
      goal: 'child',
      agentId: 'opus',
      parentTaskId: '00000000-0000-4000-8000-000000000099',
    })
    expect(res.status).toBe(201)
    const { task } = (await res.json()) as { task: { chainDepth: number; parentTaskId?: string } }
    expect(task.chainDepth).toBe(1)
    expect(task.parentTaskId).toBeUndefined()
  })

  it('creates at depth 3 without a parent for a malformed parentTaskId', async () => {
    const { base } = await startApi({ hang: true })
    const res = await create(base, { goal: 'child', agentId: 'opus', parentTaskId: 'not-a-uuid' })
    expect(res.status).toBe(201)
    const { task } = (await res.json()) as { task: { chainDepth: number; parentTaskId?: string } }
    expect(task.chainDepth).toBe(3)
    expect(task.parentTaskId).toBeUndefined()
  })

  it('lets an explicit chainDepth win over the parent lookup', async () => {
    const { base, store } = await startApi({ hang: true })
    const parent = await store.create({
      goal: 'parent',
      agentId: 'opus',
      executor: 'chat-loop',
      origin: 'api',
      chainDepth: 0,
    })
    const res = await create(base, {
      goal: 'child',
      agentId: 'opus',
      parentTaskId: parent.id,
      chainDepth: 2,
    })
    expect(res.status).toBe(201)
    const { task } = (await res.json()) as { task: { chainDepth: number; parentTaskId?: string } }
    expect(task.chainDepth).toBe(2)
    expect(task.parentTaskId).toBe(parent.id)
  })

  it('refuses depth 4 with the delegation-chain message', async () => {
    const { base, store } = await startApi({ hang: true })
    const explicit = await create(base, { goal: 'too deep', agentId: 'opus', chainDepth: 4 })
    expect(explicit.status).toBe(409)
    expect(await explicit.json()).toEqual({ error: 'delegation chain too deep (4 > 3)' })

    const parent = await store.create({
      goal: 'parent',
      agentId: 'opus',
      executor: 'chat-loop',
      origin: 'api',
      chainDepth: 3,
    })
    const fromParent = await create(base, {
      goal: 'child',
      agentId: 'opus',
      parentTaskId: parent.id,
    })
    expect(fromParent.status).toBe(409)
    expect(await fromParent.json()).toEqual({ error: 'delegation chain too deep (4 > 3)' })
  })

  it('400s a negative or non-numeric chainDepth', async () => {
    const { base } = await startApi({ hang: true })
    expect((await create(base, { goal: 'g', agentId: 'opus', chainDepth: -1 })).status).toBe(400)
    expect((await create(base, { goal: 'g', agentId: 'opus', chainDepth: 'x' })).status).toBe(400)
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

  it('GET /:id/wait resolves immediately on an already-terminal row (no kill)', async () => {
    const { base, store } = await startApi()
    const made = (await (
      await create(base, { goal: 'fast', agentId: 'opus' }, '?wait=1&timeoutMs=5000')
    ).json()) as { task: { id: string } }
    const res = await fetch(`${base}/api/tasks/${made.task.id}/wait?timeoutMs=50`)
    expect(res.status).toBe(200)
    expect((await store.get(made.task.id))?.status).toBe('completed')
  })

  it('GET /:id/wait deadline answers 504 WITHOUT killing (observer semantics)', async () => {
    const { base, store } = await startApi({ hang: true })
    const made = (await (await create(base, { goal: 'slow', agentId: 'opus' })).json()) as {
      task: { id: string }
    }
    const res = await fetch(`${base}/api/tasks/${made.task.id}/wait?timeoutMs=50`)
    expect(res.status).toBe(504)
    expect((await store.get(made.task.id))?.status).not.toBe('killed')
  })

  it('rejects oversized bodies with 413', async () => {
    const { base } = await startApi()
    const res = await create(base, {
      goal: 'x'.repeat(300 * 1024),
      agentId: 'opus',
    })
    expect(res.status).toBe(413)
  })

  it('404 on unknown ids, 405 on unsupported methods', async () => {
    const { base } = await startApi()
    expect((await fetch(`${base}/api/tasks/00000000-0000-0000-0000-000000000000`)).status).toBe(404)
    expect((await fetch(`${base}/api/tasks`, { method: 'DELETE' })).status).toBe(405)
  })

  it.each(['', '/wait', '/kill', '/steer'])(
    'rejects malformed task IDs before reading the store (%s)',
    async (action) => {
      const { base, store } = await startApi()
      const get = vi.spyOn(store, 'get')
      const response = await fetch(`${base}/api/tasks/not-a-uuid${action}`, {
        method: ['/kill', '/steer'].includes(action) ? 'POST' : 'GET',
      })
      expect(response.status).toBe(400)
      expect(await response.json()).toEqual({ error: 'Invalid task ID. Check the task link.' })
      expect(get).not.toHaveBeenCalled()
    },
  )
})

describe('agent-aware dispatch (resolveAffinity)', () => {
  async function startWithResolver() {
    const executors = createExecutorRegistry()
    executors.register('chat-loop', fakeExecutor({ hang: true }))
    const store = new InMemoryTaskStore()
    const waiter = createTaskCompletionWaiter({ store, pollFallbackMs: 10 })
    const route = createTaskApiRoute({
      store,
      waiter,
      resolveAffinity: async (agentId) =>
        agentId === 'local-agent'
          ? 'this-node'
          : agentId === 'remote-agent'
            ? 'node-c'
            : { error: `agent "${agentId}" not found locally or on the mesh` },
    })
    const server: Server = createServer((req, res) => {
      void route.handler(req, res)
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const port = (server.address() as AddressInfo).port
    cleanups.push(async () => {
      await waiter.stop()
      await new Promise((r) => server.close(r))
    })
    return { base: `http://127.0.0.1:${port}`, store }
  }

  it('pins unpinned creates to the resolved node', async () => {
    const { base, store } = await startWithResolver()
    const res = await create(base, { goal: 'x', agentId: 'remote-agent' })
    expect(res.status).toBe(201)
    const { task } = (await res.json()) as { task: { id: string } }
    expect((await store.get(task.id))?.nodeAffinity).toBe('node-c')
  })

  it('explicit nodeAffinity wins over the resolver', async () => {
    const { base, store } = await startWithResolver()
    const res = await create(base, { goal: 'x', agentId: 'remote-agent', nodeAffinity: 'node-d' })
    const { task } = (await res.json()) as { task: { id: string } }
    expect((await store.get(task.id))?.nodeAffinity).toBe('node-d')
  })

  it('a local queue rejects another node before inserting', async () => {
    const { base, store } = await startApi({ localQueueNode: 'test-node' })
    const denied = await create(base, { goal: 'x', agentId: 'opus', nodeAffinity: 'other' })
    expect(denied.status).toBe(400)
    const body = (await denied.json()) as { error: string }
    expect(body.error).toContain('no shared task queue')
    expect(await store.list()).toHaveLength(0)
    const ok = await create(base, { goal: 'x', agentId: 'opus', nodeAffinity: 'test-node' })
    expect(ok.status).toBe(201)
  })

  it('unknown agents 400 instead of creating a doomed row', async () => {
    const { base, store } = await startWithResolver()
    const res = await create(base, { goal: 'x', agentId: 'nobody' })
    expect(res.status).toBe(400)
    expect(await store.list()).toHaveLength(0)
  })

  function presetMesh(nodes: MeshNode[]): MeshRegistry {
    return {
      register: async () => undefined,
      deregister: async () => undefined,
      heartbeat: async () => undefined,
      getNodes: async () => nodes,
      getNode: async (id) => nodes.find((n) => n.id === id),
      findByAgent: async () => [],
      findByCapability: async () => [],
      findByProvider: async () => [],
      sync: async () => undefined,
      prune: async () => [],
    }
  }

  function reviewerPreset(overrides: Partial<AgentPreset> = {}): AgentPreset {
    return {
      id: 'preset-reviewer',
      name: 'reviewer',
      color: '',
      harnessId: 'claude-code',
      model: 'opus',
      effort: 'high',
      systemPrompt: 'be strict',
      node: 'node-g',
      directory: '/home/rivet/.rivetos/agents/reviewer',
      nodeBaseUrl: '',
      createdAt: 1,
      updatedAt: 1,
      ...overrides,
    }
  }

  async function startPresetApi(opts: {
    preset: AgentPreset
    presetHost?: PresetHostContext
    resolveAffinity?: boolean
    /** runtime agent id → online nodes hosting it (newest first) */
    runtimeAgents?: Record<string, string[]>
  }): Promise<{ base: string; store: InMemoryTaskStore }> {
    const store = new InMemoryTaskStore()
    const waiter = createTaskCompletionWaiter({ store, pollFallbackMs: 10 })
    const route = createTaskApiRoute({
      store,
      waiter,
      resolvePreset: async (agentId) =>
        agentId === opts.preset.name || agentId === opts.preset.id ? opts.preset : undefined,
      presetHost: opts.presetHost,
      resolveRuntimeAgent: opts.runtimeAgents
        ? async (agentId, node) => {
            const hosts = opts.runtimeAgents?.[agentId] ?? []
            return node ? hosts.find((h) => h === node) : hosts.at(0)
          }
        : undefined,
      resolveAffinity: opts.resolveAffinity
        ? async (agentId) =>
            agentId === 'local-agent'
              ? 'this-node'
              : { error: `agent "${agentId}" not found locally or on the mesh` }
        : undefined,
    })
    const server: Server = createServer((req, res) => {
      void route.handler(req, res)
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const port = (server.address() as AddressInfo).port
    cleanups.push(async () => {
      await waiter.stop()
      await new Promise((r) => server.close(r))
    })
    return { base: `http://127.0.0.1:${port}`, store }
  }

  it('a preset with no harness does not shadow a runtime agent of the same name', async () => {
    // "Grok" (no harness) next to runtime `grok`: the request means the runtime agent.
    const { base, store } = await startPresetApi({
      preset: reviewerPreset({ id: 'preset-grok', name: 'grok', harnessId: undefined }),
      presetHost: { nodeName: 'node-f', meshRegistry: presetMesh([]) },
      runtimeAgents: { grok: ['node-c'] },
    })
    const res = await create(base, { goal: 'search', agentId: 'grok' })
    expect(res.status).toBe(201)
    const { task } = (await res.json()) as { task: { id: string } }
    const row = await store.get(task.id)
    expect(row).toMatchObject({ executor: 'chat-loop', agentId: 'grok', nodeAffinity: 'node-c' })
    expect(row?.executorTarget).toBeUndefined()
    expect((row?.spec as { presetId?: string } | undefined)?.presetId).toBeUndefined()
  })

  it('the shadow fix also fires for the capitalised preset spelling, and stores the runtime id', async () => {
    // The preset store matches case-insensitively, so "Grok" resolves the preset;
    // the runtime agent id is `grok`.
    const store = new InMemoryTaskStore()
    const waiter = createTaskCompletionWaiter({ store, pollFallbackMs: 10 })
    const grok = reviewerPreset({ id: 'preset-grok', name: 'Grok', harnessId: undefined })
    const route = createTaskApiRoute({
      store,
      waiter,
      resolvePreset: async (agentId) => (agentId.toLowerCase() === 'grok' ? grok : undefined),
      presetHost: { nodeName: 'node-f', meshRegistry: presetMesh([]) },
      resolveRuntimeAgent: async (agentId, node) =>
        agentId === 'grok' && (!node || node === 'node-c') ? 'node-c' : undefined,
    })
    const server: Server = createServer((req, res) => {
      void route.handler(req, res)
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    cleanups.push(async () => {
      await waiter.stop()
      await new Promise((r) => server.close(r))
    })
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

    const res = await create(base, { goal: 'search', agentId: 'Grok' })
    expect(res.status).toBe(201)
    const { task } = (await res.json()) as { task: { id: string } }
    expect(await store.get(task.id)).toMatchObject({
      executor: 'chat-loop',
      agentId: 'grok',
      nodeAffinity: 'node-c',
    })

    // a client nodeAffinity is validated: the agent is not hosted there → 400, no row
    const wrong = await create(base, { goal: 'search', agentId: 'grok', nodeAffinity: 'node-x' })
    expect(wrong.status).toBe(400)
    expect(((await wrong.json()) as { error: string }).error).toBe(
      'runtime agent "grok" is not hosted on an online node "node-x"',
    )
    // …and one that does host it is accepted
    const right = await create(base, { goal: 'search', agentId: 'grok', nodeAffinity: 'node-c' })
    expect(right.status).toBe(201)
  })

  it('a preset with no harness and no runtime agent of that name still refuses as itself', async () => {
    const { base } = await startPresetApi({
      preset: reviewerPreset({ harnessId: undefined }),
      presetHost: { nodeName: 'node-f', meshRegistry: presetMesh([]) },
      runtimeAgents: {},
    })
    const res = await create(base, { goal: 'review', agentId: 'reviewer' })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toContain('no harness configured')
  })

  it('agent@node pins a runtime agent to a node that hosts it, and refuses one that does not', async () => {
    const { base, store } = await startPresetApi({
      preset: reviewerPreset(),
      runtimeAgents: { grok: ['node-new', 'node-c'] },
    })
    const res = await create(base, { goal: 'search', agentId: 'grok@node-c' })
    expect(res.status).toBe(201)
    const { task } = (await res.json()) as { task: { id: string } }
    expect(await store.get(task.id)).toMatchObject({
      executor: 'chat-loop',
      agentId: 'grok',
      nodeAffinity: 'node-c',
    })
    const bad = await create(base, { goal: 'search', agentId: 'grok@node-zzz' })
    expect(bad.status).toBe(400)
    expect(((await bad.json()) as { error: string }).error).toBe(
      'runtime agent "grok" is not hosted on an online node "node-zzz"',
    )
    // a pin that contradicts an explicit nodeAffinity is refused rather than silently resolved
    const clash = await create(base, {
      goal: 'search',
      agentId: 'grok@node-c',
      nodeAffinity: 'node-new',
    })
    expect(clash.status).toBe(400)
    expect(((await clash.json()) as { error: string }).error).toContain('pins node "node-c"')
    // a preset name wins over the pin syntax: the full string is tried as a preset first
    const preset = await create(base, { goal: 'review', agentId: 'reviewer' })
    expect(preset.status).toBe(201)
  })

  it('a preset create builds the harness-session row, not a chat-loop row', async () => {
    const reviewer = reviewerPreset()
    const host: MeshNode = {
      id: 'node-g',
      name: 'node-g',
      agents: [],
      host: '10.0.0.1',
      port: 3000,
      providers: [],
      models: [],
      capabilities: [],
      status: 'online',
      lastSeen: 1,
      registeredAt: 1,
      version: '0.1.0',
      metadata: { harnessExecutors: ['claude-code'] },
    }
    const { base, store } = await startPresetApi({
      preset: reviewer,
      presetHost: { nodeName: 'node-f', meshRegistry: presetMesh([host]) },
    })
    const res = await create(base, { goal: 'review the diff', agentId: 'reviewer' })
    expect(res.status).toBe(201)
    const { task } = (await res.json()) as { task: { id: string } }
    const row = await store.get(task.id)
    expect(row).toMatchObject({
      executor: 'harness-session',
      executorTarget: 'claude-code',
      agentId: reviewer.id,
      nodeAffinity: reviewer.node,
      origin: 'api',
      goal: 'review the diff',
    })
    expect(row?.spec).toMatchObject({
      presetId: reviewer.id,
      presetName: 'reviewer',
      workingDir: reviewer.directory,
      sharedLink: true,
      model: 'opus',
      effort: 'high',
      systemPromptAppend: 'be strict',
      excludeTools: ['delegate_task'],
    })
    expect(row?.spec.delegation).toBeUndefined()
    expect(row?.spec.meshFrom).toBeUndefined()
  })

  it('a body model wins over the preset model', async () => {
    const reviewer = reviewerPreset()
    const host: MeshNode = {
      id: 'node-g',
      name: 'node-g',
      agents: [],
      host: '10.0.0.1',
      port: 3000,
      providers: [],
      models: [],
      capabilities: [],
      status: 'online',
      lastSeen: 1,
      registeredAt: 1,
      version: '0.1.0',
      metadata: { harnessExecutors: ['claude-code'] },
    }
    const { base, store } = await startPresetApi({
      preset: reviewer,
      presetHost: { nodeName: 'node-f', meshRegistry: presetMesh([host]) },
    })
    const res = await create(base, {
      goal: 'review',
      agentId: 'reviewer',
      spec: { model: 'haiku' },
    })
    expect(res.status).toBe(201)
    const { task } = (await res.json()) as { task: { id: string } }
    expect((await store.get(task.id))?.spec.model).toBe('haiku')
  })

  it('blank model is dropped and the preset owns effort and systemPromptAppend', async () => {
    const reviewer = reviewerPreset()
    const host: MeshNode = {
      id: 'node-g',
      name: 'node-g',
      agents: [],
      host: '10.0.0.1',
      port: 3000,
      providers: [],
      models: [],
      capabilities: [],
      status: 'online',
      lastSeen: 1,
      registeredAt: 1,
      version: '0.1.0',
      metadata: { harnessExecutors: ['claude-code'] },
    }
    const { base, store } = await startPresetApi({
      preset: reviewer,
      presetHost: { nodeName: 'node-f', meshRegistry: presetMesh([host]) },
    })
    const res = await create(base, {
      goal: 'review',
      agentId: 'reviewer',
      spec: {
        model: '  ',
        effort: 'low',
        systemPromptAppend: 'from the client',
        tools: ['memory_search'],
        workingDir: '/tmp/not-the-preset',
        presetId: 'forged',
        delegation: true,
        meshFrom: 'ct999',
      },
    })
    expect(res.status).toBe(201)
    const { task } = (await res.json()) as { task: { id: string } }
    const spec = (await store.get(task.id))?.spec
    expect(spec?.model).toBeUndefined()
    expect(spec?.effort).toBe('high')
    expect(spec?.systemPromptAppend).toBe('be strict')
    expect(spec?.tools).toEqual(['memory_search'])
    expect(spec?.workingDir).toBe(reviewer.directory)
    expect(spec?.presetId).toBe(reviewer.id)
    expect(spec?.delegation).toBeUndefined()
    expect(spec?.meshFrom).toBeUndefined()
  })

  it('strips a forged parent, spawned session, and owner from the create body', async () => {
    const reviewer = reviewerPreset()
    const host: MeshNode = {
      id: 'node-g',
      name: 'node-g',
      agents: [],
      host: '10.0.0.1',
      port: 3000,
      providers: [],
      models: [],
      capabilities: [],
      status: 'online',
      lastSeen: 1,
      registeredAt: 1,
      version: '0.1.0',
      metadata: { harnessExecutors: ['claude-code'] },
    }
    const { base, store } = await startPresetApi({
      preset: reviewer,
      presetHost: { nodeName: 'node-f', meshRegistry: presetMesh([host]) },
    })
    const res = await create(base, {
      goal: 'review',
      agentId: 'reviewer',
      spec: {
        parentSessionId: 'claude-code:forged',
        spawnedSessionId: 'forged-session',
        spawnedAgentName: 'forged-name',
        spawnedModel: 'forged-model',
        owner: 'forged-owner',
        tools: ['memory_search'],
      },
    })
    expect(res.status).toBe(201)
    const { task } = (await res.json()) as { task: { id: string } }
    const spec = (await store.get(task.id))?.spec
    expect(spec?.parentSessionId).toBeUndefined()
    expect(spec?.spawnedSessionId).toBeUndefined()
    expect(spec?.spawnedAgentName).toBeUndefined()
    expect(spec?.spawnedModel).toBeUndefined()
    expect(spec?.owner).toBeUndefined()
    expect(spec?.tools).toEqual(['memory_search'])
    expect(spec?.presetId).toBe(reviewer.id)
  })

  it('an explicit executor strips a forged parent, spawned session, and owner', async () => {
    const { base, store } = await startPresetApi({ preset: reviewerPreset() })
    const res = await create(base, {
      goal: 'review',
      agentId: 'reviewer',
      executor: 'chat-loop',
      spec: {
        parentSessionId: 'claude-code:forged',
        spawnedSessionId: 'forged-session',
        spawnedAgentName: 'forged-name',
        spawnedModel: 'forged-model',
        owner: 'forged-owner',
        tools: ['memory_search'],
      },
    })
    expect(res.status).toBe(201)
    const { task } = (await res.json()) as { task: { id: string } }
    const row = await store.get(task.id)
    expect(row?.executor).toBe('chat-loop')
    expect(row?.executorTarget).toBeUndefined()
    const spec = row?.spec
    expect(spec?.parentSessionId).toBeUndefined()
    expect(spec?.spawnedSessionId).toBeUndefined()
    expect(spec?.spawnedAgentName).toBeUndefined()
    expect(spec?.spawnedModel).toBeUndefined()
    expect(spec?.owner).toBeUndefined()
    expect(spec?.tools).toEqual(['memory_search'])
    expect(spec?.presetId).toBeUndefined()
  })

  it('an unimplemented preset is 400 with the gap text and creates no row', async () => {
    const reviewer = reviewerPreset({ harnessId: 'codex', node: 'node-f' })
    const executors = createExecutorRegistry()
    executors.register(
      'harness-session',
      createNotImplementedHarnessExecutor('codex', { reason: 'binary not resolvable' }),
      'codex',
    )
    const { base, store } = await startPresetApi({
      preset: reviewer,
      presetHost: { nodeName: 'node-f', executors },
    })
    const res = await create(base, { goal: 'review', agentId: 'reviewer' })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string }
    expect(body.error).toContain('agent "reviewer" (codex on this node):')
    expect(body.error).toContain('binary not resolvable')
    expect(await store.list()).toHaveLength(0)
  })

  it('an offline hosting node is 409', async () => {
    const reviewer = reviewerPreset({ node: 'node-g' })
    const host: MeshNode = {
      id: 'node-g',
      name: 'node-g',
      agents: [],
      host: '10.0.0.1',
      port: 3000,
      providers: [],
      models: [],
      capabilities: [],
      status: 'offline',
      lastSeen: 1,
      registeredAt: 1,
      version: '0.1.0',
    }
    const { base, store } = await startPresetApi({
      preset: reviewer,
      presetHost: { nodeName: 'node-f', meshRegistry: presetMesh([host]) },
    })
    const res = await create(base, { goal: 'review', agentId: 'reviewer' })
    expect(res.status).toBe(409)
    const body = (await res.json()) as { error: string }
    expect(body.error).toContain('hosting node "node-g" is offline or unknown')
    expect(await store.list()).toHaveLength(0)
  })

  it('an explicit executor is left alone', async () => {
    const reviewer = reviewerPreset()
    const { base, store } = await startPresetApi({ preset: reviewer })
    const res = await create(base, {
      goal: 'review',
      agentId: 'reviewer',
      executor: 'chat-loop',
    })
    expect(res.status).toBe(201)
    const { task } = (await res.json()) as { task: { id: string } }
    const row = await store.get(task.id)
    expect(row?.executor).toBe('chat-loop')
    expect(row?.executorTarget).toBeUndefined()
    expect(row?.agentId).toBe('reviewer')
    expect(row?.spec.presetId).toBeUndefined()
    expect(row?.nodeAffinity).toBeUndefined()
  })

  it('an explicit executor with a forged presetId stores none and materialises nothing', async () => {
    const reviewer = reviewerPreset()
    const parent = mkdtempSync(join(tmpdir(), 'rivetos-api-forged-'))
    const dir = join(parent, 'planted')
    try {
      const { base, store } = await startPresetApi({ preset: reviewer })
      const res = await create(base, {
        goal: 'review',
        agentId: 'reviewer',
        executor: 'harness-session',
        executorTarget: 'claude-code',
        spec: {
          presetId: 'forged',
          presetName: 'nope',
          sharedLink: true,
          delegation: true,
          meshFrom: 'ct999',
          workingDir: dir,
          model: 'haiku',
        },
      })
      expect(res.status).toBe(201)
      const { task } = (await res.json()) as { task: { id: string } }
      const row = await store.get(task.id)
      expect(row?.executor).toBe('harness-session')
      expect(row?.spec.presetId).toBeUndefined()
      expect(row?.spec.presetName).toBeUndefined()
      expect(row?.spec.sharedLink).toBeUndefined()
      expect(row?.spec.delegation).toBeUndefined()
      expect(row?.spec.meshFrom).toBeUndefined()
      expect(row?.spec.model).toBe('haiku')
      expect(row?.spec.workingDir).toBe(dir)

      const executors = createExecutorRegistry()
      const fake = fakeExecutor()
      executors.register('harness-session', fake, 'claude-code')
      const handler = createTaskHandler({
        store,
        executors,
        nodeId: 'test-node',
        resolvePreset: async () => reviewer,
      })
      await handler(task.id)

      expect(existsSync(dir)).toBe(false)
      expect((await store.get(task.id))?.status).toBe('completed')
    } finally {
      rmSync(parent, { recursive: true, force: true })
    }
  })

  it('an agentId that is not a preset drops forged preset fields', async () => {
    const reviewer = reviewerPreset()
    const { base, store } = await startPresetApi({ preset: reviewer })
    const res = await create(base, {
      goal: 'review',
      agentId: 'not-a-preset',
      spec: {
        presetId: 'forged',
        presetName: 'nope',
        sharedLink: true,
        delegation: true,
        meshFrom: 'ct999',
        model: 'haiku',
      },
    })
    expect(res.status).toBe(201)
    const { task } = (await res.json()) as { task: { id: string } }
    const row = await store.get(task.id)
    expect(row?.executor).toBe('chat-loop')
    expect(row?.spec.presetId).toBeUndefined()
    expect(row?.spec.presetName).toBeUndefined()
    expect(row?.spec.sharedLink).toBeUndefined()
    expect(row?.spec.delegation).toBeUndefined()
    expect(row?.spec.meshFrom).toBeUndefined()
    expect(row?.spec.model).toBe('haiku')
  })

  it('answers a parked permission prompt and leaves the default wait terminal-only', async () => {
    const { base, store, broker } = await startApi({ hang: true, brokerTimeoutMs: 5_000 })
    if (!broker) throw new Error('broker missing')
    const created = await create(base, { goal: 'hold', agentId: 'opus' })
    const { task } = (await created.json()) as { task: { id: string } }

    const pending = broker.ask({
      taskId: task.id,
      requestId: 'req-1',
      name: 'Bash',
      input: { command: 'ls' },
    })

    const viewed = await fetch(`${base}/api/tasks/${task.id}`)
    const viewBody = (await viewed.json()) as {
      task: { pendingApprovals?: Array<{ requestId: string; name: string }> }
    }
    expect(viewBody.task.pendingApprovals?.[0]).toMatchObject({ requestId: 'req-1', name: 'Bash' })

    const blocked = await fetch(`${base}/api/tasks/${task.id}/wait?timeoutMs=80`)
    expect(blocked.status).toBe(504)

    const early = await fetch(`${base}/api/tasks/${task.id}/wait?onApproval=return&timeoutMs=2000`)
    expect(early.status).toBe(200)
    const earlyBody = (await early.json()) as { approval: { requestId: string; type: string } }
    expect(earlyBody.approval).toMatchObject({ type: 'approval-request', requestId: 'req-1' })

    const bad = await fetch(`${base}/api/tasks/${task.id}/approvals/req-1`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ decision: 'allow-session' }),
    })
    expect(bad.status).toBe(400)

    const missing = await fetch(`${base}/api/tasks/${task.id}/approvals/nope`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ decision: 'allow' }),
    })
    expect(missing.status).toBe(404)

    const ok = await fetch(`${base}/api/tasks/${task.id}/approvals/req-1`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ decision: 'allow' }),
    })
    expect(ok.status).toBe(202)
    await expect(pending).resolves.toMatchObject({ behavior: 'allow', decision: 'allow' })

    const row = await store.get(task.id)
    expect(row?.spec.permissionDecisions).toEqual([
      expect.objectContaining({ requestId: 'req-1', tool: 'Bash', decision: 'allow' }),
    ])

    const again = await fetch(`${base}/api/tasks/${task.id}/approvals/req-1`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ decision: 'deny' }),
    })
    expect(again.status).toBe(404)
  })

  it('POST /kill denies a parked prompt and a later allow is refused', async () => {
    const { base, store, broker } = await startApi({ hang: true, brokerTimeoutMs: 5_000 })
    if (!broker) throw new Error('broker missing')
    const created = await create(base, { goal: 'hold', agentId: 'opus' })
    const { task } = (await created.json()) as { task: { id: string } }
    const other = await store.create({
      goal: 'other',
      executor: 'chat-loop',
      agentId: 'opus',
      origin: 'api',
    })
    const pending = broker.ask({
      taskId: task.id,
      requestId: 'req-kill',
      name: 'Bash',
      input: { command: 'ls' },
    })
    const sibling = broker.ask({
      taskId: other.id,
      requestId: 'req-keep',
      name: 'Bash',
      input: { command: 'pwd' },
    })

    const killed = await fetch(`${base}/api/tasks/${task.id}/kill`, { method: 'POST' })
    expect(killed.status).toBe(200)
    await expect(pending).resolves.toMatchObject({
      behavior: 'deny',
      decision: 'deny',
      message: 'task is terminal',
    })
    expect(broker.decide(task.id, 'req-kill', 'allow')).toBe(false)
    expect(broker.pendingFor(other.id)).toHaveLength(1)

    const allow = await fetch(`${base}/api/tasks/${task.id}/approvals/req-kill`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ decision: 'allow' }),
    })
    expect(allow.status).toBe(409)
    const row = await store.get(task.id)
    expect(row?.status).toBe('killed')
    expect(row?.spec.permissionDecisions).toEqual([
      expect.objectContaining({
        requestId: 'req-kill',
        tool: 'Bash',
        decision: 'deny',
        message: 'task is terminal',
      }),
    ])
    const viewed = await fetch(`${base}/api/tasks/${task.id}`)
    const viewBody = (await viewed.json()) as { task: { pendingApprovals?: unknown[] } }
    expect(viewBody.task.pendingApprovals).toBeUndefined()

    expect(broker.decide(other.id, 'req-keep', 'deny')).toBe(true)
    await sibling
  })

  it('store finish denies a parked prompt and a later allow is refused', async () => {
    const { base, store, broker } = await startApi({ hang: true, brokerTimeoutMs: 5_000 })
    if (!broker) throw new Error('broker missing')
    const created = await create(base, { goal: 'hold', agentId: 'opus' })
    const { task } = (await created.json()) as { task: { id: string } }
    const pending = broker.ask({
      taskId: task.id,
      requestId: 'req-finish',
      name: 'Edit',
      input: { file_path: 'a.ts' },
    })
    await store.finish(task.id, 'failed', {
      verdict: 'failed',
      summary: 'nope',
      artifacts: [],
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, turns: 0, wallClockMs: 0 },
      error: 'nope',
    })
    await expect(pending).resolves.toMatchObject({
      behavior: 'deny',
      decision: 'deny',
      message: 'task is terminal',
    })
    const allow = await fetch(`${base}/api/tasks/${task.id}/approvals/req-finish`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ decision: 'allow' }),
    })
    expect(allow.status).toBe(409)
    const row = await store.get(task.id)
    expect(row?.spec.permissionDecisions).toEqual([
      expect.objectContaining({ requestId: 'req-finish', decision: 'deny' }),
    ])
    expect(row?.spec.permissionDecisions).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ decision: 'allow' })]),
    )
  })

  it('POST /approvals 404s when no broker is wired', async () => {
    const { base } = await startApi({ hang: true })
    const created = await create(base, { goal: 'hold', agentId: 'opus' })
    const { task } = (await created.json()) as { task: { id: string } }
    const res = await fetch(`${base}/api/tasks/${task.id}/approvals/req-1`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ decision: 'allow' }),
    })
    expect(res.status).toBe(404)
  })
})
