/**
 * createSubagentTools — tool-surface tests over the task-backed manager
 * (g2a: the legacy SubagentManagerImpl/worker/store are deleted; the task
 * engine is the only subagent engine). Manager semantics live in
 * task/subagent-task-manager.test.ts; this file pins the 5-tool surface.
 */

import { describe, it, expect, vi } from 'vitest'
import type {
  HarnessExecutor,
  HarnessExecutorCapabilities,
  TaskResult,
  TaskSpec,
} from '@rivetos/types'
import { createSubagentTools } from './subagent.js'
import { TaskBackedSubagentManager } from './task/subagent-task-manager.js'
import { InMemoryTaskStore } from './task/store.js'
import { createExecutorRegistry, createTaskHandler } from './task/runner.js'
import type { Router } from './router.js'

const caps: HarnessExecutorCapabilities = {
  steerable: true,
  multiTurn: true,
  structuredStream: true,
  usageInResult: true,
  sessionIdCapture: false,
  slashCommands: false,
  effortSelection: false,
  mcpInjection: 'none',
}

function fakeExecutor(): HarnessExecutor {
  return {
    name: 'fake',
    capabilities: () => caps,
    start(_spec: TaskSpec) {
      const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2, turns: 1, wallClockMs: 1 }
      const result: TaskResult = {
        verdict: 'completed',
        summary: 'Response from grok: all done',
        output: 'Response from grok: all done',
        artifacts: [],
        usage,
      }
      return {
        events: (async function* () {
          await Promise.resolve()
        })(),
        steer: () => Promise.resolve(),
        kill: () => Promise.resolve(),
        result: Promise.resolve(result),
      }
    },
  }
}

function buildManager(): { manager: TaskBackedSubagentManager; settle: () => Promise<void> } {
  const pending: Promise<void>[] = []
  const executors = createExecutorRegistry()
  executors.register('chat-loop', fakeExecutor())
  let handler: (taskId: string) => Promise<void>
  const store = new InMemoryTaskStore((taskId) => {
    pending.push(handler(taskId))
  })
  handler = createTaskHandler({ store, executors, nodeId: 'test-node' })
  const router = {
    getAgents: () => [{ id: 'grok', name: 'grok', provider: 'xai' }],
    getProviders: () => [{ id: 'xai' }],
    registerAgent: vi.fn(),
    registerProvider: vi.fn(),
  } as unknown as Router
  const manager = new TaskBackedSubagentManager({ router, store })
  const settle = async (): Promise<void> => {
    while (pending.length > 0) {
      await pending.splice(0).reduce((p, c) => p.then(() => c), Promise.resolve())
    }
  }
  return { manager, settle }
}

describe('createSubagentTools (task-backed)', () => {
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
    const spawnTool = createSubagentTools(manager).find((t) => t.name === 'subagent_spawn')!
    const result = await spawnTool.execute({ agent: 'grok', task: 'Do something' })
    const parsed = JSON.parse(result as string) as { sessionId: string; status: string }
    expect(parsed.sessionId).toBeDefined()
    expect(parsed.status).toBe('running')
  })

  it('status tool returns progress info after completion', async () => {
    const { manager, settle } = buildManager()
    const tools = createSubagentTools(manager)
    const spawnTool = tools.find((t) => t.name === 'subagent_spawn')!
    const statusTool = tools.find((t) => t.name === 'subagent_status')!

    const spawnResult = await spawnTool.execute({ agent: 'grok', task: 'Do something' })
    const parsed = JSON.parse(spawnResult as string) as { sessionId: string }
    await settle()

    const statusResult = await statusTool.execute({ session_id: parsed.sessionId })
    expect(typeof statusResult).toBe('string')
    expect(statusResult).toContain('completed')
    expect(statusResult).toContain('Response from')
  })

  it('spawn tool handles errors gracefully', async () => {
    const { manager } = buildManager()
    const spawnTool = createSubagentTools(manager).find((t) => t.name === 'subagent_spawn')!
    const result = await spawnTool.execute({ agent: 'nonexistent', task: 'test' })
    expect(result).toContain('Error')
  })

  it('list tool returns empty when no sessions', async () => {
    const { manager } = buildManager()
    const listTool = createSubagentTools(manager).find((t) => t.name === 'subagent_list')!
    const result = await listTool.execute({})
    expect(result).toContain('No sub-agent')
  })

  it('kill tool handles unknown session', async () => {
    const { manager } = buildManager()
    const killTool = createSubagentTools(manager).find((t) => t.name === 'subagent_kill')!
    const result = await killTool.execute({ session_id: 'bad-id' })
    expect(result).toContain('Error')
  })
})
