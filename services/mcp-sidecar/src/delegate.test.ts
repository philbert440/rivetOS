/**
 * Sidecar delegate_task / list_agents. In-memory store, pure-poll waiter.
 * Completion is driven from the store's enqueue hook so the wait observes a
 * terminal row without a runner.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { findPresetByHandle, type CachedPresetResolver } from '@rivetos/agent-registry'
import {
  InMemoryTaskStore,
  PresetDelegationEngine,
  createTaskCompletionWaiter,
  type TaskRow,
} from '@rivetos/core'
import type { AgentPreset, MeshNode, MeshRegistry } from '@rivetos/types'
import {
  DELEGATE_POOL_CONNECTION_TIMEOUT_MS,
  DELEGATE_TASK_HTTP_REASON,
  createDelegateTools,
  createDelegateToolsFromEnv,
  delegatePoolConfig,
  delegateToolsForTransport,
  resolveMeshDir,
  sidecarNodeName,
  type DelegateToolsHandle,
} from './delegate.js'

const USAGE = { inputTokens: 1, outputTokens: 2, totalTokens: 3, turns: 1, wallClockMs: 4 }
const DIR = '/home/rivet/.rivetos/agents/reviewer'
const NODE = 'ct115'

const closers: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of closers.splice(0)) await close()
})

function preset(overrides: Partial<AgentPreset> = {}): AgentPreset {
  return {
    id: 'preset-1',
    name: 'reviewer',
    color: '',
    harnessId: 'claude-code',
    model: 'opus',
    effort: 'high',
    systemPrompt: 'be strict',
    node: NODE,
    directory: DIR,
    sharedLink: true,
    nodeBaseUrl: '',
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

function meshNode(overrides: Partial<MeshNode> & Pick<MeshNode, 'name'>): MeshNode {
  return {
    id: overrides.name,
    name: overrides.name,
    agents: [],
    host: '10.0.0.8',
    port: 3100,
    providers: [],
    models: [],
    capabilities: [],
    status: 'online',
    lastSeen: 1,
    registeredAt: 1,
    version: '0.5.0',
    ...overrides,
  }
}

function resolver(rows: AgentPreset[]): CachedPresetResolver {
  return {
    list: () => Promise.resolve(rows.slice()),
    find: (handle) => Promise.resolve(findPresetByHandle(rows, handle)),
    lastKnown: () => rows.slice(),
    invalidate() {},
    status: () => ({ hasValue: true, fetchedAt: 0 }),
  }
}

function registry(getNodes: () => Promise<MeshNode[]>): MeshRegistry {
  return {
    register: () => Promise.resolve(),
    deregister: () => Promise.resolve(),
    heartbeat: () => Promise.resolve(),
    getNodes,
    getNode: () => Promise.resolve(undefined),
    findByAgent: (agentId) =>
      getNodes().then((nodes) => nodes.filter((node) => node.agents.includes(agentId))),
    findByCapability: () => Promise.resolve([]),
    findByProvider: () => Promise.resolve([]),
    sync: () => Promise.resolve(),
    prune: () => Promise.resolve([]),
  }
}

function must(row: TaskRow | undefined, label: string): TaskRow {
  if (!row) throw new Error(`expected ${label}`)
  return row
}

async function text(
  handle: DelegateToolsHandle,
  name: string,
  args: Record<string, unknown>,
  ctx?: { signal?: AbortSignal },
): Promise<string> {
  const found = handle.tools.find((tool) => tool.name === name)
  if (!found) throw new Error(`missing tool ${name}`)
  const result = await found.execute(args, ctx)
  if (typeof result !== 'string') throw new Error(`${name} returned a non-text result`)
  return result
}

/** Parent row (when requested) is inserted before auto-finish is armed. */
async function setup(opts: {
  presets?: AgentPreset[]
  nodes?: MeshNode[]
  parentDepth?: number
  autoFinish?: boolean
  pollFallbackMs?: number
}): Promise<{ store: InMemoryTaskStore; handle: DelegateToolsHandle; parent?: TaskRow }> {
  const nodes = opts.nodes ?? []
  const meshNodes = (): Promise<MeshNode[]> => Promise.resolve(nodes)
  let arm = false
  const store: InMemoryTaskStore = new InMemoryTaskStore((id) => {
    if (!arm) return
    void (async () => {
      const row = await store.get(id)
      if (!row || row.status !== 'queued') return
      const claimed = await store.claim(id, row.nodeAffinity ?? NODE)
      if (!claimed) return
      await store.finish(id, 'completed', {
        verdict: 'completed',
        summary: 'done',
        output: 'looks good',
        artifacts: [],
        usage: USAGE,
      })
    })()
  })

  let parent: TaskRow | undefined
  if (opts.parentDepth !== undefined) {
    parent = await store.create({
      goal: 'parent-seed',
      executor: 'chat-loop',
      agentId: 'parent-agent',
      origin: 'tool',
      chainDepth: opts.parentDepth,
      maxAttempts: 1,
    })
  }
  if (opts.autoFinish) arm = true

  const waiter = createTaskCompletionWaiter({
    store,
    pollFallbackMs: opts.pollFallbackMs ?? 15,
  })
  const engine = new PresetDelegationEngine({
    resolver: resolver(opts.presets ?? []),
    taskStore: store,
    waiter,
    nodeName: NODE,
    meshRegistry: registry(meshNodes),
  })
  const handle = createDelegateTools({
    store,
    waiter,
    presets: engine,
    meshNodes,
    nodeName: NODE,
    requestedBy: 'tester',
    ...(parent ? { parentTask: { id: parent.id, chainDepth: parent.chainDepth } } : {}),
  })
  closers.push(() => handle.close())
  return { store, handle, parent }
}

const HOST = meshNode({ name: NODE, agents: ['local-grok'] })
const REMOTE = meshNode({ name: 'ct112', agents: ['grok'], lastSeen: 10 })
const OFFLINE = meshNode({
  name: 'ct-down',
  agents: ['hidden'],
  status: 'offline',
  lastSeen: 99,
})

const LISTING = [
  `- reviewer (agent: claude-code on ${NODE} — this node, dir ${DIR})`,
  '',
  'Runtime agents (mesh):',
  `- local-grok (${NODE})`,
  '- grok (ct112)',
  '',
  'to_agent accepts a preset name or id, or a runtime agent id.',
].join('\n')

describe('sidecar delegate_task', () => {
  it('runs a preset as a harness-session row and returns its output', async () => {
    const { store, handle, parent } = await setup({
      presets: [preset()],
      nodes: [HOST, REMOTE, OFFLINE],
      // Depth 2 is the last depth the cap still allows (child depth 3).
      parentDepth: 2,
      autoFinish: true,
    })
    const seeded = must(parent, 'parent')

    const body = await text(handle, 'delegate_task', {
      to_agent: 'reviewer',
      task: 'review the diff',
      context: ['file a.ts'],
      model: 'override-model',
    })

    expect(body.startsWith('looks good')).toBe(true)
    expect(body).toContain('_Delegation [completed]:')
    const child = must(
      (await store.list()).find((row) => row.id !== seeded.id),
      'child row',
    )
    expect(child).toMatchObject({
      executor: 'harness-session',
      executorTarget: 'claude-code',
      nodeAffinity: NODE,
      parentTaskId: seeded.id,
      chainDepth: 3,
      requestedBy: 'tester',
      origin: 'tool',
      maxAttempts: 1,
      goal: 'review the diff\n\nContext:\nfile a.ts',
      budget: { maxWallClockMs: 20 * 60 * 1000 },
    })
    expect(child.spec).toMatchObject({
      workingDir: DIR,
      delegation: true,
      meshFrom: NODE,
      model: 'override-model',
      excludeTools: ['delegate_task'],
    })
  })

  it('pins a runtime agent to the newest online host', async () => {
    const older = meshNode({ name: 'ct-old', agents: ['grok'], lastSeen: 5 })
    const newer = meshNode({ name: 'ct-new', agents: ['grok'], lastSeen: 40 })
    const newerOffline = meshNode({
      name: 'ct-newer-off',
      agents: ['grok'],
      lastSeen: 100,
      status: 'offline',
    })
    const { store, handle, parent } = await setup({
      nodes: [older, newerOffline, newer],
      parentDepth: 0,
      autoFinish: true,
    })
    const seeded = must(parent, 'parent')

    const body = await text(handle, 'delegate_task', {
      to_agent: 'grok',
      task: 'search',
      context: ['thread 1'],
      model: 'grok-4',
    })

    expect(body.startsWith('looks good')).toBe(true)
    const child = must(
      (await store.list()).find((row) => row.id !== seeded.id),
      'child row',
    )
    expect(child).toMatchObject({
      executor: 'chat-loop',
      agentId: 'grok',
      origin: 'mesh',
      nodeAffinity: 'ct-new',
      parentTaskId: seeded.id,
      chainDepth: 1,
      requestedBy: 'tester',
      maxAttempts: 1,
      goal: 'search\n\nContext:\nthread 1',
    })
    expect(child.executorTarget).toBeUndefined()
    expect(child.spec).toMatchObject({
      delegation: true,
      meshFrom: NODE,
      excludeTools: ['delegate_task'],
      model: 'grok-4',
    })
  })

  it('lists both rosters when the target is unknown', async () => {
    const { handle } = await setup({
      presets: [preset()],
      nodes: [HOST, REMOTE, OFFLINE],
    })
    const listed = await text(handle, 'list_agents', {})
    const missing = await text(handle, 'delegate_task', { to_agent: 'nobody', task: 'x' })
    expect(listed).toBe(LISTING)
    expect(listed).not.toContain('hidden')
    expect(missing).toBe(
      `[failed] Agent "nobody" not found in RivetHub presets or runtime agents.\n\n${listed}`,
    )
  })

  it('refuses a seeded parent already at depth 3', async () => {
    const { store, handle, parent } = await setup({
      presets: [preset()],
      nodes: [HOST],
      parentDepth: 3,
    })
    const seeded = must(parent, 'parent')
    const body = await text(handle, 'delegate_task', { to_agent: 'reviewer', task: 'again' })
    expect(body).toBe('[failed] delegation chain too deep (4 > 3)')
    const rows = await store.list()
    expect(rows.map((row) => row.id)).toEqual([seeded.id])
  })

  it('kills a preset row that nobody finishes and names the node', async () => {
    const { store, handle } = await setup({
      presets: [preset()],
      nodes: [HOST],
      // timeout_ms 1 still waits the engine's +5s grace. Keep the poll tight.
      pollFallbackMs: 20,
    })
    const body = await text(handle, 'delegate_task', {
      to_agent: 'reviewer',
      task: 'review',
      timeout_ms: 1,
    })
    expect(body).toContain('[timeout]')
    expect(body).toContain(
      `no runner claimed or finished it in time — is the rivetos runtime running on "${NODE}"?`,
    )
    const rows = await store.list()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.status).toBe('killed')
    expect(rows[0]?.executor).toBe('harness-session')
    expect(rows[0]?.budget.maxWallClockMs).toBe(1)
  }, 20_000)

  it('list_agents says (none) when both rosters are empty', async () => {
    const { handle } = await setup({})
    const listed = await text(handle, 'list_agents', {})
    expect(listed).toBe(
      [
        '(none)',
        '',
        'Runtime agents (mesh):',
        '(none)',
        '',
        'to_agent accepts a preset name or id, or a runtime agent id.',
      ].join('\n'),
    )
    expect(handle.tools.map((tool) => tool.name).sort()).toEqual(['delegate_task', 'list_agents'])
    const delegate = handle.tools.find((tool) => tool.name === 'delegate_task')
    expect(delegate?.description).toContain('preset name or id wins')
    expect(delegate?.description).toContain('tool_timeout_sec')
    expect(delegate?.description).toContain('Claude Code MCP timeout')
  })

  it('stamps origin tool when the runtime agent is hosted on this node', async () => {
    const { store, handle } = await setup({
      nodes: [meshNode({ name: NODE, agents: ['local-grok'] })],
      autoFinish: true,
    })
    const body = await text(handle, 'delegate_task', { to_agent: 'local-grok', task: 'hi' })
    expect(body.startsWith('looks good')).toBe(true)
    const row = must((await store.list())[0], 'runtime row')
    expect(row.origin).toBe('tool')
    expect(row.nodeAffinity).toBe(NODE)
    expect(row.executor).toBe('chat-loop')
  })

  it('returns killed and does not create a row when the signal is already aborted', async () => {
    const { store, handle } = await setup({
      presets: [preset()],
      nodes: [HOST],
    })
    const ac = new AbortController()
    ac.abort()
    const body = await text(
      handle,
      'delegate_task',
      { to_agent: 'reviewer', task: 'review' },
      { signal: ac.signal },
    )
    expect(body).toBe('[killed] delegate_task aborted by the client')
    expect(await store.list()).toHaveLength(0)
  })

  it('kills the row when the client signal aborts during the wait', async () => {
    const { store, handle } = await setup({
      presets: [preset()],
      nodes: [HOST],
      autoFinish: false,
      pollFallbackMs: 15,
    })
    const ac = new AbortController()
    const pending = text(
      handle,
      'delegate_task',
      { to_agent: 'reviewer', task: 'review' },
      { signal: ac.signal },
    )
    const started = Date.now()
    let row = (await store.list())[0]
    while (!row) {
      if (Date.now() - started > 2_000) throw new Error('row was not created')
      await new Promise((resolve) => {
        setTimeout(resolve, 10)
      })
      row = (await store.list())[0]
    }
    ac.abort()
    const body = await pending
    expect(body).toBe('[killed] delegate_task aborted by the client')
    expect((await store.get(row.id))?.status).toBe('killed')
  })

  it('abort kills only the row this call created', async () => {
    const { store, handle } = await setup({
      presets: [preset()],
      nodes: [HOST],
      autoFinish: false,
      pollFallbackMs: 15,
    })
    const ac = new AbortController()
    const pending = text(
      handle,
      'delegate_task',
      { to_agent: 'reviewer', task: 'review' },
      { signal: ac.signal },
    )
    const started = Date.now()
    let row = (await store.list())[0]
    while (!row) {
      if (Date.now() - started > 2_000) throw new Error('row was not created')
      await sleep(10)
      row = (await store.list())[0]
    }
    const unrelated = await store.create({
      goal: 'other harness',
      executor: 'chat-loop',
      agentId: 'someone-else',
      origin: 'tool',
      chainDepth: 0,
      maxAttempts: 1,
    })
    ac.abort()
    const body = await pending
    expect(body).toBe('[killed] delegate_task aborted by the client')
    expect((await store.get(row.id))?.status).toBe('killed')
    expect((await store.get(unrelated.id))?.status).toBe('queued')
  })

  it('kills a preset row whose create resolves only after the client aborted', async () => {
    const { store, handle, release, creates } = await setupGatedCreate()
    const ac = new AbortController()
    const pending = text(
      handle,
      'delegate_task',
      { to_agent: 'reviewer', task: 'review' },
      { signal: ac.signal },
    )
    const started = Date.now()
    while (creates() === 0) {
      if (Date.now() - started > 2_000) throw new Error('create was not called')
      await sleep(10)
    }
    ac.abort()
    release()
    const body = await pending
    expect(body).toBe('[killed] delegate_task aborted by the client')
    const rows = await store.list()
    expect(rows).toHaveLength(1)
    expect(rows.some((row) => row.status === 'queued' || row.status === 'running')).toBe(false)
    expect(rows[0]?.status).toBe('killed')
  })

  it('returns the create failure when the client aborts while create is still pending', async () => {
    const { store, handle, release, creates } = await setupGatedCreate(new Error('disk full'))
    const ac = new AbortController()
    const pending = text(
      handle,
      'delegate_task',
      { to_agent: 'reviewer', task: 'review' },
      { signal: ac.signal },
    )
    const started = Date.now()
    while (creates() === 0) {
      if (Date.now() - started > 2_000) throw new Error('create was not called')
      await sleep(10)
    }
    ac.abort()
    release()
    const body = await pending
    expect(body).toContain('[failed]')
    expect(body).toContain('disk full')
    expect(body).not.toContain('[killed]')
    const rows = await store.list()
    expect(rows.some((row) => row.status === 'queued' || row.status === 'running')).toBe(false)
  })

  it('abort of a runtime delegation kills only that row', async () => {
    const { store, handle } = await setup({
      nodes: [meshNode({ name: NODE, agents: ['local-grok'] })],
      autoFinish: false,
      pollFallbackMs: 15,
    })
    const ac = new AbortController()
    const pending = text(
      handle,
      'delegate_task',
      { to_agent: 'local-grok', task: 'hi' },
      { signal: ac.signal },
    )
    const started = Date.now()
    let row = (await store.list())[0]
    while (!row) {
      if (Date.now() - started > 2_000) throw new Error('row was not created')
      await sleep(10)
      row = (await store.list())[0]
    }
    const unrelated = await store.create({
      goal: 'scheduled',
      executor: 'chat-loop',
      agentId: 'other',
      origin: 'heartbeat',
      chainDepth: 0,
      maxAttempts: 1,
    })
    ac.abort()
    const body = await pending
    expect(body).toBe('[killed] delegate_task aborted by the client')
    expect((await store.get(row.id))?.status).toBe('killed')
    expect((await store.get(unrelated.id))?.status).toBe('queued')
  })
})

async function setupGatedCreate(fail?: Error): Promise<{
  store: InMemoryTaskStore
  handle: DelegateToolsHandle
  release: () => void
  creates: () => number
}> {
  let releaseGate: () => void = () => undefined
  const gate = new Promise<void>((resolve) => {
    releaseGate = resolve
  })
  let createCalls = 0
  const store = new InMemoryTaskStore()
  const realCreate = store.create.bind(store)
  store.create = (input) => {
    createCalls += 1
    return gate.then(() => (fail ? Promise.reject(fail) : realCreate(input)))
  }
  const waiter = createTaskCompletionWaiter({ store, pollFallbackMs: 15 })
  const engine = new PresetDelegationEngine({
    resolver: resolver([preset()]),
    taskStore: store,
    waiter,
    nodeName: NODE,
    meshRegistry: registry(() => Promise.resolve([HOST])),
  })
  const handle = createDelegateTools({
    store,
    waiter,
    presets: engine,
    meshNodes: () => Promise.resolve([HOST]),
    nodeName: NODE,
    requestedBy: 'tester',
  })
  closers.push(() => handle.close())
  return {
    store,
    handle,
    release: () => {
      releaseGate()
    },
    creates: () => createCalls,
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

function ioError(code: string): Error {
  return Object.assign(new Error(code), { code })
}

function meshDocument(nodes: Record<string, unknown>): string {
  return JSON.stringify({ version: 1, updatedAt: 1, nodes })
}

function presetStore(rows: AgentPreset[], ready = true) {
  return {
    backend: 'postgres' as const,
    isReady: () => Promise.resolve(ready),
    list: () => Promise.resolve(rows.map((row) => ({ ...row }))),
    get: (id: string) => Promise.resolve(rows.find((row) => row.id === id)),
    findByHandle: (handle: string) => Promise.resolve(findPresetByHandle(rows, handle)),
    create: () => Promise.reject(new Error('preset create is not used')),
    update: () => Promise.resolve(undefined),
    delete: () => Promise.resolve(false),
  }
}

async function bootEnv(opts: {
  presets?: AgentPreset[]
  parentTaskId?: string
  parentDepth?: number
  tasksReady?: boolean
  presetsReady?: boolean
  probeError?: Error
  autoFinish?: boolean
  nodeName?: string
  sharedDir?: string
  meshBoundMs?: number
  readFile?: (path: string) => Promise<string>
  stat?: (path: string) => Promise<{ mtimeMs: number }>
  trackGets?: boolean
  /** Default true. False skips the completion waiter (HTTP/socket). */
  registerDelegateTask?: boolean
}): Promise<{
  store: InMemoryTaskStore
  handle: DelegateToolsHandle | undefined
  logs: string[]
  events: string[]
  gets: number
  poolConfig: { connectionTimeoutMillis?: number; max?: number; connectionString?: string }
  waiterStarts: number
}> {
  const logs: string[] = []
  const events: string[] = []
  let gets = 0
  let waiterStarts = 0
  let arm = false
  const store = new InMemoryTaskStore((id) => {
    if (!arm) return
    void (async () => {
      const row = await store.get(id)
      if (!row || row.status !== 'queued') return
      const claimed = await store.claim(id, row.nodeAffinity ?? opts.nodeName ?? 'local')
      if (!claimed) return
      await store.finish(id, 'completed', {
        verdict: 'completed',
        summary: 'done',
        output: 'looks good',
        artifacts: [],
        usage: USAGE,
      })
    })()
  })
  const originalGet = store.get.bind(store)
  if (opts.trackGets) {
    store.get = (id) => {
      gets += 1
      return originalGet(id)
    }
  }
  let parentTaskId = opts.parentTaskId
  if (opts.parentDepth !== undefined) {
    const parent = await store.create({
      goal: 'parent-seed',
      executor: 'chat-loop',
      agentId: 'parent-agent',
      origin: 'tool',
      chainDepth: opts.parentDepth,
      maxAttempts: 1,
    })
    if (parentTaskId === undefined) parentTaskId = parent.id
  }
  if (opts.autoFinish) arm = true

  const tasks = Object.assign(store, {
    isReady: () => {
      if (opts.probeError && opts.tasksReady === undefined) return Promise.reject(opts.probeError)
      return Promise.resolve(opts.tasksReady !== false)
    },
  })
  let poolConfig: { connectionTimeoutMillis?: number; max?: number; connectionString?: string } = {}
  const handle = await createDelegateToolsFromEnv({
    pgUrl: 'postgres://sidecar.invalid/none',
    sharedDir: opts.sharedDir ?? '/var/mesh',
    nodeName: opts.nodeName ?? 'local',
    requestedBy: 'tester',
    parentTaskId: parentTaskId ?? '',
    ...(opts.registerDelegateTask === false ? { registerDelegateTask: false } : {}),
    log: (msg) => {
      logs.push(msg)
    },
    meshBoundMs: opts.meshBoundMs ?? 40,
    readFile:
      opts.readFile ??
      (() => {
        return Promise.reject(ioError('ENOENT'))
      }),
    stat:
      opts.stat ??
      (() => {
        return Promise.reject(ioError('ENOENT'))
      }),
    createPool: (config) => {
      poolConfig = config
      return {
        on() {},
        end() {
          events.push('pool')
          return Promise.resolve()
        },
      } as never
    },
    openStores: () => ({
      tasks,
      presets: presetStore(opts.presets ?? [], opts.presetsReady !== false),
    }),
    createWaiter: (tasks) => {
      waiterStarts += 1
      const waiter = createTaskCompletionWaiter({ store: tasks, pollFallbackMs: 15 })
      return {
        wait: (id, waitOpts) => waiter.wait(id, waitOpts),
        async stop() {
          events.push('waiter')
          await waiter.stop()
        },
      }
    },
  })
  if (handle) closers.push(() => handle.close())
  return { store, handle, logs, events, gets, poolConfig, waiterStarts }
}

describe('delegate tool registration and node identity', () => {
  it('registers delegate_task only for a stdio sidecar', () => {
    const tools = [
      {
        name: 'delegate_task',
        description: '',
        inputSchema: {},
        execute: () => Promise.resolve(''),
      },
      {
        name: 'list_agents',
        description: '',
        inputSchema: {},
        execute: () => Promise.resolve(''),
      },
    ]
    const stdio = delegateToolsForTransport(tools, true)
    expect(stdio.skippedDelegateTask).toBe(false)
    expect(stdio.tools.map((tool) => tool.name)).toEqual(['delegate_task', 'list_agents'])
    const http = delegateToolsForTransport(tools, false)
    expect(http.skippedDelegateTask).toBe(true)
    expect(http.tools.map((tool) => tool.name)).toEqual(['list_agents'])
    expect(DELEGATE_TASK_HTTP_REASON).toBe(
      'delegate_task needs a per-harness stdio sidecar for the chain guard',
    )
  })

  it('matches boot: RIVETOS_NODE_NAME, else HOSTNAME, else local', () => {
    expect(sidecarNodeName({ RIVETOS_NODE_NAME: ' ct115 ', HOSTNAME: 'other' })).toBe('ct115')
    expect(sidecarNodeName({ HOSTNAME: 'box' })).toBe('box')
    expect(sidecarNodeName({})).toBe('local')
    expect(sidecarNodeName({ RIVETOS_NODE_NAME: '  ', HOSTNAME: '   ' })).toBe('local')
  })

  it('prefers RIVETOS_MESH_DIR over the shared dir', () => {
    expect(resolveMeshDir({ RIVETOS_MESH_DIR: ' /var/mesh ' }, '/rivet-shared')).toBe('/var/mesh')
    expect(resolveMeshDir({}, '/rivet-shared')).toBe('/rivet-shared')
    expect(resolveMeshDir({ RIVETOS_MESH_DIR: '   ' }, '/shared')).toBe('/shared')
  })

  it('bounds pool connect at 5s', () => {
    const config = delegatePoolConfig('postgres://sidecar.invalid/none')
    expect(config.connectionTimeoutMillis).toBe(DELEGATE_POOL_CONNECTION_TIMEOUT_MS)
    expect(config.connectionTimeoutMillis).toBe(5_000)
    expect(config.max).toBe(2)
  })
})

describe('createDelegateToolsFromEnv', () => {
  it('skips when ros_tasks is missing, ends the pool, and does not start a waiter', async () => {
    const booted = await bootEnv({ tasksReady: false })
    expect(booted.handle).toBeUndefined()
    expect(booted.logs).toContain('ros_tasks missing — delegate_task disabled')
    expect(booted.events).toEqual(['pool'])
    expect(booted.waiterStarts).toBe(0)
    expect(booted.poolConfig.connectionTimeoutMillis).toBe(5_000)
    expect(booted.poolConfig.max).toBe(2)
  })

  it('skips when ros_agent_presets is missing and ends the pool', async () => {
    const booted = await bootEnv({ presetsReady: false })
    expect(booted.handle).toBeUndefined()
    expect(booted.logs).toContain('ros_agent_presets missing — delegate_task disabled')
    expect(booted.events).toEqual(['pool'])
    expect(booted.waiterStarts).toBe(0)
  })

  it('skips the tools when the postgres probe fails', async () => {
    const booted = await bootEnv({ probeError: new Error('connect ETIMEDOUT') })
    expect(booted.handle).toBeUndefined()
    expect(booted.logs.some((line) => line.includes('postgres probe failed'))).toBe(true)
    expect(booted.logs.some((line) => line.includes('ETIMEDOUT'))).toBe(true)
    expect(booted.events).toEqual(['pool'])
    expect(booted.waiterStarts).toBe(0)
  })

  it('links a parent row when RIVETOS_TASK_ID is in ros_tasks', async () => {
    const booted = await bootEnv({
      presets: [preset({ node: 'local' })],
      parentDepth: 1,
      autoFinish: true,
    })
    const handle = mustHandle(booted.handle)
    const parent = must((await booted.store.list())[0], 'parent')
    const body = await text(handle, 'delegate_task', { to_agent: 'reviewer', task: 'review' })
    expect(body.startsWith('looks good')).toBe(true)
    const child = must(
      (await booted.store.list()).find((row) => row.id !== parent.id),
      'child',
    )
    expect(child.parentTaskId).toBe(parent.id)
    expect(child.chainDepth).toBe(2)
    expect(child.origin).toBe('tool')
  })

  it('treats a missing parent row as depth 0', async () => {
    const missing = '00000000-0000-4000-8000-000000000099'
    const booted = await bootEnv({
      presets: [preset({ node: 'local' })],
      parentTaskId: missing,
      autoFinish: true,
      trackGets: true,
    })
    const handle = mustHandle(booted.handle)
    expect(booted.logs.some((line) => line.includes('not in ros_tasks'))).toBe(true)
    expect(booted.gets).toBeGreaterThan(0)
    const body = await text(handle, 'delegate_task', { to_agent: 'reviewer', task: 'review' })
    expect(body.startsWith('looks good')).toBe(true)
    const child = must((await booted.store.list())[0], 'child')
    expect(child.parentTaskId).toBeUndefined()
    expect(child.chainDepth).toBe(1)
  })

  it('fail-closes a non-UUID RIVETOS_TASK_ID without calling get', async () => {
    const booted = await bootEnv({
      presets: [preset({ node: 'local' })],
      parentTaskId: 'not-a-uuid',
      autoFinish: true,
      trackGets: true,
    })
    const handle = mustHandle(booted.handle)
    expect(
      booted.logs.some(
        (line) => line.includes('not a UUID') && line.includes('fail closed') && line.includes('2'),
      ),
    ).toBe(true)
    expect(booted.gets).toBe(0)
    const body = await text(handle, 'delegate_task', { to_agent: 'reviewer', task: 'review' })
    expect(body.startsWith('looks good')).toBe(true)
    const child = must((await booted.store.list())[0], 'child')
    expect(child.parentTaskId).toBeUndefined()
    expect(child.chainDepth).toBe(3)
  })

  it('close stops the waiter and ends the pool exactly once', async () => {
    const booted = await bootEnv({})
    const handle = mustHandle(booted.handle)
    await handle.close()
    await handle.close()
    expect(booted.events).toEqual(['waiter', 'pool'])
  })

  it('runs a same-node preset and refuses a remote one when mesh.json is absent', async () => {
    const booted = await bootEnv({
      presets: [
        preset({ id: 'home', name: 'home', node: 'local' }),
        preset({ id: 'away', name: 'away', node: 'ct112' }),
      ],
      nodeName: 'local',
      autoFinish: true,
    })
    const handle = mustHandle(booted.handle)
    const listed = await text(handle, 'list_agents', {})
    expect(listed).toContain('on local — this node')
    expect(listed).toContain('on ct112')
    expect(listed).not.toContain('ct112 — this node')
    expect(listed).not.toContain('(mesh unavailable)')
    expect(booted.logs.filter((line) => line.includes('ENOENT'))).toHaveLength(1)
    const body = await text(handle, 'delegate_task', { to_agent: 'home', task: 'review' })
    expect(body.startsWith('looks good')).toBe(true)
    const row = must((await booted.store.list())[0], 'row')
    expect(row.nodeAffinity).toBe('local')
    expect(row.origin).toBe('tool')
    expect(row.executor).toBe('harness-session')
    const denied = await text(handle, 'delegate_task', { to_agent: 'away', task: 'go' })
    expect(denied).toContain('no mesh registry; cannot reach node "ct112"')
    const rows = await booted.store.list()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.nodeAffinity).toBe('local')
    const listedAgain = await text(handle, 'list_agents', {})
    expect(listedAgain).toContain('on local — this node')
    expect(listedAgain).not.toContain('ct112 — this node')
    expect(booted.logs.filter((line) => line.includes('ENOENT'))).toHaveLength(1)
  })

  it('does not start the completion waiter when delegate_task is not registered', async () => {
    const booted = await bootEnv({
      presets: [preset({ node: 'local' })],
      nodeName: 'local',
      registerDelegateTask: false,
    })
    const handle = mustHandle(booted.handle)
    expect(booted.waiterStarts).toBe(0)
    const listed = await text(handle, 'list_agents', {})
    expect(listed).toContain('on local — this node')
    expect(listed).not.toContain('(mesh unavailable)')
    await handle.close()
    expect(booted.events).toEqual(['pool'])
  })

  it('runs a same-node preset and refuses a remote one when mesh.json is unreadable', async () => {
    const stat = () => Promise.reject(ioError('EACCES'))
    const local = await bootEnv({
      presets: [preset({ node: 'local' })],
      nodeName: 'local',
      autoFinish: true,
      stat,
    })
    const localHandle = mustHandle(local.handle)
    const ok = await text(localHandle, 'delegate_task', { to_agent: 'reviewer', task: 'review' })
    expect(ok.startsWith('looks good')).toBe(true)
    expect(local.logs.some((line) => line.includes('EACCES'))).toBe(true)

    const remote = await bootEnv({
      presets: [preset({ node: 'ct112' })],
      nodeName: 'local',
      autoFinish: true,
      stat,
    })
    const remoteHandle = mustHandle(remote.handle)
    const denied = await text(remoteHandle, 'delegate_task', { to_agent: 'reviewer', task: 'go' })
    expect(denied).toContain('no mesh registry; cannot reach node "ct112"')
    expect(await remote.store.list()).toHaveLength(0)
  })

  it('uses a parsed mesh file and does not treat a remote preset as local', async () => {
    const body = meshDocument({
      local: { name: 'local', host: '127.0.0.1', port: 3100, status: 'online', agents: [] },
    })
    let reads = 0
    const booted = await bootEnv({
      presets: [preset({ node: 'ct112' })],
      nodeName: 'local',
      stat: () => Promise.resolve({ mtimeMs: 5 }),
      readFile: () => {
        reads += 1
        return Promise.resolve(body)
      },
    })
    const handle = mustHandle(booted.handle)
    const denied = await text(handle, 'delegate_task', { to_agent: 'reviewer', task: 'go' })
    expect(denied).toContain('hosting node "ct112" is offline or unknown')
    expect(await booted.store.list()).toHaveLength(0)
    expect(reads).toBe(1)
  })

  it('answers list_agents within the bound when readFile never resolves, and still delegates a preset', async () => {
    let reads = 0
    const booted = await bootEnv({
      presets: [preset({ node: 'local' })],
      nodeName: 'local',
      autoFinish: true,
      meshBoundMs: 80,
      stat: () => Promise.resolve({ mtimeMs: 1 }),
      readFile: () => {
        reads += 1
        return new Promise(() => undefined)
      },
    })
    const handle = mustHandle(booted.handle)
    const started = Date.now()
    const listed = await text(handle, 'list_agents', {})
    expect(Date.now() - started).toBeLessThan(1_000)
    expect(listed).toContain('(mesh unavailable)')
    expect(reads).toBe(1)
    const again = Date.now()
    const listedAgain = await text(handle, 'list_agents', {})
    expect(Date.now() - again).toBeLessThan(200)
    expect(listedAgain).toContain('(mesh unavailable)')
    expect(reads).toBe(1)
    const body = await text(handle, 'delegate_task', { to_agent: 'reviewer', task: 'review' })
    expect(body.startsWith('looks good')).toBe(true)
    const row = must((await booted.store.list())[0], 'preset row')
    expect(row.executor).toBe('harness-session')
    expect(row.status).toBe('completed')
    expect(reads).toBe(1)
  })

  it('does not readFile again while the mtime is unchanged', async () => {
    let mtime = 5
    let reads = 0
    let stats = 0
    const booted = await bootEnv({
      meshBoundMs: 40,
      stat: () => {
        stats += 1
        return Promise.resolve({ mtimeMs: mtime })
      },
      readFile: () => {
        reads += 1
        return Promise.resolve(meshDocument({}))
      },
    })
    const handle = mustHandle(booted.handle)
    await text(handle, 'list_agents', {})
    await text(handle, 'list_agents', {})
    expect(stats).toBe(1)
    expect(reads).toBe(1)
    await sleep(70)
    await text(handle, 'list_agents', {})
    expect(stats).toBe(2)
    expect(reads).toBe(1)
    mtime = 6
    await sleep(70)
    await text(handle, 'list_agents', {})
    expect(reads).toBe(2)
    expect(stats).toBe(3)
  })
})

function mustHandle(handle: DelegateToolsHandle | undefined): DelegateToolsHandle {
  if (!handle) throw new Error('expected delegate tools')
  return handle
}
