/**
 * /api/catalog (G4) — served over a bare http server with mock sources.
 */

import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { describe, it, expect, afterEach, vi } from 'vitest'
import type { HarnessExecutorCapabilities, MeshNode, MeshRegistry } from '@rivetos/types'
import { createExecutorRegistry } from './runner.js'
import { createNotImplementedHarnessExecutor } from './harness-executors.js'
import { createCatalogApiRoute } from './catalog-api.js'
import type { PresetDelegationEngine } from '../preset-delegation.js'
import type { Router } from '../router.js'

const caps: HarnessExecutorCapabilities = {
  steerable: true,
  multiTurn: true,
  structuredStream: true,
  usageInResult: true,
  sessionIdCapture: true,
  slashCommands: true,
  effortSelection: true,
  mcpInjection: 'config',
}

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn()
})

function node(
  name: string,
  agents: string[],
  status: MeshNode['status'] = 'online',
  agentDetails?: Record<string, { provider: string; model?: string }>,
): MeshNode {
  return {
    id: name,
    name,
    agents,
    host: '10.0.0.0',
    port: 3000,
    providers: [],
    models: [],
    capabilities: [],
    ...(agentDetails ? { metadata: { agentDetails } } : {}),
    status,
    lastSeen: 1,
    registeredAt: 1,
    version: '0.1.0',
  }
}

async function start(): Promise<string> {
  return startWith([
    node('node-f', ['claude']),
    // node-c advertises per-agent detail (#272); 'down' is offline
    node('node-c', ['grok'], 'online', { grok: { provider: 'xai', model: 'grok-4-1' } }),
    node('down', ['x'], 'offline'),
  ])
}

async function startWith(
  nodes: MeshNode[],
  opts?: { isHarnessAllowed?: (id: string) => boolean },
): Promise<string> {
  const executors = createExecutorRegistry()
  executors.register('chat-loop', {
    name: 'chat-loop',
    capabilities: () => caps,
    start: () => {
      throw new Error('not executed here')
    },
  })
  executors.register(
    'harness-session',
    {
      name: 'claude-code',
      capabilities: () => caps,
      listCommands: async () => [{ name: '/compact', description: 'compact context' }],
      start: () => {
        throw new Error('not executed here')
      },
    },
    'claude-code',
  )
  // A harness the node knows about but cannot run — the sheet says so rather
  // than omitting it (Phase 3 per-harness executors).
  executors.register(
    'harness-session',
    createNotImplementedHarnessExecutor('kimi-code', {
      reason: 'the `kimi` binary is not resolvable on this node',
    }),
    'kimi-code',
  )

  const router = {
    getAgents: () => [{ id: 'claude', name: 'claude', provider: 'claude-cli', model: 'fable-5' }],
    registerAgent: vi.fn(),
  } as unknown as Router
  const meshRegistry = {
    getNodes: async () => nodes,
  } as unknown as MeshRegistry

  const route = createCatalogApiRoute({
    nodeName: 'node-f',
    router,
    tools: () => [{ name: 'memory_search' } as never],
    executors,
    skills: () => [{ name: 'deep-research', description: 'research harness' } as never],
    meshRegistry,
    isHarnessAllowed: opts?.isHarnessAllowed,
  })
  const server: Server = createServer((req, res) => {
    void route.handler(req, res)
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  cleanups.push(() => new Promise((r) => server.close(r)))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

describe('/api/catalog', () => {
  it('serves the full capability sheet', async () => {
    const base = await start()
    const body = (await (await fetch(`${base}/api/catalog`)).json()) as {
      node: string
      agents: Array<{
        id: string
        node: string
        local?: boolean
        provider?: string
        model?: string
      }>
      executors: Array<{
        key: string
        commands: unknown[]
        harnessId?: string
        implemented?: boolean
      }>
      tools: string[]
      skills: Array<{ name: string }>
    }
    expect(body.node).toBe('node-f')
    // local claude + remote grok; self + offline nodes excluded from remote
    expect(body.agents.map((a) => `${a.id}@${a.node}`).sort()).toEqual([
      'claude@node-f',
      'grok@node-c',
    ])
    // #272: the remote grok carries its advertised provider/model
    const grokDetail = body.agents.find((a) => a.id === 'grok')
    expect(grokDetail).toMatchObject({ node: 'node-c', provider: 'xai', model: 'grok-4-1' })
    const harness = body.executors.find((e) => e.key === 'harness-session:claude-code')
    expect(harness?.commands).toEqual([{ name: '/compact', description: 'compact context' }])
    // harness-session entries carry the harness id + whether it is runnable
    expect(harness).toMatchObject({ harnessId: 'claude-code', implemented: true })
    expect(body.executors.find((e) => e.key === 'harness-session:kimi-code')).toMatchObject({
      harnessId: 'kimi-code',
      implemented: false,
    })
    // Non-harness executors carry neither field.
    const chat = body.executors.find((e) => e.key === 'chat-loop')
    expect(chat?.harnessId).toBeUndefined()
    expect(chat?.implemented).toBeUndefined()
    expect(body.tools).toContain('memory_search')
    expect(body.skills[0].name).toBe('deep-research')
  })

  it('remote agents without advertised detail stay bare (older peers)', async () => {
    const base = await startWith([
      node('node-f', ['claude']),
      node('node-c', ['grok']), // no agentDetails
    ])
    const body = (await (await fetch(`${base}/api/catalog/agents`)).json()) as {
      agents: Array<{ id: string; node: string; provider?: string; model?: string }>
    }
    const grok = body.agents.find((a) => a.id === 'grok')
    expect(grok).toEqual({ id: 'grok', node: 'node-c', local: false })
    expect(grok?.provider).toBeUndefined()
  })

  it('omits harness-session executors outside the allow-list', async () => {
    const base = await startWith(
      [
        node('node-f', ['claude']),
        node('node-c', ['grok'], 'online', { grok: { provider: 'xai', model: 'grok-4-1' } }),
      ],
      { isHarnessAllowed: (id) => id === 'claude-code' },
    )
    const body = (await (await fetch(`${base}/api/catalog`)).json()) as {
      executors: Array<{ key: string }>
    }
    expect(body.executors.map((e) => e.key).sort()).toEqual([
      'chat-loop',
      'harness-session:claude-code',
    ])
    expect(body.executors.find((e) => e.key === 'harness-session:kimi-code')).toBeUndefined()
  })

  it('GET /api/catalog/agents serves the agents slice; 404 elsewhere; 405 non-GET', async () => {
    const base = await start()
    const agents = (await (await fetch(`${base}/api/catalog/agents`)).json()) as {
      agents: unknown[]
    }
    expect(agents.agents).toHaveLength(2)
    expect((await fetch(`${base}/api/catalog/nope`)).status).toBe(404)
    expect((await fetch(`${base}/api/catalog`, { method: 'POST' })).status).toBe(405)
  })

  it('appends RivetHub presets as kind:preset', async () => {
    const entries = [
      {
        id: 'preset-1',
        name: 'reviewer',
        node: 'node-g',
        local: false,
        harnessId: 'claude-code' as const,
        directory: '/home/rivet/.rivetos/agents/reviewer',
        model: 'opus',
        implemented: false,
        gap: 'no headless executor',
      },
    ]
    const presets = {
      rosterEntries: () => entries,
      rosterEntriesFresh: () => Promise.resolve(entries),
    } as unknown as PresetDelegationEngine
    const executors = createExecutorRegistry()
    const router = { getAgents: () => [] } as unknown as Router
    const route = createCatalogApiRoute({
      nodeName: 'node-f',
      router,
      tools: () => [],
      executors,
      presets,
    })
    const server: Server = createServer((req, res) => {
      void route.handler(req, res)
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    cleanups.push(() => new Promise((r) => server.close(r)))
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    const body = (await (await fetch(`${base}/api/catalog/agents`)).json()) as {
      agents: Array<{ kind?: string; name?: string; implemented?: boolean; gap?: string }>
    }
    expect(body.agents).toEqual([
      {
        kind: 'preset',
        id: 'preset-1',
        name: 'reviewer',
        node: 'node-g',
        local: false,
        harnessId: 'claude-code',
        directory: '/home/rivet/.rivetos/agents/reviewer',
        model: 'opus',
        implemented: false,
        gap: 'no headless executor',
      },
    ])
  })
})
