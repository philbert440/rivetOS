import { afterEach, describe, expect, it, vi } from 'vitest'
import { GatewayError } from '@rivetos/gateway-client'
import type { ContentPart, TaskCreateRequest, TaskWire, ToolResult } from '@rivetos/types'

import type { DenToolsGateway } from './den-tools.js'
import { createDenTools } from './den-tools.js'
import {
  memoryBrowseInputSchema,
  memoryGetFullInputSchema,
  memorySearchInputSchema,
  memoryStatsInputSchema,
} from './memory.js'
import { memoryAppendInputSchema, memoryIngestSessionInputSchema } from './memory-write.js'

import { createMemoryTools } from './memory.js'
import { createWikiTools } from './wiki.js'
import {
  createDelegateTools,
  denDelegateTaskDefinition,
  type DelegateToolsDeps,
} from './delegate.js'

afterEach(() => {
  vi.restoreAllMocks()
})

const DEN = 'https://127.0.0.1:5174'
const PARENT = '11111111-1111-4111-8111-111111111111'

function taskWire(overrides: Partial<TaskWire> = {}): TaskWire {
  return {
    id: 'task-1',
    goal: 'do the thing',
    contextRefs: [],
    acceptanceCriteria: [],
    spec: {},
    executor: 'chat-loop',
    agentId: 'reviewer',
    origin: 'api',
    chainDepth: 1,
    budget: {},
    status: 'completed',
    attempt: 1,
    maxAttempts: 1,
    harnessSessionIds: [],
    evalAttempt: 0,
    createdAt: 0,
    result: {
      verdict: 'completed',
      summary: 'sum',
      output: 'done',
      artifacts: [],
      usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3, turns: 1, wallClockMs: 4 },
    },
    durationMs: 10,
    ...overrides,
  }
}

function tool(handle: ReturnType<typeof createDenTools>, name: string) {
  const found = handle.tools.find((item) => item.name === name)
  if (!found) throw new Error(`missing tool ${name}`)
  return found
}

describe('createDenTools', () => {
  it('forwards memory_search args and returns a string result', async () => {
    const memoryTool = vi.fn(async (): Promise<ToolResult> => 'found it')
    const handle = createDenTools({
      denUrl: DEN,
      enableWrite: false,
      enableDelegate: false,
      requestedBy: 'mcp-sidecar',
      log: () => undefined,
      gateway: { memoryTool } as unknown as DenToolsGateway,
    })
    const search = tool(handle, 'memory_search')
    expect(search.inputSchema).toBe(memorySearchInputSchema)
    expect(search.description).toContain('memory_get_full id=')
    const args = { query: 'deploy', mode: 'hybrid', limit: 5 }
    expect(await search.execute(args)).toBe('found it')
    expect(memoryTool).toHaveBeenCalledWith('memory_search', args, undefined)
    expect(handle.tools.map((item) => item.name)).toEqual([
      'memory_search',
      'memory_browse',
      'memory_stats',
      'memory_get_full',
      'wiki_search',
      'wiki_read',
    ])
    await handle.close()
  })

  it('returns memory_browse content parts as structured content', async () => {
    const parts: ContentPart[] = [
      { type: 'text', text: 'line' },
      { type: 'text', text: 'two' },
    ]
    const memoryTool = vi.fn(async (): Promise<ToolResult> => parts)
    const handle = createDenTools({
      denUrl: DEN,
      enableWrite: false,
      enableDelegate: false,
      requestedBy: 'mcp-sidecar',
      log: () => undefined,
      gateway: { memoryTool } as unknown as DenToolsGateway,
    })
    const browse = tool(handle, 'memory_browse')
    expect(browse.inputSchema).toBe(memoryBrowseInputSchema)
    const signal = new AbortController().signal
    expect(await browse.execute({ window: 'today' }, { signal })).toEqual({
      content: [
        { type: 'text', text: 'line' },
        { type: 'text', text: 'two' },
      ],
    })
    expect(memoryTool).toHaveBeenCalledWith('memory_browse', { window: 'today' }, signal)
  })

  it('forwards memory_stats and memory_get_full', async () => {
    const memoryTool = vi.fn(async (name: string): Promise<ToolResult> => name)
    const handle = createDenTools({
      denUrl: DEN,
      enableWrite: false,
      enableDelegate: false,
      requestedBy: 'mcp-sidecar',
      log: () => undefined,
      gateway: { memoryTool } as unknown as DenToolsGateway,
    })
    expect(tool(handle, 'memory_stats').inputSchema).toBe(memoryStatsInputSchema)
    expect(tool(handle, 'memory_get_full').inputSchema).toBe(memoryGetFullInputSchema)
    expect(await tool(handle, 'memory_stats').execute({ agent: 'grok' })).toBe('memory_stats')
    expect(await tool(handle, 'memory_get_full').execute({ id: 'row-1' })).toBe('memory_get_full')
    expect(memoryTool).toHaveBeenNthCalledWith(1, 'memory_stats', { agent: 'grok' }, undefined)
    expect(memoryTool).toHaveBeenNthCalledWith(2, 'memory_get_full', { id: 'row-1' }, undefined)
  })

  it('maps a status-0 GatewayError to den unreachable and does not throw', async () => {
    const memoryTool = vi.fn(async () => {
      throw new GatewayError(0, 'gateway unreachable: connect ECONNREFUSED', undefined)
    })
    const handle = createDenTools({
      denUrl: DEN,
      enableWrite: false,
      enableDelegate: false,
      requestedBy: 'mcp-sidecar',
      log: () => undefined,
      gateway: { memoryTool } as unknown as DenToolsGateway,
    })
    expect(await tool(handle, 'memory_stats').execute({})).toBe(
      `den unreachable at ${DEN}: gateway unreachable: connect ECONNREFUSED`,
    )
  })

  it('registers write tools and maps a 404 to not-mounted', async () => {
    const memoryTool = vi.fn(async (name: string) => {
      if (name === 'memory_append') {
        throw new GatewayError(404, 'unknown memory tool', { error: 'unknown memory tool' })
      }
      return 'ingested'
    })
    const handle = createDenTools({
      denUrl: DEN,
      enableWrite: true,
      enableDelegate: false,
      requestedBy: 'mcp-sidecar',
      log: () => undefined,
      gateway: { memoryTool } as unknown as DenToolsGateway,
    })
    expect(tool(handle, 'memory_append').inputSchema).toBe(memoryAppendInputSchema)
    expect(tool(handle, 'memory_ingest_session').inputSchema).toBe(memoryIngestSessionInputSchema)
    const appendArgs = { session_id: 's', content: 'hi', role: 'user' }
    expect(await tool(handle, 'memory_append').execute(appendArgs)).toBe(
      'den has no write tools mounted (unknown memory tool)',
    )
    expect(memoryTool).toHaveBeenCalledWith('memory_append', appendArgs, undefined)
    const ingestArgs = { session_id: 's', messages: [{ role: 'user', content: 'hi' }] }
    expect(await tool(handle, 'memory_ingest_session').execute(ingestArgs)).toBe('ingested')
    expect(memoryTool).toHaveBeenCalledWith('memory_ingest_session', ingestArgs, undefined)
  })

  it('formats wiki_search like the pg tool and wiki_read hit and miss', async () => {
    const markdown = `---
title: Example
slug: example
---

## Summary

Hello
`
    const hit = {
      topics: [
        {
          slug: 'example',
          title: 'Example',
          tags: [],
          entities: [],
          updatedAt: '2026-09-26T00:00:00Z',
          excerpt: 'Hello world',
        },
      ],
      total: 1,
    }
    const wikiIndex = vi.fn(async () => hit)
    wikiIndex.mockResolvedValueOnce(hit).mockResolvedValueOnce({ topics: [], total: 0 })
    const wikiRead = vi.fn(async (slug: string) => {
      if (slug === 'missing') {
        return { kind: 'miss' as const, suggestions: [{ slug: 'example', title: 'Example' }] }
      }
      if (slug === 'gone') return { kind: 'miss' as const, suggestions: [] }
      return { kind: 'hit' as const, markdown }
    })
    const handle = createDenTools({
      denUrl: DEN,
      enableWrite: false,
      enableDelegate: false,
      requestedBy: 'mcp-sidecar',
      log: () => undefined,
      gateway: { wikiIndex, wikiRead } as unknown as DenToolsGateway,
    })
    expect(await tool(handle, 'wiki_search').execute({ query: 'ex', limit: 3 })).toBe(
      '## Example (example)\nHello world',
    )
    expect(wikiIndex).toHaveBeenCalledWith({ q: 'ex', limit: 3 }, undefined)
    expect(await tool(handle, 'wiki_search').execute({ query: 'none' })).toBe(
      'No wiki topics match — a gap worth filling, or try memory_search for raw history.',
    )
    expect(await tool(handle, 'wiki_read').execute({ slug: 'example' })).toBe(markdown)
    expect(wikiRead).toHaveBeenCalledWith('example', undefined)
    expect(await tool(handle, 'wiki_read').execute({ slug: 'missing' })).toBe(
      'No page for "missing" — a red link. Did you mean: example?',
    )
    expect(await tool(handle, 'wiki_read').execute({ slug: 'gone' })).toBe(
      'No page for "gone" — a red link.',
    )
    expect(await tool(handle, 'wiki_read').execute({ slug: 'Not A Slug' })).toBe(
      'Invalid slug "Not A Slug" — lowercase kebab-case only.',
    )
  })

  it('maps wiki unreachable without throwing', async () => {
    const wikiIndex = vi.fn(async () => {
      throw new GatewayError(0, 'gateway unreachable: boom', undefined)
    })
    const handle = createDenTools({
      denUrl: DEN,
      enableWrite: false,
      enableDelegate: false,
      requestedBy: 'mcp-sidecar',
      log: () => undefined,
      gateway: { wikiIndex } as unknown as DenToolsGateway,
    })
    expect(await tool(handle, 'wiki_search').execute({ query: 'x' })).toBe(
      `den unreachable at ${DEN}: gateway unreachable: boom`,
    )
  })

  it('renders list_agents from the catalog and forwards delegate_task', async () => {
    const createTask = vi.fn(async () => ({ task: taskWire() }))
    const waitTask = vi.fn(async () => {
      vi.spyOn(Date, 'now').mockReturnValue(110)
      return { task: taskWire() }
    })
    vi.spyOn(Date, 'now').mockReturnValue(100)
    const catalogAgents = vi.fn(async () => ({
      agents: [
        { id: 'grok', provider: 'xai', model: 'grok', node: 'node-f', local: true as const },
        {
          kind: 'preset' as const,
          id: 'preset-1',
          name: 'reviewer',
          node: 'node-f',
          local: true,
          harnessId: 'claude-code' as const,
          directory: '/tmp/reviewer',
        },
      ],
    }))
    const handle = createDenTools({
      denUrl: DEN,
      enableWrite: false,
      enableDelegate: true,
      requestedBy: 'claude',
      parentTaskId: PARENT,
      log: () => undefined,
      gateway: { createTask, waitTask, catalogAgents } as unknown as DenToolsGateway,
    })
    expect(await tool(handle, 'list_agents').execute({})).toBe(
      [
        '- reviewer (agent: claude-code on node-f — this node, dir /tmp/reviewer)',
        '',
        'Runtime agents (mesh):',
        '- grok (node-f)',
        '',
        'to_agent accepts a preset name or id, or a runtime agent id.',
      ].join('\n'),
    )
    const body: TaskCreateRequest = {
      goal: 'do the thing\n\nContext:\nline',
      agentId: 'reviewer',
      requestedBy: 'claude',
      parentTaskId: PARENT,
      budget: { maxWallClockMs: 5_000 },
      spec: { delegation: true, excludeTools: ['delegate_task'], model: 'grok-4' },
    }
    expect(
      await tool(handle, 'delegate_task').execute({
        to_agent: 'reviewer',
        task: 'do the thing',
        context: ['line'],
        timeout_ms: 5_000,
        model: 'grok-4',
      }),
    ).toBe('done\n\n---\n_Delegation [completed]: 10ms | tokens: 3_')
    expect(createTask).toHaveBeenCalledWith(body)
    expect(waitTask).toHaveBeenCalledWith('task-1', { timeoutMs: 5_000 })
  })

  it('maps chain-too-deep 409 and den unreachable on delegate_task', async () => {
    const createTask = vi.fn(async () => {
      throw new GatewayError(409, 'delegation chain too deep (4 > 3)', {
        error: 'delegation chain too deep (4 > 3)',
      })
    })
    const handle = createDenTools({
      denUrl: DEN,
      enableWrite: false,
      enableDelegate: true,
      requestedBy: 'mcp-sidecar',
      log: () => undefined,
      gateway: { createTask } as unknown as DenToolsGateway,
    })
    expect(
      await tool(handle, 'delegate_task').execute({ to_agent: 'reviewer', task: 'again' }),
    ).toBe('[failed] delegation chain too deep (4 > 3)')

    createTask.mockRejectedValueOnce(new GatewayError(0, 'gateway unreachable: down', undefined))
    expect(
      await tool(handle, 'delegate_task').execute({ to_agent: 'reviewer', task: 'again' }),
    ).toBe(`den unreachable at ${DEN}: gateway unreachable: down`)
  })

  it('fail-closes a non-UUID parent as chain depth 3 and omits parentTaskId', async () => {
    const lines: string[] = []
    const createTask = vi.fn(async () => ({
      task: taskWire({ result: undefined, durationMs: undefined }),
    }))
    const handle = createDenTools({
      denUrl: DEN,
      enableWrite: false,
      enableDelegate: true,
      requestedBy: 'mcp-sidecar',
      parentTaskId: 'not-a-uuid',
      log: (message) => {
        lines.push(message)
      },
      gateway: { createTask, waitTask: createTask } as unknown as DenToolsGateway,
    })
    expect(lines).toEqual([
      'RIVETOS_TASK_ID "not-a-uuid" is not a UUID — delegate tools registered at chain depth 2 (fail closed)',
    ])
    expect(
      await tool(handle, 'delegate_task').execute({ to_agent: 'reviewer', task: 'go' }),
    ).toContain('[no response from remote agent]')
    expect(createTask).toHaveBeenCalledWith(
      expect.objectContaining({ chainDepth: 3, agentId: 'reviewer' }),
    )
    const body = createTask.mock.calls[0]?.[0] as TaskCreateRequest
    expect(body.parentTaskId).toBeUndefined()
  })

  it('shares registration schemas and metadata with pg, except den delegate_task wording', async () => {
    const memory = createMemoryTools({ pgUrl: 'postgres://unused', enableWrite: true })
    const wiki = createWikiTools({ pgUrl: 'postgres://unused' })
    const delegate = createDelegateTools({
      waiter: { stop: async () => undefined },
    } as DelegateToolsDeps)
    const den = createDenTools({
      denUrl: DEN,
      enableWrite: true,
      enableDelegate: true,
      requestedBy: 'test',
      log: () => undefined,
      gateway: {} as DenToolsGateway,
    })
    const pg = [...memory.tools, ...wiki.tools, ...delegate.tools]
    expect(pg).toHaveLength(10)
    for (const registration of pg) {
      const proxy = tool(den, registration.name)
      expect(proxy.name).toBe(registration.name)
      expect(proxy.annotations).toEqual(registration.annotations)
      if (registration.name === 'delegate_task') {
        // Den does not implement agent@node, so description and to_agent text differ.
        expect(proxy.description).toBe(denDelegateTaskDefinition.description)
        expect(proxy.description).not.toContain('agent@node')
        expect(registration.description).toContain('agent@node')
        expect(Object.is(proxy.inputSchema, denDelegateTaskDefinition.inputSchema)).toBe(true)
        expect(Object.is(proxy.inputSchema, registration.inputSchema)).toBe(false)
        continue
      }
      expect(Object.is(proxy.inputSchema, registration.inputSchema)).toBe(true)
      expect(proxy.description).toBe(registration.description)
    }
    await Promise.all([memory.close(), wiki.close(), delegate.close()])
  })

  function delegationGateway(waitTask: DenToolsGateway['waitTask'], parentTaskId?: string) {
    const createTask = vi.fn(async () => ({ task: taskWire({ status: 'queued' }) }))
    const killTask = vi.fn<DenToolsGateway['killTask']>(async () => ({
      ok: true,
      prior: 'running',
    }))
    const getTask = vi.fn(async () => ({ task: taskWire() }))
    const handle = createDenTools({
      denUrl: DEN,
      enableWrite: false,
      enableDelegate: true,
      requestedBy: 'test',
      log: () => undefined,
      parentTaskId,
      gateway: { createTask, waitTask, killTask, getTask } as unknown as DenToolsGateway,
    })
    return { execute: tool(handle, 'delegate_task').execute, createTask, killTask, getTask }
  }

  it.each([undefined, '   '])('starts parentless children at depth 1 (%s)', async (parent) => {
    const { execute, createTask } = delegationGateway(async () => ({ task: taskWire() }), parent)
    await execute({ to_agent: 'reviewer', task: 'go' })
    expect(createTask).toHaveBeenCalledWith(expect.objectContaining({ chainDepth: 1 }))
    expect(createTask.mock.calls[0]?.[0]).not.toHaveProperty('parentTaskId')
  })

  it('reports a killed 504 as timeout with elapsed time and diagnostic', async () => {
    vi.spyOn(Date, 'now').mockReturnValueOnce(100).mockReturnValue(6100)
    const { execute, killTask } = delegationGateway(async () => {
      throw new GatewayError(504, 'deadline', {
        task: taskWire({ status: 'killed', nodeAffinity: 'node-f' }),
        error: 'wait deadline exceeded — task killed',
      })
    })
    expect(await execute({ to_agent: 'reviewer', task: 'go', timeout_ms: 5000 })).toBe(
      '[timeout] Remote delegation to reviewer timed out after 5000ms (task task-1 killed): wait deadline exceeded — task killed — no runner claimed or finished it in time — is the rivetos runtime running on "node-f"?\n\n---\n_Delegation [timeout]: 6000ms_',
    )
    expect(killTask).toHaveBeenCalledExactlyOnceWith('task-1')
  })

  it('kills on the observation-only wait deadline without a task body', async () => {
    const { execute, killTask } = delegationGateway(async () => {
      throw new GatewayError(504, 'deadline', undefined)
    })
    expect(await execute({ to_agent: 'reviewer', task: 'go', timeout_ms: 5000 })).toContain(
      '[timeout] Remote delegation to reviewer timed out after 5000ms (task task-1 killed)',
    )
    expect(killTask).toHaveBeenCalledExactlyOnceWith('task-1')
  })

  it.each(['terminal', 'missing'])(
    'returns completion after a 504 and %s kill response',
    async (killOutcome) => {
      vi.spyOn(Date, 'now').mockReturnValueOnce(100).mockReturnValue(6100)
      const { execute, killTask, getTask } = delegationGateway(async () => {
        throw new GatewayError(504, 'deadline', undefined)
      })
      if (killOutcome === 'terminal') killTask.mockResolvedValueOnce({ ok: true, prior: null })
      else killTask.mockRejectedValueOnce(new GatewayError(404, 'missing', undefined))
      expect(await execute({ to_agent: 'reviewer', task: 'go', timeout_ms: 5000 })).toBe(
        'done\n\n---\n_Delegation [completed]: 6000ms | tokens: 3_',
      )
      expect(killTask).toHaveBeenCalledExactlyOnceWith('task-1')
      expect(getTask).toHaveBeenCalledExactlyOnceWith('task-1')
    },
  )

  it.each([
    { id: 't', status: 'completed', result: { output: { toString: null } } },
    { id: 't', status: {} },
    { id: 't', status: 'killed', nodeAffinity: {} },
    { id: 't', status: 'completed', result: { summary: {} } },
    { id: 't', status: 'completed', result: { usage: { inputTokens: '1', outputTokens: 2 } } },
    { id: 't', status: 'killed', usage: null },
    { id: 't', status: 'killed', durationMs: '1' },
    { id: 't', status: 'killed', error: {} },
  ])('falls back to text for malformed timeout task %j', async (task) => {
    const { execute } = delegationGateway(async () => {
      throw new GatewayError(504, 'deadline', { task })
    })
    expect(await execute({ to_agent: 'reviewer', task: 'go', timeout_ms: 5000 })).toBe(
      '[timeout] Remote delegation to reviewer timed out after 5000ms',
    )
  })

  it.each([false, true])(
    'kills exactly once and rethrows mid-wait abort (kill failure %s)',
    async (killFails) => {
      const controller = new AbortController()
      const abort = new DOMException('cancelled', 'AbortError')
      const waitTask = vi.fn<DenToolsGateway['waitTask']>(async (_id, opts) => {
        return new Promise((_resolve, reject) => {
          opts?.signal?.addEventListener('abort', () => reject(abort), { once: true })
        })
      })
      const { execute, killTask } = delegationGateway(waitTask)
      if (killFails) killTask.mockRejectedValueOnce(new Error('offline'))
      const pending = execute({ to_agent: 'reviewer', task: 'go' }, { signal: controller.signal })
      await Promise.resolve()
      expect(waitTask).toHaveBeenCalledWith('task-1', {
        timeoutMs: 1200000,
        signal: controller.signal,
      })
      controller.abort()
      await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
      expect(killTask).toHaveBeenCalledExactlyOnceWith('task-1')
    },
  )

  it.each([false, true])(
    'normalizes string-reason cancellation during wait (kill failure %s)',
    async (killFails) => {
      const controller = new AbortController()
      const waitTask = vi.fn<DenToolsGateway['waitTask']>(async (_id, opts) => {
        return new Promise((_resolve, reject) => {
          opts?.signal?.addEventListener(
            'abort',
            () => {
              reject(new GatewayError(0, 'gateway unreachable: user cancelled', undefined))
            },
            { once: true },
          )
        })
      })
      const { execute, killTask } = delegationGateway(waitTask)
      if (killFails) killTask.mockRejectedValueOnce(new Error('offline'))
      const pending = execute({ to_agent: 'reviewer', task: 'go' }, { signal: controller.signal })
      await Promise.resolve()
      expect(waitTask).toHaveBeenCalledOnce()
      controller.abort('user cancelled')
      await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
      expect(killTask).toHaveBeenCalledExactlyOnceWith('task-1')
    },
  )

  it.each([false, true])(
    'normalizes cancellation during creation (creation failure %s)',
    async (createFails) => {
      const controller = new AbortController()
      const waitTask = vi.fn<DenToolsGateway['waitTask']>()
      const { execute, createTask, killTask } = delegationGateway(waitTask)
      createTask.mockImplementationOnce(async () => {
        controller.abort('user cancelled')
        if (createFails) throw new GatewayError(0, 'gateway unreachable: user cancelled', undefined)
        return { task: taskWire({ status: 'queued' }) }
      })
      await expect(
        execute({ to_agent: 'reviewer', task: 'go' }, { signal: controller.signal }),
      ).rejects.toMatchObject({ name: 'AbortError' })
      expect(waitTask).not.toHaveBeenCalled()
      if (createFails) expect(killTask).not.toHaveBeenCalled()
      else expect(killTask).toHaveBeenCalledExactlyOnceWith('task-1')
    },
  )

  it('rejects an already-aborted call without creating a task', async () => {
    const controller = new AbortController()
    controller.abort('user cancelled')
    const { execute, createTask, killTask } = delegationGateway(vi.fn())
    await expect(
      execute({ to_agent: 'reviewer', task: 'go' }, { signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(createTask).not.toHaveBeenCalled()
    expect(killTask).not.toHaveBeenCalled()
  })

  it('formats failure and empty completion with elapsed time and no absent tokens', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(100)
    const { execute } = delegationGateway(async () => ({
      task: taskWire({ status: 'failed', result: undefined, error: 'boom', nodeAffinity: 'node-f' }),
    }))
    expect(await execute({ to_agent: 'reviewer', task: 'go' })).toBe(
      '[failed] Remote delegation to reviewer on node-f failed: boom\n\n---\n_Delegation [failed]: 0ms_',
    )
    const summary = delegationGateway(async () => ({
      task: taskWire({ result: undefined }),
    }))
    expect(await summary.execute({ to_agent: 'reviewer', task: 'go' })).toBe(
      '[no response from remote agent]\n\n---\n_Delegation [completed]: 0ms_',
    )
  })

  it('omits delegate tools when enableDelegate is false', () => {
    const handle = createDenTools({
      denUrl: DEN,
      enableWrite: false,
      enableDelegate: false,
      requestedBy: 'mcp-sidecar',
      log: () => undefined,
      gateway: {} as DenToolsGateway,
    })
    expect(handle.tools.some((item) => item.name === 'delegate_task')).toBe(false)
    expect(handle.tools.some((item) => item.name === 'list_agents')).toBe(false)
  })
})
