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

const noWait = async (): Promise<void> => {}

function fakeEndpoint(opts: { fail?: () => boolean; dims?: number; status?: number; nullAt?: number } = {}) {
  const calls: Array<{ url: string; input: string[]; auth: string | null }> = []
  const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { input: string[] }
    const headers = new Headers(init?.headers)
    calls.push({ url: String(url), input: body.input, auth: headers.get('authorization') })
    if (opts.fail?.()) return new Response('overloaded', { status: opts.status ?? 503 })
    return Response.json({
      data: body.input.map((text, index) => ({
        index,
        embedding:
          index === opts.nullAt
            ? null
            : opts.dims
              ? Array.from({ length: opts.dims }, () => 1)
              : toyVector(text),
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
      embed: { endpoint: 'https://embed.test', model: 'toy', apiKey: 'k', fetch: endpoint.fetch, sleep: noWait },
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
      embed: { endpoint: 'https://embed.test', model: 'toy', fetch: endpoint.fetch, sleep: noWait },
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

  it('without an endpoint nothing is queued and search is full-text only; adding one later embeds what was written', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rivet-sqlite-later-'))
    const path = join(dir, 'memory.sqlite')
    try {
      memory = new SqliteMemory({ path })
      const id = await add(memory, 'postgres database tuning notes written before any endpoint')
      expect(memory.hasEmbedQueueEntryForTest(id)).toBe(false)
      expect((await memory.search('postgres')).map((r) => r.id)).toEqual([id])
      expect(await memory.search('datastore')).toEqual([])
      memory.close()
      // The same file, now with an endpoint: the sweep finds the unembedded row.
      const endpoint = fakeEndpoint()
      memory = new SqliteMemory({
        path,
        workers: false,
        embed: { endpoint: 'https://embed.test', model: 'toy', fetch: endpoint.fetch, sleep: noWait },
      })
      expect(await memory.runJobs()).toBe(1)
      expect(memory.embedStateForTest([id])[id].status).toBe('done')
      expect((await memory.search('datastore')).map((r) => r.id)).toEqual([id])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('a job that went dead during an outage is revived by the sweep and embeds once the endpoint is back', async () => {
    let down = true
    const endpoint = fakeEndpoint({ fail: () => down })
    let clock = new Date('2026-10-04T12:00:00Z')
    memory = new SqliteMemory({
      path: ':memory:',
      workers: false,
      log: () => {},
      now: () => clock,
      embed: { endpoint: 'https://embed.test', model: 'toy', fetch: endpoint.fetch, sleep: noWait },
    })
    const id = await add(memory, 'sqlite database written during the outage window')
    // Five attempts, each after its retry delay, all against a dead endpoint.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await memory.runJobs()
      clock = new Date(clock.getTime() + 2 * 60 * 60 * 1000)
    }
    expect(memory.jobs().counts()).toEqual([{ task: 'embed-target', state: 'dead', count: 1 }])
    expect(memory.embedStateForTest([id])[id].failures).toBe(5)
    // Endpoint recovers. The next sweep gives the dead job fresh attempts.
    down = false
    clock = new Date(clock.getTime() + 11 * 60 * 1000)
    expect(await memory.runJobs()).toBe(1)
    expect(memory.embedStateForTest([id])[id]).toMatchObject({ status: 'done', failures: 0 })
    expect(memory.jobs().counts()).toEqual([])
  })

  it('retries a 503 inside the call, and honours Retry-After on a 429', async () => {
    let failures = 2
    const endpoint = fakeEndpoint({ fail: () => failures-- > 0 })
    const waits: number[] = []
    const client = new EmbedClient({
      endpoint: 'https://embed.test',
      model: 'toy',
      fetch: endpoint.fetch,
      sleep: async (ms) => {
        waits.push(ms)
      },
    })
    expect(await client.embed(['postgres'])).toHaveLength(1)
    expect(endpoint.calls).toHaveLength(3)
    expect(waits).toEqual([1000, 2000])

    const limited = vi.fn(async () =>
      new Response('slow down', { status: 429, headers: { 'Retry-After': '3' } }),
    )
    const waits429: number[] = []
    const client429 = new EmbedClient({
      endpoint: 'https://embed.test',
      model: 'toy',
      maxRetries: 1,
      fetch: limited as unknown as typeof globalThis.fetch,
      sleep: async (ms) => {
        waits429.push(ms)
      },
    })
    await expect(client429.embed(['x'])).rejects.toThrow('embed HTTP 429')
    expect(waits429).toEqual([3000])
    // A 400 is not retried.
    const bad = fakeEndpoint({ fail: () => true, status: 400 })
    const client400 = new EmbedClient({ endpoint: 'https://embed.test', model: 'toy', fetch: bad.fetch, sleep: noWait })
    await expect(client400.embed(['x'])).rejects.toThrow('embed HTTP 400')
    expect(bad.calls).toHaveLength(1)
  })

  it('pools the chunks that embedded when one chunk comes back empty', async () => {
    const endpoint = fakeEndpoint({ nullAt: 0 })
    const client = new EmbedClient({
      endpoint: 'https://embed.test',
      model: 'toy',
      charsPerChunk: 40,
      fetch: endpoint.fetch,
      sleep: noWait,
    })
    const out = await client.embedMessage(`${'database '.repeat(6)}${'kitchen '.repeat(6)}`, null)
    expect(out.kind).toBe('vector')
    // A single-chunk message with no vector is a failure, not a silent skip.
    await expect(client.embedMessage('database', null)).rejects.toThrow(/no usable vector/)
  })

  it('one vector of another width fails its job and leaves the store alone; a configured width change re-embeds', async () => {
    let dims: number | undefined
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { input: string[] }
      return Response.json({
        data: body.input.map((text, index) => ({
          index,
          embedding: dims ? Array.from({ length: dims }, (_, d) => d + 1) : toyVector(text),
        })),
      })
    }) as unknown as typeof globalThis.fetch
    const dir = mkdtempSync(join(tmpdir(), 'rivet-sqlite-width-'))
    const path = join(dir, 'memory.sqlite')
    try {
      const logs: string[] = []
      memory = new SqliteMemory({
        path,
        workers: false,
        log: (l) => logs.push(l),
        embed: { endpoint: 'https://embed.test', model: 'toy', fetch, sleep: noWait },
      })
      const first = await add(memory, 'postgres database notes embedded at the first width')
      await memory.runJobs()
      expect(memory.embedStateForTest([first])[first].dims).toBe(TOPICS.length)
      // The endpoint returns an odd width once: nothing is wiped, the job fails.
      dims = 3
      const second = await add(memory, 'sqlite database notes that arrive at another width')
      await memory.runJobs()
      const state = memory.embedStateForTest([first, second])
      expect(state[first]).toMatchObject({ status: 'done', dims: TOPICS.length })
      expect(state[second].error).toMatch(/3 wide but the store holds 6-wide vectors; set embed_expected_dims to 3/)
      expect(logs.join('\n')).not.toMatch(/embedding width changed/)
      memory.close()

      // The operator confirms the new width: now the old vectors are re-embedded.
      memory = new SqliteMemory({
        path,
        workers: false,
        log: (l) => logs.push(l),
        embed: { endpoint: 'https://embed.test', model: 'toy', expectedDims: 3, fetch, sleep: noWait },
      })
      memory.jobs().requeueDead()
      const third = await add(memory, 'another sqlite database note, written after the change')
      await memory.runJobs()
      expect(logs.join('\n')).toMatch(/embedding width changed \(6 → 3\)/)
      expect(memory.embedStateForTest([first])[first]).toMatchObject({ status: null, dims: 0 })
      expect(memory.embedStateForTest([third])[third].dims).toBe(3)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('a store without a recorded width adopts the common one and re-queues the rest', async () => {
    const endpoint = fakeEndpoint()
    const dir = mkdtempSync(join(tmpdir(), 'rivet-sqlite-adopt-'))
    const path = join(dir, 'memory.sqlite')
    try {
      const embed = { endpoint: 'https://embed.test', model: 'toy', fetch: endpoint.fetch, sleep: noWait }
      memory = new SqliteMemory({ path, workers: false, embed })
      const a = await add(memory, 'postgres database notes, the first of the common width')
      const b = await add(memory, 'sqlite database notes, the second of the common width')
      const odd = await add(memory, 'a kitchen recipe stored with a stray narrower vector')
      await memory.runJobs()
      memory.close()
      // As an older build left it: no recorded width, one vector of another size.
      const raw = new DatabaseSync(path)
      raw.exec(`DELETE FROM ros_meta WHERE key = 'embed_dims'`)
      raw.prepare(`UPDATE ros_messages SET embedding = ? WHERE id = ?`).run(new Uint8Array(8), odd)
      raw.close()
      const logs: string[] = []
      memory = new SqliteMemory({ path, workers: false, log: (l) => logs.push(l), embed })
      expect(logs.join('\n')).toMatch(/1 stored vector\(s\) were not 6 wide and will be re-embedded/)
      const state = memory.embedStateForTest([a, b, odd])
      expect(state[a].dims).toBe(TOPICS.length)
      expect(state[b].dims).toBe(TOPICS.length)
      expect(state[odd]).toMatchObject({ status: null, dims: 0 })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('the live index and a reloaded one agree on rows at the quality floor', async () => {
    const endpoint = fakeEndpoint()
    const dir = mkdtempSync(join(tmpdir(), 'rivet-sqlite-floor-'))
    const path = join(dir, 'memory.sqlite')
    try {
      const embed = { endpoint: 'https://embed.test', model: 'toy', fetch: endpoint.fetch, sleep: noWait }
      memory = new SqliteMemory({ path, workers: false, embed })
      // Load the index first, so later vectors arrive through add().
      await memory.search('database')
      // 38 characters plus two newlines: SQLite's trim() strips spaces only, so
      // this row is past the floor in SQL although a JS trim would cut it.
      const trailing = await add(memory, `database ${'x'.repeat(29)}\n\n`)
      // 25 astral characters: 25 by SQLite's count, 50 UTF-16 units in JS.
      const astral = await add(memory, `database ${'\u{1F600}'.repeat(16)}`)
      await memory.runJobs()
      const live = (await memory.search('datastore', { limit: 10 })).map((h) => h.id).sort()
      memory.close()
      memory = new SqliteMemory({ path, workers: false, embed })
      const reloaded = (await memory.search('datastore', { limit: 10 })).map((h) => h.id).sort()
      expect(live).toEqual(reloaded)
      expect(live).toContain(trailing)
      expect(live).not.toContain(astral)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('normalizes a query and applies the default instruction, like the Postgres backend', async () => {
    const endpoint = fakeEndpoint()
    const client = new EmbedClient({ endpoint: 'https://embed.test', model: 'toy', fetch: endpoint.fetch, sleep: noWait })
    await client.embedQuery('  postgres   tuning ')
    await client.embedQuery('postgres tuning')
    expect(endpoint.calls).toHaveLength(1)
    expect(endpoint.calls[0].input[0]).toMatch(/^Instruct: .*\nQuery: postgres tuning$/)
  })

  it('rejects a vector of an unexpected width instead of storing it', async () => {
    const endpoint = fakeEndpoint({ dims: 8 })
    const client = new EmbedClient({
      endpoint: 'https://embed.test',
      model: 'toy',
      expectedDims: 6,
      fetch: endpoint.fetch,
      sleep: noWait,
    })
    await expect(client.embed(['x'])).rejects.toThrow(/embedding 0 is missing or not the expected width \(expected 6\)/)
  })

  it('long text is chunked and pooled into one vector', async () => {
    const endpoint = fakeEndpoint()
    const client = new EmbedClient({
      endpoint: 'https://embed.test',
      model: 'toy',
      charsPerChunk: 40,
      fetch: endpoint.fetch,
      sleep: noWait,
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
      sleep: noWait,
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
      embed: { endpoint: 'https://embed.test', model: 'toy', fetch: endpoint.fetch, sleep: noWait },
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
      embed: { endpoint: 'https://embed.test', model: 'toy', fetch: failing.fetch, sleep: noWait },
    })
    const id = await m.append({ sessionId: 's', agent: 'rivet', channel: 'cli', role: 'user', content: 'postgres notes that are long enough to pass the quality floor' })
    expect((await m.search('postgres')).map((h) => h.id)).toEqual([id])
    expect(logs.join('\n')).toMatch(/query embedding failed, searching without the vector arm/)
    m.close()
  })

  it('reinforces returned rows: their access count rises', async () => {
    await memory.search('postgres database')
    await memory.search('postgres database')
    expect(memory.accessCountForTest(ids.pg)).toBe(2)
    expect(memory.accessCountForTest(ids.food)).toBe(0)
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
    const embed = { endpoint: 'https://embed.test', model: 'toy', fetch: endpoint.fetch, sleep: noWait }
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
