/**
 * /api/memory — HTTP routing over a fake pool + injected search.
 */

import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type pg from 'pg'
import type { SearchHit } from '../search.js'
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
}): pg.Pool {
  const sessionKey = opts?.sessionKey ?? 'claude-code:native-1'
  return {
    query: async (sql: string, params?: unknown[]) => {
      if (opts?.missing) throw new Error('relation "ros_messages" does not exist')
      const text = sql.replace(/\s+/g, ' ')
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

async function serve(opts: Parameters<typeof createMemoryApiRoute>[0]): Promise<string> {
  const api = createMemoryApiRoute(opts)
  const server: Server = createServer((req, res) => {
    void api.handler(req, res)
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  cleanups.push(() => new Promise((r) => server.close(r)))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

describe('/api/memory', () => {
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
      embedEndpoint: 'http://192.168.1.9:9401',
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
      embedEndpoint: 'http://192.168.1.9:9401',
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
          headers: { 'x-rivetos-user': ['coco', 'phil'] },
        } as never,
        res as never,
      )
      expect(code).toBe(503)
    })
  })
})
