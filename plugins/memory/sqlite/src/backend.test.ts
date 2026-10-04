/**
 * SqliteBackend: capture, the Memory pages' data, tags and the HTTP tools,
 * against a real in-memory database.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryRequestError, hasMemoryBackend } from '@rivetos/types'
import type { CaptureBatchRequest, Tool } from '@rivetos/types'
import { SqliteMemory } from './adapter.js'
import type { SqliteBackend } from './backend.js'

const noWait = async (): Promise<void> => {}

function batch(over: Partial<CaptureBatchRequest> = {}): CaptureBatchRequest {
  return {
    session_key: 'sess-1',
    agent: 'rivet',
    channel: 'cli',
    messages: [
      { event_id: 'e1', role: 'user', content: 'how do we deploy the acmeapp service to staging' },
      {
        event_id: 'e2',
        role: 'assistant',
        content: 'run the deploy script from the release branch, then watch the health check',
        created_at: '2026-10-04T10:00:00+02:00',
      },
      {
        event_id: 'e3',
        role: 'tool',
        content: '',
        tool_name: 'Bash',
        tool_args: { command: 'make deploy' },
        tool_result: 'deployed build 42 to staging',
      },
    ],
    ...over,
  }
}

describe('SqliteBackend', () => {
  let memory: SqliteMemory
  let backend: SqliteBackend
  const tool = (name: string): Tool => {
    const found = backend.tools().find((t) => t.name === name)
    if (!found) throw new Error(`no tool ${name}`)
    return found
  }

  beforeEach(() => {
    memory = new SqliteMemory({ path: ':memory:', log: () => {} })
    backend = memory.backend()
  })
  afterEach(() => {
    memory.close()
  })

  it('is discoverable through the Memory it belongs to', () => {
    expect(hasMemoryBackend(memory)).toBe(true)
    expect(hasMemoryBackend({})).toBe(false)
    expect(memory.backend()).toBe(backend)
  })

  describe('capture', () => {
    it('writes a batch once: a re-sent batch is skipped event by event', async () => {
      const first = await backend.capture(batch())
      expect(first).toMatchObject({ ok: true, inserted: 3, skipped: 0 })
      const again = await backend.capture(
        batch({
          messages: [
            ...batch().messages,
            { event_id: 'e4', role: 'user', content: 'and how do we roll it back afterwards' },
          ],
        }),
      )
      expect(again).toEqual({ ok: true, conversation_id: first.conversation_id, inserted: 1, skipped: 3 })
      const history = await memory.getSessionHistory('sess-1')
      expect(history.map((m) => m.role)).toContain('user')
      expect((await backend.stats()).messages).toBe(4)
    })

    it('the same event id under another session or agent is a different message', async () => {
      await backend.capture(batch())
      expect((await backend.capture(batch({ session_key: 'sess-2' }))).inserted).toBe(3)
      expect((await backend.capture(batch({ agent: 'other' }))).inserted).toBe(3)
      expect((await backend.stats()).conversations).toBe(3)
    })

    it('keeps title, settings and task id unless the batch supplies them', async () => {
      await backend.capture(batch({ title: 'Deploy talk', settings: { cwd: '/work/acmeapp' }, task_id: 'T1' }))
      await backend.capture(batch({ messages: [] }))
      const stats = await backend.stats()
      expect(stats.recentSessions[0]).toMatchObject({ sessionId: 'sess-1', title: 'Deploy talk', messages: 3 })
      expect(await memory.loadSessionSettings('sess-1')).toEqual({ cwd: '/work/acmeapp' })
      await backend.capture(batch({ messages: [], title: 'Renamed' }))
      expect((await backend.stats()).recentSessions[0].title).toBe('Renamed')
    })

    it('stores timestamps in UTC, caps oversized text and records that it did', async () => {
      const big = 'x'.repeat(20000)
      await backend.capture(
        batch({ messages: [{ event_id: 'big', role: 'user', content: big, created_at: '2026-10-04T10:00:00+02:00' }] }),
      )
      const { messages } = await backend.browse({})
      expect(messages[0].createdAt).toBe('2026-10-04T08:00:00.000Z')
      expect(messages[0].content).toHaveLength(16000)
      const full = String(await tool('memory_get_full').execute({ id: messages[0].id }))
      expect(full).toMatch(/stored text was truncated at capture/)
    })

    it('queues captured messages for embedding when an endpoint is configured', async () => {
      memory.close()
      const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as { input: string[] }
        return Response.json({ data: body.input.map((_t, index) => ({ index, embedding: [1, 0, 0] })) })
      }) as unknown as typeof globalThis.fetch
      memory = new SqliteMemory({
        path: ':memory:',
        workers: false,
        log: () => {},
        embed: { endpoint: 'https://embed.test', model: 'toy', fetch, sleep: noWait },
      })
      backend = memory.backend()
      await backend.capture(batch())
      expect((await backend.stats()).embedQueueDepth).toBe(3)
      await memory.runJobs()
      const stats = await backend.stats()
      expect(stats.embedQueueDepth).toBe(0)
      expect(stats.embeddedMessages).toBe(3)
      const health = await backend.health()
      // This store was opened without the job loop: its queues are not being drained.
      expect(health).toMatchObject({ status: 'ok', embeddings: { status: 'ok' }, queueStatus: 'unavailable' })
    })
  })

  describe('search and browse', () => {
    beforeEach(async () => {
      await backend.capture(batch())
      await backend.capture(
        batch({
          session_key: 'sess-2',
          agent: 'other',
          messages: [{ event_id: 'o1', role: 'user', content: 'notes about the staging database migration' }],
        }),
      )
    })

    it('returns hits with their conversation, session and tags, and says ranking is keyword-only', async () => {
      await memory.tags().add({ entityType: 'conversation', sessionKey: 'sess-1', tag: 'project:acmeapp' }, 'owner')
      const res = await backend.search('deploy', { scope: 'both', limit: 10 })
      expect(res.degraded).toEqual({
        reason: 'embedding endpoint not configured',
        effect: 'Keyword / FTS ranking only — not meaning-based.',
      })
      expect(res.results.length).toBeGreaterThanOrEqual(2)
      for (const hit of res.results) {
        expect(hit).toMatchObject({ source: 'message', sessionId: 'sess-1', tags: ['project:acmeapp'] })
        expect(hit.conversationId).toMatch(/^[0-9a-f-]{36}$/)
      }
    })

    it('a tag filter keeps only hits from conversations carrying the tag', async () => {
      await memory.tags().add({ entityType: 'conversation', sessionKey: 'sess-2', tag: 'project:infra' }, 'owner')
      const all = await backend.search('staging', { scope: 'messages', limit: 10 })
      expect(new Set(all.results.map((h) => h.sessionId))).toEqual(new Set(['sess-1', 'sess-2']))
      const tagged = await backend.search('staging', { scope: 'messages', limit: 10, tag: 'project:infra' })
      expect(tagged.results.map((h) => h.sessionId)).toEqual(['sess-2'])
      expect((await backend.search('staging', { scope: 'messages', limit: 10, tag: 'project:none' })).results).toEqual([])
      await expect(backend.search('staging', { scope: 'messages', limit: 10, tag: 'nocolon' })).rejects.toBeInstanceOf(
        MemoryRequestError,
      )
    })

    it('a tag filter still finds tagged hits ranked below many untagged ones', async () => {
      // 40 untagged conversations that match better than the one tagged match.
      for (let i = 0; i < 40; i += 1) {
        await backend.capture(
          batch({
            session_key: `noise-${String(i)}`,
            messages: [{ event_id: 'n', role: 'user', content: 'rollback rollback rollback procedure notes' }],
          }),
        )
      }
      await backend.capture(
        batch({
          session_key: 'tagged',
          messages: [
            {
              event_id: 't',
              role: 'user',
              content: 'a long note that mentions the rollback only once among many other unrelated words here',
            },
          ],
        }),
      )
      await memory.tags().add({ entityType: 'conversation', sessionKey: 'tagged', tag: 'project:rare' }, 'owner')
      const res = await backend.search('rollback', { scope: 'messages', limit: 2, tag: 'project:rare' })
      expect(res.results.map((h) => h.sessionId)).toEqual(['tagged'])
    })

    it('browses newest first with role, agent, tool, tag and time filters', async () => {
      const all = await backend.browse({})
      expect(all.messages).toHaveLength(4)
      expect((await backend.browse({ agent: 'other' })).messages.map((m) => m.sessionId)).toEqual(['sess-2'])
      expect((await backend.browse({ toolName: 'Bash' })).messages.map((m) => m.role)).toEqual(['tool'])
      expect((await backend.browse({ role: 'assistant' })).messages).toHaveLength(1)
      expect((await backend.browse({ before: '2026-10-04T09:00:00Z' })).messages.map((m) => m.role)).toEqual([
        'assistant',
      ])
      expect((await backend.browse({ limit: 2 })).messages).toHaveLength(2)
      await expect(backend.browse({ window: 'someday' })).rejects.toBeInstanceOf(MemoryRequestError)
      await expect(backend.browse({ since: 'not a date' })).rejects.toBeInstanceOf(MemoryRequestError)
    })
  })

  it('stats and health describe the store', async () => {
    await backend.capture(batch())
    const stats = await backend.stats()
    expect(stats).toMatchObject({
      conversations: 1,
      messages: 3,
      toolCalls: 1,
      summaries: 0,
      embedQueueDepth: 0,
      embeddedMessages: 0,
      failedEmbeddings: 0,
      topTools: [{ tool: 'Bash', count: 1 }],
    })
    expect((await backend.stats('nobody')).messages).toBe(0)
    const health = await backend.health()
    expect(health.status).toBe('degraded')
    expect(health.embeddings).toMatchObject({ status: 'unavailable', error: 'embedding endpoint not configured' })
    // Three unsummarized messages in a fresh session: below the batch floor.
    expect(health.compaction).toEqual({ eligible: 0, activeTail: 0, belowFloor: 3 })
  })

  it('health is degraded while an embedding keeps failing', async () => {
    memory.close()
    const fetch = vi.fn(async () => new Response('no', { status: 400 })) as unknown as typeof globalThis.fetch
    let clock = new Date('2026-10-04T12:00:00Z')
    memory = new SqliteMemory({
      path: ':memory:',
      workers: false,
      log: () => {},
      now: () => clock,
      embed: { endpoint: 'https://embed.test', model: 'toy', fetch, sleep: noWait, maxRetries: 0 },
    })
    backend = memory.backend()
    await backend.capture(batch({ messages: [batch().messages[0]] }))
    for (let i = 0; i < 6; i += 1) {
      await memory.runJobs()
      clock = new Date(clock.getTime() + 60 * 60_000)
    }
    const health = await backend.health()
    expect(health.embeddings.status).toBe('ok')
    expect(health.failedEmbeddings).toBe(1)
    expect(health.status).toBe('degraded')
  })

  describe('tags', () => {
    it('adds, lists, counts, decides and looks up through the backend', async () => {
      await backend.capture(batch())
      const tags = backend.tags()
      const tag = await tags.add({ entityType: 'conversation', sessionKey: 'sess-1', tag: 'project:acmeapp' }, 'owner')
      expect(tag).toMatchObject({ key: 'project', value: 'acmeapp', state: 'accepted' })
      expect(await tags.list({ key: 'project' })).toHaveLength(1)
      expect(await tags.counts(undefined, 10)).toEqual([
        { key: 'project', value: 'acmeapp', display: 'acmeapp', conversations: 1 },
      ])
      expect(await tags.decide([tag.id], 'rejected', 'owner')).toEqual([tag.id])
      expect(await tags.pending(10)).toEqual([])
      expect((await tags.forSessionKeys(['sess-1'], ['rejected'])).get('sess-1')).toHaveLength(1)
      expect(await tags.taxonomy({})).toEqual([])
      // The vocabulary is editable through the backend.
      const entry = await tags.upsertTaxonomy?.({ key: 'project', value: 'Acme App', display: 'Acme App' })
      expect(entry).toMatchObject({ key: 'project', value: 'acme-app', state: 'accepted' })
      expect(await tags.taxonomy({ key: 'project' })).toHaveLength(1)
    })
  })

  describe('tools', () => {
    beforeEach(async () => {
      await backend.capture(batch())
    })

    it('offers the seven memory tools; the agent gets the read ones', () => {
      expect(backend.tools().map((t) => t.name)).toEqual([
        'memory_search',
        'memory_browse',
        'memory_stats',
        'memory_get_full',
        'memory_tags',
        'memory_append',
        'memory_ingest_session',
      ])
      expect(backend.readTools().map((t) => t.name)).toEqual([
        'memory_search',
        'memory_browse',
        'memory_stats',
        'memory_get_full',
        'memory_tags',
      ])
    })

    it('the agent\'s tags tool reads but cannot add or decide', async () => {
      const agentTags = backend.readTools().find((t) => t.name === 'memory_tags')
      const add = { action: 'add', entity_type: 'conversation', session_key: 'sess-1', tag: 'project:acmeapp' }
      expect(String(await agentTags?.execute(add))).toMatch(/not available to the agent/)
      expect(String(await agentTags?.execute({ action: 'decide', ids: ['x'], state: 'accepted' }))).toMatch(
        /not available to the agent/,
      )
      expect(await memory.tags().list({})).toEqual([])
      expect(JSON.parse(String(await agentTags?.execute({ action: 'list' }))) as object).toEqual({ tags: [] })
      // The vocabulary is not the agent's to edit either.
      for (const action of ['taxonomy_upsert', 'taxonomy_decide', 'taxonomy_merge']) {
        expect(
          String(await agentTags?.execute({ action, key: 'project', value: 'x', from: 'a', into: 'b' })),
        ).toMatch(/not available to the agent/)
      }
      expect(memory.vocabulary().list({ states: ['suggested', 'accepted', 'rejected'] })).toEqual([])
      expect(JSON.parse(String(await agentTags?.execute({ action: 'taxonomy' }))) as object).toEqual({
        entries: [],
      })
    })

    it('memory_search lists hits with ids, and memory_get_full returns the record behind one', async () => {
      const out = String(await tool('memory_search').execute({ query: 'deploy', limit: 5 }))
      expect(out).toMatch(/^⚠ embedding endpoint not configured/)
      const id = /id=([0-9a-f-]{36})/.exec(out)?.[1]
      expect(id).toBeDefined()
      const full = String(await tool('memory_get_full').execute({ id }))
      expect(full).toMatch(/^Message /)
      expect(full).toMatch(/session sess-1/)
      expect(String(await tool('memory_get_full').execute({ id: 'nope' }))).toMatch(/No message or summary/)
      expect(String(await tool('memory_search').execute({}))).toBe('Error: query is required')
      expect(String(await tool('memory_search').execute({ query: 'zzzzqqq' }))).toMatch(/No results/)
    })

    it('memory_browse and memory_stats report in text', async () => {
      // Defaults match the Postgres tool: newest first, tool traffic left out.
      const browse = String(await tool('memory_browse').execute({}))
      expect(browse).toMatch(/rivet\/user/)
      expect(browse).not.toMatch(/Bash/)
      expect(browse.indexOf('rivet/assistant')).toBeGreaterThan(browse.indexOf('rivet/user'))
      expect(String(await tool('memory_browse').execute({ include_tools: true }))).toMatch(/Bash/)
      // A bad filter is answered in text, not thrown.
      expect(String(await tool('memory_browse').execute({ window: 'someday' }))).toMatch(/^Error: /)
      expect(String(await tool('memory_search').execute({ query: 'deploy', tag: 'nocolon' }))).toBe(
        'Error: tag must be key:value',
      )
      const stats = String(await tool('memory_stats').execute({}))
      expect(stats).toMatch(/Backend: sqlite/)
      expect(stats).toMatch(/Messages: 3 \(0 embedded, 1 tool calls\)/)
      expect(stats).toMatch(/Summarization: off/)
    })

    it('memory_append answers in the Postgres shape, is idempotent, and refuses what Postgres refuses', async () => {
      const append = tool('memory_append')
      const args = { session_id: 'mcp-1', role: 'user', content: 'remember the release checklist', source: 'cli' }
      const first = JSON.parse(String(await append.execute(args))) as Record<string, unknown>
      expect(first).toMatchObject({ session_id: 'mcp-1', source: 'cli', agent: 'mcp', channel: 'mcp' })
      expect(first.id).toMatch(/^[0-9a-f-]{36}$/)
      expect(first.event_id).toMatch(/^[0-9a-f]{64}$/)
      const again = JSON.parse(String(await append.execute(args))) as Record<string, unknown>
      expect(again).toMatchObject({ skipped: true, id: first.id, event_id: first.event_id })
      // An explicit event id is the identity.
      const keyed = JSON.parse(String(await append.execute({ ...args, content: 'other', event_id: 'evt-9' }))) as {
        event_id: string
      }
      expect(keyed.event_id).toBe('evt-9')
      await expect(append.execute({ ...args, role: 'robot' })).rejects.toThrow(/role must be/)
      await expect(append.execute({ ...args, content: '' })).rejects.toThrow(/content is required/)
      await expect(append.execute({ ...args, session_id: '  ' })).rejects.toThrow(/session_id is required/)
      // A tool-call message may have no content.
      const call = JSON.parse(
        String(await append.execute({ session_id: 'mcp-1', role: 'assistant', content: '', tool_name: 'Bash' })),
      ) as { id: string }
      expect(call.id).toBeDefined()
      // Oversized text is cut with a marker and reported.
      const big = JSON.parse(
        String(await append.execute({ session_id: 'mcp-1', role: 'user', content: 'y'.repeat(17000) })),
      ) as { truncated: boolean; full_content_length: number; id: string }
      expect(big).toMatchObject({ truncated: true, full_content_length: 17000 })
      expect(String(await tool('memory_get_full').execute({ id: big.id }))).toMatch(/…\[truncated\]/)
    })

    it('memory_ingest_session answers in the Postgres shape and stores tool calls as tool rows', async () => {
      const ingest = tool('memory_ingest_session')
      const messages = [
        { role: 'user', content: 'same line' },
        { role: 'user', content: 'same line' },
        { role: 'assistant', content: '', tool_calls: [{ id: 't1', name: 'Bash', input: { command: 'ls' } }] },
        { role: 'assistant', content: 'noted twice', created_at: '2026-10-04T10:00:00Z' },
        { role: 'user', content: '' },
        { role: 'user', content: 'bad stamp', created_at: 'whenever' },
      ]
      const first = JSON.parse(String(await ingest.execute({ session_id: 'mcp-2', messages }))) as {
        ingested: number
        skipped: number
        ids: string[]
        session_id: string
        agent: string
      }
      expect(first).toMatchObject({ session_id: 'mcp-2', ingested: 4, skipped: 2, agent: 'mcp', source: 'mcp' })
      expect(first.ids).toHaveLength(4)
      const second = JSON.parse(String(await ingest.execute({ session_id: 'mcp-2', messages }))) as {
        ingested: number
        skipped: number
      }
      expect(second).toMatchObject({ ingested: 0, skipped: 6 })
      expect((await backend.browse({ toolName: 'Bash', agent: 'mcp' })).messages).toHaveLength(1)
      // The same line with a different tool name is a different event.
      const renamed = messages.map((m) =>
        m.tool_calls ? { ...m, tool_calls: [{ id: 't1', name: 'Read', input: {} }] } : m,
      )
      const third = JSON.parse(String(await ingest.execute({ session_id: 'mcp-2', messages: renamed }))) as {
        ingested: number
      }
      expect(third.ingested).toBe(1)
      await expect(ingest.execute({ session_id: 'mcp-2', messages: [] })).rejects.toThrow(/non-empty/)
      await expect(ingest.execute({ session_id: 'mcp-2', messages: [{ role: 'robot', content: 'x' }] })).rejects.toThrow(
        /role is invalid/,
      )
    })

    it('write tools take their attribution from the harness variables when no argument names it', async () => {
      const prior = { ...process.env }
      process.env.RIVETOS_MEMORY_AGENT = 'deskagent'
      process.env.RIVETOS_MEMORY_SOURCE = 'harness'
      process.env.RIVETOS_MEMORY_PERSONA = 'reviewer'
      try {
        const out = JSON.parse(
          String(await tool('memory_append').execute({ session_id: 'env-1', role: 'user', content: 'attributed by env' })),
        ) as Record<string, unknown>
        expect(out).toMatchObject({ agent: 'deskagent', source: 'harness', persona: 'reviewer', channel: 'mcp' })
        const explicit = JSON.parse(
          String(
            await tool('memory_append').execute({ session_id: 'env-1', role: 'user', content: 'named', agent: 'other' }),
          ),
        ) as Record<string, unknown>
        expect(explicit.agent).toBe('other')
      } finally {
        for (const k of ['RIVETOS_MEMORY_AGENT', 'RIVETOS_MEMORY_SOURCE', 'RIVETOS_MEMORY_PERSONA']) {
          if (prior[k] === undefined) delete process.env[k]
          else process.env[k] = prior[k]
        }
      }
    })

    it('the HTTP memory_tags tool reads and writes tags and validates vocabulary edits', async () => {
      const tags = tool('memory_tags')
      const added = JSON.parse(
        String(await tags.execute({ action: 'add', entity_type: 'conversation', session_key: 'sess-1', tag: 'project:acmeapp' })),
      ) as { tag: { id: string } }
      const listed = JSON.parse(String(await tags.execute({ action: 'list', key: 'project' }))) as { tags: unknown[] }
      expect(listed.tags).toHaveLength(1)
      const decided = JSON.parse(
        String(await tags.execute({ action: 'decide', ids: [added.tag.id], state: 'rejected' })),
      ) as { changed: string[] }
      expect(decided.changed).toEqual([added.tag.id])
      expect(String(await tags.execute({ action: 'taxonomy_merge', key: 'k', from: 'a', into: 'b' }))).toMatch(
        /^Error: invalid merge: k:a is not in the vocabulary or in use/,
      )
      expect(String(await tags.execute({ action: 'bogus' }))).toMatch(/does not support action "bogus"/)
      // The default action is the review queue, as on Postgres.
      expect(JSON.parse(String(await tags.execute({}))) as object).toEqual({ tags: [] })
      // More ids than the route accepts is an error, not a silent cut.
      const many = Array.from({ length: 1001 }, () => added.tag.id)
      expect(String(await tags.execute({ action: 'decide', ids: many, state: 'accepted' }))).toBe(
        'Error: at most 1000 ids',
      )
    })
  })

  it('refuses work after the store is closed', async () => {
    const closed = new SqliteMemory({ path: ':memory:', log: () => {} })
    const b = closed.backend()
    closed.close()
    await expect(b.stats()).rejects.toThrow(/closed/)
    await expect(b.capture(batch())).rejects.toThrow(/closed/)
  })
})
