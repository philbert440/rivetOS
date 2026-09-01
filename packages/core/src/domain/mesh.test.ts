import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
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
      models: ['claude-sonnet-4-20250514', 'grok-4-1-fast-reasoning'],
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
      models: ['grok-4-1-fast-reasoning'],
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
      models: ['claude-sonnet-4-20250514', 'grok-4-1-fast-reasoning'],
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

  it('buildLocalNode passes capabilities and metadata through (den advertising)', () => {
    const node = buildLocalNode({
      name: 'den-node',
      agents: ['opus'],
      host: '192.168.1.101',
      port: 3100,
      providers: [],
      models: [],
      capabilities: ['den'],
      metadata: { denPort: 5174 },
      version: '0.7.0',
    })

    expect(node.capabilities).toEqual(['den'])
    expect(node.metadata).toEqual({ denPort: 5174 })
  })

  it('buildLocalNode defaults to empty capabilities and no metadata key', () => {
    const node = buildLocalNode({
      name: 'plain-node',
      agents: ['opus'],
      host: '192.168.1.101',
      port: 3100,
      providers: [],
      models: [],
      version: '0.7.0',
    })

    expect(node.capabilities).toEqual([])
    // No stray metadata key — register() writes the entry verbatim into
    // mesh.json, so absent must stay absent (not `metadata: undefined`).
    expect('metadata' in node).toBe(false)
  })

  it('registered den capability + metadata survive the mesh.json round-trip', async () => {
    const node = buildLocalNode({
      name: 'den-node',
      agents: ['opus'],
      host: '192.168.1.101',
      port: 3100,
      providers: [],
      models: [],
      capabilities: ['den'],
      metadata: { denPort: 5199 },
      version: '0.7.0',
    })

    await registry.register(node)

    const byCapability = await registry.findByCapability('den')
    expect(byCapability).toHaveLength(1)
    expect(byCapability[0].metadata).toEqual({ denPort: 5199 })
  })

  it('getNodes returns all nodes', async () => {
    const node1 = buildLocalNode({
      name: 'a',
      agents: ['opus'],
      host: '10.0.0.1',
      port: 3100,
      providers: [],
      models: [],
      version: '0.7.0',
    })
    const node2 = buildLocalNode({
      name: 'b',
      agents: ['grok'],
      host: '10.0.0.2',
      port: 3100,
      providers: [],
      models: [],
      version: '0.7.0',
    })

    await registry.register(node1)
    await registry.register(node2)

    const all = await registry.getNodes()
    expect(all).toHaveLength(2)
  })

  it('fails loud on pre-capabilities flat-array mesh.json', async () => {
    await writeFile(
      join(tmpDir, 'mesh.json'),
      JSON.stringify({
        nodes: [{ name: 'legacy-node', ip: '192.0.2.1', role: 'primary' }],
        updatedAt: 1,
      }),
      'utf-8',
    )

    await expect(registry.getNodes()).rejects.toThrow(/pre-capabilities flat-array/)
  })

  it('round-trips unknown node and root fields through heartbeat', async () => {
    await writeFile(
      join(tmpDir, 'mesh.json'),
      JSON.stringify(
        {
          version: 1,
          updatedAt: 1,
          extraRoot: { future: true },
          nodes: {
            n1: {
              id: 'n1',
              name: 'n1',
              host: '192.0.2.1',
              port: 3100,
              agents: [],
              providers: [],
              models: [],
              capabilities: [],
              status: 'online',
              lastSeen: 1,
              registeredAt: 1,
              version: '1',
              unknownNodeField: 'keep-me',
            },
          },
        },
        null,
        2,
      ),
      'utf-8',
    )

    await registry.heartbeat('n1', 'online')

    const saved = JSON.parse(await readFile(join(tmpDir, 'mesh.json'), 'utf-8')) as {
      extraRoot?: unknown
      nodes: Record<string, { unknownNodeField?: unknown; lastSeen: number }>
    }
    expect(saved.extraRoot).toEqual({ future: true })
    expect(saved.nodes.n1.unknownNodeField).toBe('keep-me')
    expect(saved.nodes.n1.lastSeen).toBeGreaterThan(1)
  })

  it('skips a malformed node instead of failing the registry load', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await writeFile(
        join(tmpDir, 'mesh.json'),
        JSON.stringify({
          version: 1,
          updatedAt: 1,
          nodes: {
            good: {
              id: 'good',
              name: 'good',
              host: '192.0.2.1',
              port: 3100,
              agents: [],
              providers: [],
              models: [],
              capabilities: [],
              status: 'online',
              lastSeen: 1,
              registeredAt: 1,
              version: '1',
            },
            bad: { host: 'h', port: '3100' },
          },
        }),
        'utf-8',
      )

      const nodes = await registry.getNodes()
      expect(nodes.map((n) => n.id)).toEqual(['good'])
      expect(warn).toHaveBeenCalledTimes(1)
      expect(String(warn.mock.calls[0]?.[0])).toMatch(/"bad"/)
    } finally {
      warn.mockRestore()
    }
  })

  it('save leaves the original mesh.json intact when writeFile fails', async () => {
    const node = buildLocalNode({
      name: 'kept-node',
      agents: ['opus'],
      host: '192.168.1.101',
      port: 3100,
      providers: [],
      models: [],
      version: '0.7.0',
    })
    await registry.register(node)

    const meshPath = join(tmpDir, 'mesh.json')
    const before = await readFile(meshPath, 'utf-8')

    vi.mocked(writeFile).mockRejectedValueOnce(
      Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' }),
    )

    const other = buildLocalNode({
      name: 'other-node',
      agents: ['grok'],
      host: '192.168.1.102',
      port: 3100,
      providers: [],
      models: [],
      version: '0.7.0',
    })
    await expect(registry.register(other)).rejects.toThrow(/ENOSPC/)

    const after = await readFile(meshPath, 'utf-8')
    expect(after).toBe(before)
    const retrieved = await registry.getNode(node.id)
    expect(retrieved?.name).toBe('kept-node')
  })

  it('heartbeat on an empty roster re-registers instead of no-op', async () => {
    const node = buildLocalNode({
      name: 'self-heal-node',
      agents: ['opus'],
      host: '192.168.1.101',
      port: 3100,
      providers: ['anthropic'],
      models: ['claude-sonnet-4-20250514'],
      version: '0.7.0',
    })
    await registry.start(node)

    await writeFile(
      join(tmpDir, 'mesh.json'),
      JSON.stringify({ version: 1, nodes: {}, updatedAt: 0 }),
      'utf-8',
    )

    expect(await registry.getNode(node.id)).toBeUndefined()

    await registry.heartbeat(node.id, 'online')

    const restored = await registry.getNode(node.id)
    expect(restored).toBeDefined()
    expect(restored!.id).toBe(node.id)
    expect(restored!.name).toBe('self-heal-node')
    expect(restored!.agents).toEqual(['opus'])
    expect(restored!.host).toBe('192.168.1.101')
    expect(restored!.status).toBe('online')
    expect(restored!.lastSeen).toBeGreaterThan(node.lastSeen)
  })
})
