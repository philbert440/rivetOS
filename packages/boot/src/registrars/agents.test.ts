import { createServer } from 'node:http'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect, afterEach, vi } from 'vitest'
import pg from 'pg'
import { FileAgentPresetStore } from '@rivetos/agent-registry'
import type { GatewayRoute } from '@rivetos/types'
import { PostgresMemory, RoutingMemory } from '@rivetos/memory-postgres'
import type { Runtime } from '@rivetos/core'
import type { RivetConfig } from '../config.js'
import {
  createApiMemoryLookup,
  memoryHttpTools,
  makeWikiFor,
  memoryApiEmbedFromEnv,
  registerAgentTools,
  resolveAdvertiseHost,
} from './agents.js'

const coreMocks = vi.hoisted(() => {
  const pgTaskStores: unknown[] = []
  const meshRegisters: Array<{ metadata?: { harnessExecutors?: unknown } }> = []
  let taskStoreReady = true
  class PgTaskStore {
    pool: unknown
    constructor(pool: unknown) {
      this.pool = pool
      pgTaskStores.push(pool)
    }
    async isReady(): Promise<boolean> {
      return taskStoreReady
    }
  }
  const createTaskRunner = vi.fn((opts: { pgPool?: unknown }) => ({
    opts,
    handler: vi.fn(),
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
  }))
  const createTaskCompletionWaiter = vi.fn(() => ({
    stop: vi.fn(async () => undefined),
  }))
  const started: Array<{ id: string; name: string }> = []
  const nodeNames: string[] = []
  class FileMeshRegistry {
    constructor(config: { mesh?: { nodeName?: string } }) {
      if (config.mesh?.nodeName) nodeNames.push(config.mesh.nodeName)
    }
    async register(node: { metadata?: { harnessExecutors?: unknown } }): Promise<void> {
      meshRegisters.push(node)
    }
    async start(node: {
      id: string
      name: string
      metadata?: { harnessExecutors?: unknown }
    }): Promise<void> {
      started.push({ id: node.id, name: node.name })
      await this.register(node)
    }
    async deregister(): Promise<void> {}
    async heartbeat(): Promise<void> {}
    async getNodes(): Promise<unknown[]> {
      return []
    }
    async getNode(): Promise<undefined> {
      return undefined
    }
    async findByAgent(): Promise<unknown[]> {
      return []
    }
    async findByCapability(): Promise<unknown[]> {
      return []
    }
    async findByProvider(): Promise<unknown[]> {
      return []
    }
    async sync(): Promise<void> {}
    async prune(): Promise<unknown[]> {
      return []
    }
  }
  class AgentChannelServer {
    constructor(_config: unknown) {}
    async start(): Promise<void> {}
    async stop(): Promise<void> {}
  }
  const loadTlsConfig = (): {
    ca: Buffer
    cert: Buffer
    key: Buffer
    cn: string
  } => ({
    ca: Buffer.from('ca'),
    cert: Buffer.from('cert'),
    key: Buffer.from('key'),
    cn: 'test',
  })
  return {
    PgTaskStore,
    pgTaskStores,
    createTaskRunner,
    createTaskCompletionWaiter,
    FileMeshRegistry,
    AgentChannelServer,
    loadTlsConfig,
    meshRegisters,
    started,
    nodeNames,
    get taskStoreReady() {
      return taskStoreReady
    },
    set taskStoreReady(value: boolean) {
      taskStoreReady = value
    },
  }
})

const meshCapture = vi.hoisted(() => {
  const constructed: Array<{ taskStore?: unknown; waiter?: unknown }> = []
  class MeshDelegationEngine {
    constructor(opts: { taskStore?: unknown; waiter?: unknown }) {
      constructed.push(opts)
    }
    createDelegationTool(): { name: string } {
      return { name: 'delegate_task' }
    }
  }
  return { MeshDelegationEngine, constructed }
})

const pgMocks = vi.hoisted(() => {
  const constructed = vi.fn()
  class Pool {
    static instances: Pool[] = []
    options: { connectionString?: string; max?: number }
    end = vi.fn(async () => undefined)
    query = vi.fn(async () => ({ rows: [] }))
    constructor(options: { connectionString?: string; max?: number }) {
      constructed(options)
      this.options = options
      Pool.instances.push(this)
    }
  }
  return { Pool, constructed }
})

vi.mock('@rivetos/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@rivetos/core')>()
  return {
    ...actual,
    PgTaskStore: coreMocks.PgTaskStore,
    createTaskRunner: coreMocks.createTaskRunner,
    createTaskCompletionWaiter: coreMocks.createTaskCompletionWaiter,
    FileMeshRegistry: coreMocks.FileMeshRegistry,
    AgentChannelServer: coreMocks.AgentChannelServer,
    MeshDelegationEngine: meshCapture.MeshDelegationEngine,
    loadTlsConfig: coreMocks.loadTlsConfig,
  }
})

vi.mock('undici', () => ({
  Agent: class Agent {
    constructor(_opts?: unknown) {
      void _opts
    }
  },
  fetch: vi.fn(),
}))

vi.mock('pg', () => ({
  default: { Pool: pgMocks.Pool },
}))

vi.mock('node:child_process', () => ({
  spawn: vi.fn(() => {
    const proc = {
      stdout: { on: vi.fn() },
      kill: vi.fn(),
      on: vi.fn((event: string, cb: (err?: Error) => void) => {
        if (event === 'error') queueMicrotask(() => cb(new Error('ENOENT')))
        return proc
      }),
    }
    return proc
  }),
}))

afterEach(() => {
  vi.unstubAllEnvs()
  coreMocks.pgTaskStores.splice(0)
  coreMocks.meshRegisters.splice(0)
  coreMocks.taskStoreReady = true
  coreMocks.createTaskRunner.mockClear()
  coreMocks.createTaskCompletionWaiter.mockClear()
  pgMocks.Pool.instances.splice(0)
  coreMocks.started.splice(0)
  coreMocks.nodeNames.splice(0)
  meshCapture.constructed.splice(0)
})

describe('resolveAdvertiseHost', () => {
  it('prefers an explicit advertise_host', () => {
    expect(resolveAdvertiseHost({ advertise_host: '192.0.2.4' })).toBe('192.0.2.4')
  })

  it('trims surrounding whitespace', () => {
    expect(resolveAdvertiseHost({ advertise_host: '  host.example  ' })).toBe('host.example')
  })

  it('falls back to RIVETOS_HOST when advertise_host is unset', () => {
    vi.stubEnv('RIVETOS_HOST', '192.0.2.50')
    expect(resolveAdvertiseHost({})).toBe('192.0.2.50')
    expect(resolveAdvertiseHost(undefined)).toBe('192.0.2.50')
  })

  it('ignores a blank advertise_host and falls back', () => {
    vi.stubEnv('RIVETOS_HOST', '192.0.2.51')
    expect(resolveAdvertiseHost({ advertise_host: '   ' })).toBe('192.0.2.51')
  })
})

describe('createMemoryApiRoute env pass-through', () => {
  it('receives embedQueryInstruction, embedTimeoutMs, hnswEfSearch from env', () => {
    vi.stubEnv('RIVETOS_EMBED_QUERY_INSTRUCTION', 'Instruct: test\nQuery: ')
    vi.stubEnv('RIVETOS_EMBED_TIMEOUT_MS', '8000')
    vi.stubEnv('RIVETOS_HNSW_EF_SEARCH', '80')
    expect(memoryApiEmbedFromEnv()).toEqual({
      embedQueryInstruction: 'Instruct: test\nQuery: ',
      embedTimeoutMs: '8000',
      hnswEfSearch: '80',
    })
  })
})

describe('makeWikiFor (#584 audit: refusal order is the pin)', () => {
  const fakePool = {} as never
  const UNSAFE = [
    '..',
    '../..',
    'a/b',
    'a\\b',
    '/etc/passwd',
    '.hidden',
    'coco/../../..',
    '%2e%2e',
    'a\0b',
  ]

  it('refuses unsafe ids before the pool lookup or any path join', () => {
    const gets: string[] = []
    class SpyMap extends Map<string, never> {
      override get(k: string): never | undefined {
        gets.push(k)
        return super.get(k)
      }
    }
    const pools = new SpyMap([['..', fakePool]]) // even a poisoned pool entry must be unreachable
    const buildIndex = vi.fn(() => ({}))
    const wikiFor = makeWikiFor(pools, '/root', buildIndex)
    for (const evil of UNSAFE) {
      expect(wikiFor(evil)).toBeNull()
    }
    expect(gets).toHaveLength(0)
    expect(buildIndex).not.toHaveBeenCalled()
  })

  it('safe unknown ids consult the pool map and refuse; known ids get a joined dir once', () => {
    const gets: string[] = []
    class SpyMap extends Map<string, never> {
      override get(k: string): never | undefined {
        gets.push(k)
        return super.get(k)
      }
    }
    const pools = new SpyMap([['coco', fakePool]])
    const buildIndex = vi.fn(() => ({ tag: 'idx' }))
    const wikiFor = makeWikiFor(pools, '/root', buildIndex)

    expect(wikiFor('stranger')).toBeNull()
    expect(gets).toContain('stranger')

    const first = wikiFor('coco')
    expect(first?.wikiDir).toBe('/root/users/coco')
    expect(wikiFor('coco')).toBe(first) // cached
    expect(buildIndex).toHaveBeenCalledTimes(1)
  })
})

describe('registerAgentTools shared pool wiring', () => {
  const pgUrl = 'postgres://user:pass@localhost:5432/db'

  function config(): RivetConfig {
    return {
      runtime: { workspace: '/tmp', default_agent: 'test-agent', skill_dirs: [] },
      agents: { 'test-agent': { provider: 'p', model: 'm' } },
      workflows: { enabled: false },
    } as RivetConfig
  }

  function stubRuntime(opts: {
    pgPool?: { end: ReturnType<typeof vi.fn> }
    pgUrl?: string
  }): {
    runtime: Runtime
    hooks: Array<() => Promise<void>>
    setHeartbeatTaskStore: ReturnType<typeof vi.fn>
  } {
    const hooks: Array<() => Promise<void>> = []
    const setHeartbeatTaskStore = vi.fn()
    const runtime = {
      getPgUrl: () => ('pgUrl' in opts ? opts.pgUrl : pgUrl),
      getPgPool: () => opts.pgPool,
      addShutdownHook: (hook: () => Promise<void>) => {
        hooks.push(hook)
      },
      getRouter: () => ({ getAgents: () => [], getProviders: () => [] }),
      getWorkspace: () => ({}),
      getTools: () => [],
      getHooks: () => undefined,
      getMemory: () => undefined,
      registerTool: () => undefined,
      registerSkillCatalog: () => undefined,
      setHeartbeatTaskStore,
    } as unknown as Runtime
    return { runtime, hooks, setHeartbeatTaskStore }
  }

  it('passes the host pool to PgTaskStore and createTaskRunner and does not end it', async () => {
    const hostPool = {
      end: vi.fn(async () => undefined),
      // Preset store probes ros_agent_presets on the same pool. Empty → not ready.
      query: vi.fn(async () => ({ rows: [] })),
    }
    const { runtime, hooks } = stubRuntime({ pgPool: hostPool })
    await registerAgentTools(runtime, config(), '/tmp')
    expect(coreMocks.pgTaskStores[0]).toBe(hostPool)
    expect(coreMocks.createTaskRunner).toHaveBeenCalledWith(
      expect.objectContaining({ pgPool: hostPool }),
    )
    for (const hook of hooks) await hook()
    expect(hostPool.end).not.toHaveBeenCalled()
  })

  it('passes resolvePreset and invalidatePreset to createTaskRunner', async () => {
    const hostPool = {
      end: vi.fn(async () => undefined),
      query: vi.fn(async (sql: unknown) => {
        if (typeof sql === 'string' && sql.includes("to_regclass('ros_agent_presets')")) {
          return { rows: [{ reg: 'ros_agent_presets' }] }
        }
        return { rows: [] }
      }),
    }
    const { runtime, hooks } = stubRuntime({ pgPool: hostPool })
    await registerAgentTools(runtime, config(), '/tmp')
    const opts = coreMocks.createTaskRunner.mock.calls[0]?.[0] as {
      resolvePreset?: (id: string) => Promise<unknown>
      invalidatePreset?: () => void
    }
    expect(typeof opts.resolvePreset).toBe('function')
    expect(typeof opts.invalidatePreset).toBe('function')
    opts.invalidatePreset?.()
    await expect(opts.resolvePreset?.('missing')).resolves.toBeUndefined()
    for (const hook of hooks) await hook()
  })

  it('creates a registrar-owned pool and registers an end() hook when no host pool', async () => {
    const { runtime, hooks } = stubRuntime({})
    await registerAgentTools(runtime, config(), '/tmp')
    const created = pgMocks.Pool.instances.find((p) => p.options.max === 4)
    expect(created).toBeDefined()
    expect(coreMocks.pgTaskStores[0]).toBe(created)
    expect(coreMocks.createTaskRunner).toHaveBeenCalledWith(
      expect.objectContaining({ pgPool: created }),
    )
    expect(created?.end).not.toHaveBeenCalled()
    for (const hook of hooks) await hook()
    expect(created?.end).toHaveBeenCalledTimes(1)
  })

  function meshConfig(nodeName?: string): RivetConfig {
    return {
      runtime: { workspace: '/tmp', default_agent: 'test-agent', skill_dirs: [] },
      agents: { 'test-agent': { provider: 'p', model: 'm' } },
      workflows: { enabled: false },
      mesh: {
        enabled: true,
        tls: true,
        storage_dir: '/tmp/agt-s2-mesh-reg',
        ...(nodeName !== undefined ? { node_name: nodeName } : {}),
      },
    } as RivetConfig
  }

  it('registers a whitespace-padded mesh.node_name trimmed', async () => {
    vi.stubEnv('HOSTNAME', 'from-host')
    const { runtime } = stubRuntime({})
    await registerAgentTools(runtime, meshConfig('  node-f  '), '/tmp')
    expect(coreMocks.nodeNames).toEqual(['node-f'])
    expect(coreMocks.started).toEqual([{ id: 'node-f', name: 'node-f' }])
  })

  it('registers HOSTNAME when mesh.node_name is absent', async () => {
    vi.stubEnv('HOSTNAME', 'from-host')
    const { runtime } = stubRuntime({})
    await registerAgentTools(runtime, meshConfig(), '/tmp')
    expect(coreMocks.nodeNames).toEqual(['from-host'])
    expect(coreMocks.started).toEqual([{ id: 'from-host', name: 'from-host' }])
  })

  it('registers harnessExecutors on the first mesh register()', async () => {
    const hostPool = {
      end: vi.fn(async () => undefined),
      query: vi.fn(async () => ({ rows: [] })),
    }
    const { runtime, hooks } = stubRuntime({ pgPool: hostPool })
    await registerAgentTools(
      runtime,
      {
        ...config(),
        mesh: { enabled: true, tls: true, node_name: 'node-f' },
      },
      '/tmp',
    )
    expect(coreMocks.meshRegisters).toHaveLength(1)
    expect(coreMocks.meshRegisters[0]?.metadata?.harnessExecutors).toEqual([])
    for (const hook of hooks) await hook()
  })

  it('does not probe the preset store when the task engine is not live', async () => {
    const hostPool = {
      end: vi.fn(async () => undefined),
      query: vi.fn(async () => ({ rows: [{ reg: 'ros_agent_presets' }] })),
    }
    const { runtime, hooks } = stubRuntime({ pgPool: hostPool })
    await registerAgentTools(runtime, { ...config(), tasks: { enabled: false } }, '/tmp')
    expect(hostPool.query).not.toHaveBeenCalled()
    for (const hook of hooks) await hook()
  })

  it('a preset-store probe error does not abort boot', async () => {
    const hostPool = {
      end: vi.fn(async () => undefined),
      query: vi.fn(async () => {
        throw new Error('connection refused')
      }),
    }
    const { runtime, hooks } = stubRuntime({ pgPool: hostPool })
    await expect(registerAgentTools(runtime, config(), '/tmp')).resolves.toEqual(
      expect.objectContaining({ gatewayRoutes: expect.any(Array) }),
    )
    for (const hook of hooks) await hook()
  })

  it('does not probe presets when ros_tasks is not ready', async () => {
    coreMocks.taskStoreReady = false
    const hostPool = {
      end: vi.fn(async () => undefined),
      query: vi.fn(async () => ({ rows: [{ reg: 'ros_agent_presets' }] })),
    }
    const { runtime, hooks } = stubRuntime({ pgPool: hostPool })
    await registerAgentTools(runtime, config(), '/tmp')
    expect(hostPool.query).not.toHaveBeenCalled()
    for (const hook of hooks) await hook()
  })

  it('mounts /api/tasks from sqlite_path and resolves a file preset', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'boot-sqlite-'))
    const agentDir = mkdtempSync(join(tmpdir(), 'boot-agent-'))
    vi.stubEnv('RIVETOS_DEN_STATE_DIR', dir)
    vi.stubEnv('HOSTNAME', 'laptop')
    const presets = new FileAgentPresetStore(join(dir, 'agents.json'))
    await presets.create({
      name: 'reviewer',
      node: 'laptop',
      harnessId: 'claude-code',
      model: 'preset-model',
      sharedLink: false,
      directory: agentDir,
    })
    const dbPath = join(dir, 'tasks.db')
    const { runtime, hooks, setHeartbeatTaskStore } = stubRuntime({ pgUrl: undefined })
    try {
      const result = await registerAgentTools(
        runtime,
        { ...config(), tasks: { sqlite_path: dbPath } },
        '/tmp',
      )
      expect(result.gatewayRoutes.some((route) => route.prefix === '/api/tasks')).toBe(true)
      expect(coreMocks.createTaskRunner).not.toHaveBeenCalled()
      expect(setHeartbeatTaskStore).toHaveBeenCalled()
      const waiterArg = coreMocks.createTaskCompletionWaiter.mock.calls.at(-1)?.[0] as {
        pgUrl?: string
      }
      expect(waiterArg.pgUrl).toBeUndefined()
      expect(existsSync(dbPath)).toBe(true)

      const catalog = result.gatewayRoutes.find((route) => route.prefix === '/api/catalog')
      expect(catalog).toBeDefined()
      const body = await getJson(result.gatewayRoutes, '/api/catalog/agents')
      expect(JSON.stringify(body)).toContain('reviewer')
    } finally {
      for (const hook of hooks) await hook()
      rmSync(dir, { recursive: true, force: true })
      rmSync(agentDir, { recursive: true, force: true })
    }
  })

  it('keeps Postgres when pgUrl and sqlite_path are both set', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'boot-sqlite-skip-'))
    const dbPath = join(dir, 'nested', 'tasks.db')
    const hostPool = {
      end: vi.fn(async () => undefined),
      query: vi.fn(async () => ({ rows: [] })),
    }
    const { runtime, hooks } = stubRuntime({ pgPool: hostPool })
    try {
      await registerAgentTools(runtime, { ...config(), tasks: { sqlite_path: dbPath } }, '/tmp')
      expect(existsSync(dbPath)).toBe(false)
      expect(existsSync(join(dir, 'nested'))).toBe(false)
      expect(coreMocks.createTaskRunner).toHaveBeenCalledWith(
        expect.objectContaining({ pgPool: hostPool }),
      )
    } finally {
      for (const hook of hooks) await hook()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('does not hand the sqlite store to mesh delegation', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'boot-sqlite-mesh-'))
    const dbPath = join(dir, 'tasks.db')
    vi.stubEnv('HOSTNAME', 'laptop')
    const { runtime, hooks } = stubRuntime({ pgUrl: undefined })
    try {
      await registerAgentTools(
        runtime,
        {
          ...config(),
          tasks: { sqlite_path: dbPath },
          mesh: { enabled: true, tls: true, node_name: 'laptop' },
        },
        '/tmp',
      )
      expect(meshCapture.constructed).toHaveLength(1)
      expect(meshCapture.constructed[0]?.taskStore).toBeUndefined()
      expect(meshCapture.constructed[0]?.waiter).toBeUndefined()
      expect(existsSync(dbPath)).toBe(true)
    } finally {
      for (const hook of hooks) await hook()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('hands the postgres task store to mesh delegation', async () => {
    const hostPool = {
      end: vi.fn(async () => undefined),
      query: vi.fn(async () => ({ rows: [] })),
    }
    const { runtime, hooks } = stubRuntime({ pgPool: hostPool })
    try {
      await registerAgentTools(
        runtime,
        {
          ...config(),
          mesh: { enabled: true, tls: true, node_name: 'node-f' },
        },
        '/tmp',
      )
      expect(meshCapture.constructed).toHaveLength(1)
      expect(meshCapture.constructed[0]?.taskStore).toBeInstanceOf(coreMocks.PgTaskStore)
      expect(meshCapture.constructed[0]?.waiter).toBeDefined()
    } finally {
      for (const hook of hooks) await hook()
    }
  })

  it('does not open sqlite when tasks are disabled', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'boot-sqlite-off-'))
    const dbPath = join(dir, 'tasks.db')
    const { runtime, hooks } = stubRuntime({ pgUrl: undefined })
    try {
      const result = await registerAgentTools(
        runtime,
        { ...config(), tasks: { enabled: false, sqlite_path: dbPath } },
        '/tmp',
      )
      expect(existsSync(dbPath)).toBe(false)
      expect(coreMocks.createTaskRunner).not.toHaveBeenCalled()
      expect(result.gatewayRoutes.some((route) => route.prefix === '/api/tasks')).toBe(false)
    } finally {
      for (const hook of hooks) await hook()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

async function getJson(routes: GatewayRoute[], path: string): Promise<unknown> {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const route = routes
      .filter(
        (candidate) =>
          url.pathname === candidate.prefix || url.pathname.startsWith(`${candidate.prefix}/`),
      )
      .sort((a, b) => b.prefix.length - a.prefix.length)[0]
    if (!route) {
      res.writeHead(404)
      res.end()
      return
    }
    void Promise.resolve(route.handler(req, res)).catch((err: unknown) => {
      if (!res.headersSent) {
        res.writeHead(500)
        res.end(err instanceof Error ? err.message : String(err))
      }
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('no port')
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}${path}`)
    expect(response.status).toBe(200)
    return await response.json()
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

describe('memory API pool-to-tools composition', () => {
  it.each(['postgres', 'routing', 'unset'] as const)(
    'reuses or caches adapters with %s registered and never constructs a pool',
    (kind) => {
      const ownerPool = { query: vi.fn() } as unknown as pg.Pool
      const userPool = { query: vi.fn() } as unknown as pg.Pool
      pgMocks.constructed.mockClear()
      const poolConstructor = vi.spyOn(pg, 'Pool')
      try {
        const owner = new PostgresMemory({ connectionString: '', pool: ownerPool })
        const registered =
          kind === 'postgres'
            ? owner
            : kind === 'routing'
              ? new RoutingMemory(owner, new Map())
              : undefined
        const lookup = createApiMemoryLookup({ ownerPool, registered, pgUrl: undefined, embed: {} })
        const ownerMemory = lookup(ownerPool)
        expect(ownerMemory).toBeInstanceOf(PostgresMemory)
        if (kind === 'postgres') expect(ownerMemory).toBe(owner)
        else expect(ownerMemory).not.toBe(owner)
        expect(ownerMemory.getPool()).toBe(ownerPool)
        expect(lookup(ownerPool)).toBe(ownerMemory)
        const userMemory = lookup(userPool)
        expect(userMemory).not.toBe(ownerMemory)
        expect(userMemory.getPool()).toBe(userPool)
        expect(lookup(userPool)).toBe(userMemory)
        for (const [memory, pool] of [
          [ownerMemory, ownerPool],
          [userMemory, userPool],
        ] as const) {
          const names = memoryHttpTools(memory, pool).map((tool) => tool.name)
          expect(names.sort()).toEqual(
            [
              'memory_search',
              'memory_browse',
              'memory_stats',
              'memory_get_full',
              'memory_append',
              'memory_ingest_session',
            ].sort(),
          )
          expect(new Set(names).size).toBe(6)
        }
        expect(poolConstructor).not.toHaveBeenCalled()
        expect(pgMocks.constructed).not.toHaveBeenCalled()
      } finally {
        poolConstructor.mockRestore()
      }
    },
  )
})
