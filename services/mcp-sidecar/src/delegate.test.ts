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
import { createDelegateTools, type DelegateToolsHandle } from './delegate.js'

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
): Promise<string> {
  const found = handle.tools.find((tool) => tool.name === name)
  if (!found) throw new Error(`missing tool ${name}`)
  const result = await found.execute(args)
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
  })
})
