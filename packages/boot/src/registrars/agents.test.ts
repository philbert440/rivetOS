import { describe, it, expect, afterEach, vi } from 'vitest'
import type { Runtime } from '@rivetos/core'
import type { RivetConfig } from '../config.js'
import {
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
  class MeshDelegationEngine {
    createDelegationTool(): { name: string } {
      return { name: 'delegate_task' }
    }
  }
  return { MeshDelegationEngine }
})

const pgMocks = vi.hoisted(() => {
  class Pool {
    static instances: Pool[] = []
    options: { connectionString?: string; max?: number }
    end = vi.fn(async () => undefined)
    query = vi.fn(async () => ({ rows: [] }))
    constructor(options: { connectionString?: string; max?: number }) {
      this.options = options
      Pool.instances.push(this)
    }
  }
  return { Pool }
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

  function stubRuntime(opts: { pgPool?: { end: ReturnType<typeof vi.fn> } }): {
    runtime: Runtime
    hooks: Array<() => Promise<void>>
  } {
    const hooks: Array<() => Promise<void>> = []
    const runtime = {
      getPgUrl: () => pgUrl,
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
      setHeartbeatTaskStore: () => undefined,
    } as unknown as Runtime
    return { runtime, hooks }
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
    await registerAgentTools(runtime, meshConfig('  ct115  '), '/tmp')
    expect(coreMocks.nodeNames).toEqual(['ct115'])
    expect(coreMocks.started).toEqual([{ id: 'ct115', name: 'ct115' }])
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
        mesh: { enabled: true, tls: true, node_name: 'ct115' },
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
})
