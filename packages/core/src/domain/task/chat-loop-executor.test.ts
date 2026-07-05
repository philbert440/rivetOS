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
