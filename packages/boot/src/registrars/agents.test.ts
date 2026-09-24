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
  class PgTaskStore {
    pool: unknown
    constructor(pool: unknown) {
      this.pool = pool
      pgTaskStores.push(pool)
    }
    async isReady(): Promise<boolean> {
      return true
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
  return { PgTaskStore, pgTaskStores, createTaskRunner, createTaskCompletionWaiter }
})

const meshCapture = vi.hoisted(() => {
  const started: Array<{ id: string; name: string }> = []
  const nodeNames: string[] = []
  class FileMeshRegistry {
    constructor(opts: { mesh?: { nodeName?: string } }) {
      if (opts.mesh?.nodeName) nodeNames.push(opts.mesh.nodeName)
    }
    start(node: { id: string; name: string }): Promise<void> {
      started.push({ id: node.id, name: node.name })
      return Promise.resolve()
    }
  }
  class AgentChannelServer {
    start(): Promise<void> {
      return Promise.resolve()
    }
  }
  class MeshDelegationEngine {
    createDelegationTool(): { name: string } {
      return { name: 'delegate_task' }
    }
  }
  return { started, nodeNames, FileMeshRegistry, AgentChannelServer, MeshDelegationEngine }
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
    FileMeshRegistry: meshCapture.FileMeshRegistry,
    AgentChannelServer: meshCapture.AgentChannelServer,
    MeshDelegationEngine: meshCapture.MeshDelegationEngine,
    loadTlsConfig: () => ({
      ca: Buffer.from('ca'),
      cert: Buffer.from('cert'),
      key: Buffer.from('key'),
      cn: 'node',
    }),
  }
})

vi.mock('undici', () => ({
  Agent: class Agent {
    constructor(_opts?: unknown) {
      void _opts
    }
  },
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
  coreMocks.createTaskRunner.mockClear()
  coreMocks.createTaskCompletionWaiter.mockClear()
  pgMocks.Pool.instances.splice(0)
  meshCapture.started.splice(0)
  meshCapture.nodeNames.splice(0)
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
    expect(meshCapture.nodeNames).toEqual(['ct115'])
    expect(meshCapture.started).toEqual([{ id: 'ct115', name: 'ct115' }])
  })

  it('registers HOSTNAME when mesh.node_name is absent', async () => {
    vi.stubEnv('HOSTNAME', 'from-host')
    const { runtime } = stubRuntime({})
    await registerAgentTools(runtime, meshConfig(), '/tmp')
    expect(meshCapture.nodeNames).toEqual(['from-host'])
    expect(meshCapture.started).toEqual([{ id: 'from-host', name: 'from-host' }])
  })
})
