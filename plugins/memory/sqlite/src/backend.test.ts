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
      expect(health).toMatchObject({ status: 'ok', embeddings: { status: 'ok' }, queueStatus: 'available' })
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
      // Vocabulary edits are not offered here: the route answers 501.
      expect(tags.upsertTaxonomy).toBeUndefined()
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
      const browse = String(await tool('memory_browse').execute({ include_tools: false }))
      expect(browse).toMatch(/rivet\/user/)
      expect(browse).not.toMatch(/Bash/)
      const stats = String(await tool('memory_stats').execute({}))
      expect(stats).toMatch(/Backend: sqlite/)
      expect(stats).toMatch(/Messages: 3 \(0 embedded, 1 tool calls\)/)
      expect(stats).toMatch(/Summarization: off/)
    })

    it('memory_append and memory_ingest_session write idempotently', async () => {
      const append = tool('memory_append')
      const args = { session_id: 'mcp-1', role: 'user', content: 'remember the release checklist', source: 'cli' }
      expect(JSON.parse(String(await append.execute(args)))).toMatchObject({ ok: true, inserted: 1 })
      expect(JSON.parse(String(await append.execute(args)))).toMatchObject({ inserted: 0, skipped: 1 })
      expect(String(await append.execute({ ...args, role: 'robot' }))).toMatch(/^Error: role/)

      const ingest = tool('memory_ingest_session')
      const messages = [
        { role: 'user', content: 'same line' },
        { role: 'user', content: 'same line' },
        { role: 'assistant', content: 'noted twice', created_at: '2026-10-04T10:00:00Z' },
      ]
      const first = JSON.parse(String(await ingest.execute({ session_id: 'mcp-2', messages }))) as { inserted: number }
      expect(first.inserted).toBe(3)
      const second = JSON.parse(String(await ingest.execute({ session_id: 'mcp-2', messages }))) as { skipped: number }
      expect(second.skipped).toBe(3)
      expect(String(await ingest.execute({ session_id: 'mcp-2', messages: [{ role: 'user' }] }))).toMatch(/^Error/)
    })

    it('memory_tags reads and writes tags and refuses vocabulary edits', async () => {
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
        /does not support action "taxonomy_merge"/,
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
