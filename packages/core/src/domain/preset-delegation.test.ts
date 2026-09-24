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
import type { CachedPresetResolver } from '@rivetos/agent-registry'
import { harnessExecutorGap } from './task/harness-executors.js'
import { createNotImplementedHarnessExecutor } from './task/harness-executors.js'
import { createExecutorRegistry, type TaskExecutorRegistry } from './task/runner.js'
import { InMemoryTaskStore } from './task/store.js'
import { createTaskCompletionWaiter } from './task/completion-waiter.js'
import { PresetDelegationEngine } from './preset-delegation.js'

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
    expect(text).toContain(harnessExecutorGap('codex'))
    expect(text).toContain(
      '- kimi reviewer (agent: kimi-code on ct116, dir /home/rivet/.rivetos/agents/kimi) — NO headless executor:',
    )
    expect(text).toContain('- bare (on ct114 — this node) — no harness configured')
  })
})
