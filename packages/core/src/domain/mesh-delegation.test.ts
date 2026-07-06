/**
 * Tests for MeshDelegationEngine's agent-roster advertising.
 *
 * Regression context: rivet-local could "delegate" but only ever to its own
 * local `grok` agent — it never discovered remote mesh agents because the
 * delegate_task tool gave the model no roster. These tests pin the behaviour
 * that the tool now advertises the live, reachable roster.
 */

import { describe, it, expect } from 'vitest'
import type { MeshNode, MeshRegistry, Tool } from '@rivetos/types'
import { MeshDelegationEngine } from './mesh-delegation.js'
import type { DelegationEngine } from './delegation.js'
import type { Router } from './router.js'

function node(name: string, agents: string[], status: MeshNode['status'] = 'online'): MeshNode {
  return {
    id: name,
    name,
    agents,
    host: `10.0.0.0`,
    port: 3000,
    providers: [],
    models: [],
    capabilities: [],
    status,
    lastSeen: 1,
    registeredAt: 1,
    version: '0.1.0',
  }
}

function makeRegistry(nodes: MeshNode[]): MeshRegistry {
  return {
    register: async () => {},
    deregister: async () => {},
    heartbeat: async () => {},
    getNodes: async () => nodes,
    getNode: async (id) => nodes.find((n) => n.id === id),
    findByAgent: async (a) => nodes.filter((n) => n.agents.includes(a)),
    findByCapability: async () => [],
    findByProvider: async () => [],
    sync: async () => {},
    prune: async () => [],
  }
}

function makeEngine(nodes: MeshNode[]): MeshDelegationEngine {
  return new MeshDelegationEngine({
    localEngine: {} as DelegationEngine,
    router: { getAgents: () => [] } as unknown as Router,
    meshRegistry: makeRegistry(nodes),
    tls: { ca: '', cert: '', key: '' },
    httpsDispatcher: {}, // skip dispatcher auto-create
    localAgents: ['local', 'grok'],
    nodeName: 'ct114',
  })
}

describe('MeshDelegationEngine roster', () => {
  it('lists local agents and remote mesh agents, excluding self', async () => {
    const engine = makeEngine([
      node('ct114', ['local', 'grok']), // self — excluded from remote
      node('ct115', ['opus', 'grok']),
      node('ct112', ['grok', 'grok-fast']),
      node('ct113', ['local']),
    ])

    const reachable = await engine.listReachableAgents()
    const byId = new Map(reachable.map((e) => [e.agentId, e]))

    // local agents win and stay in-process
    expect(byId.get('local')?.local).toBe(true)
    expect(byId.get('grok')?.local).toBe(true)
    // remote-only agent is discovered with its location
    expect(byId.get('opus')?.local).toBe(false)
    expect(byId.get('opus')?.remoteNodes).toContain('ct115')
    expect(byId.get('grok-fast')?.local).toBe(false)
    expect(byId.get('grok-fast')?.remoteNodes).toContain('ct112')
    // self's own agents are not advertised as "remote on ct114"
    expect(byId.get('grok')?.remoteNodes).not.toContain('ct114')
  })

  it('ignores offline nodes', async () => {
    const engine = makeEngine([
      node('ct114', ['local', 'grok']),
      node('ct115', ['opus'], 'offline'),
    ])
    const ids = (await engine.listReachableAgents()).map((e) => e.agentId)
    expect(ids).not.toContain('opus')
  })

  it('advertises the roster in the live delegate_task description', async () => {
    const engine = makeEngine([node('ct114', ['local', 'grok']), node('ct115', ['opus'])])
    // Let the constructor's primed refresh settle.
    await new Promise((r) => setTimeout(r, 10))

    const tool: Tool = engine.createDelegationTool()
    const desc = tool.description
    expect(desc).toContain('delegate to right now')
    expect(desc).toContain('opus')
    expect(desc).toContain('remote: ct115')
    expect(desc).toContain('local')
  })
})

// ---------------------------------------------------------------------------
// Postgres mesh transport (cutover step g1)
// ---------------------------------------------------------------------------

import { InMemoryTaskStore } from './task/store.js'
import { createTaskCompletionWaiter } from './task/completion-waiter.js'

function makePgEngine(
  nodes: MeshNode[],
  store: InMemoryTaskStore,
  transport?: 'postgres' | 'http',
): MeshDelegationEngine {
  return new MeshDelegationEngine({
    localEngine: {} as DelegationEngine,
    router: { getAgents: () => [] } as unknown as Router,
    meshRegistry: makeRegistry(nodes),
    tls: { ca: '', cert: '', key: '' },
    httpsDispatcher: {},
    localAgents: ['local'],
    nodeName: 'ct115',
    taskStore: store,
    waiter: createTaskCompletionWaiter({ store, pollFallbackMs: 10 }),
    transport,
  })
}

describe('MeshDelegationEngine postgres transport', () => {
  const remote = [node('ct112', ['grok'])]

  it('creates a node_affinity mesh task and returns the terminal result', async () => {
    // Simulated remote runner: claim + finish whatever gets enqueued.
    const store: InMemoryTaskStore = new InMemoryTaskStore((id) => {
      void (async () => {
        await store.claim(id, 'ct112')
        await store.finish(id, 'completed', {
          verdict: 'completed',
          summary: 'remote grok says hi',
          output: 'remote grok says hi',
          artifacts: [],
          usage: { inputTokens: 5, outputTokens: 7, totalTokens: 12, turns: 2, wallClockMs: 3 },
        })
      })()
    })
    const engine = makePgEngine(remote, store)

    const result = await engine.delegate(
      { fromAgent: 'local', toAgent: 'grok', task: 'summarize the mesh' },
      1,
    )

    expect(result.status).toBe('completed')
    expect(result.response).toBe('remote grok says hi')
    expect(result.iterations).toBe(2)

    const rows = await store.list()
    expect(rows).toHaveLength(1)
    expect(rows[0].origin).toBe('mesh')
    expect(rows[0].nodeAffinity).toBe('ct112')
    expect(rows[0].requestedBy).toBe('local')
    expect(rows[0].chainDepth).toBe(2)
    expect(rows[0].spec).toMatchObject({
      delegation: true,
      meshFrom: 'ct115',
      excludeTools: ['delegate_task'],
    })
    expect(rows[0].maxAttempts).toBe(1)
  })

  it('timeout: kills the row and returns status timeout', async () => {
    const store = new InMemoryTaskStore() // nobody claims — remote node down
    const engine = makePgEngine(remote, store)

    const result = await engine.delegate(
      { fromAgent: 'local', toAgent: 'grok', task: 'never answered', timeoutMs: -5_500 },
      0,
    )

    expect(result.status).toBe('timeout')
    expect((await store.list())[0].status).toBe('killed')
  })

  it('failed remote run maps to failed with the error text', async () => {
    const store: InMemoryTaskStore = new InMemoryTaskStore((id) => {
      void (async () => {
        await store.claim(id, 'ct112')
        await store.finish(id, 'failed', {
          verdict: 'failed',
          summary: 'boom',
          artifacts: [],
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, turns: 0, wallClockMs: 0 },
          error: 'provider exploded',
        })
      })()
    })
    const engine = makePgEngine(remote, store)
    const result = await engine.delegate({ fromAgent: 'local', toAgent: 'grok', task: 'x' }, 0)
    expect(result.status).toBe('failed')
    expect(result.response).toContain('provider exploded')
  })

  it("transport 'http' forces the legacy path (no task rows)", async () => {
    const store = new InMemoryTaskStore()
    const engine = makePgEngine(remote, store, 'http')
    // The undici path will fail fast against the fake node — that's fine;
    // the assertion is that no ros_tasks row was created.
    const result = await engine.delegate({ fromAgent: 'local', toAgent: 'grok', task: 'x' }, 0)
    expect(result.status).not.toBe('completed')
    expect(await store.list()).toHaveLength(0)
  })
})
