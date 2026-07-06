/**
 * ChatLoopExecutor — conformance suite + chat-loop specifics.
 *
 * Uses the shared executor conformance helper (test/executor-conformance.ts)
 * with a mock Router/Provider/Workspace, mirroring subagent.test.ts fixtures.
 */

import { describe, it, expect, vi } from 'vitest'
import type { TaskSpec } from '@rivetos/types'
import { createChatLoopExecutor, type ChatLoopExecutorConfig } from './chat-loop-executor.js'
import type { Router } from '../router.js'
import type { WorkspaceLoader } from '../workspace.js'
import { makeMockProvider } from '../../test-utils/mock-aisdk-provider.js'
import { runExecutorConformance, makeConformanceSpec } from './test/executor-conformance.js'

function createMockRouter(opts?: { stepDelayMs?: number }): Router {
  const provider = makeMockProvider({
    id: 'mock',
    stepDelayMs: opts?.stepDelayMs ?? 10,
    chunks: [
      { type: 'text', delta: 'Task response' },
      { type: 'done', usage: { promptTokens: 7, completionTokens: 11 } },
    ],
  })
  return {
    getAgents: () => [{ id: 'conformance-agent', name: 'conformance-agent', provider: 'mock' }],
    getProviders: () => [provider],
    registerAgent: vi.fn(),
    registerProvider: vi.fn(),
    route: vi.fn(),
    healthCheck: vi.fn(),
  } as unknown as Router
}

function createMockWorkspace(opts?: { fail?: boolean }): WorkspaceLoader {
  return {
    buildSystemPrompt: vi.fn(async (agentId: string) => {
      if (opts?.fail) throw new Error('workspace exploded')
      return `System prompt for ${agentId}`
    }),
    load: vi.fn(async () => []),
  } as unknown as WorkspaceLoader
}

function makeConfig(overrides?: Partial<ChatLoopExecutorConfig>): ChatLoopExecutorConfig {
  return {
    router: createMockRouter(),
    workspace: createMockWorkspace(),
    tools: () => [],
    ...overrides,
  }
}

runExecutorConformance('chat-loop', {
  makeSuccess: () => ({
    executor: createChatLoopExecutor(makeConfig()),
    spec: makeConformanceSpec(),
  }),
  makeError: () => ({
    executor: createChatLoopExecutor(makeConfig({ workspace: createMockWorkspace({ fail: true }) })),
    spec: makeConformanceSpec(),
  }),
  makeSlow: () => ({
    executor: createChatLoopExecutor(makeConfig({ router: createMockRouter({ stepDelayMs: 2000 }) })),
    spec: makeConformanceSpec(),
  }),
})

describe('ChatLoopExecutor specifics', () => {
  it('declares the audited capability matrix', () => {
    const caps = createChatLoopExecutor(makeConfig()).capabilities()
    expect(caps).toEqual({
      steerable: true,
      multiTurn: true,
      structuredStream: true,
      usageInResult: true,
      sessionIdCapture: false,
      slashCommands: false,
      effortSelection: false,
      mcpInjection: 'none',
    })
  })

  it('fails cleanly when the agent is not registered', async () => {
    const executor = createChatLoopExecutor(makeConfig())
    const handle = executor.start(makeConformanceSpec({ agentId: 'nope' }), {
      signal: new AbortController().signal,
    })
    const result = await handle.result
    expect(result.verdict).toBe('failed')
    expect(result.error).toMatch(/not registered/)
  })

  it('accumulates usage into the TaskUsage shape', async () => {
    const executor = createChatLoopExecutor(makeConfig())
    const handle = executor.start(makeConformanceSpec(), {
      signal: new AbortController().signal,
    })
    const result = await handle.result
    expect(result.usage.inputTokens).toBe(7)
    expect(result.usage.outputTokens).toBe(11)
    expect(result.usage.totalTokens).toBe(18)
    expect(result.usage.turns).toBe(1)
  })

  it('resume executes resumeMessage instead of the goal (P3)', async () => {
    const userTexts: string[] = []
    const provider = makeMockProvider({
      id: 'mock',
      chunks: [
        { type: 'text', delta: 'resumed' },
        { type: 'done', usage: { promptTokens: 1, completionTokens: 1 } },
      ],
      onCall: ({ prompt }) => {
        for (const msg of prompt) {
          if (msg.role !== 'user') continue
          for (const part of msg.content) {
            if (part.type === 'text') userTexts.push(part.text)
          }
        }
      },
    })
    const router = {
      getAgents: () => [{ id: 'conformance-agent', name: 'conformance-agent', provider: 'mock' }],
      getProviders: () => [provider],
    } as unknown as Router
    const executor = createChatLoopExecutor(makeConfig({ router }))

    const handle = executor.start(
      makeConformanceSpec({
        goal: 'THE ORIGINAL GOAL',
        resumeMessage: 'pick up where we left off',
      }),
      { signal: new AbortController().signal },
    )
    const result = await handle.result

    expect(result.verdict).toBe('completed')
    expect(result.usage.turns).toBe(1)
    expect(userTexts).toContain('pick up where we left off')
    // The goal must never re-execute as a user turn on resume.
    expect(userTexts).not.toContain('THE ORIGINAL GOAL')
  })

  it('persists each turn to memory under session_key task:<id>', async () => {
    const appended: Array<{ sessionId: string; role: string; content: string; channel: string }> =
      []
    const memory: ChatLoopExecutorConfig['memory'] = {
      append: vi.fn(async (entry) => {
        appended.push({
          sessionId: entry.sessionId,
          role: entry.role,
          content: entry.content,
          channel: entry.channel,
        })
        return 'id'
      }),
      getSessionHistory: vi.fn(async () => []),
    }
    const executor = createChatLoopExecutor(makeConfig({ memory }))
    const spec = makeConformanceSpec()
    const result = await executor.start(spec, { signal: new AbortController().signal }).result

    expect(result.verdict).toBe('completed')
    expect(appended).toHaveLength(2)
    expect(appended[0]).toMatchObject({
      sessionId: `task:${spec.taskId}`,
      role: 'user',
      content: spec.goal,
      channel: 'task',
    })
    expect(appended[1]).toMatchObject({ role: 'assistant', content: 'Task response' })
  })

  it('memory append failure does not fail the task', async () => {
    const memory: ChatLoopExecutorConfig['memory'] = {
      append: vi.fn(async () => {
        throw new Error('pg down')
      }),
      getSessionHistory: vi.fn(async () => []),
    }
    const executor = createChatLoopExecutor(makeConfig({ memory }))
    const result = await executor.start(makeConformanceSpec(), {
      signal: new AbortController().signal,
    }).result
    expect(result.verdict).toBe('completed')
  })

  it('resume rehydrates prior history from the task conversation', async () => {
    const prompts: Array<Array<{ role: string; text: string }>> = []
    const provider = makeMockProvider({
      id: 'mock',
      chunks: [
        { type: 'text', delta: 'resumed' },
        { type: 'done', usage: { promptTokens: 1, completionTokens: 1 } },
      ],
      onCall: ({ prompt }) => {
        const flat: Array<{ role: string; text: string }> = []
        for (const msg of prompt) {
          if (msg.role !== 'user' && msg.role !== 'assistant') continue
          for (const part of msg.content) {
            if (part.type === 'text') flat.push({ role: msg.role, text: part.text })
          }
        }
        prompts.push(flat)
      },
    })
    const router = {
      getAgents: () => [{ id: 'conformance-agent', name: 'conformance-agent', provider: 'mock' }],
      getProviders: () => [provider],
    } as unknown as Router
    const memory: ChatLoopExecutorConfig['memory'] = {
      append: vi.fn(async () => 'id'),
      getSessionHistory: vi.fn(async () => [
        { role: 'user' as const, content: 'THE ORIGINAL GOAL' },
        { role: 'assistant' as const, content: 'first pass done, need input' },
        { role: 'system' as const, content: 'should be filtered out' },
      ]),
    }
    const executor = createChatLoopExecutor(makeConfig({ router, memory }))
    const spec = makeConformanceSpec({
      goal: 'THE ORIGINAL GOAL',
      resumeMessage: 'here is the input',
    })
    const result = await executor.start(spec, { signal: new AbortController().signal }).result

    expect(result.verdict).toBe('completed')
    expect(memory.getSessionHistory).toHaveBeenCalledWith(`task:${spec.taskId}`)
    const flat = prompts[0]
    // Prior turns precede the resume message; system rows are filtered.
    expect(flat.map((m) => m.text)).toEqual([
      'THE ORIGINAL GOAL',
      'first pass done, need input',
      'here is the input',
    ])
  })

  it('resume survives a rehydration failure with empty history', async () => {
    const memory: ChatLoopExecutorConfig['memory'] = {
      append: vi.fn(async () => 'id'),
      getSessionHistory: vi.fn(async () => {
        throw new Error('pg down')
      }),
    }
    const executor = createChatLoopExecutor(makeConfig({ memory }))
    const result = await executor.start(
      makeConformanceSpec({ goal: 'goal', resumeMessage: 'resume' }),
      { signal: new AbortController().signal },
    ).result
    expect(result.verdict).toBe('completed')
  })

  it('steer before the first turn completes runs a follow-up turn', async () => {
    const executor = createChatLoopExecutor(makeConfig())
    const handle = executor.start(makeConformanceSpec(), {
      signal: new AbortController().signal,
    })
    await handle.steer('and another thing')
    const result = await handle.result
    expect(result.verdict).toBe('completed')
    expect(result.usage.turns).toBe(2)
  })
})
