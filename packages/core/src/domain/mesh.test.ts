import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileMeshRegistry, buildLocalNode } from './mesh.js'
import type { MeshNode, MeshNodeEvent } from '@rivetos/types'

describe('FileMeshRegistry', () => {
  let tmpDir: string
  let registry: FileMeshRegistry
  let events: MeshNodeEvent[]

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'mesh-test-'))
    events = []
    registry = new FileMeshRegistry({
      storageDir: tmpDir,
      mesh: {
        enabled: true,
        heartbeatIntervalMs: 60_000, // Don't actually heartbeat in tests
        staleThresholdMs: 5_000,
      },
      onEvent: (event) => events.push(event),
    })
  })

  afterEach(async () => {
    await registry.stop()
    await rm(tmpDir, { recursive: true, force: true })
  })

  it('registers and retrieves a node', async () => {
    const node = buildLocalNode({
      name: 'test-node',
      agents: ['opus', 'grok'],
      host: '192.168.1.101',
      port: 3100,
      providers: ['anthropic', 'xai'],
      models: ['claude-sonnet-4-20250514', 'grok-3'],
      version: '0.7.0',
    })

    await registry.register(node)

    const retrieved = await registry.getNode(node.id)
    expect(retrieved).toBeDefined()
    expect(retrieved!.name).toBe('test-node')
    expect(retrieved!.agents).toEqual(['opus', 'grok'])
    expect(retrieved!.status).toBe('online')

    // Check file was written
    const raw = await readFile(join(tmpDir, 'mesh.json'), 'utf-8')
    const data = JSON.parse(raw)
    expect(data.version).toBe(1)
    expect(Object.keys(data.nodes)).toHaveLength(1)

    // Check event was emitted
    expect(events).toHaveLength(1)
    expect(events[0].type).toBe('node:joined')
  })

  it('finds nodes by agent', async () => {
    const node1 = buildLocalNode({
      name: 'node-1',
      agents: ['opus'],
      host: '192.168.1.101',
      port: 3100,
      providers: ['anthropic'],
      models: ['claude-sonnet-4-20250514'],
      version: '0.7.0',
    })

    const node2 = buildLocalNode({
      name: 'node-2',
      agents: ['grok'],
      host: '192.168.1.102',
      port: 3100,
      providers: ['xai'],
      models: ['grok-3'],
      version: '0.7.0',
    })

    await registry.register(node1)
    await registry.register(node2)

    const opusNodes = await registry.findByAgent('opus')
    expect(opusNodes).toHaveLength(1)
    expect(opusNodes[0].name).toBe('node-1')

    const grokNodes = await registry.findByAgent('grok')
    expect(grokNodes).toHaveLength(1)
    expect(grokNodes[0].name).toBe('node-2')

    const localNodes = await registry.findByAgent('local')
    expect(localNodes).toHaveLength(0)
  })

  it('finds nodes by provider', async () => {
    const node = buildLocalNode({
      name: 'multi-provider',
      agents: ['opus', 'grok'],
      host: '192.168.1.101',
      port: 3100,
      providers: ['anthropic', 'xai'],
      models: ['claude-sonnet-4-20250514', 'grok-3'],
      version: '0.7.0',
    })

    await registry.register(node)

    const anthNodes = await registry.findByProvider('anthropic')
    expect(anthNodes).toHaveLength(1)

    const ollamaNodes = await registry.findByProvider('ollama')
    expect(ollamaNodes).toHaveLength(0)
  })

  it('deregisters a node (marks offline)', async () => {
    const node = buildLocalNode({
      name: 'ephemeral',
      agents: ['test'],
      host: '192.168.1.200',
      port: 3100,
      providers: [],
      models: [],
      version: '0.7.0',
    })

    await registry.register(node)
    await registry.deregister(node.id)

    const retrieved = await registry.getNode(node.id)
    expect(retrieved).toBeDefined()
    expect(retrieved!.status).toBe('offline')

    // Offline nodes shouldn't appear in findByAgent
    const found = await registry.findByAgent('test')
    expect(found).toHaveLength(0)
  })

  it('heartbeats update lastSeen', async () => {
    const node = buildLocalNode({
      name: 'heartbeat-test',
      agents: ['opus'],
      host: '192.168.1.101',
      port: 3100,
      providers: [],
      models: [],
      version: '0.7.0',
    })

    await registry.register(node)
    const before = (await registry.getNode(node.id))!.lastSeen

    // Wait a tick
    await new Promise((r) => setTimeout(r, 10))
    await registry.heartbeat(node.id, 'online')

    const after = (await registry.getNode(node.id))!.lastSeen
    expect(after).toBeGreaterThan(before)
  })

  it('prunes stale nodes', async () => {
    // Start the registry as the local node (sets localNodeId)
    const localNode = buildLocalNode({
      name: 'local-node',
      agents: ['opus'],
      host: '192.168.1.101',
      port: 3100,
      providers: [],
      models: [],
      version: '0.7.0',
    })
    await registry.start(localNode)

    // Now register a remote node with old timestamp
    const staleNode = buildLocalNode({
      name: 'stale-node',
      agents: ['old'],
      host: '192.168.1.200',
      port: 3100,
      providers: [],
      models: [],
      version: '0.1.0',
    })
    staleNode.lastSeen = Date.now() - 100_000
    await registry.register(staleNode)

    // Prune with 5s threshold — should only prune the stale remote node
    const pruned = await registry.prune(5_000)
    expect(pruned).toHaveLength(1)
    expect(pruned[0].name).toBe('stale-node')

    // Should be marked offline now
    const retrieved = await registry.getNode(staleNode.id)
    expect(retrieved!.status).toBe('offline')
  })

  it('does not prune infrastructure nodes (non-agent role)', async () => {
    const localNode = buildLocalNode({
      name: 'local-node',
      agents: ['opus'],
      host: '192.168.1.101',
      port: 3100,
      providers: [],
      models: [],
      version: '0.7.0',
    })
    await registry.start(localNode)

    // Register an infrastructure node with stale lastSeen
    const infraNode = buildLocalNode({
      name: 'datahub',
      agents: [],
      host: '192.168.1.110',
      port: 3100,
      providers: [],
      models: [],
      role: 'datahub',
      version: '0.7.0',
    })
    infraNode.lastSeen = Date.now() - 100_000
    await registry.register(infraNode)

    // Prune with 5s threshold — should NOT prune the infra node
    const pruned = await registry.prune(5_000)
    expect(pruned).toHaveLength(0)

    // Should still be online
    const retrieved = await registry.getNode(infraNode.id)
    expect(retrieved!.status).toBe('online')
  })

  it('buildLocalNode generates valid node with UUID', () => {
    const node = buildLocalNode({
      name: 'test',
      agents: ['opus'],
      host: '192.168.1.101',
      port: 3100,
      providers: ['anthropic'],
      models: ['claude-sonnet-4-20250514'],
      version: '0.7.0',
    })

    expect(node.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(node.status).toBe('online')
    expect(node.registeredAt).toBeGreaterThan(0)
    expect(node.lastSeen).toBeGreaterThan(0)
  })

  it('buildLocalNode preserves existing ID', () => {
    const node = buildLocalNode({
      existingId: 'my-fixed-id',
      name: 'test',
      agents: [],
      host: '127.0.0.1',
      port: 3100,
      providers: [],
      models: [],
      version: '0.7.0',
    })

    expect(node.id).toBe('my-fixed-id')
  })

  it('getNodes returns all nodes', async () => {
    const node1 = buildLocalNode({
      name: 'a', agents: ['opus'], host: '10.0.0.1', port: 3100,
      providers: [], models: [], version: '0.7.0',
    })
    const node2 = buildLocalNode({
      name: 'b', agents: ['grok'], host: '10.0.0.2', port: 3100,
      providers: [], models: [], version: '0.7.0',
    })

    await registry.register(node1)
    await registry.register(node2)

    const all = await registry.getNodes()
    expect(all).toHaveLength(2)
  })
})
