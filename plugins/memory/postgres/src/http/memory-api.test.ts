/**
 * /api/memory — HTTP routing over a fake pool + injected search.
 */

import { createServer, request, type Server } from 'node:http'
import type { AddressInfo, Socket } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Tool } from '@rivetos/types'
import type pg from 'pg'
import { SearchEngine, type SearchHit } from '../search.js'
import { createMemoryApiRoute } from './memory-api.js'

const CONV = '8f3a0000-0000-4000-8000-000000000001'
const HIT: SearchHit = {
  id: 'm1',
  type: 'message',
  content: 'we decided on loopback-only',
  role: 'user',
  agent: 'grok',
  conversationId: CONV,
  score: 0.42,
  createdAt: new Date('2026-08-12T18:00:00.000Z'),
}

function fakePool(opts?: {
  sessionKey?: string
  browse?: Array<Record<string, unknown>>
  counts?: Record<string, string>
  missing?: boolean
  recentFailed?: string
  recentDead?: string
  dead?: boolean
  queueMissing?: boolean
}): pg.Pool {
  const sessionKey = opts?.sessionKey ?? 'claude-code:native-1'
  return {
    query: async (sql: string, params?: unknown[]) => {
      if (opts?.missing) throw new Error('relation "ros_messages" does not exist')
      const text = sql.replace(/\s+/g, ' ')
      if (text.includes('AS msg_queue'))
        return {
          rows: [
            {
              msg_queue: opts?.counts?.n ?? '3',
              sum_queue: '0',
              failed: '2',
              recent_failed: opts?.recentFailed ?? '0',
              unembeddable: '4',
            },
          ],
        }
      if (text.includes('graphile_worker._private_jobs')) {
        if (opts?.queueMissing) throw Object.assign(new Error('missing queue'), { code: '42P01' })
        return {
          rows: opts?.dead
            ? [
                {
                  task: 'extract-wiki',
                  pending: '5',
                  dead: '2',
                  recent_dead: opts?.recentDead ?? '0',
                  running: '1',
                  scheduled: '3',
                  oldest_pending_age_min: '90.5',
                  last_error: 'private error',
                },
              ]
            : [],
        }
      }
      if (text.includes('WITH per_conv'))
        return { rows: [{ eligible_msgs: '10', active_tail_msgs: '3', below_floor_msgs: '1' }] }
      if (text.includes('FROM ros_conversations WHERE id = ANY')) {
        const ids = (params?.[0] as string[]) ?? []
        return {
          rows: ids.includes(CONV) ? [{ id: CONV, session_key: sessionKey }] : [],
        }
      }
      if (text.includes('FROM ros_messages m')) {
        return {
          rows: opts?.browse ?? [
            {
              id: 'b1',
              role: 'user',
              agent: 'grok',
              content: 'this morning we shipped A',
              created_at: new Date('2026-08-12T12:00:00.000Z'),
              conversation_id: CONV,
              session_key: sessionKey,
              tool_name: null,
            },
          ],
        }
      }
      if (text.includes('GROUP BY tool_name')) {
        return { rows: [{ tool: 'Bash', n: '2' }] }
      }
      if (text.includes('GROUP BY c.id')) {
        return {
          rows: [
            {
              session_key: sessionKey,
              title: 'Phase E',
              agent: 'grok',
              last_active: new Date('2026-08-12T18:00:00.000Z'),
              messages: '4',
            },
          ],
        }
      }
      if (text.includes('COUNT(*)') || text.includes('COUNT(embedding)')) {
        return { rows: [{ n: opts?.counts?.n ?? '3' }] }
      }
      return { rows: [] }
    },
  } as unknown as pg.Pool
}

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  for (const fn of cleanups.splice(0)) await fn()
})

async function serve(
  opts: Parameters<typeof createMemoryApiRoute>[0],
  onConnection?: (socket: Socket) => void,
): Promise<string> {
  const api = createMemoryApiRoute(opts)
  const server: Server = createServer((req, res) => {
    void api.handler(req, res)
  })
  if (onConnection) server.on('connection', onConnection)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  cleanups.push(() => new Promise((r) => server.close(r)))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

describe('/api/memory', () => {
  it('exposes dead work and normalizes queue ages without exposing raw errors', async () => {
    vi.spyOn(SearchEngine.prototype, 'checkEmbeddingHealth').mockResolvedValue({
      available: true,
      checkedAt: new Date().toISOString(),
    })
    const base = await serve({ pool: fakePool({ dead: true, recentDead: '1' }) })
    const health = await (await fetch(`${base}/api/memory/health`)).json()
    expect(health).toMatchObject({
      status: 'degraded',
      queueStatus: 'available',
      queues: [
        {
          task: 'extract-wiki',
          pending: 5,
          dead: 2,
          running: 1,
          scheduled: 3,
          oldestPendingMinutes: 90.5,
        },
      ],
    })
    expect(JSON.stringify(health)).not.toContain('private error')
  })
  it.each([
    ['historical failures', '0', '0', 'ok'],
    ['recent embedding failures', '1', '0', 'degraded'],
    ['recent dead jobs', '0', '1', 'degraded'],
  ])(
    'uses recent thresholds for %s while retaining totals',
    async (_label, recentFailed, recentDead, status) => {
      vi.spyOn(SearchEngine.prototype, 'checkEmbeddingHealth').mockResolvedValue({
        available: true,
        checkedAt: new Date().toISOString(),
      })
      const base = await serve({ pool: fakePool({ dead: true, recentFailed, recentDead }) })
      const health = await (await fetch(`${base}/api/memory/health`)).json()
      expect(health).toMatchObject({
        status,
        failedEmbeddings: 2,
        queues: [{ dead: 2 }],
        capture: { status: 'unknown' },
      })
    },
  )

  it('coalesces all diagnostic queries per pool, shares embedding counts with stats, and expires at 60 s', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(100_000)
    const pool = fakePool()
    const original = pool.query.bind(pool)
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const query = vi.spyOn(pool, 'query').mockImplementation((async (sql: string) => {
      await gate
      return original(sql)
    }) as typeof pool.query)
    const base = await serve({ pool })
    const first = fetch(`${base}/api/memory/health`)
    await vi.waitFor(() => expect(query).toHaveBeenCalledTimes(3))
    now.mockReturnValue(170_000) // Still coalesces if the query outlives the TTL.
    const second = fetch(`${base}/api/memory/health`)
    const stats = fetch(`${base}/api/memory/stats`)
    await vi.waitFor(() => expect(query.mock.calls.length).toBeGreaterThanOrEqual(5))
    release()
    expect((await Promise.all([first, second, stats])).map((r) => r.status)).toEqual([
      200, 200, 200,
    ])
    expect(query).toHaveBeenCalledTimes(10)
    const diagnostics = () =>
      query.mock.calls.filter(([sql]) =>
        /AS msg_queue|WITH per_conv|graphile_worker/.test(String(sql)),
      )
    expect(diagnostics()).toHaveLength(3)
    now.mockReturnValue(229_999)
    await fetch(`${base}/api/memory/health`)
    expect(diagnostics()).toHaveLength(3)
    now.mockReturnValue(230_000)
    await fetch(`${base}/api/memory/health`)
    expect(diagnostics()).toHaveLength(6)
  })

  it('evicts rejected counts so the next request can recover', async () => {
    const pool = fakePool()
    const query = vi.spyOn(pool, 'query').mockRejectedValueOnce(new Error('temporary failure'))
    const base = await serve({ pool })
    expect((await fetch(`${base}/api/memory/health`)).status).toBe(500)
    expect((await fetch(`${base}/api/memory/health`)).status).toBe(200)
    expect(query.mock.calls.filter(([sql]) => String(sql).includes('AS msg_queue'))).toHaveLength(2)
  })

  it('does not expose cached owner queues when a routed pool aliases the owner pool', async () => {
    const pool = fakePool({ dead: true })
    const query = vi.spyOn(pool, 'query')
    const base = await serve({ pool, userPools: new Map([['coco', pool]]) })
    await fetch(`${base}/api/memory/health`)
    query.mockClear()
    const health = await (
      await fetch(`${base}/api/memory/health`, { headers: { 'x-rivetos-user': 'coco' } })
    ).json()
    expect(health.queueStatus).toBe('restricted')
    expect(health.queues).toBeUndefined()
    expect(query).not.toHaveBeenCalled()
  })

  it('distinguishes unavailable queue schema from an empty queue', async () => {
    const base = await serve({ pool: fakePool({ queueMissing: true }) })
    const health = await (await fetch(`${base}/api/memory/health`)).json()
    expect(health.queueStatus).toBe('unavailable')
    expect(health.queues).toBeUndefined()
  })

  it('reports real embedding failures, compaction buckets, and owner-only queues', async () => {
    const userPool = fakePool()
    const query = vi.spyOn(userPool, 'query')
    const base = await serve({ pool: fakePool(), userPools: new Map([['coco', userPool]]) })
    const stats = await (await fetch(`${base}/api/memory/stats`)).json()
    expect(stats).toMatchObject({ embedQueueDepth: 3, failedEmbeddings: 2 })
    const health = await (
      await fetch(`${base}/api/memory/health`, { headers: { 'x-rivetos-user': 'coco' } })
    ).json()
    expect(health).toMatchObject({
      queueStatus: 'restricted',
      failedEmbeddings: 2,
      skippedEmbeddings: 4,
      compaction: { eligible: 10, activeTail: 3, belowFloor: 1 },
      capture: { status: 'unknown' },
    })
    expect(health.queues).toBeUndefined()
    expect(query.mock.calls.some(([sql]) => String(sql).includes('graphile_worker'))).toBe(false)
    expect(Number.isFinite(Date.parse(health.observedAt))).toBe(true)
  })

  it('rejects POST and unknown paths', async () => {
    const base = await serve({ pool: fakePool(), search: async () => [] })
    expect((await fetch(`${base}/api/memory/search`, { method: 'POST' })).status).toBe(405)
    expect((await fetch(`${base}/api/memory/nope`)).status).toBe(404)
  })

  it('reuses one SearchEngine per pool so the privilege probe runs once across requests', async () => {
    const clientQueries: string[] = []
    const run = (sql: string): { rows: unknown[] } => {
      const text = sql.replace(/\s+/g, ' ').trim()
      if (
        text.includes('has_table_privilege') ||
        text.includes("to_regclass('ros_message_chunks')")
      ) {
        return { rows: [{ present: true, granted: true }] }
      }
      if (text.includes('FROM ros_conversations WHERE id = ANY')) return { rows: [] }
      if (text.startsWith('UPDATE')) return { rows: [] }
      return { rows: [] }
    }
    const pool = {
      query: (sql: string) => Promise.resolve(run(sql)),
      connect: () =>
        Promise.resolve({
          query: (sql: string) => {
            clientQueries.push(sql.replace(/\s+/g, ' ').trim())
            return Promise.resolve(run(sql))
          },
          release: () => undefined,
        }),
    } as unknown as pg.Pool

    const realFetch = globalThis.fetch
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (url.includes('/v1/embeddings')) {
        return Promise.resolve(
          new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2, 0.3] }] }), {
            status: 200,
          }),
        )
      }
      return realFetch(input, init)
    })

    const base = await serve({
      pool,
      embedEndpoint: 'http://127.0.0.1:9401',
      embedModel: 'Qwen3-Embedding-0.6B',
    })
    expect((await fetch(`${base}/api/memory/search?q=loopback`)).status).toBe(200)
    expect((await fetch(`${base}/api/memory/search?q=loopback`)).status).toBe(200)
    expect(clientQueries.filter((q) => q.includes('has_table_privilege'))).toHaveLength(1)
  })

  it('search requires q and maps session_key', async () => {
    const base = await serve({
      pool: fakePool(),
      search: async (_pool, q) => (q.includes('loopback') ? [HIT] : []),
    })
    expect((await fetch(`${base}/api/memory/search`)).status).toBe(400)
    const body = (await (await fetch(`${base}/api/memory/search?q=loopback`)).json()) as {
      query: string
      degraded: { reason: string } | null
      results: Array<{ sessionId: string; source: string; content: string }>
    }
    expect(body.query).toBe('loopback')
    expect(body.degraded?.reason).toMatch(/embedding/)
    expect(body.results[0].sessionId).toBe('claude-code:native-1')
    expect(body.results[0].source).toBe('message')
    expect(body.results[0].content).toContain('loopback-only')
  })

  it('marks search undegraded when embed endpoint is set', async () => {
    const base = await serve({
      pool: fakePool(),
      embedEndpoint: 'http://192.0.2.9:9401',
      search: async () => [HIT],
    })
    const body = (await (await fetch(`${base}/api/memory/search?q=x`)).json()) as {
      degraded: null
    }
    expect(body.degraded).toBeNull()
  })

  it('derives degraded from hits.degraded and keeps fallback on hits', async () => {
    const recovered = {
      ...HIT,
      fallback: 'trigram' as const,
      degraded: { vector: true as const, reason: 'timeout' },
    }
    const hits = Object.assign([recovered], {
      degraded: { vector: true as const, reason: 'timeout' },
      fallback: 'trigram' as const,
    })
    const base = await serve({
      pool: fakePool(),
      embedEndpoint: 'http://192.0.2.9:9401',
      embedTimeoutMs: '900',
      hnswEfSearch: '80',
      search: async () => hits,
    })
    const body = (await (await fetch(`${base}/api/memory/search?q=x`)).json()) as {
      degraded: { reason: string } | null
      fallback?: 'trigram'
      results: Array<{ fallback?: 'trigram'; content: string }>
    }
    expect(body.degraded?.reason).toBe('timeout')
    expect(body.fallback).toBe('trigram')
    expect(body.results[0].fallback).toBe('trigram')
    expect(body.results[0].content).toContain('loopback-only')
  })

  it('browse returns newest messages with session ids', async () => {
    const base = await serve({ pool: fakePool(), search: async () => [] })
    const body = (await (await fetch(`${base}/api/memory/browse?role=user&limit=10`)).json()) as {
      messages: Array<{ role: string; sessionId: string }>
    }
    expect(body.messages).toHaveLength(1)
    expect(body.messages[0].role).toBe('user')
    expect(body.messages[0].sessionId).toBe('claude-code:native-1')
  })

  it('stats and health report volume + embed state', async () => {
    const base = await serve({ pool: fakePool(), search: async () => [] })
    const stats = (await (await fetch(`${base}/api/memory/stats`)).json()) as {
      conversations: number
      topTools: Array<{ tool: string }>
      recentSessions: Array<{ title: string }>
    }
    expect(stats.conversations).toBe(3)
    expect(stats.topTools[0].tool).toBe('Bash')
    expect(stats.recentSessions[0].title).toBe('Phase E')

    const health = (await (await fetch(`${base}/api/memory/health`)).json()) as {
      status: string
      embeddings: { status: string }
    }
    expect(health.status).toBe('degraded')
    expect(health.embeddings.status).toBe('unavailable')
  })

  it('stats keeps at most two pool queries in flight', async () => {
    const pool = fakePool()
    const original = pool.query.bind(pool)
    let inFlight = 0
    let maxInFlight = 0
    vi.spyOn(pool, 'query').mockImplementation((async (sql: string, params?: unknown[]) => {
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      try {
        await new Promise((r) => setTimeout(r, 20))
        return original(sql, params)
      } finally {
        inFlight -= 1
      }
    }) as typeof pool.query)
    const base = await serve({ pool, search: async () => [] })
    const res = await fetch(`${base}/api/memory/stats`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { conversations: number }
    expect(body.conversations).toBe(3)
    expect(maxInFlight).toBeGreaterThan(0)
    expect(maxInFlight).toBeLessThanOrEqual(2)
  })

  it('missing tables return empty 200, not 500', async () => {
    const base = await serve({ pool: fakePool({ missing: true }), search: async () => [] })
    const res = await fetch(`${base}/api/memory/stats`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { conversations: number }
    expect(body.conversations).toBe(0)
  })

  describe('per-user routing (x-rivetos-user)', () => {
    const routed = { headers: { 'x-rivetos-user': 'coco' } }

    it('differentiates owner and routed pools on every endpoint', async () => {
      const ownerPool = fakePool({ browse: [], counts: { n: '3' } })
      const cocoPool = fakePool({ sessionKey: 'claude-code:coco-1', counts: { n: '7' } })
      const base = await serve({
        pool: ownerPool,
        userPools: new Map([['coco', cocoPool]]),
        search: async (pool) => (pool === cocoPool ? [HIT] : []),
      })

      const ownerSearch = (await (await fetch(`${base}/api/memory/search?q=x`)).json()) as {
        results: unknown[]
      }
      expect(ownerSearch.results).toHaveLength(0)
      const cocoSearch = (await (await fetch(`${base}/api/memory/search?q=x`, routed)).json()) as {
        results: Array<{ sessionId: string }>
      }
      expect(cocoSearch.results).toHaveLength(1)
      expect(cocoSearch.results[0].sessionId).toBe('claude-code:coco-1')

      const ownerBrowse = (await (await fetch(`${base}/api/memory/browse`)).json()) as {
        messages: unknown[]
      }
      expect(ownerBrowse.messages).toHaveLength(0)
      const cocoBrowse = (await (await fetch(`${base}/api/memory/browse`, routed)).json()) as {
        messages: Array<{ sessionId: string }>
      }
      expect(cocoBrowse.messages).toHaveLength(1)
      expect(cocoBrowse.messages[0].sessionId).toBe('claude-code:coco-1')

      const ownerStats = (await (await fetch(`${base}/api/memory/stats`)).json()) as {
        conversations: number
      }
      expect(ownerStats.conversations).toBe(3)
      const cocoStats = (await (await fetch(`${base}/api/memory/stats`, routed)).json()) as {
        conversations: number
        recentSessions: Array<{ sessionId: string }>
      }
      expect(cocoStats.conversations).toBe(7)
      expect(cocoStats.recentSessions[0].sessionId).toBe('claude-code:coco-1')

      const ownerHealth = (await (await fetch(`${base}/api/memory/health`)).json()) as {
        embedQueueDepth: number
      }
      expect(ownerHealth.embedQueueDepth).toBe(3)
      const cocoHealth = (await (await fetch(`${base}/api/memory/health`, routed)).json()) as {
        embedQueueDepth: number
      }
      expect(cocoHealth.embedQueueDepth).toBe(7)
    })

    it('refuses a stamped user with no pool — never the owner fallback', async () => {
      const empty = await serve({ pool: fakePool(), search: async () => [] })
      expect((await fetch(`${empty}/api/memory/browse`, routed)).status).toBe(503)
      // unknown id in a NON-empty map takes the same refusal path
      const populated = await serve({
        pool: fakePool(),
        userPools: new Map([['someone-else', fakePool()]]),
        search: async () => [],
      })
      expect((await fetch(`${populated}/api/memory/browse`, routed)).status).toBe(503)
    })

    it('refuses a tombstoned user (pool construction failed)', async () => {
      const base = await serve({
        pool: fakePool(),
        userPools: new Map([['coco', null]]),
        search: async () => [],
      })
      for (const ep of ['search?q=x', 'browse', 'stats', 'health']) {
        expect((await fetch(`${base}/api/memory/${ep}`, routed)).status).toBe(503)
      }
    })

    it('refuses a present-but-malformed header instead of defaulting to owner', async () => {
      const base = await serve({ pool: fakePool(), search: async () => [] })
      expect(
        (await fetch(`${base}/api/memory/browse`, { headers: { 'x-rivetos-user': '' } })).status,
      ).toBe(503)

      // Duplicated header (array form) can't be produced through fetch —
      // exercise the handler directly with a crafted request.
      const api = createMemoryApiRoute({ pool: fakePool(), search: async () => [] })
      let code = 0
      const res = {
        writeHead: (c: number) => {
          code = c
        },
        end: () => undefined,
      }
      await api.handler(
        {
          method: 'GET',
          url: '/api/memory/browse',
          headers: { 'x-rivetos-user': ['coco', 'owner'] },
        } as never,
        res as never,
      )
      expect(code).toBe(503)
    })
  })

  describe('POST /api/memory/tool/<name>', () => {
    const TOOL_NAMES = [
      'memory_search',
      'memory_browse',
      'memory_stats',
      'memory_get_full',
      'memory_append',
      'memory_ingest_session',
    ] as const

    function fakeTools(execute?: Tool['execute']): Tool[] {
      return TOOL_NAMES.map((name) => ({
        name,
        description: name,
        parameters: {},
        execute: execute ?? vi.fn(async (args) => JSON.stringify({ name, args })),
      }))
    }

    it.each(TOOL_NAMES)('runs %s and returns its ToolResult unchanged', async (name) => {
      const tools = fakeTools()
      const base = await serve({
        pool: fakePool(),
        tools: () => tools,
      })
      const body = { query: 'loopback', limit: 2 }
      const res = await fetch(`${base}/api/memory/tool/${name}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      expect(res.status).toBe(200)
      const payload = (await res.json()) as { ok: boolean; result: string }
      expect(payload.ok).toBe(true)
      expect(JSON.parse(payload.result)).toEqual({ name, args: body })
      expect(tools.find((tool) => tool.name === name)?.execute).toHaveBeenCalledWith(body)
    })

    it('passes a ContentPart[] result through', async () => {
      const parts = [{ type: 'text' as const, text: 'full row' }]
      const base = await serve({
        pool: fakePool(),
        tools: () => [
          {
            name: 'memory_get_full',
            description: 'full',
            parameters: {},
            execute: async () => parts,
          },
        ],
      })
      const res = await fetch(`${base}/api/memory/tool/memory_get_full`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: 'row-1' }),
      })
      expect(res.status).toBe(200)
      const payload = (await res.json()) as { ok: boolean; result: typeof parts }
      expect(payload).toEqual({ ok: true, result: parts })
    })

    it('404s an unknown tool and write tools that were not mounted', async () => {
      const base = await serve({
        pool: fakePool(),
        tools: () => fakeTools().filter((tool) => tool.name !== 'memory_append'),
      })
      const missing = await fetch(`${base}/api/memory/tool/memory_nope`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      })
      expect(missing.status).toBe(404)
      expect(await missing.json()).toEqual({ error: 'unknown memory tool' })
      const append = await fetch(`${base}/api/memory/tool/memory_append`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      })
      expect(append.status).toBe(404)
      expect(await append.json()).toEqual({ error: 'unknown memory tool' })
    })

    it('rejects a non-object body, invalid JSON, and a non-POST', async () => {
      const base = await serve({ pool: fakePool(), tools: () => fakeTools() })
      const post = (body: string) =>
        fetch(`${base}/api/memory/tool/memory_search`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body,
        })
      expect((await post('[1]')).status).toBe(400)
      expect((await post('null')).status).toBe(400)
      expect((await post('{')).status).toBe(400)
      expect((await post('')).status).toBe(400)
      expect((await fetch(`${base}/api/memory/tool/memory_search`, { method: 'GET' })).status).toBe(
        405,
      )
      expect((await fetch(`${base}/api/memory/tool/memory_search`, { method: 'PUT' })).status).toBe(
        405,
      )
    })

    it('413s a body over 256 KiB', async () => {
      const base = await serve({ pool: fakePool(), tools: () => fakeTools() })
      const res = await fetch(`${base}/api/memory/tool/memory_search`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: `{"query":"${'q'.repeat(256 * 1024)}"}`,
      })
      expect(res.status).toBe(413)
      expect(await res.json()).toEqual({ error: 'body too large' })
    })

    it('sends 413 and closes the socket for an unfinished chunked upload over 256 KiB', async () => {
      let serverSocket: Socket | undefined
      const base = await serve({ pool: fakePool(), tools: () => fakeTools() }, (socket) => {
        serverSocket = socket
      })
      await new Promise<void>((resolve, reject) => {
        const client = request(`${base}/api/memory/tool/memory_search`, { method: 'POST' })
        const timer = setTimeout(() => {
          client.destroy()
          reject(new Error('unfinished oversized upload socket did not close within 2 seconds'))
        }, 2000)
        let responseEnded = false
        client.on('error', reject)
        client.on('socket', (socket) => {
          socket.once('close', () => {
            clearTimeout(timer)
            try {
              expect(responseEnded).toBe(true)
              expect(socket.destroyed).toBe(true)
              expect(serverSocket?.destroyed).toBe(true)
              resolve()
            } catch (error) {
              reject(error)
            }
          })
        })
        client.on('response', (res) => {
          let body = ''
          res.setEncoding('utf8')
          res.on('data', (chunk: string) => {
            body += chunk
          })
          res.on('end', () => {
            try {
              expect(res.statusCode).toBe(413)
              expect(res.headers.connection).toBe('close')
              expect(JSON.parse(body)).toEqual({ error: 'body too large' })
              responseEnded = true
            } catch (error) {
              reject(error)
            }
          })
        })
        for (let chunk = 0; chunk < 17; chunk++) client.write(Buffer.alloc(16 * 1024, 'q'))
        // Deliberately never end the request: the server must close the connection.
      })
    })

    it('memoizes the tool factory once per pool', async () => {
      const owner = fakePool()
      const coco = fakePool()
      const ownerQuery = vi.spyOn(owner, 'query')
      const userQuery = vi.spyOn(coco, 'query')
      const factory = vi.fn((pool: pg.Pool) =>
        fakeTools(async () => {
          await pool.query('SELECT 1')
          return pool === owner ? 'owner' : 'coco'
        }),
      )
      const base = await serve({
        pool: owner,
        userPools: new Map([['coco', coco]]),
        tools: factory,
      })
      const post = (headers?: Record<string, string>) =>
        fetch(`${base}/api/memory/tool/memory_stats`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...headers },
          body: '{}',
        })
      expect((await post()).status).toBe(200)
      expect((await post()).status).toBe(200)
      expect(factory).toHaveBeenCalledTimes(1)
      expect(factory).toHaveBeenNthCalledWith(1, owner, { kind: 'owner' })
      expect(ownerQuery).toHaveBeenCalledTimes(2)
      expect(userQuery).not.toHaveBeenCalled()
      expect((await post({ 'x-rivetos-user': 'coco' })).status).toBe(200)
      expect(factory).toHaveBeenCalledTimes(2)
      const userResponse = await post({ 'x-rivetos-user': 'coco' })
      expect(userResponse.status).toBe(200)
      expect(await userResponse.json()).toEqual({ ok: true, result: 'coco' })
      expect(factory).toHaveBeenCalledTimes(2)
      expect(factory).toHaveBeenNthCalledWith(2, coco, { kind: 'user', id: 'coco' })
      expect(userQuery).toHaveBeenCalledTimes(2)
      expect(ownerQuery).toHaveBeenCalledTimes(2)
    })

    it('500s a thrown execute without the stack, including a missing relation', async () => {
      const boom = new Error('boom')
      boom.stack = 'boom\n    at secretFrame (secret.ts:1:1)'
      const base = await serve({
        pool: fakePool(),
        tools: () => [
          {
            name: 'memory_search',
            description: 'search',
            parameters: {},
            execute: async () => {
              throw boom
            },
          },
          {
            name: 'memory_browse',
            description: 'browse',
            parameters: {},
            execute: async () => {
              throw new Error('relation "ros_messages" does not exist')
            },
          },
        ],
      })
      const thrown = await fetch(`${base}/api/memory/tool/memory_search`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      })
      expect(thrown.status).toBe(500)
      const text = await thrown.text()
      expect(JSON.parse(text)).toEqual({ error: 'boom' })
      expect(text).not.toContain('secretFrame')
      const missing = await fetch(`${base}/api/memory/tool/memory_browse`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      })
      expect(missing.status).toBe(500)
      expect(await missing.json()).toEqual({ error: 'relation "ros_messages" does not exist' })
    })

    it('refuses a bad routing identity on the tool route', async () => {
      const base = await serve({
        pool: fakePool(),
        userPools: new Map([['coco', null]]),
        tools: () => fakeTools(),
      })
      const malformed = await fetch(`${base}/api/memory/tool/memory_search`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-rivetos-user': '' },
        body: '{}',
      })
      expect(malformed.status).toBe(503)
      const tombstone = await fetch(`${base}/api/memory/tool/memory_search`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-rivetos-user': 'coco' },
        body: '{}',
      })
      expect(tombstone.status).toBe(503)
    })
  })
})
