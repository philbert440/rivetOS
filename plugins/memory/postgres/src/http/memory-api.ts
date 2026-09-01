/**
 * /api/memory — HTTP surface for RivetHub Search / Browse / Stats.
 *
 * Same data the MCP tools already expose; JSON so the Hub does not have to
 * speak MCP. Mounted next to /api/wiki whenever the shared pool exists.
 *
 *   GET /api/memory/search?q=&scope=both|messages|summaries&limit=
 *   GET /api/memory/browse?role=&agent=&limit=&window=
 *   GET /api/memory/stats
 *   GET /api/memory/health
 */

import type { ServerResponse } from 'node:http'
import {
  routedUserResult,
  type GatewayRoute,
  type MemoryBrowseMessage,
  type MemoryBrowseResponse,
  type MemoryHealthResponse,
  type MemorySearchHit,
  type MemorySearchResponse,
  type MemoryStatsResponse,
} from '@rivetos/types'
import type pg from 'pg'
import {
  SearchEngine,
  type SearchEngineConfig,
  type SearchOptions,
  type SearchResults,
} from '../search.js'
import { applyWindowArgs } from '../tools/helpers.js'

/** One engine per pool so the chunk-arm privilege probe and the M1 query-embed
 *  cache survive across HTTP requests. Keyed by pool identity (owner vs each
 *  routed user). First config for a given pool wins. */
const enginesByPool = new WeakMap<pg.Pool, SearchEngine>()

function engineForPool(pool: pg.Pool, config: SearchEngineConfig): SearchEngine {
  const cached = enginesByPool.get(pool)
  if (cached) return cached
  const created = new SearchEngine(pool, config)
  enginesByPool.set(pool, created)
  return created
}

export type MemorySearchFn = (
  pool: pg.Pool,
  query: string,
  options?: SearchOptions,
) => Promise<SearchResults>

export interface MemoryApiOptions {
  /** The node owner's database — used only for requests den left unstamped. */
  pool: pg.Pool
  /** Per-user pools from the users.json registry. `null` = configured but
   *  unusable (tombstone): the user must get an error, never the owner's data. */
  userPools?: ReadonlyMap<string, pg.Pool | null>
  embedEndpoint?: string
  embedModel?: string
  embedQueryInstruction?: string
  embedTimeoutMs?: number | string
  hnswEfSearch?: number | string
  /** Test seam — production uses SearchEngine. */
  search?: MemorySearchFn
}

function json(res: ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

function emptyFor(rawUrl: string): unknown {
  const path = new URL(rawUrl, 'http://localhost').pathname
  if (path.endsWith('/search')) {
    return {
      query: '',
      scope: 'both',
      degraded: null,
      results: [],
    } satisfies MemorySearchResponse
  }
  if (path.endsWith('/browse')) return { messages: [] } satisfies MemoryBrowseResponse
  if (path.endsWith('/stats')) {
    return {
      conversations: 0,
      messages: 0,
      toolCalls: 0,
      summaries: 0,
      embedQueueDepth: 0,
      embeddedMessages: 0,
      failedEmbeddings: 0,
      topTools: [],
      recentSessions: [],
    } satisfies MemoryStatsResponse
  }
  return {
    status: 'ok',
    embeddings: { status: 'unavailable' },
    embedQueueDepth: 0,
  } satisfies MemoryHealthResponse
}

function intParam(url: URL, name: string, fallback: number): number {
  const raw = url.searchParams.get(name)
  if (!raw) return fallback
  const n = Number(raw)
  return Number.isFinite(n) ? n : fallback
}

async function sessionKeys(pool: pg.Pool, conversationIds: string[]): Promise<Map<string, string>> {
  const ids = [...new Set(conversationIds.filter(Boolean))]
  const map = new Map<string, string>()
  if (ids.length === 0) return map
  const { rows } = await pool.query<{ id: string; session_key: string }>(
    `SELECT id, session_key FROM ros_conversations WHERE id = ANY($1::uuid[])`,
    [ids],
  )
  for (const r of rows) map.set(r.id, r.session_key)
  return map
}

export function createMemoryApiRoute(opts: MemoryApiOptions): GatewayRoute {
  const embedOk = Boolean(opts.embedEndpoint)
  const engineConfig: SearchEngineConfig = {
    embedEndpoint: opts.embedEndpoint,
    embedModel: opts.embedModel,
    embedQueryInstruction: opts.embedQueryInstruction,
    embedTimeoutMs: opts.embedTimeoutMs,
    hnswEfSearch: opts.hnswEfSearch,
  }
  const search: MemorySearchFn =
    opts.search ??
    ((pool, query, options) => engineForPool(pool, engineConfig).search(query, options))

  return {
    prefix: '/api/memory',
    handler: async (req, res) => {
      try {
        if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' })
        // HARD INVARIANT: this route must only ever be dispatched by den-server
        // AFTER its unconditional strip-and-stamp of x-rivetos-user (embedded
        // gateway extraRoutes). den stamps only resolved non-owner identities,
        // so absent = owner; a PRESENT-but-malformed value is refused, and a
        // stamped user must resolve to their own pool — unknown or tombstoned
        // entries are refused too. Falling through to the owner pool is exactly
        // the cross-tenant leak this routing exists to close. Never mount this
        // route on an unauthenticated port.
        const routed = routedUserResult(req.headers)
        if (routed.kind === 'invalid') {
          return json(res, 503, { error: 'malformed routing identity' })
        }
        let pool: pg.Pool
        if (routed.kind === 'owner') {
          pool = opts.pool
        } else {
          const userPool = opts.userPools?.get(routed.id)
          if (!userPool) {
            return json(res, 503, { error: `memory is not available for user "${routed.id}"` })
          }
          pool = userPool
        }
        const url = new URL(req.url ?? '/', 'http://localhost')
        const rest = url.pathname.slice('/api/memory'.length).replace(/^\//, '')
        const [head] = rest.split('/')

        if (head === 'search') return await handleSearch(url, res, search, pool, embedOk)
        if (head === 'browse') return await handleBrowse(url, res, pool)
        if (head === 'stats') return await handleStats(res, pool)
        if (head === 'health') return await handleHealth(res, pool, embedOk)
        return json(res, 404, { error: 'unknown memory resource' })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        if (/does not exist|relation/i.test(msg)) {
          return json(res, 200, emptyFor(req.url ?? ''))
        }
        json(res, 500, { error: msg })
      }
    },
  }
}

async function handleSearch(
  url: URL,
  res: ServerResponse,
  search: MemorySearchFn,
  pool: pg.Pool,
  embedOk: boolean,
): Promise<void> {
  const q = (url.searchParams.get('q') ?? '').trim()
  if (!q) return json(res, 400, { error: 'q required' })
  const scopeRaw = url.searchParams.get('scope') ?? 'both'
  const scope =
    scopeRaw === 'messages' || scopeRaw === 'summaries' || scopeRaw === 'both' ? scopeRaw : 'both'
  const limit = Math.min(Math.max(intParam(url, 'limit', 20), 1), 50)
  const hits = await search(pool, q, { scope, limit })
  const keys = await sessionKeys(
    pool,
    hits.map((h) => h.conversationId).filter((id): id is string => Boolean(id)),
  )
  const results: MemorySearchHit[] = hits.map((h) => ({
    id: h.id,
    source: h.type === 'summary' ? 'summary' : 'message',
    content: h.content,
    createdAt: h.createdAt.toISOString(),
    score: h.score,
    role: h.role,
    agent: h.agent,
    kind: h.kind,
    conversationId: h.conversationId,
    sessionId: h.conversationId ? (keys.get(h.conversationId) ?? null) : null,
    ...(h.fallback ? { fallback: h.fallback } : {}),
  }))
  const body: MemorySearchResponse = {
    query: q,
    scope,
    degraded: httpSearchDegraded(hits, embedOk),
    ...(hits.fallback ? { fallback: hits.fallback } : {}),
    results,
  }
  json(res, 200, body)
}

function httpSearchDegraded(
  hits: SearchResults,
  embedOk: boolean,
): MemorySearchResponse['degraded'] {
  if (hits.degraded) {
    return {
      reason: hits.degraded.reason,
      effect: 'Keyword / FTS ranking only — not meaning-based.',
    }
  }
  if (!embedOk) {
    return {
      reason: 'embedding endpoint not configured',
      effect: 'Keyword / FTS ranking only — not meaning-based.',
    }
  }
  return null
}

async function handleBrowse(url: URL, res: ServerResponse, pool: pg.Pool): Promise<void> {
  const conditions: string[] = []
  const params: unknown[] = []
  let pi = 1
  const role = url.searchParams.get('role')
  if (role) {
    conditions.push(`m.role = $${String(pi++)}`)
    params.push(role)
  }
  const agent = url.searchParams.get('agent')
  if (agent) {
    conditions.push(`m.agent = $${String(pi++)}`)
    params.push(agent)
  }
  const toolName = url.searchParams.get('tool_name')
  if (toolName) {
    conditions.push(`m.tool_name = $${String(pi++)}`)
    params.push(toolName)
  }
  let since: string | undefined
  let before: string | undefined
  try {
    ;({ since, before } = applyWindowArgs({
      window: url.searchParams.get('window') ?? undefined,
      since: url.searchParams.get('since') ?? undefined,
      before: url.searchParams.get('before') ?? undefined,
    }))
  } catch (err) {
    return json(res, 400, { error: err instanceof Error ? err.message : String(err) })
  }
  if (since) {
    conditions.push(`m.created_at >= $${String(pi++)}`)
    params.push(since)
  }
  if (before) {
    conditions.push(`m.created_at < $${String(pi++)}`)
    params.push(before)
  }
  const limit = Math.min(Math.max(intParam(url, 'limit', 50), 1), 200)
  params.push(limit)
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
  const { rows } = await pool.query<{
    id: string
    role: string
    agent: string
    content: string
    created_at: Date
    conversation_id: string
    session_key: string | null
    tool_name: string | null
  }>(
    `SELECT m.id, m.role, m.agent, m.content, m.created_at,
            m.conversation_id, c.session_key, m.tool_name
       FROM ros_messages m
       LEFT JOIN ros_conversations c ON c.id = m.conversation_id
       ${where}
       ORDER BY m.created_at DESC
       LIMIT $${String(pi)}`,
    params,
  )
  const messages: MemoryBrowseMessage[] = rows.map((r) => ({
    id: r.id,
    role: r.role,
    agent: r.agent,
    content: r.content,
    createdAt: r.created_at.toISOString(),
    conversationId: r.conversation_id,
    sessionId: r.session_key,
    toolName: r.tool_name,
  }))
  json(res, 200, { messages } satisfies MemoryBrowseResponse)
}

async function handleStats(res: ServerResponse, pool: pg.Pool): Promise<void> {
  const [conv, msg, tools, sums, queue, embedded, topTools, recent] = await Promise.all([
    pool.query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM ros_conversations`),
    pool.query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM ros_messages`),
    pool.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM ros_messages WHERE role = 'tool' OR tool_name IS NOT NULL`,
    ),
    pool.query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM ros_summaries`),
    pool.query<{ n: string }>(`
      SELECT (
        (SELECT COUNT(*) FROM ros_messages WHERE embedding IS NULL AND content IS NOT NULL AND LENGTH(content) > 0)
        + (SELECT COUNT(*) FROM ros_summaries WHERE embedding IS NULL AND content IS NOT NULL)
      )::text AS n
    `),
    pool.query<{ n: string }>(`SELECT COUNT(embedding)::text AS n FROM ros_messages`),
    pool.query<{ tool: string; n: string }>(`
      SELECT tool_name AS tool, COUNT(*)::text AS n
        FROM ros_messages
       WHERE tool_name IS NOT NULL
       GROUP BY tool_name
       ORDER BY COUNT(*) DESC
       LIMIT 12
    `),
    pool.query<{
      session_key: string
      title: string | null
      agent: string
      last_active: Date
      messages: string
    }>(`
      SELECT c.session_key, c.title, c.agent, c.updated_at AS last_active,
             COUNT(m.id)::text AS messages
        FROM ros_conversations c
        LEFT JOIN ros_messages m ON m.conversation_id = c.id
       GROUP BY c.id
       ORDER BY c.updated_at DESC
       LIMIT 12
    `),
  ])
  const body: MemoryStatsResponse = {
    conversations: Number(conv.rows[0]?.n ?? 0),
    messages: Number(msg.rows[0]?.n ?? 0),
    toolCalls: Number(tools.rows[0]?.n ?? 0),
    summaries: Number(sums.rows[0]?.n ?? 0),
    embedQueueDepth: Number(queue.rows[0]?.n ?? 0),
    embeddedMessages: Number(embedded.rows[0]?.n ?? 0),
    failedEmbeddings: 0,
    topTools: topTools.rows.map((r) => ({ tool: r.tool, count: Number(r.n) })),
    recentSessions: recent.rows.map((r) => ({
      sessionId: r.session_key,
      title: r.title,
      agent: r.agent,
      lastActive: r.last_active.toISOString(),
      messages: Number(r.messages),
    })),
  }
  json(res, 200, body)
}

async function handleHealth(res: ServerResponse, pool: pg.Pool, embedOk: boolean): Promise<void> {
  const queue = await pool.query<{ n: string }>(`
    SELECT (
      (SELECT COUNT(*) FROM ros_messages WHERE embedding IS NULL AND content IS NOT NULL AND LENGTH(content) > 0)
      + (SELECT COUNT(*) FROM ros_summaries WHERE embedding IS NULL AND content IS NOT NULL)
    )::text AS n
  `)
  const embedQueueDepth = Number(queue.rows[0]?.n ?? 0)
  const body: MemoryHealthResponse = {
    status: embedOk ? 'ok' : 'degraded',
    embeddings: embedOk
      ? { status: 'ok' }
      : {
          status: 'unavailable',
          impact: 'Keyword matching still works; meaning-based ranking is offline.',
        },
    embedQueueDepth,
  }
  json(res, 200, body)
}
