/**
 * M3b — chunk-level vector arm.
 *
 * Unit tests use a fake pg pool + stubbed fetch (no live Postgres/embedder).
 * The final describe is PG-gated on RIVETOS_MEMORY_TEST_PG_URL (a scratch DB — it
 * creates and drops a schema) and exercises the real chunk SQL end to end.
 */
import { afterEach, beforeAll, afterAll, describe, expect, it, vi } from 'vitest'
import pg from 'pg'
import { SearchEngine, mergeChunkAndParentCandidates, chunkArmErrorReason } from './search.js'
import type { SearchSnippet } from './search.js'
import {
  formatSearchMessageBody,
  formatSnippetBody,
  SEARCH_CONTENT_LIMIT,
  SEARCH_SNIPPET_LIMIT,
} from './tools/helpers.js'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const MSG_LONG = '00000000-0000-4000-8000-00000000000a'
const MSG_SHORT = '00000000-0000-4000-8000-00000000000b'
const CONV = '00000000-0000-4000-8000-0000000000c0'

/** A 12k-char message whose answer lives in chunk 3 (idx 2 of 7). */
const CHUNK3_TEXT =
  'The V100 NVFP4 cudagraph cap must never be lower than seqs x (K+1) — that was the degeneration.'
const LONG_CONTENT = `${'filler prose about unrelated deploys. '.repeat(300)}${CHUNK3_TEXT}${' more filler. '.repeat(300)}`

function parentRow(id: string, sim: string, content: string) {
  return {
    id,
    content,
    role: 'assistant',
    agent: 'rivet',
    conversation_id: CONV,
    created_at: new Date('2026-08-20T10:00:00.000Z'),
    boost: '0.10',
    metadata: null,
    tool_name: null,
    tool_result: null,
    semantic_sim: sim,
  }
}

function chunkRow(id: string, sim: string, opts?: { idx?: number; count?: string }) {
  return {
    ...parentRow(id, sim, LONG_CONTENT),
    chunk_content: CHUNK3_TEXT,
    chunk_char_start: 6000,
    chunk_char_end: 7024,
    chunk_idx: opts?.idx ?? 2,
    chunk_count: opts?.count ?? '7',
  }
}

interface FakeOpts {
  /** rows for the parent (ros_messages) vector SELECT */
  parentRows?: unknown[]
  /** rows for the FTS/trigram text arms (hybrid only; default none) */
  textRows?: unknown[]
  /** rows for the chunk CTE SELECT */
  chunkRows?: unknown[]
  /** value returned by the has_table_privilege probe (`granted`) */
  chunkPrivilege?: boolean
  /** `to_regclass` present; default true. False = pre-0014 DB (table absent). */
  chunkPresent?: boolean
  /** error thrown by the chunk SELECT (after a successful probe) */
  chunkThrow?: unknown
  /** error thrown by the probe itself */
  probeThrow?: unknown
  clientQueries?: string[]
}

function fakePool(opts: FakeOpts = {}): pg.Pool {
  const run = (sql: string): { rows: unknown[] } => {
    const text = sql.replace(/\s+/g, ' ').trim()
    if (
      text.includes('has_table_privilege') ||
      text.includes("to_regclass('ros_message_chunks')")
    ) {
      if (opts.probeThrow) throw opts.probeThrow
      return {
        rows: [
          {
            present: opts.chunkPresent ?? true,
            granted: opts.chunkPrivilege ?? true,
          },
        ],
      }
    }
    if (text.includes('ros_message_chunks c')) {
      if (opts.chunkThrow) throw opts.chunkThrow
      return { rows: opts.chunkRows ?? [] }
    }
    if (text.startsWith('UPDATE')) return { rows: [] }
    if (text.includes('ros_summaries')) return { rows: [] }
    if (text.includes('ros_messages m')) {
      // '<=>' distinguishes the parent vector arm from the FTS/trigram arms.
      return { rows: (text.includes('<=>') ? opts.parentRows : opts.textRows) ?? [] }
    }
    return { rows: [] }
  }
  return {
    query: (sql: string) => Promise.resolve(run(sql)),
    connect: () =>
      Promise.resolve({
        query: (sql: string) => {
          opts.clientQueries?.push(sql.replace(/\s+/g, ' ').trim())
          return Promise.resolve(run(sql))
        },
        release: () => undefined,
      }),
  } as unknown as pg.Pool
}

function stubEmbedOk(): void {
  vi.stubGlobal('fetch', () =>
    Promise.resolve(
      new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2, 0.3] }] }), { status: 200 }),
    ),
  )
}

function engine(pool: pg.Pool): SearchEngine {
  return new SearchEngine(pool, {
    embedEndpoint: 'http://127.0.0.1:9401',
    embedModel: 'Qwen3-Embedding-0.6B',
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

// ---------------------------------------------------------------------------
// Pure merge logic
// ---------------------------------------------------------------------------

const snip = (idx: number): SearchSnippet => ({
  text: CHUNK3_TEXT,
  charStart: 6000,
  charEnd: 7024,
  chunkIdx: idx,
  chunkCount: 7,
})

describe('mergeChunkAndParentCandidates', () => {
  it('takes the chunk similarity when it beats the parent, and attaches the snippet', () => {
    const { merged, chunkWins, parentWins } = mergeChunkAndParentCandidates(
      [{ id: MSG_LONG, sim: 0.41 }],
      [{ id: MSG_LONG, sim: 0.88, snippet: snip(2) }],
    )
    expect(merged).toHaveLength(1)
    expect(merged[0].sim).toBeCloseTo(0.88)
    expect(merged[0].snippet?.chunkIdx).toBe(2)
    expect(chunkWins).toBe(1)
    expect(parentWins).toBe(0)
  })

  it('keeps the parent similarity and no snippet when the parent matches better', () => {
    const { merged, chunkWins, parentWins } = mergeChunkAndParentCandidates(
      [{ id: MSG_LONG, sim: 0.9 }],
      [{ id: MSG_LONG, sim: 0.5, snippet: snip(2) }],
    )
    expect(merged[0].sim).toBeCloseTo(0.9)
    expect(merged[0].snippet).toBeUndefined()
    expect(chunkWins).toBe(0)
    expect(parentWins).toBe(1)
  })

  it('gives ties to the chunk (same score, strictly more information)', () => {
    const { merged, chunkWins } = mergeChunkAndParentCandidates(
      [{ id: MSG_LONG, sim: 0.7 }],
      [{ id: MSG_LONG, sim: 0.7, snippet: snip(4) }],
    )
    expect(merged[0].sim).toBeCloseTo(0.7)
    expect(merged[0].snippet?.chunkIdx).toBe(4)
    expect(chunkWins).toBe(1)
  })

  it('still returns parent-only rows (short messages, chunks not embedded yet)', () => {
    const { merged, parentWins } = mergeChunkAndParentCandidates(
      [
        { id: MSG_SHORT, sim: 0.6 },
        { id: MSG_LONG, sim: 0.2 },
      ],
      [],
    )
    expect(merged.map((m) => m.id)).toEqual([MSG_SHORT, MSG_LONG])
    expect(merged.every((m) => m.snippet === undefined)).toBe(true)
    expect(parentWins).toBe(2)
  })

  it('adds chunk-only messages the parent arm never returned', () => {
    const { merged, chunkWins } = mergeChunkAndParentCandidates(
      [{ id: MSG_SHORT, sim: 0.6 }],
      [{ id: MSG_LONG, sim: 0.95, snippet: snip(2) }],
    )
    expect(merged.map((m) => m.id)).toEqual([MSG_LONG, MSG_SHORT])
    expect(chunkWins).toBe(1)
  })

  it('orders the merged list by the winning similarity', () => {
    const { merged } = mergeChunkAndParentCandidates(
      [
        { id: 'a', sim: 0.5 },
        { id: 'b', sim: 0.4 },
        { id: 'c', sim: 0.3 },
      ],
      [{ id: 'c', sim: 0.99, snippet: snip(1) }],
    )
    expect(merged.map((m) => m.id)).toEqual(['c', 'a', 'b'])
  })

  it('counts arm wins after slice(0, limit), not the full merged pool', () => {
    const { merged, chunkWins, parentWins } = mergeChunkAndParentCandidates(
      [
        { id: 'a', sim: 0.9 },
        { id: 'b', sim: 0.5 },
        { id: 'c', sim: 0.1 },
      ],
      [{ id: 'a', sim: 0.95, snippet: snip(1) }],
      2,
    )
    expect(merged.map((m) => m.id)).toEqual(['a', 'b'])
    expect(chunkWins).toBe(1)
    expect(parentWins).toBe(1)
  })
})

describe('chunkArmErrorReason', () => {
  it('names the missing grant and the missing table', () => {
    expect(chunkArmErrorReason({ code: '42501' })).toBe('no SELECT on ros_message_chunks')
    expect(chunkArmErrorReason({ code: '42P01' })).toBe('ros_message_chunks missing')
    expect(chunkArmErrorReason({ code: '22000' })).toBe('sql 22000')
    expect(chunkArmErrorReason(new Error('boom'))).toBe('boom')
  })
})

// ---------------------------------------------------------------------------
// Engine wiring
// ---------------------------------------------------------------------------

describe('chunk arm in the vector path', () => {
  it('runs the chunk CTE inside the ef_search transaction and returns the snippet', async () => {
    stubEmbedOk()
    const clientQueries: string[] = []
    const eng = engine(
      fakePool({
        clientQueries,
        parentRows: [parentRow(MSG_LONG, '0.41', LONG_CONTENT)],
        chunkRows: [chunkRow(MSG_LONG, '0.88')],
      }),
    )
    const hits = await eng.search('nvfp4 cudagraph cap', { mode: 'vector', scope: 'messages' })

    expect(clientQueries[0]).toBe('BEGIN')
    expect(clientQueries[1]).toMatch(/^SET LOCAL hnsw\.ef_search/)
    expect(clientQueries.some((q) => q.includes('SAVEPOINT chunk_arm_probe'))).toBe(true)
    expect(clientQueries.some((q) => q === 'SAVEPOINT chunk_arm')).toBe(true)
    expect(clientQueries.some((q) => q.includes('ros_message_chunks c'))).toBe(true)
    expect(clientQueries[clientQueries.length - 1]).toBe('COMMIT')

    expect(hits).toHaveLength(1)
    expect(hits[0].snippet).toEqual({
      text: CHUNK3_TEXT,
      charStart: 6000,
      charEnd: 7024,
      chunkIdx: 2,
      chunkCount: 7,
    })
    expect(hits.chunkArm).toBeUndefined()
    expect(hits.degraded).toBeUndefined()
    expect(eng.getRuntimeStats().chunkArmHits).toBe(1)
    expect(eng.getRuntimeStats().parentArmHits).toBe(0)
  })

  it('ACCEPTANCE: a 12k-char message answered in chunk 3 outranks a better parent match', async () => {
    stubEmbedOk()
    const eng = engine(
      fakePool({
        parentRows: [
          // The short message matches the whole-message vector better; the long
          // message's mean-pooled vector dilutes chunk 3 into noise.
          parentRow(MSG_SHORT, '0.62', 'unrelated note about the pve3 GPU service map'),
          parentRow(MSG_LONG, '0.41', LONG_CONTENT),
        ],
        chunkRows: [chunkRow(MSG_LONG, '0.91')],
      }),
    )
    const hits = await eng.search('nvfp4 cudagraph cap', { mode: 'vector', scope: 'messages' })

    expect(hits[0].id).toBe(MSG_LONG)
    expect(hits[0].snippet?.chunkIdx).toBe(2)
    expect(hits[0].score).toBeGreaterThan(hits[1].score)
    expect(formatSearchMessageBody(hits[0])).toContain('[chunk 3/7')
    expect(formatSearchMessageBody(hits[0])).toContain(CHUNK3_TEXT)
    expect(LONG_CONTENT.length).toBeGreaterThan(12_000)
  })

  it('skips the chunk arm and still searches parents when SELECT is not granted', async () => {
    stubEmbedOk()
    const clientQueries: string[] = []
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const eng = engine(
      fakePool({
        clientQueries,
        chunkPresent: true,
        chunkPrivilege: false,
        parentRows: [parentRow(MSG_SHORT, '0.62', 'a parent-only hit')],
        chunkRows: [chunkRow(MSG_LONG, '0.99')],
      }),
    )
    const hits = await eng.search('nvfp4 cudagraph cap', { mode: 'vector', scope: 'messages' })

    expect(clientQueries.some((q) => q.includes('ros_message_chunks c'))).toBe(false)
    expect(hits.map((h) => h.id)).toEqual([MSG_SHORT])
    expect(hits.chunkArm).toEqual({ chunks: true, reason: 'no SELECT on ros_message_chunks' })
    expect(hits[0].chunkArm?.chunks).toBe(true)
    expect(eng.getRuntimeStats().chunkArmUnavailable).toBe(1)
    expect(warn).toHaveBeenCalledOnce()
  })

  it('names a missing table as not present (run migrations), not a missing GRANT', async () => {
    stubEmbedOk()
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const eng = engine(
      fakePool({
        chunkPresent: false,
        chunkPrivilege: false,
        parentRows: [parentRow(MSG_SHORT, '0.62', 'a parent-only hit')],
        chunkRows: [chunkRow(MSG_LONG, '0.99')],
      }),
    )
    const hits = await eng.search('nvfp4 cudagraph cap', { mode: 'vector', scope: 'messages' })

    expect(hits.map((h) => h.id)).toEqual([MSG_SHORT])
    expect(hits.chunkArm).toEqual({
      chunks: true,
      reason: 'ros_message_chunks not present (run migrations)',
    })
    expect(eng.getRuntimeStats().chunkArmUnavailable).toBe(1)
  })

  it('probes once per engine, not once per search', async () => {
    stubEmbedOk()
    const clientQueries: string[] = []
    const eng = engine(
      fakePool({
        clientQueries,
        parentRows: [parentRow(MSG_SHORT, '0.62', 'a parent hit')],
        chunkRows: [],
      }),
    )
    await eng.search('one', { mode: 'vector', scope: 'messages' })
    await eng.search('two', { mode: 'vector', scope: 'messages' })
    expect(clientQueries.filter((q) => q.includes('has_table_privilege'))).toHaveLength(1)
  })

  it('rolls back to the savepoint and keeps parent hits when the chunk SELECT errors', async () => {
    stubEmbedOk()
    const clientQueries: string[] = []
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const eng = engine(
      fakePool({
        clientQueries,
        chunkThrow: Object.assign(new Error('permission denied'), { code: '42501' }),
        parentRows: [parentRow(MSG_SHORT, '0.62', 'a parent-only hit')],
      }),
    )
    const hits = await eng.search('nvfp4 cudagraph cap', { mode: 'vector', scope: 'messages' })

    expect(clientQueries).toContain('ROLLBACK TO SAVEPOINT chunk_arm')
    expect(clientQueries[clientQueries.length - 1]).toBe('COMMIT')
    expect(hits.map((h) => h.id)).toEqual([MSG_SHORT])
    expect(hits.chunkArm?.reason).toBe('no SELECT on ros_message_chunks')
    expect(eng.getRuntimeStats().chunkArmUnavailable).toBe(1)
  })

  it('rolls back the probe savepoint and keeps parent hits when the privilege probe throws', async () => {
    stubEmbedOk()
    const clientQueries: string[] = []
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const eng = engine(
      fakePool({
        clientQueries,
        probeThrow: Object.assign(new Error('privilege check failed'), { code: '42501' }),
        parentRows: [parentRow(MSG_SHORT, '0.62', 'a parent-only hit')],
      }),
    )
    const hits = await eng.search('nvfp4 cudagraph cap', { mode: 'vector', scope: 'messages' })

    expect(clientQueries).toContain('ROLLBACK TO SAVEPOINT chunk_arm_probe')
    expect(clientQueries[clientQueries.length - 1]).toBe('COMMIT')
    expect(hits.map((h) => h.id)).toEqual([MSG_SHORT])
    expect(hits[0].snippet).toBeUndefined()
    expect(clientQueries.some((q) => q.includes('ros_message_chunks c'))).toBe(false)
  })

  it('hybrid mode merges chunk hits and reports arm counts', async () => {
    stubEmbedOk()
    const eng = engine(
      fakePool({
        parentRows: [parentRow(MSG_SHORT, '0.62', 'a parent-only hit that is long enough to pass')],
        chunkRows: [chunkRow(MSG_LONG, '0.91')],
      }),
    )
    const hits = await eng.search('nvfp4 cudagraph cap', { mode: 'hybrid', scope: 'messages' })
    expect(hits.some((h) => h.id === MSG_LONG && h.snippet?.chunkIdx === 2)).toBe(true)
    const stats = eng.getRuntimeStats()
    expect(stats.chunkArmHits).toBe(1)
    expect(stats.parentArmHits).toBe(1)
  })

  it('counts chunkArmHits/parentArmHits after the returned slice, not the full merge pool', async () => {
    stubEmbedOk()
    const third = '00000000-0000-4000-8000-00000000000c'
    const eng = engine(
      fakePool({
        parentRows: [
          parentRow(MSG_LONG, '0.41', LONG_CONTENT),
          parentRow(MSG_SHORT, '0.62', 'a parent-only hit that is long enough to pass'),
          parentRow(third, '0.30', 'another parent-only hit long enough to pass xx'),
        ],
        chunkRows: [chunkRow(MSG_LONG, '0.91')],
      }),
    )
    const hits = await eng.search('nvfp4 cudagraph cap', {
      mode: 'vector',
      scope: 'messages',
      limit: 2,
    })
    expect(hits).toHaveLength(2)
    expect(hits.map((h) => h.id)).toEqual([MSG_LONG, MSG_SHORT])
    const stats = eng.getRuntimeStats()
    expect(stats.chunkArmHits).toBe(1)
    expect(stats.parentArmHits).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------

describe('snippet rendering', () => {
  it('marks the chunk position and renders chunk.content, not the message head', () => {
    const body = formatSearchMessageBody({
      id: MSG_LONG,
      content: LONG_CONTENT,
      snippet: snip(2),
    })
    expect(body).toContain('…[chunk 3/7 · chars 6000-7024')
    expect(body).toContain(`memory_get_full id=${MSG_LONG}`)
    expect(body).toContain(CHUNK3_TEXT)
    expect(body).not.toContain('filler prose about unrelated deploys')
  })

  it('falls back to the bare index when the chunk count is unknown', () => {
    const body = formatSnippetBody(MSG_LONG, { ...snip(0), chunkCount: undefined })
    expect(body).toContain('…[chunk 1 ·')
    expect(body).not.toContain('/')
  })

  it('display-truncates a long chunk', () => {
    const body = formatSnippetBody(MSG_LONG, { ...snip(1), text: 'x'.repeat(900) }, 100)
    expect(body.endsWith('…')).toBe(true)
    expect(body.length).toBeLessThan(300)
  })

  it('keeps SEARCH_SNIPPET_LIMIT chars of a 6000-char chunk so the match survives', () => {
    const needle = 'THE MATCHING SENTENCE ABOUT NVFP4 CUDAGRAPH CAP'
    const prefix = 'a'.repeat(500)
    const chunk = `${prefix}${needle}${'b'.repeat(6000)}`.slice(0, 6000)
    expect(chunk.length).toBe(6000)
    expect(chunk.indexOf(needle)).toBeGreaterThan(SEARCH_CONTENT_LIMIT)
    expect(chunk.indexOf(needle)).toBeLessThan(SEARCH_SNIPPET_LIMIT)

    const body = formatSearchMessageBody({
      id: MSG_LONG,
      content: 'message head that must not appear in the snippet path',
      snippet: { text: chunk, charStart: 0, charEnd: 6000, chunkIdx: 0, chunkCount: 1 },
    })
    expect(body).toContain(needle)
    expect(body).not.toContain('message head that must not appear')
    const rendered = body.slice(body.indexOf('\n') + 1)
    expect(rendered.endsWith('…')).toBe(true)
    expect(rendered.slice(0, -1).length).toBe(SEARCH_SNIPPET_LIMIT)
    expect(rendered.slice(0, SEARCH_CONTENT_LIMIT)).not.toContain(needle)
  })

  it('leaves non-chunk hits on the existing content + tool_result path', () => {
    const body = formatSearchMessageBody({
      id: MSG_SHORT,
      content: '[tool] Bash',
      toolName: 'Bash',
      toolResult: 'nvidia-smi output',
    })
    expect(body).toContain('[tool_result (Bash)]')
    expect(body).not.toContain('[chunk')
  })
})

// ---------------------------------------------------------------------------
// PG-gated: the real SQL
// ---------------------------------------------------------------------------

/**
 * Dedicated scratch-DB handle. Deliberately NOT `RIVETOS_PG_URL` (adapter.test.ts's
 * read-only harness, which on dev boxes points at the live memory database):
 * this suite creates and drops a schema, so it needs a throwaway target.
 */
const TEST_PG_URL = process.env.RIVETOS_MEMORY_TEST_PG_URL ?? ''

describe.skipIf(!TEST_PG_URL)('chunk arm against Postgres', () => {
  let pool: pg.Pool
  const schema = `m3b_${String(Date.now())}`

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: TEST_PG_URL, max: 2 })
    await pool.query(`CREATE SCHEMA ${schema}`)
    await pool.query(`SET search_path TO ${schema}, public`)
    await pool.query('CREATE EXTENSION IF NOT EXISTS vector')
    await pool.query(`
      CREATE TABLE ${schema}.ros_messages (
        id UUID PRIMARY KEY, conversation_id UUID NOT NULL, role TEXT NOT NULL,
        agent TEXT NOT NULL, content TEXT NOT NULL, tool_name TEXT, tool_result TEXT,
        metadata JSONB, embedding halfvec(3), access_count INT NOT NULL DEFAULT 0,
        last_accessed_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT now())`)
    await pool.query(`
      CREATE TABLE ${schema}.ros_message_chunks (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        message_id UUID NOT NULL REFERENCES ${schema}.ros_messages(id) ON DELETE CASCADE,
        idx INT NOT NULL, char_start INT NOT NULL, char_end INT NOT NULL,
        content TEXT NOT NULL, embedding halfvec(3), UNIQUE (message_id, idx))`)
    const long = `${'filler '.repeat(1000)}${CHUNK3_TEXT}${' filler'.repeat(1000)}`
    await pool.query(
      `INSERT INTO ${schema}.ros_messages (id, conversation_id, role, agent, content, embedding)
       VALUES ($1,$2,'assistant','rivet',$3,'[0.2,0.9,0.1]'),
              ($4,$2,'assistant','rivet',$5,'[0.9,0.3,0.1]')`,
      [MSG_LONG, CONV, long, MSG_SHORT, 'a shorter unrelated note about the pve3 GPU map'],
    )
    for (let i = 0; i < 7; i++) {
      await pool.query(
        `INSERT INTO ${schema}.ros_message_chunks (message_id, idx, char_start, char_end, content, embedding)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [
          MSG_LONG,
          i,
          i * 1000,
          i * 1000 + 1000,
          i === 2 ? CHUNK3_TEXT : `filler chunk ${String(i)} ${'x'.repeat(60)}`,
          i === 2 ? '[1,0,0]' : '[0,0,1]',
        ],
      )
    }
  })

  afterAll(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
    await pool.end()
  })

  it('ranks the chunk-3 message top and returns chunk 3 as the snippet', async () => {
    const scoped = new pg.Pool({
      connectionString: TEST_PG_URL,
      max: 2,
      options: `-c search_path=${schema},public`,
    })
    try {
      const eng = new SearchEngine(scoped)
      // Query vector points at chunk 3, away from both parent vectors.
      const hits = await eng.vectorSearch([1, 0, 0], { scope: 'messages', limit: 5 })
      expect(hits[0].id).toBe(MSG_LONG)
      expect(hits[0].snippet?.chunkIdx).toBe(2)
      expect(hits[0].snippet?.text).toBe(CHUNK3_TEXT)
      expect(hits[0].snippet?.chunkCount).toBe(7)
      expect(formatSearchMessageBody(hits[0])).toContain('[chunk 3/7')
    } finally {
      await scoped.end()
    }
  })
})
