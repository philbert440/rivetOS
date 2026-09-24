/**
 * PresetDelegationEngine — RivetHub presets as harness-session task rows.
 */

import { describe, it, expect, afterEach } from 'vitest'
import type {
  AgentPreset,
  HarnessExecutor,
  HarnessExecutorCapabilities,
  HarnessId,
  MeshNode,
  MeshRegistry,
} from '@rivetos/types'
import {
  createCachedPresetResolver,
  type AgentPresetStore,
  type CachedPresetResolver,
} from '@rivetos/agent-registry'
import type { Router } from './router.js'
import { harnessExecutorGap } from './task/harness-executors.js'
import { createNotImplementedHarnessExecutor } from './task/harness-executors.js'
import { createExecutorRegistry, type TaskExecutorRegistry } from './task/runner.js'
import { InMemoryTaskStore } from './task/store.js'
import { createTaskCompletionWaiter } from './task/completion-waiter.js'
import { buildCatalogAgents } from './task/catalog-api.js'
import { NoMeshRegistryError, PresetDelegationEngine, presetTaskSpec } from './preset-delegation.js'

const caps: HarnessExecutorCapabilities = {
  steerable: false,
  multiTurn: false,
  structuredStream: false,
  usageInResult: false,
  sessionIdCapture: false,
  slashCommands: false,
  effortSelection: false,
  mcpInjection: 'none',
}

const USAGE = { inputTokens: 1, outputTokens: 2, totalTokens: 3, turns: 1, wallClockMs: 4 }

function runnable(name: string): HarnessExecutor {
  return {
    name,
    capabilities: () => caps,
    start: () => {
      throw new Error('not started here')
    },
  }
}

function preset(overrides: Partial<AgentPreset> = {}): AgentPreset {
  return {
    id: 'preset-1',
    name: 'reviewer',
    color: '',
    harnessId: 'claude-code',
    model: 'opus',
    effort: 'high',
    systemPrompt: 'be strict',
    node: 'ct115',
    directory: '/home/rivet/.rivetos/agents/reviewer',
    sharedLink: true,
    nodeBaseUrl: '',
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

function resolver(rows: AgentPreset[]): CachedPresetResolver {
  return {
    list: () => Promise.resolve(rows.slice()),
    find: (handle) => {
      const trimmed = handle.trim()
      const found =
        rows.find((p) => p.id === trimmed) ??
        rows.find((p) => p.name === trimmed) ??
        rows.find((p) => p.name.toLowerCase() === trimmed.toLowerCase())
      return Promise.resolve(found)
    },
    lastKnown: () => rows.slice(),
    invalidate() {},
    // Always fresh: this stub has no store, so roster reads must not invalidate it.
    status: () => ({ hasValue: true, fetchedAt: Date.now() }),
  }
}

function node(
  name: string,
  status: MeshNode['status'] = 'online',
  harnessExecutors?: string[],
): MeshNode {
  return {
    id: name,
    name,
    agents: [],
    host: '10.0.0.1',
    port: 3000,
    providers: [],
    models: [],
    capabilities: [],
    status,
    lastSeen: 1,
    registeredAt: 1,
    version: '0.1.0',
    ...(harnessExecutors ? { metadata: { harnessExecutors } } : {}),
  }
}

function mesh(nodes: MeshNode[]): MeshRegistry {
  return {
    register: async () => {},
    deregister: async () => {},
    heartbeat: async () => {},
    getNodes: async () => nodes,
    getNode: async (id) => nodes.find((n) => n.id === id),
    findByAgent: async () => [],
    findByCapability: async () => [],
    findByProvider: async () => [],
    sync: async () => {},
    prune: async () => [],
  }
}

function executors(implemented: HarnessId[], rejected: HarnessId[] = []): TaskExecutorRegistry {
  const registry = createExecutorRegistry()
  for (const id of implemented) registry.register('harness-session', runnable(id), id)
  for (const id of rejected) {
    registry.register(
      'harness-session',
      createNotImplementedHarnessExecutor(id, { reason: 'not wired' }),
      id,
    )
  }
  return registry
}

const stoppers: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const stop of stoppers.splice(0)) await stop()
})

function engineFor(
  rows: AgentPreset[],
  opts: {
    store: InMemoryTaskStore
    nodeName?: string
    executors?: TaskExecutorRegistry
    mesh?: MeshRegistry
  },
): PresetDelegationEngine {
  const waiter = createTaskCompletionWaiter({ store: opts.store, pollFallbackMs: 10 })
  stoppers.push(() => waiter.stop())
  return new PresetDelegationEngine({
    resolver: resolver(rows),
    taskStore: opts.store,
    waiter,
    nodeName: opts.nodeName ?? 'ct115',
    executors: opts.executors,
    meshRegistry: opts.mesh,
  })
}

describe('PresetDelegationEngine', () => {
  it('trims a non-blank model on the preset spec', () => {
    expect(presetTaskSpec(preset(), { model: ' opus ' }).model).toBe('opus')
    expect(presetTaskSpec(preset({ model: ' haiku ' })).model).toBe('haiku')
    expect(presetTaskSpec(preset(), { model: '   ' }).model).toBeUndefined()
  })

  it('creates a harness-session row pinned to the hosting node', async () => {
    const store: InMemoryTaskStore = new InMemoryTaskStore((id) => {
      void (async () => {
        await store.claim(id, 'ct115')
        await store.finish(id, 'completed', {
          verdict: 'completed',
          summary: 'reviewed',
          output: 'looks good',
          artifacts: [],
          usage: USAGE,
        })
      })()
    })
    const rowPreset = preset()
    const engine = engineFor([rowPreset], {
      store,
      executors: executors(['claude-code']),
    })

    const result = await engine.delegate(
      {
        fromAgent: 'local',
        toAgent: 'reviewer',
        task: 'review the diff',
        context: ['file a.ts'],
        model: 'override-model',
      },
      rowPreset,
      1,
      'parent-1',
    )

    expect(result.status).toBe('completed')
    expect(result.response).toBe('looks good')
    const rows = await store.list()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      executor: 'harness-session',
      executorTarget: 'claude-code',
      agentId: 'preset-1',
      origin: 'tool',
      nodeAffinity: 'ct115',
      requestedBy: 'local',
      chainDepth: 2,
      parentTaskId: 'parent-1',
      maxAttempts: 1,
      goal: 'review the diff\n\nContext:\nfile a.ts',
    })
    expect(rows[0]?.spec).toMatchObject({
      delegation: true,
      presetId: 'preset-1',
      presetName: 'reviewer',
      meshFrom: 'ct115',
      workingDir: '/home/rivet/.rivetos/agents/reviewer',
      sharedLink: true,
      model: 'override-model',
      effort: 'high',
      systemPromptAppend: 'be strict',
      excludeTools: ['delegate_task'],
    })
  })

  it('model falls back to the preset, then is omitted when both are empty', async () => {
    const store = new InMemoryTaskStore((id) => {
      void store.finish(id, 'completed', {
        verdict: 'completed',
        summary: 'ok',
        output: 'ok',
        artifacts: [],
        usage: USAGE,
      })
    })
    const presetModel = preset({ model: 'preset-model' })
    const engine = engineFor([presetModel], {
      store,
      executors: executors(['claude-code']),
    })
    await engine.delegate({ fromAgent: 'local', toAgent: 'reviewer', task: 't' }, presetModel)
    expect((await store.list())[0]?.spec).toMatchObject({ model: 'preset-model' })

    const store2 = new InMemoryTaskStore((id) => {
      void store2.finish(id, 'completed', {
        verdict: 'completed',
        summary: 'ok',
        output: 'ok',
        artifacts: [],
        usage: USAGE,
      })
    })
    const emptyModel = preset({ model: '' })
    const engine2 = engineFor([emptyModel], {
      store: store2,
      executors: executors(['claude-code']),
    })
    await engine2.delegate({ fromAgent: 'local', toAgent: 'reviewer', task: 't' }, emptyModel)
    expect((await store2.list())[0]?.spec.model).toBeUndefined()
  })

  it('omits effort values outside low|medium|high', async () => {
    const store = new InMemoryTaskStore((id) => {
      void store.finish(id, 'completed', {
        verdict: 'completed',
        summary: 'ok',
        output: 'ok',
        artifacts: [],
        usage: USAGE,
      })
    })
    const xhigh = preset({ effort: 'xhigh', systemPrompt: '' })
    const engine = engineFor([xhigh], {
      store,
      executors: executors(['claude-code']),
    })
    await engine.delegate({ fromAgent: 'local', toAgent: 'reviewer', task: 't' }, xhigh)
    const spec = (await store.list())[0]?.spec
    expect(spec?.effort).toBeUndefined()
    expect(spec?.systemPromptAppend).toBeUndefined()
  })

  it('timeout kills the row', async () => {
    const store = new InMemoryTaskStore()
    const engine = engineFor([preset()], {
      store,
      executors: executors(['claude-code']),
    })
    const result = await engine.delegate(
      { fromAgent: 'local', toAgent: 'reviewer', task: 'hang', timeoutMs: -5_500 },
      preset(),
      0,
    )
    expect(result.status).toBe('timeout')
    expect((await store.list())[0]?.status).toBe('killed')
  })

  it('pre-flight: no harness, no node, chain cap — no row', async () => {
    const store = new InMemoryTaskStore()
    const rows = [
      preset({ id: 'a', name: 'bare', harnessId: undefined }),
      preset({ id: 'b', name: 'homeless', node: undefined }),
      preset({ id: 'c', name: 'deep' }),
    ]
    const engine = engineFor(rows, { store, executors: executors(['claude-code']) })

    const bare = (await engine.find('bare'))!
    const noHarness = await engine.delegate(
      { fromAgent: 'local', toAgent: 'bare', task: 't' },
      bare,
      0,
    )
    expect(noHarness.status).toBe('failed')
    expect(noHarness.response).toContain('preset "bare" has no harness configured')

    const homeless = (await engine.find('homeless'))!
    const noNode = await engine.delegate(
      { fromAgent: 'local', toAgent: 'homeless', task: 't' },
      homeless,
      0,
    )
    expect(noNode.response).toContain('preset "homeless" has no hosting node')

    const deepPreset = (await engine.find('deep'))!
    const deep = await engine.delegate(
      { fromAgent: 'local', toAgent: 'deep', task: 't' },
      deepPreset,
      3,
    )
    expect(deep.response).toContain('chain too deep')
    expect(deep.response).not.toContain('mesh')
    expect(await store.list()).toHaveLength(0)

    const far = preset({ id: 'd', name: 'far', node: 'ct116' })
    const remoteCap = await engine.delegate(
      { fromAgent: 'local', toAgent: 'far', task: 't' },
      far,
      3,
    )
    expect(remoteCap.response).toContain('refusing mesh delegation')
    expect(await store.list()).toHaveLength(0)
  })

  it('pre-flight: local harness with no headless executor names the gap', async () => {
    const store = new InMemoryTaskStore()
    const engine = engineFor([preset({ harnessId: 'codex' })], {
      store,
      executors: executors([], ['codex']),
    })
    const found = (await engine.find('reviewer'))!
    const result = await engine.delegate(
      { fromAgent: 'local', toAgent: 'reviewer', task: 't' },
      found,
      0,
    )
    expect(result.status).toBe('failed')
    expect(result.response).toContain('agent "reviewer" (codex on this node):')
    expect(result.response).toContain('not wired')
    expect(result.response).not.toContain(harnessExecutorGap('codex'))
    expect(await store.list()).toHaveLength(0)
  })

  it('local pre-flight falls back to the recorded gap when no executor is registered', async () => {
    const store = new InMemoryTaskStore()
    const engine = engineFor([preset({ harnessId: 'codex' })], {
      store,
      executors: executors([]),
    })
    const result = await engine.delegate(
      { fromAgent: 'local', toAgent: 'reviewer', task: 't' },
      preset({ harnessId: 'codex' }),
      0,
    )
    expect(result.response).toContain(harnessExecutorGap('codex'))
    expect(await store.list()).toHaveLength(0)
  })

  it('pre-flight: hosting node offline or unknown', async () => {
    const store = new InMemoryTaskStore()
    const remote = preset({ node: 'ct116', harnessId: 'claude-code' })
    const engine = engineFor([remote], {
      store,
      nodeName: 'ct115',
      executors: executors(['claude-code']),
      mesh: mesh([node('ct116', 'offline', ['claude-code'])]),
    })
    const result = await engine.delegate(
      { fromAgent: 'local', toAgent: 'reviewer', task: 't' },
      remote,
      0,
    )
    expect(result.response).toContain('hosting node "ct116" is offline or unknown')
    expect(await store.list()).toHaveLength(0)
  })

  it('pre-flight: remote node advertising executors without the harness', async () => {
    const store = new InMemoryTaskStore()
    const remote = preset({ node: 'ct116', harnessId: 'codex' })
    const engine = engineFor([remote], {
      store,
      nodeName: 'ct115',
      mesh: mesh([node('ct116', 'online', ['claude-code'])]),
    })
    const result = await engine.delegate(
      { fromAgent: 'local', toAgent: 'reviewer', task: 't' },
      remote,
      0,
    )
    expect(result.response).toContain('agent "reviewer" (codex on ct116):')
    expect(result.response).toContain(harnessExecutorGap('codex'))
    expect(await store.list()).toHaveLength(0)
  })

  it('pre-flight: no mesh registry cannot reach a remote node', async () => {
    const store = new InMemoryTaskStore()
    const remote = preset({ node: 'ct116' })
    const engine = engineFor([remote], { store, nodeName: 'ct115' })
    const result = await engine.delegate(
      { fromAgent: 'local', toAgent: 'reviewer', task: 't' },
      remote,
      0,
    )
    expect(result.response).toContain('no mesh registry; cannot reach node "ct116"')
    expect(await store.list()).toHaveLength(0)
  })

  it('treats NoMeshRegistryError like a missing registry', async () => {
    const absent: MeshRegistry = {
      ...mesh([]),
      getNodes: () => Promise.reject(new NoMeshRegistryError()),
    }
    const remoteStore = new InMemoryTaskStore()
    const remote = preset({ node: 'ct116' })
    const refused = engineFor([remote], { store: remoteStore, nodeName: 'ct115', mesh: absent })
    const denied = await refused.delegate(
      { fromAgent: 'local', toAgent: 'reviewer', task: 't' },
      remote,
      0,
    )
    expect(denied.response).toContain('no mesh registry; cannot reach node "ct116"')
    expect(await remoteStore.list()).toHaveLength(0)

    const localStore = autoFinish('completed')
    const local = preset({ node: 'ct115' })
    let seen: string | undefined
    const allowed = engineFor([local], { store: localStore, nodeName: 'ct115', mesh: absent })
    const result = await allowed.delegate(
      { fromAgent: 'local', toAgent: 'reviewer', task: 't' },
      local,
      0,
      undefined,
      (rowId) => {
        seen = rowId
      },
    )
    expect(result.status).toBe('completed')
    expect(result.response).not.toContain('no mesh registry')
    const row = (await localStore.list())[0]
    expect(row?.nodeAffinity).toBe('ct115')
    expect(seen).toBe(row?.id)
  })

  it('remote node that advertises the harness runs as a mesh-origin row', async () => {
    const store = new InMemoryTaskStore((id) => {
      void store.finish(id, 'completed', {
        verdict: 'completed',
        summary: 'remote done',
        output: 'remote done',
        artifacts: [],
        usage: USAGE,
      })
    })
    const remote = preset({ node: 'ct116' })
    const engine = engineFor([remote], {
      store,
      nodeName: 'ct115',
      mesh: mesh([node('ct116', 'online', ['claude-code'])]),
    })
    const result = await engine.delegate(
      { fromAgent: 'local', toAgent: 'reviewer', task: 't' },
      remote,
      0,
    )
    expect(result.status).toBe('completed')
    expect((await store.list())[0]).toMatchObject({
      origin: 'mesh',
      nodeAffinity: 'ct116',
      executor: 'harness-session',
    })
  })

  it('rosterText shapes: local, remote, unimplemented, no harness', async () => {
    const store = new InMemoryTaskStore()
    const rows = [
      preset({
        id: '1',
        name: 'reviewer',
        harnessId: 'codex',
        node: 'ct114',
        directory: '/home/rivet/.rivetos/agents/reviewer',
      }),
      preset({
        id: '2',
        name: 'kimi reviewer',
        harnessId: 'kimi-code',
        node: 'ct116',
        directory: '/home/rivet/.rivetos/agents/kimi',
      }),
      preset({ id: '3', name: 'bare', harnessId: undefined, node: 'ct114', directory: undefined }),
    ]
    const engine = engineFor(rows, {
      store,
      nodeName: 'ct114',
      executors: executors([], ['codex']),
      mesh: mesh([node('ct116', 'online', ['claude-code'])]),
    })
    await engine.find('reviewer')
    const text = engine.rosterText()
    expect(text).toContain(
      '- reviewer (agent: codex on ct114 — this node, dir /home/rivet/.rivetos/agents/reviewer) — NO headless executor:',
    )
    expect(text).toContain('not wired')
    expect(text).toContain(harnessExecutorGap('kimi-code'))
    expect(text).toContain(
      '- kimi reviewer (agent: kimi-code on ct116, dir /home/rivet/.rivetos/agents/kimi) — NO headless executor:',
    )
    expect(text).toContain('- bare (on ct114 — this node) — no harness configured')
  })

  function autoFinish(
    status: 'completed' | 'failed' | 'timeout',
    error?: string,
  ): InMemoryTaskStore {
    const store = new InMemoryTaskStore((id) => {
      void store.finish(id, status, {
        verdict: status === 'completed' ? 'completed' : 'failed',
        summary: status,
        ...(status === 'completed' ? { output: 'done' } : {}),
        artifacts: [],
        usage: USAGE,
        ...(error ? { error } : {}),
      })
    })
    return store
  }

  it('maps a failed terminal row to text', async () => {
    const store = autoFinish('failed', 'capability_unsupported: binary not resolvable')
    const rowPreset = preset()
    const engine = engineFor([rowPreset], { store, executors: executors(['claude-code']) })
    const result = await engine.delegate(
      { fromAgent: 'local', toAgent: 'reviewer', task: 't' },
      rowPreset,
      0,
    )
    expect(result.status).toBe('failed')
    expect(result.response).toContain('Delegation to reviewer on ct115 failed')
    expect(result.response).toContain('binary not resolvable')
  })

  it('maps a timeout terminal row to text', async () => {
    const store = autoFinish('timeout', 'deadline')
    const rowPreset = preset()
    const engine = engineFor([rowPreset], { store, executors: executors(['claude-code']) })
    const result = await engine.delegate(
      { fromAgent: 'local', toAgent: 'reviewer', task: 't' },
      rowPreset,
      0,
    )
    expect(result.status).toBe('timeout')
    expect(result.response).toContain('Delegation to reviewer on ct115 timeout')
    expect(result.response).toContain('deadline')
  })

  it('durations use the engine clock', async () => {
    const store = autoFinish('completed')
    const waiter = createTaskCompletionWaiter({ store, pollFallbackMs: 10 })
    stoppers.push(() => waiter.stop())
    const rowPreset = preset()
    const engine = new PresetDelegationEngine({
      resolver: resolver([rowPreset]),
      taskStore: store,
      waiter,
      nodeName: 'ct115',
      executors: executors(['claude-code']),
      now: () => 1_000_000,
    })
    const result = await engine.delegate(
      { fromAgent: 'local', toAgent: 'reviewer', task: 't' },
      rowPreset,
    )
    expect(result.status).toBe('completed')
    expect(result.durationMs).toBe(0)
  })

  it('an older peer with no harnessExecutors metadata gets a row', async () => {
    const store = autoFinish('completed')
    const remote = preset({ node: 'ct116' })
    const engine = engineFor([remote], {
      store,
      nodeName: 'ct115',
      mesh: mesh([node('ct116', 'online')]),
    })
    const result = await engine.delegate(
      { fromAgent: 'local', toAgent: 'reviewer', task: 't' },
      remote,
      0,
    )
    expect(result.status).toBe('completed')
    expect(await store.list()).toHaveLength(1)
  })

  it('canonicalises advertised executor targets before the coverage check', async () => {
    const store = autoFinish('completed')
    const remote = preset({ node: 'ct116', harnessId: 'claude-code' })
    const engine = engineFor([remote], {
      store,
      nodeName: 'ct115',
      mesh: mesh([node('ct116', 'online', ['claude-cli'])]),
    })
    const result = await engine.delegate(
      { fromAgent: 'local', toAgent: 'reviewer', task: 't' },
      remote,
      0,
    )
    expect(result.status).toBe('completed')
    expect(await store.list()).toHaveLength(1)
  })

  it('a local preset with no executor registry uses its own mesh entry', async () => {
    const store = autoFinish('completed')
    const local = preset({ node: 'ct115' })
    const engine = engineFor([local], {
      store,
      nodeName: 'ct115',
      mesh: mesh([node('ct115', 'online', ['claude-code'])]),
    })
    const allowed = await engine.delegate(
      { fromAgent: 'local', toAgent: 'reviewer', task: 't' },
      local,
      0,
    )
    expect(allowed.status).toBe('completed')

    const refusedStore = new InMemoryTaskStore()
    const refused = engineFor([local], {
      store: refusedStore,
      nodeName: 'ct115',
      mesh: mesh([node('ct115', 'online', ['kimi-code'])]),
    })
    const blocked = await refused.delegate(
      { fromAgent: 'local', toAgent: 'reviewer', task: 't' },
      local,
      0,
    )
    expect(blocked.response).toContain(harnessExecutorGap('claude-code'))
    expect(await refusedStore.list()).toHaveLength(0)
  })

  it('a local preset with no executor registry and no mesh registry is created', async () => {
    const store = autoFinish('completed')
    const local = preset({ node: 'ct115' })
    const engine = engineFor([local], { store, nodeName: 'ct115' })
    const result = await engine.delegate(
      { fromAgent: 'local', toAgent: 'reviewer', task: 't' },
      local,
      0,
    )
    expect(result.status).toBe('completed')
    expect(result.response).not.toContain('no mesh registry')
    expect(await store.list()).toHaveLength(1)
  })

  it('a preset added after boot shows up in rosterText after one TTL and in the next catalog request', async () => {
    const rows: AgentPreset[] = [preset({ id: 'a', name: 'first' })]
    let now = 1_000
    const backing = {
      list: async () => rows.map((row) => ({ ...row })),
    } as unknown as AgentPresetStore
    const cached = createCachedPresetResolver(backing, { ttlMs: 1_000, now: () => now })
    const store = new InMemoryTaskStore()
    const waiter = createTaskCompletionWaiter({ store, pollFallbackMs: 10 })
    stoppers.push(() => waiter.stop())
    const engine = new PresetDelegationEngine({
      resolver: cached,
      taskStore: store,
      waiter,
      nodeName: 'ct115',
      executors: executors(['claude-code']),
      now: () => now,
    })
    await cached.list()
    expect(engine.rosterText()).toContain('first')

    rows.push(preset({ id: 'b', name: 'second' }))
    expect(engine.rosterText()).not.toContain('second')

    now += 1_000
    engine.rosterText()
    for (let i = 0; i < 20 && !cached.lastKnown().some((row) => row.name === 'second'); i++) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    expect(engine.rosterText()).toContain('second')

    // Catalog half must await a refresh, not read the cache rosterText just filled.
    // 30s is the roster TTL (`MESH_REFRESH_TTL_MS`); the resolver's own TTL is 1s.
    rows.push(preset({ id: 'c', name: 'third' }))
    now += 30_000
    const agents = await buildCatalogAgents({
      nodeName: 'ct115',
      router: { getAgents: () => [] } as unknown as Router,
      tools: () => [],
      executors: executors(['claude-code']),
      presets: engine,
    })
    expect(agents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'preset', name: 'second' }),
        expect.objectContaining({ kind: 'preset', name: 'third' }),
      ]),
    )
  })

  function catalogOpts(
    engine: PresetDelegationEngine,
    rosterFreshTimeoutMs: number,
  ): Parameters<typeof buildCatalogAgents>[0] {
    const hungMesh = mesh([])
    hungMesh.getNodes = () => new Promise(() => {})
    return {
      nodeName: 'ct115',
      router: { getAgents: () => [] } as unknown as Router,
      tools: () => [],
      executors: executors(['claude-code']),
      presets: engine,
      rosterFreshTimeoutMs,
      meshRegistry: hungMesh,
    }
  }

  it('the first catalog request after the TTL awaits a pending store read', async () => {
    const rows: AgentPreset[] = [preset({ id: 'a', name: 'first' })]
    let now = 1_000
    const pending: Array<(rows: AgentPreset[]) => void> = []
    let mode: 'immediate' | 'deferred' | 'hang' = 'immediate'
    let listCalls = 0
    const backing = {
      list: () => {
        listCalls += 1
        if (mode === 'hang') return new Promise<AgentPreset[]>(() => {})
        if (mode === 'deferred') {
          return new Promise<AgentPreset[]>((resolve) => {
            pending.push((next) => resolve(next.map((row) => ({ ...row }))))
          })
        }
        return Promise.resolve(rows.map((row) => ({ ...row })))
      },
    } as unknown as AgentPresetStore
    const cached = createCachedPresetResolver(backing, { ttlMs: 1_000, now: () => now })
    const store = new InMemoryTaskStore()
    const waiter = createTaskCompletionWaiter({ store, pollFallbackMs: 10 })
    stoppers.push(() => waiter.stop())
    const engine = new PresetDelegationEngine({
      resolver: cached,
      taskStore: store,
      waiter,
      nodeName: 'ct115',
      executors: executors(['claude-code']),
      now: () => now,
    })
    await cached.list()

    rows.push(preset({ id: 'b', name: 'second' }))
    // Past the roster TTL, not merely the resolver's 1s TTL — otherwise no invalidate.
    now += 30_000
    mode = 'deferred'
    const catalog = buildCatalogAgents(catalogOpts(engine, 300))
    for (let i = 0; i < 20 && pending.length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    expect(pending.length).toBeGreaterThan(0)
    pending[0]?.(rows)
    const agents = await catalog
    expect(agents).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: 'preset', name: 'second' })]),
    )

    rows.push(preset({ id: 'c', name: 'third' }))
    now += 30_000
    mode = 'hang'
    const callsBeforeHang = listCalls
    const started = Date.now()
    const hung = await buildCatalogAgents(catalogOpts(engine, 40))
    const elapsed = Date.now() - started
    expect(elapsed).toBeGreaterThanOrEqual(30)
    expect(elapsed).toBeLessThan(500)
    expect(hung.some((agent) => agent.name === 'third')).toBe(false)
    expect(hung.some((agent) => agent.name === 'second')).toBe(true)
    expect(listCalls).toBeGreaterThan(callsBeforeHang)

    // A timed-out list() stays in flight, so the next call must not start another.
    const callsAfterTimeout = listCalls
    const againStarted = Date.now()
    const again = await engine.rosterEntriesFresh({ timeoutMs: 40 })
    expect(Date.now() - againStarted).toBeLessThan(500)
    expect(listCalls).toBe(callsAfterTimeout)
    expect(again.some((entry) => entry.name === 'second')).toBe(true)
    expect(again.some((entry) => entry.name === 'third')).toBe(false)
  })

  it('a hung mesh read does not pin the next roster refresh', async () => {
    let calls = 0
    const hung = mesh([])
    hung.getNodes = () => {
      calls += 1
      return new Promise(() => {})
    }
    const store = new InMemoryTaskStore()
    const engine = engineFor([preset()], { store, mesh: hung })
    const afterConstruct = calls
    expect(afterConstruct).toBeGreaterThanOrEqual(1)
    await engine.rosterEntriesFresh({ timeoutMs: 30 })
    await engine.rosterEntriesFresh({ timeoutMs: 30 })
    expect(calls).toBeGreaterThan(afterConstruct)
  })

  it('a timed-out mesh read does not overwrite a newer snapshot', async () => {
    const staleNode = node('ct116', 'online', ['kimi-code'])
    const freshNode = node('ct116', 'online', ['claude-code'])
    let call = 0
    let releaseFirst: (nodes: MeshNode[]) => void = () => {}
    const registry = mesh([])
    registry.getNodes = () => {
      call += 1
      if (call === 1) {
        return new Promise((resolve) => {
          releaseFirst = resolve
        })
      }
      return Promise.resolve([freshNode])
    }
    const store = new InMemoryTaskStore()
    const remote = preset({ node: 'ct116' })
    const engine = engineFor([remote], { store, mesh: registry })
    expect(call).toBe(1)
    await engine.rosterEntriesFresh({ timeoutMs: 20 })
    await engine.rosterEntriesFresh({ timeoutMs: 200 })
    expect(engine.rosterEntries().find((entry) => entry.id === remote.id)?.implemented).toBe(true)

    releaseFirst([staleNode])
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(engine.rosterEntries().find((entry) => entry.id === remote.id)?.implemented).toBe(true)
    expect(call).toBe(2)
  })
})
