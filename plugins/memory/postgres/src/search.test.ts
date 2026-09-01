/**
 * Unit tests for SearchEngine M1 recall-path changes.
 * Fake pool + stubbed fetch — no live Postgres or embedder.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type pg from 'pg'
import {
  SearchEngine,
  applyEmbedQueryInstruction,
  clampEmbedTimeoutMs,
  clampHnswEfSearch,
  DEFAULT_EMBED_QUERY_INSTRUCTION,
  DEFAULT_EMBED_TIMEOUT_MS,
  DEFAULT_HNSW_EF_SEARCH,
  looksLiteral,
  MIN_EMBED_TIMEOUT_MS,
  MAX_EMBED_TIMEOUT_MS,
  MIN_HNSW_EF_SEARCH,
  MAX_HNSW_EF_SEARCH,
  QUERY_EMBED_CACHE_MAX,
  QUERY_EMBED_CACHE_TTL_MS,
  shouldTrigramFallback,
} from './search.js'

const HIT_ROW = {
  id: '00000000-0000-4000-8000-000000000001',
  content: 'the families.app package was chosen for the mesh',
  role: 'user',
  agent: 'grok',
  conversation_id: '00000000-0000-4000-8000-000000000002',
  created_at: new Date('2026-08-01T12:00:00.000Z'),
  boost: '0.2',
  score: '0.8',
  metadata: null,
  tool_name: null,
  tool_result: null,
}

function fakePool(opts?: {
  onQuery?: (sql: string, params?: unknown[]) => { rows: unknown[] } | undefined
  clientQueries?: string[]
  callLog?: string[]
  releaseArgs?: unknown[]
  clientThrow?: unknown
}): pg.Pool {
  const clientQueries = opts?.clientQueries
  const query = async (sql: string, params?: unknown[]) => {
    const override = opts?.onQuery?.(sql, params)
    if (override) return override
    const text = sql.replace(/\s+/g, ' ')
    if (text.includes('UPDATE')) return { rows: [] }
    if (text.includes('ros_summaries')) return { rows: [] }
    if (text.includes('similarity(')) return { rows: [HIT_ROW] }
    if (text.includes('plainto_tsquery')) return { rows: [] }
    return { rows: [] }
  }
  return {
    query,
    connect: async () => {
      opts?.callLog?.push('connect')
      return {
        query: async (sql: string, params?: unknown[]) => {
          const text = sql.replace(/\s+/g, ' ').trim()
          clientQueries?.push(text)
          if (
            opts?.clientThrow &&
            (text.includes('SELECT') || text.includes('<=>') || text.includes('ros_messages'))
          ) {
            throw opts.clientThrow
          }
          return query(sql, params)
        },
        release: (err?: unknown) => {
          opts?.releaseArgs?.push(err)
        },
      }
    },
  } as unknown as pg.Pool
}

function stubEmbedOk(log?: string[]): void {
  vi.stubGlobal(
    'fetch',
    async () => {
      log?.push('fetch')
      return new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2, 0.3] }] }), {
        status: 200,
      })
    },
  )
}

function engine(pool: pg.Pool, extra?: ConstructorParameters<typeof SearchEngine>[1]) {
  return new SearchEngine(pool, extra)
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('looksLiteral / shouldTrigramFallback', () => {
  it('treats families.app as a dotted brand/package name', () => {
    expect(looksLiteral('families.app')).toBe(true)
    expect(shouldTrigramFallback('families.app')).toBe(true)
  })

  it('treats hyphenated model ids as literal via dotted/alnum tokens', () => {
    expect(looksLiteral('qwen3.6-27b-int4')).toBe(true)
    expect(shouldTrigramFallback('qwen3.6-27b-int4')).toBe(true)
  })

  it('does not treat hyphenated prose as literal', () => {
    expect(looksLiteral('state-of-the-art model')).toBe(false)
    expect(looksLiteral('follow-up on compaction')).toBe(false)
    expect(shouldTrigramFallback('state-of-the-art model')).toBe(true)
  })

  it('does not treat plain prose as literal', () => {
    expect(looksLiteral('what did we decide about memory')).toBe(false)
    expect(shouldTrigramFallback('what did we decide about memory')).toBe(false)
  })

  it('mixed-token queries with a dotted name still look literal', () => {
    // Pin: any dotted token in the query routes the hybrid trigram arm.
    expect(looksLiteral('what is families.app?')).toBe(true)
    expect(shouldTrigramFallback('what is families.app?')).toBe(true)
  })
})

describe('config clamps', () => {
  it('defaults, floors, and caps embed timeout', () => {
    expect(clampEmbedTimeoutMs(undefined)).toBe(DEFAULT_EMBED_TIMEOUT_MS)
    expect(clampEmbedTimeoutMs(100)).toBe(MIN_EMBED_TIMEOUT_MS)
    expect(clampEmbedTimeoutMs('100')).toBe(MIN_EMBED_TIMEOUT_MS)
    expect(clampEmbedTimeoutMs('12000')).toBe(12_000)
    expect(clampEmbedTimeoutMs('nope')).toBe(DEFAULT_EMBED_TIMEOUT_MS)
    expect(clampEmbedTimeoutMs(0)).toBe(MIN_EMBED_TIMEOUT_MS)
    expect(clampEmbedTimeoutMs(-20)).toBe(MIN_EMBED_TIMEOUT_MS)
    expect(clampEmbedTimeoutMs(800_000)).toBe(MAX_EMBED_TIMEOUT_MS)
  })

  it('clamps hnsw.ef_search to 10..1000 and truncates fractions', () => {
    expect(clampHnswEfSearch(undefined)).toBe(DEFAULT_HNSW_EF_SEARCH)
    expect(clampHnswEfSearch(5)).toBe(MIN_HNSW_EF_SEARCH)
    expect(clampHnswEfSearch(5000)).toBe(MAX_HNSW_EF_SEARCH)
    expect(clampHnswEfSearch('40')).toBe(40)
    expect(clampHnswEfSearch('40.7')).toBe(40)
    expect(clampHnswEfSearch('nope')).toBe(DEFAULT_HNSW_EF_SEARCH)
    expect(clampHnswEfSearch(0)).toBe(MIN_HNSW_EF_SEARCH)
    expect(clampHnswEfSearch(-3)).toBe(MIN_HNSW_EF_SEARCH)
    expect(Math.trunc(40.7)).toBe(40)
  })
})

describe('query instruction prefix', () => {
  it('applies the Qwen3 instruct prefix to the query text', () => {
    expect(applyEmbedQueryInstruction(DEFAULT_EMBED_QUERY_INSTRUCTION, 'hello')).toBe(
      `${DEFAULT_EMBED_QUERY_INSTRUCTION}hello`,
    )
  })

  it('empty instruction disables the prefix', () => {
    expect(applyEmbedQueryInstruction('', 'hello')).toBe('hello')
  })

  it('slices the query so instruction + text stay within 8000 chars', () => {
    const instruction = 'Instruct: x\nQuery: '
    const text = 'q'.repeat(9000)
    const out = applyEmbedQueryInstruction(instruction, text)
    expect(out.length).toBe(8000)
    expect(out.startsWith(instruction)).toBe(true)
  })

  it('sends the prefix in the embed request body', async () => {
    const bodies: unknown[] = []
    vi.stubGlobal(
      'fetch',
      async (_url: string, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body)))
        return new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2, 0.3] }] }), {
          status: 200,
        })
      },
    )
    const clientQueries: string[] = []
    const eng = engine(fakePool({ clientQueries }), {
      embedEndpoint: 'http://127.0.0.1:9401',
      embedModel: 'Qwen3-Embedding-0.6B',
    })
    await eng.search('hello world', { mode: 'vector', scope: 'messages' })
    const body = bodies[0] as { input: string[] }
    expect(body.input[0]).toContain('Instruct: Given a search query, retrieve relevant passages')
    expect(body.input[0]).toContain('Query: hello world')
    expect(body.input[0].startsWith('Instruct:')).toBe(true)
  })

  it('omits the prefix when embedQueryInstruction is empty', async () => {
    const bodies: unknown[] = []
    vi.stubGlobal(
      'fetch',
      async (_url: string, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body)))
        return new Response(JSON.stringify({ data: [{ embedding: [0.1] }] }), { status: 200 })
      },
    )
    const eng = engine(fakePool({ clientQueries: [] }), {
      embedEndpoint: 'http://127.0.0.1:9401',
      embedModel: 'Qwen3-Embedding-0.6B',
      embedQueryInstruction: '',
    })
    await eng.search('hello', { mode: 'vector', scope: 'messages' })
    const body = bodies[0] as { input: string[] }
    expect(body.input[0]).toBe('hello')
  })
})

describe('trigram fallback', () => {
  it('recovers families.app in default hybrid when FTS is empty', async () => {
    const eng = engine(fakePool())
    const hits = await eng.search('families.app', { mode: 'hybrid', scope: 'messages' })
    expect(hits.length).toBeGreaterThan(0)
    // looksLiteral → trigram is the normal routed arm, not a fallback.
    expect(hits.fallback).toBeUndefined()
    expect(hits[0]?.content).toContain('families.app')
  })

  it('recovers families.app in explicit fts mode when FTS is empty', async () => {
    const eng = engine(fakePool())
    const hits = await eng.search('families.app', { mode: 'fts', scope: 'messages' })
    expect(hits.length).toBeGreaterThan(0)
    expect(hits.fallback).toBe('trigram')
    expect(hits[0]?.content).toContain('families.app')
  })

  it('does not annotate fallback when FTS already hit (hybrid)', async () => {
    const pool = fakePool({
      onQuery: (sql) => {
        const text = sql.replace(/\s+/g, ' ')
        if (text.includes('UPDATE')) return { rows: [] }
        if (text.includes('plainto_tsquery') || text.includes('similarity(')) {
          return { rows: [HIT_ROW] }
        }
        return { rows: [] }
      },
    })
    const hits = await engine(pool).search('families.app', { mode: 'hybrid', scope: 'messages' })
    expect(hits.length).toBeGreaterThan(0)
    expect(hits.fallback).toBeUndefined()
  })

  it('does not annotate fallback when FTS already hit (explicit fts)', async () => {
    const pool = fakePool({
      onQuery: (sql) => {
        const text = sql.replace(/\s+/g, ' ')
        if (text.includes('UPDATE')) return { rows: [] }
        if (text.includes('plainto_tsquery')) return { rows: [HIT_ROW] }
        return { rows: [] }
      },
    })
    const hits = await engine(pool).search('families.app', { mode: 'fts', scope: 'messages' })
    expect(hits.length).toBeGreaterThan(0)
    expect(hits.fallback).toBeUndefined()
  })

  it('does not run similarity() for hyphenated prose in hybrid when FTS hits', async () => {
    const sqls: string[] = []
    const pool = fakePool({
      onQuery: (sql) => {
        const text = sql.replace(/\s+/g, ' ')
        sqls.push(text)
        if (text.includes('UPDATE')) return { rows: [] }
        if (text.includes('plainto_tsquery')) return { rows: [HIT_ROW] }
        return { rows: [] }
      },
    })
    await engine(pool).search('state-of-the-art model', { mode: 'hybrid', scope: 'messages' })
    expect(sqls.some((s) => s.includes('similarity('))).toBe(false)
  })

  it('runs trigram as recovery (fallback annotated) for hyphenated prose when FTS is empty', async () => {
    const sqls: string[] = []
    const pool = fakePool({
      onQuery: (sql) => {
        const text = sql.replace(/\s+/g, ' ')
        sqls.push(text)
        if (text.includes('UPDATE')) return { rows: [] }
        if (text.includes('similarity(')) return { rows: [HIT_ROW] }
        if (text.includes('plainto_tsquery')) return { rows: [] }
        return { rows: [] }
      },
    })
    const hits = await engine(pool).search('state-of-the-art model', {
      mode: 'hybrid',
      scope: 'messages',
    })
    expect(sqls.some((s) => s.includes('similarity('))).toBe(true)
    expect(hits.fallback).toBe('trigram')
    expect(hits.length).toBeGreaterThan(0)
  })

  it('mixed-token dotted query routes trigram as a normal hybrid arm', async () => {
    const sqls: string[] = []
    const pool = fakePool({
      onQuery: (sql) => {
        const text = sql.replace(/\s+/g, ' ')
        sqls.push(text)
        if (text.includes('UPDATE')) return { rows: [] }
        if (text.includes('similarity(') || text.includes('plainto_tsquery')) {
          return { rows: [HIT_ROW] }
        }
        return { rows: [] }
      },
    })
    const hits = await engine(pool).search('what is families.app?', {
      mode: 'hybrid',
      scope: 'messages',
    })
    expect(sqls.some((s) => s.includes('similarity('))).toBe(true)
    expect(hits.fallback).toBeUndefined()
  })
})

describe('degraded-mode signal', () => {
  it('sets degraded, increments counters, and rate-limits the warn log', async () => {
    vi.stubGlobal(
      'fetch',
      async () => new Response('nope', { status: 503 }),
    )
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const eng = engine(fakePool(), {
      embedEndpoint: 'http://127.0.0.1:9401',
      embedModel: 'Qwen3-Embedding-0.6B',
    })

    const first = await eng.search('hello', { mode: 'hybrid', scope: 'messages' })
    const second = await eng.search('hello', { mode: 'hybrid', scope: 'messages' })

    expect(first.degraded).toEqual({ vector: true, reason: 'http 503' })
    expect(second.degraded?.vector).toBe(true)
    const stats = eng.getRuntimeStats()
    expect(stats.vectorArmDropped).toBe(2)
    expect(stats.vectorArmDroppedLastHour).toBe(2)

    const dropLogs = warn.mock.calls.filter((c) =>
      String(c[0]).startsWith('[memory-search] vector arm dropped:'),
    )
    expect(dropLogs).toHaveLength(1)
    expect(String(dropLogs[0]?.[0])).toMatch(
      /\[memory-search\] vector arm dropped: http 503 \(\d+ms\)/,
    )
  })

  it('does not count a missing embed endpoint as a drop', async () => {
    const eng = engine(fakePool())
    const hits = await eng.search('hello', { mode: 'hybrid', scope: 'messages' })
    expect(hits.degraded).toBeUndefined()
    expect(eng.getRuntimeStats().vectorArmDropped).toBe(0)
  })
})

describe('query-embedding LRU cache', () => {
  it('skips the embed call on a cache hit and counts it', async () => {
    let fetches = 0
    vi.stubGlobal(
      'fetch',
      async () => {
        fetches += 1
        return new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2] }] }), { status: 200 })
      },
    )
    const eng = engine(fakePool({ clientQueries: [] }), {
      embedEndpoint: 'http://127.0.0.1:9401',
      embedModel: 'Qwen3-Embedding-0.6B',
    })
    await eng.search('hello', { mode: 'vector', scope: 'messages' })
    await eng.search('  hello  ', { mode: 'vector', scope: 'messages' })
    expect(fetches).toBe(1)
    expect(eng.getRuntimeStats().queryEmbedCacheHits).toBe(1)
  })

  it('does not cache failed embeds', async () => {
    let fetches = 0
    vi.stubGlobal(
      'fetch',
      async () => {
        fetches += 1
        return new Response('nope', { status: 500 })
      },
    )
    const eng = engine(fakePool(), {
      embedEndpoint: 'http://127.0.0.1:9401',
      embedModel: 'Qwen3-Embedding-0.6B',
    })
    await eng.search('hello', { mode: 'vector', scope: 'messages' })
    await eng.search('hello', { mode: 'vector', scope: 'messages' })
    expect(fetches).toBe(2)
    expect(eng.getRuntimeStats().queryEmbedCacheHits).toBe(0)
  })
})

describe('hnsw.ef_search per query', () => {
  it('SET LOCAL hnsw.ef_search inside a transaction before the vector SELECT', async () => {
    vi.stubGlobal(
      'fetch',
      async () =>
        new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2] }] }), { status: 200 }),
    )
    const clientQueries: string[] = []
    const eng = engine(fakePool({ clientQueries }), {
      embedEndpoint: 'http://127.0.0.1:9401',
      embedModel: 'Qwen3-Embedding-0.6B',
      hnswEfSearch: 80,
    })
    await eng.search('hello', { mode: 'vector', scope: 'messages' })
    expect(clientQueries[0]).toBe('BEGIN')
    expect(clientQueries[1]).toBe('SET LOCAL hnsw.ef_search = 80')
    expect(clientQueries.some((q) => q.includes('<=>'))).toBe(true)
    expect(clientQueries[clientQueries.length - 1]).toBe('COMMIT')
  })
})

describe('embed timeout from config', () => {
  it('aborts at the configured timeout (floor 500ms)', async () => {
    vi.useFakeTimers()
    vi.stubGlobal(
      'fetch',
      (_url: unknown, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const err = new Error('This operation was aborted')
            err.name = 'AbortError'
            reject(err)
          })
        }),
    )
    const eng = engine(fakePool(), {
      embedEndpoint: 'http://127.0.0.1:9401',
      embedModel: 'Qwen3-Embedding-0.6B',
      embedTimeoutMs: 100,
    })
    const pending = eng.search('hello', { mode: 'vector', scope: 'messages' })
    await vi.advanceTimersByTimeAsync(MIN_EMBED_TIMEOUT_MS)
    const hits = await pending
    expect(hits.degraded?.reason).toBe('timeout')
    expect(eng.getRuntimeStats().vectorArmDropped).toBe(1)
  })
})

describe('degraded-mode extras', () => {
  it('logs again after the 60s rate-limit window and decays last-hour after >1h', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-01T12:00:00.000Z'))
    vi.stubGlobal('fetch', async () => new Response('nope', { status: 503 }))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const eng = engine(fakePool(), {
      embedEndpoint: 'http://127.0.0.1:9401',
      embedModel: 'Qwen3-Embedding-0.6B',
    })

    await eng.search('hello', { mode: 'hybrid', scope: 'messages' })
    await eng.search('hello-2', { mode: 'hybrid', scope: 'messages' })
    let dropLogs = warn.mock.calls.filter((c) =>
      String(c[0]).startsWith('[memory-search] vector arm dropped:'),
    )
    expect(dropLogs).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(60_000)
    await eng.search('hello-3', { mode: 'hybrid', scope: 'messages' })
    dropLogs = warn.mock.calls.filter((c) =>
      String(c[0]).startsWith('[memory-search] vector arm dropped:'),
    )
    expect(dropLogs).toHaveLength(2)
    expect(eng.getRuntimeStats().vectorArmDropped).toBe(3)
    expect(eng.getRuntimeStats().vectorArmDroppedLastHour).toBe(3)

    await vi.advanceTimersByTimeAsync(3_600_000 + 60_000)
    expect(eng.getRuntimeStats().vectorArmDropped).toBe(3)
    expect(eng.getRuntimeStats().vectorArmDroppedLastHour).toBe(0)
  })

  it('successful embed + zero vector rows is not degraded', async () => {
    stubEmbedOk()
    const eng = engine(
      fakePool({
        onQuery: (sql) => {
          const text = sql.replace(/\s+/g, ' ')
          if (text.includes('UPDATE')) return { rows: [] }
          return { rows: [] }
        },
      }),
      {
        embedEndpoint: 'http://127.0.0.1:9401',
        embedModel: 'Qwen3-Embedding-0.6B',
      },
    )
    const hits = await eng.search('hello', { mode: 'hybrid', scope: 'messages' })
    expect(hits.degraded).toBeUndefined()
    expect(eng.getRuntimeStats().vectorArmDropped).toBe(0)
  })

  it('network-level fetch rejection sets reason network and bumps the counter', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('fetch failed')
    })
    const eng = engine(fakePool(), {
      embedEndpoint: 'http://127.0.0.1:9401',
      embedModel: 'Qwen3-Embedding-0.6B',
    })
    const hits = await eng.search('hello', { mode: 'hybrid', scope: 'messages' })
    expect(hits.degraded).toEqual({ vector: true, reason: 'network' })
    expect(eng.getRuntimeStats().vectorArmDropped).toBe(1)
  })

  it('JSON parse errors are bad response, not network', async () => {
    vi.stubGlobal('fetch', async () => {
      return new Response('not-json{', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    })
    const eng = engine(fakePool(), {
      embedEndpoint: 'http://127.0.0.1:9401',
      embedModel: 'Qwen3-Embedding-0.6B',
    })
    const hits = await eng.search('hello', { mode: 'hybrid', scope: 'messages' })
    expect(hits.degraded?.reason).toBe('bad response')
    expect(eng.getRuntimeStats().vectorArmDropped).toBe(1)
  })

  it('explicit fts embed failure attaches degraded but does not bump vectorArmDropped', async () => {
    vi.stubGlobal('fetch', async () => new Response('nope', { status: 503 }))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const pool = fakePool({
      onQuery: (sql) => {
        const text = sql.replace(/\s+/g, ' ')
        if (text.includes('UPDATE')) return { rows: [] }
        if (text.includes('plainto_tsquery')) return { rows: [HIT_ROW] }
        return { rows: [] }
      },
    })
    const eng = engine(pool, {
      embedEndpoint: 'http://127.0.0.1:9401',
      embedModel: 'Qwen3-Embedding-0.6B',
    })
    const hits = await eng.search('hello', { mode: 'fts', scope: 'messages' })
    expect(hits.degraded).toEqual({ vector: true, reason: 'http 503' })
    expect(hits.length).toBeGreaterThan(0)
    expect(eng.getRuntimeStats().vectorArmDropped).toBe(0)
    expect(
      warn.mock.calls.some((c) => String(c[0]).startsWith('[memory-search] vector arm dropped:')),
    ).toBe(true)
  })

  it('degraded and fallback co-occur on hyphenated empty-FTS hybrid when embed fails', async () => {
    vi.stubGlobal('fetch', async () => new Response('nope', { status: 503 }))
    const eng = engine(fakePool(), {
      embedEndpoint: 'http://127.0.0.1:9401',
      embedModel: 'Qwen3-Embedding-0.6B',
    })
    const hits = await eng.search('state-of-the-art model', { mode: 'hybrid', scope: 'messages' })
    expect(hits.degraded?.vector).toBe(true)
    expect(hits.fallback).toBe('trigram')
    expect(hits[0]?.degraded?.vector).toBe(true)
    expect(hits[0]?.fallback).toBe('trigram')
  })
})

describe('query-embedding LRU extras', () => {
  it('embeds the normalized text so equal keys produce equal vectors', async () => {
    const bodies: unknown[] = []
    vi.stubGlobal(
      'fetch',
      async (_url: string, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body)))
        return new Response(JSON.stringify({ data: [{ embedding: [0.1] }] }), { status: 200 })
      },
    )
    const eng = engine(fakePool({ clientQueries: [] }), {
      embedEndpoint: 'http://127.0.0.1:9401',
      embedModel: 'Qwen3-Embedding-0.6B',
    })
    await eng.search('  hello   world  ', { mode: 'vector', scope: 'messages' })
    const body = bodies[0] as { input: string[] }
    expect(body.input[0]).toContain('Query: hello world')
    expect(body.input[0]).not.toContain('  hello')
  })

  it('expires entries after the 10-minute TTL', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-01T12:00:00.000Z'))
    let fetches = 0
    vi.stubGlobal(
      'fetch',
      async () => {
        fetches += 1
        return new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2] }] }), { status: 200 })
      },
    )
    const eng = engine(fakePool({ clientQueries: [] }), {
      embedEndpoint: 'http://127.0.0.1:9401',
      embedModel: 'Qwen3-Embedding-0.6B',
    })
    await eng.search('hello', { mode: 'vector', scope: 'messages' })
    expect(fetches).toBe(1)
    await vi.advanceTimersByTimeAsync(QUERY_EMBED_CACHE_TTL_MS + 1)
    await eng.search('hello', { mode: 'vector', scope: 'messages' })
    expect(fetches).toBe(2)
    expect(eng.getRuntimeStats().queryEmbedCacheHits).toBe(0)
  })

  it('evicts the oldest key once 257 entries are stored; a hit still runs SELECT', async () => {
    let fetches = 0
    vi.stubGlobal(
      'fetch',
      async () => {
        fetches += 1
        return new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2] }] }), { status: 200 })
      },
    )
    const clientQueries: string[] = []
    const eng = engine(fakePool({ clientQueries }), {
      embedEndpoint: 'http://127.0.0.1:9401',
      embedModel: 'Qwen3-Embedding-0.6B',
    })
    for (let i = 0; i < QUERY_EMBED_CACHE_MAX + 1; i++) {
      await eng.search(`q-${String(i)}`, { mode: 'vector', scope: 'messages' })
    }
    expect(fetches).toBe(QUERY_EMBED_CACHE_MAX + 1)
    const selectsBefore = clientQueries.filter((q) => q.includes('<=>')).length
    await eng.search('q-0', { mode: 'vector', scope: 'messages' })
    expect(fetches).toBe(QUERY_EMBED_CACHE_MAX + 2)
    await eng.search(`q-${String(QUERY_EMBED_CACHE_MAX)}`, { mode: 'vector', scope: 'messages' })
    expect(fetches).toBe(QUERY_EMBED_CACHE_MAX + 2)
    expect(eng.getRuntimeStats().queryEmbedCacheHits).toBe(1)
    expect(clientQueries.filter((q) => q.includes('<=>')).length).toBeGreaterThan(selectsBefore)
  })

  it('counts cache misses alongside hits', async () => {
    stubEmbedOk()
    const eng = engine(fakePool({ clientQueries: [] }), {
      embedEndpoint: 'http://127.0.0.1:9401',
      embedModel: 'Qwen3-Embedding-0.6B',
    })
    await eng.search('alpha', { mode: 'vector', scope: 'messages' })
    await eng.search('alpha', { mode: 'vector', scope: 'messages' })
    const stats = eng.getRuntimeStats()
    expect(stats.queryEmbedCacheMisses).toBe(1)
    expect(stats.queryEmbedCacheHits).toBe(1)
  })
})

describe('withHnswEfSearch release', () => {
  it('happy path calls release() with no error after COMMIT', async () => {
    stubEmbedOk()
    const releaseArgs: unknown[] = []
    const clientQueries: string[] = []
    const eng = engine(fakePool({ clientQueries, releaseArgs }), {
      embedEndpoint: 'http://127.0.0.1:9401',
      embedModel: 'Qwen3-Embedding-0.6B',
    })
    await eng.search('hello', { mode: 'vector', scope: 'messages' })
    expect(clientQueries[clientQueries.length - 1]).toBe('COMMIT')
    expect(releaseArgs).toEqual([undefined])
  })

  it('txn failure issues ROLLBACK and release(err)', async () => {
    stubEmbedOk()
    const boom = new Error('vector select failed')
    const releaseArgs: unknown[] = []
    const clientQueries: string[] = []
    const eng = engine(fakePool({ clientQueries, releaseArgs, clientThrow: boom }), {
      embedEndpoint: 'http://127.0.0.1:9401',
      embedModel: 'Qwen3-Embedding-0.6B',
    })
    await expect(eng.search('hello', { mode: 'vector', scope: 'messages' })).rejects.toThrow(
      'vector select failed',
    )
    expect(clientQueries).toContain('BEGIN')
    expect(clientQueries).toContain('ROLLBACK')
    expect(releaseArgs).toEqual([boom])
  })
})

describe('pool.connect vs embed fetch order', () => {
  it('acquires the pooled client only after the query embed resolves', async () => {
    const callLog: string[] = []
    vi.stubGlobal(
      'fetch',
      async () => {
        callLog.push('fetch')
        return new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2] }] }), { status: 200 })
      },
    )
    const eng = engine(fakePool({ callLog }), {
      embedEndpoint: 'http://127.0.0.1:9401',
      embedModel: 'Qwen3-Embedding-0.6B',
    })
    await eng.search('hello', { mode: 'vector', scope: 'messages' })
    expect(callLog[0]).toBe('fetch')
    expect(callLog.indexOf('connect')).toBeGreaterThan(callLog.indexOf('fetch'))
  })
})

describe('hnsw.ef_search truncation', () => {
  it('SET LOCAL uses Math.trunc so 40.7 becomes 40', async () => {
    stubEmbedOk()
    const clientQueries: string[] = []
    const eng = engine(fakePool({ clientQueries }), {
      embedEndpoint: 'http://127.0.0.1:9401',
      embedModel: 'Qwen3-Embedding-0.6B',
      hnswEfSearch: '40.7',
    })
    await eng.search('hello', { mode: 'vector', scope: 'messages' })
    expect(clientQueries[1]).toBe('SET LOCAL hnsw.ef_search = 40')
  })
})
