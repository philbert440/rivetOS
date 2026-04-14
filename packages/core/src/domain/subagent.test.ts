/**
 * Tests for SubagentManager — async-first child agent session orchestration.
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  SubagentManagerImpl,
  createSubagentTools,
  type SubagentManagerConfig,
} from './subagent.js'
import type { Router } from './router.js'
import type { WorkspaceLoader } from './workspace.js'

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

/** How long the mock provider takes to "respond" (ms) */
const MOCK_PROVIDER_DELAY = 10

function createMockRouter(
  agents: Array<{ id: string; provider: string }> = [],
): Router {
  const mockAgents = agents.map((a) => ({
    id: a.id,
    name: a.id,
    provider: a.provider,
  }))

  const mockProviders = [...new Set(agents.map((a) => a.provider))].map(
    (p) => ({
      id: p,
      chatStream: vi.fn(async function* (_msgs: unknown, opts: { signal?: AbortSignal } = {}) {
        // Small delay to simulate real work
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, MOCK_PROVIDER_DELAY)
          if (opts.signal?.aborted) {
            clearTimeout(timer)
            reject(new Error('aborted'))
            return
          }
          opts.signal?.addEventListener('abort', () => {
            clearTimeout(timer)
            reject(new Error('aborted'))
          })
        })
        yield { type: 'text' as const, delta: `Response from ${p}` }
        yield {
          type: 'done' as const,
          usage: { promptTokens: 5, completionTokens: 10 },
        }
      }),
      healthCheck: vi.fn(async () => true),
      getContextWindow: () => 0,
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
    buildSystemPrompt: vi.fn(
      async (agentId: string) => `System prompt for ${agentId}`,
    ),
    load: vi.fn(async () => []),
    buildHeartbeatPrompt: vi.fn(async () => 'heartbeat'),
  } as unknown as WorkspaceLoader
}

function createConfig(
  agents: Array<{ id: string; provider: string }> = [
    { id: 'grok', provider: 'xai' },
    { id: 'opus', provider: 'anthropic' },
  ],
): SubagentManagerConfig {
  return {
    router: createMockRouter(agents),
    workspace: createMockWorkspace(),
    tools: () => [],
  }
}

/** Wait for a session to reach a terminal status */
async function waitForCompletion(
  manager: SubagentManagerImpl,
  sessionId: string,
  timeoutMs = 5000,
): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const status = manager.status(sessionId)
      if (status.status !== 'running') return
    } catch {
      return // session not found = already done
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
    it('returns immediately with a running session', () => {
      const manager = new SubagentManagerImpl(createConfig())
      const session = manager.spawn({
        agent: 'grok',
        task: 'Write a test',
      })

      expect(session.status).toBe('running')
      expect(session.childAgent).toBe('grok')
      expect(session.id).toBeTruthy()
    })

    it('completes in the background', async () => {
      const manager = new SubagentManagerImpl(createConfig())
      const session = manager.spawn({
        agent: 'grok',
        task: 'Write a test',
      })

      await waitForCompletion(manager, session.id)
      const status = manager.status(session.id)

      expect(status.status).toBe('completed')
      expect(status.lastResponse).toContain('Response from xai')
    })

    it('throws on unknown agent', () => {
      const manager = new SubagentManagerImpl(createConfig())
      expect(() =>
        manager.spawn({ agent: 'nonexistent', task: 'test' }),
      ).toThrow('Unknown agent')
    })

    it('throws on missing provider', () => {
      const router = createMockRouter([{ id: 'grok', provider: 'xai' }])
      ;(router.getAgents() as Array<{ id: string; name: string; provider: string }>).push({
        id: 'broken',
        name: 'broken',
        provider: 'ghost',
      })
      const config: SubagentManagerConfig = {
        router,
        workspace: createMockWorkspace(),
        tools: () => [],
      }
      const manager = new SubagentManagerImpl(config)
      expect(() =>
        manager.spawn({ agent: 'broken', task: 'test' }),
      ).toThrow('Provider')
    })
  })

  describe('status', () => {
    it('returns progress info while running', () => {
      const manager = new SubagentManagerImpl(createConfig())
      const session = manager.spawn({
        agent: 'grok',
        task: 'Do work',
      })

      const status = manager.status(session.id)
      expect(status.status).toBe('running')
      expect(status.agent).toBe('grok')
      expect(status.elapsedMs).toBeGreaterThanOrEqual(0)
      expect(status.iterations).toBe(0)
    })

    it('returns final results after completion', async () => {
      const manager = new SubagentManagerImpl(createConfig())
      const session = manager.spawn({
        agent: 'grok',
        task: 'Do work',
      })

      await waitForCompletion(manager, session.id)
      const status = manager.status(session.id)

      expect(status.status).toBe('completed')
      expect(status.lastResponse).toContain('Response from')
      expect(status.elapsedMs).toBeGreaterThan(0)
    })

    it('throws on unknown session', () => {
      const manager = new SubagentManagerImpl(createConfig())
      expect(() => manager.status('bad-id')).toThrow('not found')
    })
  })

  describe('send', () => {
    it('sends a follow-up to a completed session', async () => {
      const manager = new SubagentManagerImpl(createConfig())
      const session = manager.spawn({
        agent: 'grok',
        task: 'Start',
      })

      await waitForCompletion(manager, session.id)

      // Send follow-up (should not throw)
      manager.send(session.id, 'Follow up')

      // Wait for the follow-up to complete
      await waitForCompletion(manager, session.id)
      const status = manager.status(session.id)
      expect(status.status).toBe('completed')
    })

    it('throws when session is still running', () => {
      const manager = new SubagentManagerImpl(createConfig())
      const session = manager.spawn({
        agent: 'grok',
        task: 'Start',
      })

      expect(() => manager.send(session.id, 'too early')).toThrow(
        'still running',
      )
    })

    it('throws on unknown session', () => {
      const manager = new SubagentManagerImpl(createConfig())
      expect(() => manager.send('bad-id', 'hello')).toThrow('not found')
    })
  })

  describe('kill', () => {
    it('kills a running session', async () => {
      const manager = new SubagentManagerImpl(createConfig())
      const session = manager.spawn({
        agent: 'grok',
        task: 'Start',
      })

      manager.kill(session.id)

      const status = manager.status(session.id)
      expect(status.status).toBe('failed')
      expect(status.error).toBe('Killed by parent')
    })

    it('throws on unknown session', () => {
      const manager = new SubagentManagerImpl(createConfig())
      expect(() => manager.kill('bad-id')).toThrow('not found')
    })
  })

  describe('list', () => {
    it('returns all sessions regardless of status', async () => {
      const manager = new SubagentManagerImpl(createConfig())

      const s1 = manager.spawn({ agent: 'grok', task: 'A' })
      const s2 = manager.spawn({ agent: 'opus', task: 'B' })

      // Wait for both to complete
      await waitForCompletion(manager, s1.id)
      await waitForCompletion(manager, s2.id)

      const listed = manager.list()
      expect(listed).toHaveLength(2)
      expect(listed.every((s) => s.status === 'completed')).toBe(true)
    })

    it('includes running sessions', () => {
      const manager = new SubagentManagerImpl(createConfig())
      manager.spawn({ agent: 'grok', task: 'A' })

      const listed = manager.list()
      expect(listed).toHaveLength(1)
      expect(listed[0].status).toBe('running')
    })
  })

  describe('timeout', () => {
    it('fails the session on timeout', async () => {
      // Use a provider that hangs forever
      const config = createConfig()
      const xaiProvider = config.router
        .getProviders()
        .find((p) => p.id === 'xai') as ReturnType<Router['getProviders']>[0] & {
        chatStream: ReturnType<typeof vi.fn>
      }
      xaiProvider.chatStream = vi.fn(async function* (
        _msgs: unknown,
        opts: { signal?: AbortSignal } = {},
      ) {
        await new Promise<void>((_resolve, reject) => {
          if (opts.signal?.aborted) {
            reject(new Error('aborted'))
            return
          }
          opts.signal?.addEventListener('abort', () => reject(new Error('aborted')))
          // Never resolves naturally
        })
      })

      const manager = new SubagentManagerImpl(config)
      const session = manager.spawn({
        agent: 'grok',
        task: 'Hang forever',
        timeoutMs: 50,
      })

      await waitForCompletion(manager, session.id, 2000)
      const status = manager.status(session.id)
      expect(status.status).toBe('failed')
    })
  })
})

describe('createSubagentTools', () => {
  it('creates 5 tools', () => {
    const manager = new SubagentManagerImpl(createConfig())
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
    const manager = new SubagentManagerImpl(createConfig())
    const tools = createSubagentTools(manager)
    const spawnTool = tools.find((t) => t.name === 'subagent_spawn')!

    const result = await spawnTool.execute({
      agent: 'grok',
      task: 'Do something',
    })

    const parsed = JSON.parse(result as string) as { sessionId: string; status: string }
    expect(parsed.sessionId).toBeDefined()
    expect(parsed.status).toBe('running')
  })

  it('status tool returns progress info', async () => {
    const manager = new SubagentManagerImpl(createConfig())
    const tools = createSubagentTools(manager)
    const spawnTool = tools.find((t) => t.name === 'subagent_spawn')!
    const statusTool = tools.find((t) => t.name === 'subagent_status')!

    const spawnResult = await spawnTool.execute({
      agent: 'grok',
      task: 'Do something',
    })

    const parsed = JSON.parse(spawnResult as string) as { sessionId: string }

    // Wait for completion
    await waitForCompletion(manager, parsed.sessionId)

    const statusResult = await statusTool.execute({
      session_id: parsed.sessionId,
    })

    expect(typeof statusResult).toBe('string')
    expect(statusResult).toContain('completed')
    expect(statusResult).toContain('Response from')
  })

  it('spawn tool handles errors gracefully', async () => {
    const manager = new SubagentManagerImpl(createConfig())
    const tools = createSubagentTools(manager)
    const spawnTool = tools.find((t) => t.name === 'subagent_spawn')!

    const result = await spawnTool.execute({
      agent: 'nonexistent',
      task: 'test',
    })

    expect(result).toContain('Error')
  })

  it('list tool returns empty when no sessions', async () => {
    const manager = new SubagentManagerImpl(createConfig())
    const tools = createSubagentTools(manager)
    const listTool = tools.find((t) => t.name === 'subagent_list')!

    const result = await listTool.execute({})
    expect(result).toContain('No sub-agent')
  })

  it('kill tool handles unknown session', async () => {
    const manager = new SubagentManagerImpl(createConfig())
    const tools = createSubagentTools(manager)
    const killTool = tools.find((t) => t.name === 'subagent_kill')!

    const result = await killTool.execute({ session_id: 'bad-id' })
    expect(result).toContain('Error')
  })
})
