/**
 * Tests for SubagentManager — async-first, store-backed child session orchestration.
 *
 * Uses the in-memory store + executor (no Postgres) to exercise the full
 * spawn → executeTurn → recordTurn loop. The pg-backed store is exercised
 * separately by integration tests against staging.
 */

import { describe, it, expect, vi } from 'vitest'
import {
  SubagentManagerImpl,
  createSubagentTools,
  type SubagentManagerConfig,
} from './subagent.js'
import { InMemorySubagentStore } from './subagent-store.js'
import { createSubagentExecutor, type SubagentExecutorConfig } from './subagent-worker.js'
import type { Router } from './router.js'
import type { WorkspaceLoader } from './workspace.js'
import { makeMockProvider } from '../test-utils/mock-aisdk-provider.js'

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const MOCK_PROVIDER_DELAY = 10

function createMockRouter(agents: Array<{ id: string; provider: string }> = []): Router {
  const mockAgents = agents.map((a) => ({ id: a.id, name: a.id, provider: a.provider }))
  const mockProviders = [...new Set(agents.map((a) => a.provider))].map((p) =>
    makeMockProvider({
      id: p,
      name: p,
      modelId: `mock-model-${p}`,
      stepDelayMs: MOCK_PROVIDER_DELAY,
      chunks: [
        { type: 'text', delta: `Response from ${p}` },
        { type: 'done', usage: { promptTokens: 5, completionTokens: 10 } },
      ],
    }),
  )
  return {
    getAgents: () => mockAgents as ReturnType<Router['getAgents']>,
    getProviders: () => mockProviders as ReturnType<Router['getProviders']>,
    registerAgent: vi.fn(),
    registerProvider: vi.fn(),
    route: vi.fn(),
    healthCheck: vi.fn(),
  } as unknown as Router
}

function createMockWorkspace(): WorkspaceLoader {
  return {
    buildSystemPrompt: vi.fn(async (agentId: string) => `System prompt for ${agentId}`),
    load: vi.fn(async () => []),
    buildHeartbeatPrompt: vi.fn(async () => 'heartbeat'),
  } as unknown as WorkspaceLoader
}

/**
 * Wire a manager + in-memory executor + enqueue function that mirrors the
 * production boot setup. Returns the manager and store.
 */
function buildManager(agents: Array<{ id: string; provider: string }> = [
  { id: 'grok', provider: 'xai' },
  { id: 'opus', provider: 'anthropic' },
]): {
  manager: SubagentManagerImpl
  store: InMemorySubagentStore
  pendingTurns: Promise<void>[]
} {
  const router = createMockRouter(agents)
  const workspace = createMockWorkspace()
  const store = new InMemorySubagentStore()

  const execCfg: SubagentExecutorConfig = {
    router,
    workspace,
    store,
    tools: () => [],
  }
  const executor = createSubagentExecutor(execCfg)
  const pendingTurns: Promise<void>[] = []

  const cfg: SubagentManagerConfig = {
    router,
    store,
    enqueueTurn(sessionId): Promise<void> {
      // Fire in background — production semantics. We track the promise so
      // tests can await all in-flight work via Promise.all(pendingTurns).
      const p = executor.executeTurn(sessionId)
      pendingTurns.push(p)
      return Promise.resolve()
    },
  }
  return { manager: new SubagentManagerImpl(cfg), store, pendingTurns }
}

async function waitForCompletion(
  manager: SubagentManagerImpl,
  sessionId: string,
  timeoutMs = 5000,
): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const status = await manager.status(sessionId)
      if (status.status !== 'running') return
    } catch {
      return
    }
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error(`Session ${sessionId} did not complete within ${timeoutMs}ms`)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SubagentManagerImpl', () => {
  describe('spawn', () => {
    it('returns immediately with a running session', async () => {
      const { manager } = buildManager()
      const session = await manager.spawn({ agent: 'grok', task: 'Write a test' })

      expect(session.status).toBe('running')
      expect(session.childAgent).toBe('grok')
      expect(session.id).toBeTruthy()
    })

    it('completes in the background', async () => {
      const { manager, pendingTurns } = buildManager()
      const session = await manager.spawn({ agent: 'grok', task: 'Write a test' })

      await Promise.all(pendingTurns)
      const status = await manager.status(session.id)

      expect(status.status).toBe('completed')
      expect(status.lastResponse).toContain('Response from xai')
    })

    it('throws on unknown agent', async () => {
      const { manager } = buildManager()
      await expect(manager.spawn({ agent: 'nonexistent', task: 'test' })).rejects.toThrow(
        'Unknown agent',
      )
    })

    it('throws on missing provider', async () => {
      const router = createMockRouter([{ id: 'grok', provider: 'xai' }])
      ;(router.getAgents() as Array<{ id: string; name: string; provider: string }>).push({
        id: 'broken',
        name: 'broken',
        provider: 'ghost',
      })
      const store = new InMemorySubagentStore()
      const manager = new SubagentManagerImpl({
        router,
        store,
        enqueueTurn: () => Promise.resolve(),
      })
      await expect(manager.spawn({ agent: 'broken', task: 'test' })).rejects.toThrow('Provider')
    })
  })

  describe('status', () => {
    it('returns progress info while running', async () => {
      const { manager } = buildManager()
      const session = await manager.spawn({ agent: 'grok', task: 'Do work' })

      const status = await manager.status(session.id)
      expect(status.status).toBe('running')
      expect(status.agent).toBe('grok')
      expect(status.elapsedMs).toBeGreaterThanOrEqual(0)
      expect(status.iterations).toBe(0)
    })

    it('returns final results after completion', async () => {
      const { manager, pendingTurns } = buildManager()
      const session = await manager.spawn({ agent: 'grok', task: 'Do work' })

      await Promise.all(pendingTurns)
      const status = await manager.status(session.id)

      expect(status.status).toBe('completed')
      expect(status.lastResponse).toContain('Response from')
    })

    it('throws on unknown session', async () => {
      const { manager } = buildManager()
      await expect(manager.status('bad-id')).rejects.toThrow('not found')
    })
  })

  describe('send', () => {
    it('sends a follow-up to a completed session', async () => {
      const { manager, pendingTurns } = buildManager()
      const session = await manager.spawn({ agent: 'grok', task: 'Start' })
      await Promise.all(pendingTurns)

      await manager.send(session.id, 'Follow up')
      await Promise.all(pendingTurns)

      const status = await manager.status(session.id)
      expect(status.status).toBe('completed')
    })

    it('throws when session is still running', async () => {
      const { manager } = buildManager()
      const session = await manager.spawn({ agent: 'grok', task: 'Start' })

      await expect(manager.send(session.id, 'too early')).rejects.toThrow('still running')
    })

    it('throws on unknown session', async () => {
      const { manager } = buildManager()
      await expect(manager.send('bad-id', 'hello')).rejects.toThrow('not found')
    })
  })

  describe('kill', () => {
    it('marks a running session killed', async () => {
      const { manager } = buildManager()
      const session = await manager.spawn({ agent: 'grok', task: 'Start' })

      await manager.kill(session.id)
      const status = await manager.status(session.id)
      // 'killed' is collapsed to 'failed' in the public status enum
      expect(status.status).toBe('failed')
      expect(status.error).toBe('Killed by parent')
    })

    it('throws on unknown session', async () => {
      const { manager } = buildManager()
      await expect(manager.kill('bad-id')).rejects.toThrow('not found')
    })
  })

  describe('list', () => {
    it('returns all sessions regardless of status', async () => {
      const { manager, pendingTurns } = buildManager()

      await manager.spawn({ agent: 'grok', task: 'A' })
      await manager.spawn({ agent: 'opus', task: 'B' })
      await Promise.all(pendingTurns)

      const listed = await manager.list()
      expect(listed).toHaveLength(2)
      expect(listed.every((s) => s.status === 'completed')).toBe(true)
    })

    it('includes running sessions', async () => {
      const { manager } = buildManager()
      await manager.spawn({ agent: 'grok', task: 'A' })

      const listed = await manager.list()
      expect(listed).toHaveLength(1)
      expect(listed[0].status).toBe('running')
    })
  })

  describe('sweepRunning — crash recovery (option 1a)', () => {
    it('flips running rows to failed with worker_restarted', async () => {
      const { manager, store } = buildManager()
      // Spawn but skip awaiting the turn — leaves it in 'running' if the
      // turn hasn't completed yet. Force-claim the row to simulate a
      // worker that started a turn and then crashed.
      const session = await manager.spawn({ agent: 'grok', task: 'A' })
      await store.claim(session.id) // simulates worker that began executing

      const swept = await store.sweepRunning()
      expect(swept).toBeGreaterThanOrEqual(1)

      const status = await manager.status(session.id)
      expect(status.status).toBe('failed')
      expect(status.error).toBe('worker_restarted')
    })
  })
})

describe('createSubagentTools', () => {
  it('creates 5 tools', () => {
    const { manager } = buildManager()
    const tools = createSubagentTools(manager)

    expect(tools).toHaveLength(5)
    const names = tools.map((t) => t.name)
    expect(names).toContain('subagent_spawn')
    expect(names).toContain('subagent_status')
    expect(names).toContain('subagent_send')
    expect(names).toContain('subagent_list')
    expect(names).toContain('subagent_kill')
  })

  it('spawn tool returns immediately with session info', async () => {
    const { manager } = buildManager()
    const tools = createSubagentTools(manager)
    const spawnTool = tools.find((t) => t.name === 'subagent_spawn')!

    const result = await spawnTool.execute({ agent: 'grok', task: 'Do something' })
    const parsed = JSON.parse(result as string) as { sessionId: string; status: string }
    expect(parsed.sessionId).toBeDefined()
    expect(parsed.status).toBe('running')
  })

  it('status tool returns progress info', async () => {
    const { manager, pendingTurns } = buildManager()
    const tools = createSubagentTools(manager)
    const spawnTool = tools.find((t) => t.name === 'subagent_spawn')!
    const statusTool = tools.find((t) => t.name === 'subagent_status')!

    const spawnResult = await spawnTool.execute({ agent: 'grok', task: 'Do something' })
    const parsed = JSON.parse(spawnResult as string) as { sessionId: string }

    await Promise.all(pendingTurns)
    await waitForCompletion(manager, parsed.sessionId)
    const statusResult = await statusTool.execute({ session_id: parsed.sessionId })

    expect(typeof statusResult).toBe('string')
    expect(statusResult).toContain('completed')
    expect(statusResult).toContain('Response from')
  })

  it('spawn tool handles errors gracefully', async () => {
    const { manager } = buildManager()
    const tools = createSubagentTools(manager)
    const spawnTool = tools.find((t) => t.name === 'subagent_spawn')!

    const result = await spawnTool.execute({ agent: 'nonexistent', task: 'test' })
    expect(result).toContain('Error')
  })

  it('list tool returns empty when no sessions', async () => {
    const { manager } = buildManager()
    const tools = createSubagentTools(manager)
    const listTool = tools.find((t) => t.name === 'subagent_list')!

    const result = await listTool.execute({})
    expect(result).toContain('No sub-agent')
  })

  it('kill tool handles unknown session', async () => {
    const { manager } = buildManager()
    const tools = createSubagentTools(manager)
    const killTool = tools.find((t) => t.name === 'subagent_kill')!

    const result = await killTool.execute({ session_id: 'bad-id' })
    expect(result).toContain('Error')
  })
})
