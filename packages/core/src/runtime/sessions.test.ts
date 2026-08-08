/**
 * SessionManager lifecycle hook tests — session:start / session:end emitters.
 */

import { describe, it, expect, vi } from 'vitest'
import { SessionManager } from './sessions.js'
import { HookPipelineImpl } from '../domain/hooks.js'
import { createSessionStartHook, createSessionSummaryHook } from '../domain/session-hooks.js'
import type { AgentConfig, InboundMessage, SessionStartContext, SessionEndContext } from '@rivetos/types'
import type { Router } from '../domain/router.js'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const agent: AgentConfig = {
  id: 'opus',
  name: 'Opus',
  provider: 'mock',
  model: 'test-model',
}

function makeRouter(): Router {
  return {
    route: () => ({ agent, provider: { id: 'mock' } }),
    registerAgent: () => {},
    registerProvider: () => {},
    getAgents: () => [agent],
    getProviders: () => [],
    healthCheck: async () => ({}),
  } as unknown as Router
}

function makeMessage(overrides?: Partial<InboundMessage>): InboundMessage {
  return {
    id: 'm1',
    userId: 'user-1',
    channelId: 'ch-1',
    chatType: 'dm',
    text: 'hello',
    platform: 'telegram',
    timestamp: Date.now(),
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// session:start
// ---------------------------------------------------------------------------

describe('SessionManager session:start', () => {
  it('emits session:start when a session is created', async () => {
    const pipeline = new HookPipelineImpl()
    const seen: SessionStartContext[] = []
    pipeline.register({
      id: 'capture-start',
      event: 'session:start',
      handler: (ctx) => {
        seen.push(ctx as SessionStartContext)
      },
    })

    const sm = new SessionManager(makeRouter(), undefined, pipeline)
    const session = await sm.createSession('ch-1:user-1', agent, {
      platform: 'telegram',
      userId: 'user-1',
    })

    expect(session.id).toBe('ch-1:user-1')
    expect(seen).toHaveLength(1)
    expect(seen[0].event).toBe('session:start')
    expect(seen[0].agentId).toBe('opus')
    expect(seen[0].sessionId).toBe('ch-1:user-1')
    expect(seen[0].platform).toBe('telegram')
    expect(seen[0].userId).toBe('user-1')
  })

  it('does not emit session:start on get of existing session', async () => {
    const pipeline = new HookPipelineImpl()
    const seen: string[] = []
    pipeline.register({
      id: 'capture-start',
      event: 'session:start',
      handler: () => {
        seen.push('start')
      },
    })

    const sm = new SessionManager(makeRouter(), undefined, pipeline)
    const msg = makeMessage()
    await sm.getOrCreateSession('ch-1:user-1', msg)
    await sm.getOrCreateSession('ch-1:user-1', msg)

    expect(seen).toHaveLength(1)
  })

  it('runs boot-style createSessionStartHook end-to-end', async () => {
    const pipeline = new HookPipelineImpl()
    const fileWriter = {
      write: vi.fn().mockResolvedValue(undefined),
      read: vi.fn().mockResolvedValue('# Daily note'),
      append: vi.fn().mockResolvedValue(undefined),
    }
    pipeline.register(
      createSessionStartHook({
        workspaceDir: '/tmp/ws',
        fileWriter,
      }),
    )

    const sm = new SessionManager(makeRouter(), undefined, pipeline)
    await sm.createSession('ch-1:user-1', agent, {
      platform: 'discord',
      userId: 'u2',
    })

    expect(fileWriter.read).toHaveBeenCalled()
  })

  it('createSession succeeds when a start hook throws (fail-safe)', async () => {
    const pipeline = new HookPipelineImpl()
    pipeline.register({
      id: 'boom',
      event: 'session:start',
      onError: 'continue',
      handler: () => {
        throw new Error('hook exploded')
      },
    })

    const sm = new SessionManager(makeRouter(), undefined, pipeline)
    const session = await sm.createSession('ch-1:user-1', agent)
    expect(session.id).toBe('ch-1:user-1')
  })
})

// ---------------------------------------------------------------------------
// session:end
// ---------------------------------------------------------------------------

describe('SessionManager session:end', () => {
  it('emits session:end on endSession with turn bookkeeping', async () => {
    const pipeline = new HookPipelineImpl()
    const seen: SessionEndContext[] = []
    pipeline.register({
      id: 'capture-end',
      event: 'session:end',
      handler: (ctx) => {
        seen.push(ctx as SessionEndContext)
      },
    })

    const sm = new SessionManager(makeRouter(), undefined, pipeline)
    const session = await sm.createSession('ch-1:user-1', agent)
    sm.set('ch-1:user-1', session)
    sm.recordTurn('ch-1:user-1', { promptTokens: 100, completionTokens: 50 })
    sm.recordTurn('ch-1:user-1', { promptTokens: 200, completionTokens: 75 })

    await sm.endSession('ch-1:user-1')

    expect(sm.has('ch-1:user-1')).toBe(false)
    expect(seen).toHaveLength(1)
    expect(seen[0].event).toBe('session:end')
    expect(seen[0].agentId).toBe('opus')
    expect(seen[0].sessionId).toBe('ch-1:user-1')
    expect(seen[0].turnCount).toBe(2)
    expect(seen[0].totalTokens).toEqual({ prompt: 300, completion: 125 })
  })

  it('runs boot-style createSessionSummaryHook end-to-end', async () => {
    const pipeline = new HookPipelineImpl()
    const fileWriter = {
      write: vi.fn().mockResolvedValue(undefined),
      read: vi.fn().mockResolvedValue(null),
      append: vi.fn().mockResolvedValue(undefined),
    }
    pipeline.register(
      createSessionSummaryHook({
        workspaceDir: '/tmp/ws',
        fileWriter,
      }),
    )

    const sm = new SessionManager(makeRouter(), undefined, pipeline)
    const session = await sm.createSession('ch-1:user-1', agent)
    sm.set('ch-1:user-1', session)
    sm.recordTurn('ch-1:user-1', { promptTokens: 10, completionTokens: 5 })
    await sm.endSession('ch-1:user-1')

    expect(fileWriter.append).toHaveBeenCalled()
    const appended = (fileWriter.append as ReturnType<typeof vi.fn>).mock.calls[0][1] as string
    expect(appended).toContain('Session ended')
    expect(appended).toContain('opus')
  })

  it('endAllSessions ends every live session', async () => {
    const pipeline = new HookPipelineImpl()
    const ends: string[] = []
    pipeline.register({
      id: 'capture-end',
      event: 'session:end',
      handler: (ctx) => {
        ends.push((ctx as SessionEndContext).sessionId ?? '')
      },
    })

    const sm = new SessionManager(makeRouter(), undefined, pipeline)
    const a = await sm.createSession('s1', agent)
    const b = await sm.createSession('s2', agent)
    sm.set('s1', a)
    sm.set('s2', b)

    await sm.endAllSessions()

    expect(sm.has('s1')).toBe(false)
    expect(sm.has('s2')).toBe(false)
    expect(ends.sort()).toEqual(['s1', 's2'])
  })

  it('delete does not emit session:end', async () => {
    const pipeline = new HookPipelineImpl()
    const ends: string[] = []
    pipeline.register({
      id: 'capture-end',
      event: 'session:end',
      handler: () => {
        ends.push('end')
      },
    })

    const sm = new SessionManager(makeRouter(), undefined, pipeline)
    const session = await sm.createSession('s1', agent)
    sm.set('s1', session)
    sm.delete('s1')

    expect(ends).toHaveLength(0)
    expect(sm.has('s1')).toBe(false)
  })
})
