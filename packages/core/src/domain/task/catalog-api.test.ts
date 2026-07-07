/**
 * /api/catalog (G4) — served over a bare http server with mock sources.
 */

import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { describe, it, expect, afterEach, vi } from 'vitest'
import type { HarnessExecutorCapabilities, MeshNode, MeshRegistry } from '@rivetos/types'
import { createExecutorRegistry } from './runner.js'
import { createCatalogApiRoute } from './catalog-api.js'
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
      name: 'claude-cli',
      capabilities: () => caps,
      listCommands: async () => [{ name: '/compact', description: 'compact context' }],
      start: () => {
        throw new Error('not executed here')
      },
    },
    'claude-cli',
  )

  const router = {
    getAgents: () => [{ id: 'claude', name: 'claude', provider: 'claude-cli', model: 'fable-5' }],
    registerAgent: vi.fn(),
  } as unknown as Router
  const meshRegistry = {
    getNodes: async () => [
      node('ct115', ['claude']),
      // ct112 advertises per-agent detail (#272); 'down' is offline
      node('ct112', ['grok'], 'online', { grok: { provider: 'xai', model: 'grok-4-1' } }),
      node('down', ['x'], 'offline'),
    ],
  } as unknown as MeshRegistry

  const route = createCatalogApiRoute({
    nodeName: 'ct115',
    router,
    tools: () => [{ name: 'memory_search' } as never],
    executors,
    skills: () => [{ name: 'deep-research', description: 'research harness' } as never],
    meshRegistry,
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
      agents: Array<{ id: string; node: string; local?: boolean; provider?: string; model?: string }>
      executors: Array<{ key: string; commands: unknown[] }>
      tools: string[]
      skills: Array<{ name: string }>
    }
    expect(body.node).toBe('ct115')
    // local claude + remote grok; self + offline nodes excluded from remote
    expect(body.agents.map((a) => `${a.id}@${a.node}`).sort()).toEqual([
      'claude@ct115',
      'grok@ct112',
    ])
    // #272: the remote grok carries its advertised provider/model
    const grok = body.agents.find((a) => a.id === 'grok')
    expect(grok).toMatchObject({ node: 'ct112', provider: 'xai', model: 'grok-4-1' })
    const harness = body.executors.find((e) => e.key === 'harness-session:claude-cli')
    expect(harness?.commands).toEqual([{ name: '/compact', description: 'compact context' }])
    expect(body.tools).toContain('memory_search')
    expect(body.skills[0].name).toBe('deep-research')
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
})
