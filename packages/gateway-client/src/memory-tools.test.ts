import { describe, expect, it, vi } from 'vitest'
import type { MemoryToolArgsByName, MemoryToolName, ToolResult } from '@rivetos/types'
import { GatewayError, RivetGateway } from './index.js'

const args = {
  memory_search: {
    query: 'gateway',
    mode: 'trigram',
    scope: 'both',
    limit: 7,
    agent: 'rivet',
    since: '2026-09-01',
    before: '2026-09-26',
    window: 'today',
    expand: true,
    synthesize: false,
  },
  memory_browse: {
    conversation_id: 'c1',
    since: '2026-09-01',
    before: '2026-09-26',
    window: 'today',
    agent: 'rivet',
    include_tools: true,
    limit: 100,
    order: 'asc',
  },
  memory_stats: { agent: 'rivet' },
  memory_get_full: { id: 'm1' },
  memory_append: {
    session_id: 's1',
    content: 'hello',
    role: 'tool',
    tool_name: 'echo',
    tool_args: { text: 'hello' },
    tool_result: 'hello',
    event_id: 'e1',
    agent: 'rivet',
    persona: 'engineer',
    source: 'codex',
    channel: 'cli',
  },
  memory_ingest_session: {
    session_id: 's1',
    messages: [
      {
        role: 'assistant',
        content: 'hello',
        created_at: '2026-09-26T12:00:00Z',
        tool_calls: [{ id: 'call1', name: 'echo', input: { text: 'hello' } }],
      },
    ],
    agent: 'rivet',
    persona: 'engineer',
    source: 'codex',
    channel: 'cli',
  },
  memory_tags: { action: 'pending', limit: 5 },
} satisfies MemoryToolArgsByName

const wrappers = {
  memory_search: 'memorySearchTool',
  memory_browse: 'memoryBrowseTool',
  memory_stats: 'memoryStatsTool',
  memory_get_full: 'memoryGetFull',
  memory_append: 'memoryAppend',
  memory_ingest_session: 'memoryIngestSession',
} as const

const results: ToolResult[] = ['found', [{ type: 'text', text: 'found' }]]

describe('memory tool routes', () => {
  for (const name of Object.keys(wrappers) as MemoryToolName[]) {
    for (const result of results) {
      it(`${name} forwards args and unwraps ${typeof result}`, async () => {
        const fetch = vi
          .fn<typeof globalThis.fetch>()
          .mockResolvedValue(Response.json({ ok: true, result }))
        const client = new RivetGateway({ baseUrl: 'https://den.test', fetch })
        const signal = new AbortController().signal
        // Keep each wrapper's input tied to its tool name at compile time.
        const calls = {
          memory_search: () => client.memorySearchTool(args.memory_search, signal),
          memory_browse: () => client.memoryBrowseTool(args.memory_browse, signal),
          memory_stats: () => client.memoryStatsTool(args.memory_stats, signal),
          memory_get_full: () => client.memoryGetFull(args.memory_get_full, signal),
          memory_append: () => client.memoryAppend(args.memory_append, signal),
          memory_ingest_session: () =>
            client.memoryIngestSession(args.memory_ingest_session, signal),
        }
        expect(await calls[name]()).toEqual(result)
        expect(fetch).toHaveBeenCalledExactlyOnceWith(`https://den.test/api/memory/tool/${name}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(args[name]),
          signal,
        })
      })
    }
  }

  it.each([404, 500])('preserves status %s and the error body', async (status) => {
    const body = { error: 'tool unavailable' }
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(Response.json(body, { status }))
    const client = new RivetGateway({ baseUrl: 'https://den.test', fetch })
    const result = client.memoryTool('memory_stats', {})
    await expect(result).rejects.toBeInstanceOf(GatewayError)
    await expect(result).rejects.toMatchObject({ status, body, message: body.error })
  })
})

describe('wikiRead', () => {
  it('returns raw markdown and encodes the slug', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response('# Topic\n'))
    const client = new RivetGateway({ baseUrl: 'https://den.test', fetch })
    const signal = new AbortController().signal
    expect(await client.wikiRead('a/b', signal)).toEqual({ kind: 'hit', markdown: '# Topic\n' })
    expect(fetch).toHaveBeenCalledWith(
      'https://den.test/api/wiki/a%2Fb/raw',
      expect.objectContaining({ method: 'GET', signal }),
    )
  })

  it.each([{ suggestions: [] }, { suggestions: [{ slug: 'nearby', title: 'Nearby' }] }])(
    'returns miss suggestions $suggestions',
    async ({ suggestions }) => {
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValue(
          Response.json({ error: 'no topic missing', suggestions }, { status: 404 }),
        )
      const client = new RivetGateway({ baseUrl: 'https://den.test', fetch })
      expect(await client.wikiRead('missing')).toEqual({ kind: 'miss', suggestions })
    },
  )

  it.each([
    { status: 500, body: { error: 'failed', suggestions: [] } },
    { status: 404, body: { error: 'missing' } },
    { status: 404, body: { error: 'missing', suggestions: [{ slug: 1, title: 'bad' }] } },
    { status: 404, body: { suggestions: [] } },
  ])('throws for $status with invalid miss or failure', async ({ status, body }) => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(Response.json(body, { status }))
    const client = new RivetGateway({ baseUrl: 'https://den.test', fetch })
    await expect(client.wikiRead('missing')).rejects.toMatchObject({
      name: 'GatewayError',
      status,
      body,
    })
  })
})

it('forwards task delegation fields', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json({ task: {} }))
  const client = new RivetGateway({ baseUrl: 'https://den.test', fetch })
  const body = { goal: 'build', agentId: 'rivet', parentTaskId: 'parent', chainDepth: 2 }
  await client.createTask(body)
  expect(fetch).toHaveBeenCalledWith(
    'https://den.test/api/tasks',
    expect.objectContaining({ method: 'POST', body: JSON.stringify(body) }),
  )
})
