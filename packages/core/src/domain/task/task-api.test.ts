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
}): Promise<{
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
  const route = createTaskApiRoute({ store, waiter, criteriaPolicy: opts?.criteriaPolicy })

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
            ? 'ct112'
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
    expect((await store.get(task.id))?.nodeAffinity).toBe('ct112')
  })

  it('explicit nodeAffinity wins over the resolver', async () => {
    const { base, store } = await startWithResolver()
    const res = await create(base, { goal: 'x', agentId: 'remote-agent', nodeAffinity: 'ct113' })
    const { task } = (await res.json()) as { task: { id: string } }
    expect((await store.get(task.id))?.nodeAffinity).toBe('ct113')
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
      node: 'ct116',
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
  }): Promise<{ base: string; store: InMemoryTaskStore }> {
    const store = new InMemoryTaskStore()
    const waiter = createTaskCompletionWaiter({ store, pollFallbackMs: 10 })
    const route = createTaskApiRoute({
      store,
      waiter,
      resolvePreset: async (agentId) =>
        agentId === opts.preset.name || agentId === opts.preset.id ? opts.preset : undefined,
      presetHost: opts.presetHost,
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

  it('a preset create builds the harness-session row, not a chat-loop row', async () => {
    const reviewer = reviewerPreset()
    const host: MeshNode = {
      id: 'ct116',
      name: 'ct116',
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
      presetHost: { nodeName: 'ct115', meshRegistry: presetMesh([host]) },
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
      id: 'ct116',
      name: 'ct116',
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
      presetHost: { nodeName: 'ct115', meshRegistry: presetMesh([host]) },
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
      id: 'ct116',
      name: 'ct116',
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
      presetHost: { nodeName: 'ct115', meshRegistry: presetMesh([host]) },
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

  it('an unimplemented preset is 400 with the gap text and creates no row', async () => {
    const reviewer = reviewerPreset({ harnessId: 'codex', node: 'ct115' })
    const executors = createExecutorRegistry()
    executors.register(
      'harness-session',
      createNotImplementedHarnessExecutor('codex', { reason: 'binary not resolvable' }),
      'codex',
    )
    const { base, store } = await startPresetApi({
      preset: reviewer,
      presetHost: { nodeName: 'ct115', executors },
    })
    const res = await create(base, { goal: 'review', agentId: 'reviewer' })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string }
    expect(body.error).toContain('agent "reviewer" (codex on this node):')
    expect(body.error).toContain('binary not resolvable')
    expect(await store.list()).toHaveLength(0)
  })

  it('an offline hosting node is 409', async () => {
    const reviewer = reviewerPreset({ node: 'ct116' })
    const host: MeshNode = {
      id: 'ct116',
      name: 'ct116',
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
      presetHost: { nodeName: 'ct115', meshRegistry: presetMesh([host]) },
    })
    const res = await create(base, { goal: 'review', agentId: 'reviewer' })
    expect(res.status).toBe(409)
    const body = (await res.json()) as { error: string }
    expect(body.error).toContain('hosting node "ct116" is offline or unknown')
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
})
