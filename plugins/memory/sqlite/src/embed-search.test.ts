/**
 * Embedding drain + hybrid search, end to end against a real file-less
 * database and a fake embedding endpoint.
 */

import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SqliteMemory } from './adapter.js'
import { EmbedClient } from './embed.js'
import { SCHEMA_VERSION } from './schema.js'

/** A toy embedding: one dimension per topic word, so similar text is close. */
const TOPICS = ['database', 'postgres', 'sqlite', 'kitchen', 'recipe', 'garden']
function toyVector(text: string): number[] {
  const lower = text.toLowerCase()
  const v = TOPICS.map((t) => (lower.includes(t) ? 1 : 0))
  // Synonym the full-text arm cannot see.
  if (lower.includes('datastore')) v[0] = 1
  return v.some((x) => x > 0) ? v : [0.01, 0.01, 0.01, 0.01, 0.01, 0.01]
}

function fakeEndpoint(opts: { fail?: () => boolean; dims?: number } = {}) {
  const calls: Array<{ url: string; input: string[]; auth: string | null }> = []
  const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { input: string[] }
    const headers = new Headers(init?.headers)
    calls.push({ url: String(url), input: body.input, auth: headers.get('authorization') })
    if (opts.fail?.()) return new Response('overloaded', { status: 503 })
    return Response.json({
      data: body.input.map((text, index) => ({
        index,
        embedding: opts.dims ? Array.from({ length: opts.dims }, () => 1) : toyVector(text),
      })),
    })
  })
  return { fetch: fetch as unknown as typeof globalThis.fetch, calls }
}

async function add(memory: SqliteMemory, content: string, agent = 'rivet'): Promise<string> {
  return memory.append({ sessionId: 's1', agent, channel: 'cli', role: 'user', content })
}

describe('embedding drain', () => {
  let memory: SqliteMemory
  afterEach(() => {
    memory.close()
  })

  it('embeds queued messages, stores unit vectors, and marks what is not worth embedding', async () => {
    const endpoint = fakeEndpoint()
    memory = new SqliteMemory({
      path: ':memory:',
      workers: false,
      embed: { endpoint: 'https://embed.test', model: 'toy', apiKey: 'k', fetch: endpoint.fetch },
    })
    const a = await add(memory, 'postgres database tuning')
    const blob = await add(memory, `iVBORw0KGgo${'A'.repeat(400)}`)
    expect(memory.hasEmbedQueueEntryForTest(a)).toBe(true)
    expect(await memory.runJobs()).toBe(2)
    expect(memory.jobs().counts()).toEqual([])
    expect(endpoint.calls).toHaveLength(1)
    expect(endpoint.calls[0]).toMatchObject({
      url: 'https://embed.test/v1/embeddings',
      input: ['postgres database tuning'],
      auth: 'Bearer k',
    })
    const rows = memory.embedStateForTest([a, blob])
    expect(rows[a]).toMatchObject({ status: 'done', error: null, dims: TOPICS.length })
    expect(rows[blob]).toMatchObject({ status: 'unembeddable', dims: 0 })
    expect(rows[blob].error).toMatch(/unembeddable: base64-png/)
  })

  it('a failing endpoint leaves the job queued with a recorded error, and never fails the append', async () => {
    let down = true
    const endpoint = fakeEndpoint({ fail: () => down })
    const logs: string[] = []
    memory = new SqliteMemory({
      path: ':memory:',
      workers: false,
      log: (l) => logs.push(l),
      embed: { endpoint: 'https://embed.test', model: 'toy', fetch: endpoint.fetch },
    })
    const id = await add(memory, 'sqlite database')
    expect(await memory.runJobs()).toBe(1)
    expect(memory.jobs().counts()).toEqual([{ task: 'embed-target', state: 'queued', count: 1 }])
    expect(memory.embedStateForTest([id])[id]).toMatchObject({ status: null, error: 'embed HTTP 503' })
    expect(logs.join('\n')).toMatch(/embed-target .* failed \(attempt 1\/5, retry\): embed HTTP 503/)
    down = false
    // Not due yet (retry delay), so nothing runs; requeueing dead work is separate.
    expect(await memory.runJobs()).toBe(0)
  })

  it('without an endpoint the work stays queued and search is full-text only', async () => {
    memory = new SqliteMemory({ path: ':memory:' })
    const id = await add(memory, 'postgres database tuning')
    expect(memory.hasEmbedQueueEntryForTest(id)).toBe(true)
    expect((await memory.search('postgres')).map((r) => r.id)).toEqual([id])
    expect(await memory.search('datastore')).toEqual([])
  })

  it('rejects a vector of an unexpected width instead of storing it', async () => {
    const endpoint = fakeEndpoint({ dims: 8 })
    const client = new EmbedClient({
      endpoint: 'https://embed.test',
      model: 'toy',
      expectedDims: 6,
      fetch: endpoint.fetch,
    })
    await expect(client.embed(['x'])).rejects.toThrow(/has 8 dimensions, expected 6/)
  })

  it('long text is chunked and pooled into one vector', async () => {
    const endpoint = fakeEndpoint()
    const client = new EmbedClient({
      endpoint: 'https://embed.test',
      model: 'toy',
      charsPerChunk: 40,
      fetch: endpoint.fetch,
    })
    const out = await client.embedMessage(`${'database '.repeat(6)}${'kitchen '.repeat(6)}`, null)
    expect(endpoint.calls[0].input.length).toBeGreaterThan(1)
    expect(out.kind).toBe('vector')
    if (out.kind === 'vector') {
      expect(out.vector[TOPICS.indexOf('database')]).toBeGreaterThan(0)
      expect(out.vector[TOPICS.indexOf('kitchen')]).toBeGreaterThan(0)
    }
  })

  it('caches a repeated query embedding', async () => {
    const endpoint = fakeEndpoint()
    const client = new EmbedClient({
      endpoint: 'https://embed.test',
      model: 'toy',
      queryInstruction: 'query: ',
      fetch: endpoint.fetch,
    })
    await client.embedQuery('postgres')
    await client.embedQuery('postgres')
    expect(endpoint.calls).toHaveLength(1)
    expect(endpoint.calls[0].input).toEqual(['query: postgres'])
  })
})

describe('hybrid search', () => {
  let memory: SqliteMemory
  let ids: Record<string, string>
  let endpoint: ReturnType<typeof fakeEndpoint>

  beforeEach(async () => {
    endpoint = fakeEndpoint()
    memory = new SqliteMemory({
      path: ':memory:',
      workers: false,
      embed: { endpoint: 'https://embed.test', model: 'toy', fetch: endpoint.fetch },
    })
    ids = {
      pg: await add(memory, 'postgres database tuning notes from the long migration weekend'),
      lite: await add(memory, 'sqlite database file living on a laptop, written by one process'),
      food: await add(memory, 'a kitchen recipe for a slow soup that takes the whole afternoon'),
      plants: await add(memory, 'garden plan for the coming spring, beds and seeds', 'other'),
      host: await add(memory, 'the box at 192.0.2.7:5174 answers slowly when it is busy'),
      short: await add(memory, 'database ok'),
    }
    while ((await memory.runJobs()) > 0) {
      // drain
    }
  })
  afterEach(() => {
    memory.close()
  })

  it('finds by meaning what full-text alone cannot', async () => {
    // "datastore" appears in no message; the vector arm maps it to database.
    // There is no similarity floor (as on Postgres): the nearest rows lead.
    const hits = await memory.search('datastore', { limit: 2 })
    expect(hits.map((h) => h.id).sort()).toEqual([ids.pg, ids.lite].sort())
    expect(hits[0].relevanceScore).toBeGreaterThan(0)
  })

  it('applies the quality floor: a one-liner is not a full-text or vector candidate', async () => {
    const hits = await memory.search('database', { limit: 10 })
    expect(hits.map((h) => h.id)).not.toContain(ids.short)
    expect(hits.map((h) => h.id)).toEqual(expect.arrayContaining([ids.pg, ids.lite]))
  })

  it('ranks a hit found by two arms above one found by a single arm', async () => {
    const hits = await memory.search('postgres database')
    expect(hits[0].id).toBe(ids.pg)
    expect(hits.map((h) => h.id)).not.toContain(ids.food)
  })

  it('a literal-looking query uses the substring arm', async () => {
    const hits = await memory.search('192.0.2.7:5174')
    expect(hits[0].id).toBe(ids.host)
  })

  it('respects the agent filter in every arm', async () => {
    expect((await memory.search('garden', { agent: 'rivet' })).map((h) => h.id)).not.toContain(ids.plants)
    expect((await memory.search('garden', { agent: 'other' })).map((h) => h.id)).toEqual([ids.plants])
  })

  it('falls back to the other arms when the query embedding fails', async () => {
    const logs: string[] = []
    const failing = fakeEndpoint({ fail: () => true })
    const m = new SqliteMemory({
      path: ':memory:',
      workers: false,
      log: (l) => logs.push(l),
      embed: { endpoint: 'https://embed.test', model: 'toy', fetch: failing.fetch },
    })
    const id = await m.append({ sessionId: 's', agent: 'rivet', channel: 'cli', role: 'user', content: 'postgres notes that are long enough to pass the quality floor' })
    expect((await m.search('postgres')).map((h) => h.id)).toEqual([id])
    expect(logs.join('\n')).toMatch(/query embedding failed, searching without the vector arm/)
    m.close()
  })

  it('scope summaries is still empty, and the limit is honoured', async () => {
    expect(await memory.search('database', { scope: 'summaries' })).toEqual([])
    expect(await memory.search('database', { limit: 1 })).toHaveLength(1)
  })
})

describe('schema v3 on an existing file', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rivet-sqlite-v3-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('adds the vector columns, moves the phase-1 queue into jobs, and re-embeds when the model changes', async () => {
    const path = join(dir, 'memory.sqlite')
    // A v2 file: the old ros_messages shape and a row waiting in the old queue.
    const old = new DatabaseSync(path)
    old.exec(`
      CREATE TABLE ros_conversations (id TEXT PRIMARY KEY, session_key TEXT NOT NULL, agent TEXT NOT NULL,
        channel TEXT NOT NULL DEFAULT 'unknown', channel_id TEXT, bot_identity TEXT, title TEXT,
        settings TEXT NOT NULL DEFAULT '{}', active INTEGER NOT NULL DEFAULT 1, task_id TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE UNIQUE INDEX ux_ros_conversations_session_agent ON ros_conversations (session_key, agent);
      CREATE TABLE ros_messages (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, agent TEXT NOT NULL,
        channel TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL DEFAULT '', tool_name TEXT,
        tool_args TEXT, tool_result TEXT, metadata TEXT NOT NULL DEFAULT '{}',
        access_count INTEGER NOT NULL DEFAULT 0, last_accessed_at TEXT, created_at TEXT NOT NULL,
        embed_status TEXT);
      CREATE TABLE ros_embed_queue (id TEXT PRIMARY KEY, message_id TEXT NOT NULL UNIQUE,
        enqueued_at TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT);
      INSERT INTO ros_conversations (id, session_key, agent, created_at, updated_at)
        VALUES ('c1', 's1', 'rivet', '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z');
      INSERT INTO ros_messages (id, conversation_id, agent, channel, role, content, created_at)
        VALUES ('m1', 'c1', 'rivet', 'cli', 'user', 'postgres database notes kept from the old phase one file', '2026-10-01T00:00:00Z');
      INSERT INTO ros_embed_queue (id, message_id, enqueued_at) VALUES ('q1', 'm1', '2026-10-01T00:00:00Z');
      PRAGMA user_version = 2;
    `)
    old.close()

    const endpoint = fakeEndpoint()
    const embed = { endpoint: 'https://embed.test', model: 'toy', fetch: endpoint.fetch }
    let memory = new SqliteMemory({ path, workers: false, embed })
    expect(memory.schemaVersionForTest()).toBe(SCHEMA_VERSION)
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(3)
    expect(memory.hasEmbedQueueEntryForTest('m1')).toBe(true)
    expect(await memory.runJobs()).toBe(1)
    expect(memory.embedStateForTest(['m1']).m1).toMatchObject({ status: 'done', dims: TOPICS.length })
    // The FTS table did not exist in this hand-made v2 file; search still answers by vector.
    expect((await memory.search('datastore')).map((h) => h.id)).toEqual(['m1'])
    memory.close()

    // Same file, a different embedding model: the old vectors are dropped and queued again.
    const logs: string[] = []
    memory = new SqliteMemory({
      path,
      workers: false,
      log: (l) => logs.push(l),
      embed: { ...embed, model: 'toy-v2' },
    })
    expect(logs.join('\n')).toMatch(/embedding model changed \(toy → toy-v2\)/)
    expect(memory.embedStateForTest(['m1']).m1).toMatchObject({ status: null, dims: 0 })
    // The first pass runs the unembedded-rows sweep, which queues it again.
    expect(await memory.runJobs()).toBe(1)
    expect(memory.embedStateForTest(['m1']).m1.status).toBe('done')
    memory.close()
  })
})
