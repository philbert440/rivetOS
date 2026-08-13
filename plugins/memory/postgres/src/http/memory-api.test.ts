/**
 * /api/memory — HTTP routing over a fake pool + injected search.
 */

import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
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
  for (const fn of cleanups.splice(0)) await fn()
})

async function serve(
  opts: Parameters<typeof createMemoryApiRoute>[0],
): Promise<string> {
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

  it('search requires q and maps session_key', async () => {
    const base = await serve({
      pool: fakePool(),
      search: async (q) => (q.includes('loopback') ? [HIT] : []),
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
})
