/**
 * The backend-neutral memory routes, against a real HTTP server and a
 * scripted MemoryBackend.
 */

import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { MemoryRequestError, TRUSTED_USER_HEADER } from '@rivetos/types'
import type { MemoryBackend, MemoryTagsBackend, Tag } from '@rivetos/types'
import {
  createBackendCaptureRoute,
  createBackendMemoryRoute,
  parseCaptureBatch,
} from './backend-api.js'

const TAG: Tag = {
  id: '11111111-1111-4111-8111-111111111111',
  entityType: 'conversation',
  entityId: '22222222-2222-4222-8222-222222222222',
  key: 'project',
  value: 'acmeapp',
  display: 'acmeapp',
  state: 'accepted',
  source: 'user',
  reason: '',
  createdAt: new Date('2026-10-04T00:00:00Z'),
  updatedAt: new Date('2026-10-04T00:00:00Z'),
} as Tag

function fakeBackend(tags: Partial<MemoryTagsBackend> = {}): { backend: MemoryBackend; calls: unknown[][] } {
  const calls: unknown[][] = []
  const record =
    <T>(name: string, result: T) =>
    async (...args: unknown[]): Promise<T> => {
      calls.push([name, ...args])
      return result
    }
  const tagsBackend: MemoryTagsBackend = {
    list: record('tags.list', [TAG]),
    pending: record('tags.pending', []),
    counts: record('tags.counts', []),
    decide: record('tags.decide', [TAG.id]),
    add: record('tags.add', TAG),
    forSessionKeys: record('tags.forSessionKeys', new Map([['s1', [TAG]]])),
    taxonomy: record('tags.taxonomy', []),
    ...tags,
  }
  const backend: MemoryBackend = {
    capture: record('capture', { ok: true as const, conversation_id: 'c1', inserted: 1, skipped: 0 }),
    search: record('search', { query: 'q', scope: 'both' as const, degraded: null, results: [] }),
    browse: async (filter) => {
      calls.push(['browse', filter])
      if (filter.window === 'someday') throw new MemoryRequestError('Unknown window="someday"')
      return { messages: [] }
    },
    stats: async () => {
      throw new Error('disk on fire')
    },
    health: record('health', {
      status: 'ok' as const,
      embeddings: { status: 'ok' as const },
      embedQueueDepth: 0,
    }),
    tools: () => [
      {
        name: 'memory_stats',
        description: '',
        parameters: {},
        execute: async (args) => `stats for ${String(args.agent)}`,
      },
    ],
    tags: () => tagsBackend,
  }
  return { backend, calls }
}

describe('backend memory routes', () => {
  let server: Server | undefined
  afterEach(async () => {
    await new Promise<void>((done) => (server ? server.close(() => done()) : done()))
    server = undefined
  })

  async function serve(backend: MemoryBackend): Promise<string> {
    const routes = [createBackendCaptureRoute(backend), createBackendMemoryRoute(backend)]
    server = createServer((req, res) => {
      const route = routes.find((r) => (req.url ?? '').startsWith(r.prefix))
      if (!route) {
        res.writeHead(404).end()
        return
      }
      void route.handler(req, res)
    })
    await new Promise<void>((done) => server?.listen(0, '127.0.0.1', done))
    return `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
  }

  const post = (url: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> =>
    fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    })

  it('captures a valid batch and rejects a bad one before the backend sees it', async () => {
    const { backend, calls } = fakeBackend()
    const base = await serve(backend)
    const batch = {
      session_key: 's1',
      agent: 'rivet',
      messages: [{ event_id: 'e1', role: 'user', content: 'hello' }],
    }
    const ok = await post(`${base}/api/capture`, batch)
    expect(ok.status).toBe(200)
    expect(await ok.json()).toEqual({ ok: true, conversation_id: 'c1', inserted: 1, skipped: 0 })
    expect(calls).toEqual([['capture', batch, { allowFilesystem: true }]])

    const bad = await post(`${base}/api/capture`, { ...batch, messages: [{ role: 'user', content: 'x' }] })
    expect(bad.status).toBe(400)
    expect(await bad.json()).toEqual({ error: 'messages[0].event_id is required' })
    expect((await post(`${base}/api/capture`, '{nope')).status).toBe(400)
    expect((await fetch(`${base}/api/capture`)).status).toBe(405)
    expect((await post(`${base}/api/capture`, 'x'.repeat(1024 * 1024 + 10))).status).toBe(413)
    expect(calls).toHaveLength(1)
  })

  it('refuses a request stamped for a routed user on every route: it never reaches the owner store', async () => {
    const { backend, calls } = fakeBackend()
    const base = await serve(backend)
    const stamped = { [TRUSTED_USER_HEADER]: 'alice' }
    const capture = await post(
      `${base}/api/capture`,
      { session_key: 's', agent: 'a', messages: [] },
      stamped,
    )
    expect(capture.status).toBe(503)
    expect(await capture.json()).toEqual({ error: 'memory is not available for user "alice"' })
    for (const path of ['search?q=x', 'browse', 'stats', 'health', 'tags', 'tags/pending']) {
      expect((await fetch(`${base}/api/memory/${path}`, { headers: stamped })).status).toBe(503)
    }
    expect((await post(`${base}/api/memory/tool/memory_stats`, {}, stamped)).status).toBe(503)
    expect((await post(`${base}/api/memory/tags/decide`, { ids: [TAG.id], state: 'accepted' }, stamped)).status).toBe(503)
    expect(calls).toEqual([])
  })

  it('search and browse pass clamped, validated parameters', async () => {
    const { backend, calls } = fakeBackend()
    const base = await serve(backend)
    expect((await fetch(`${base}/api/memory/search`)).status).toBe(400)
    expect((await fetch(`${base}/api/memory/search?q=x&tag=nocolon`)).status).toBe(400)
    expect((await fetch(`${base}/api/memory/search?q=%20deploy%20&scope=weird&limit=999&tag=project:acmeapp`)).status).toBe(200)
    expect(calls.at(-1)).toEqual(['search', 'deploy', { scope: 'both', limit: 50, tag: 'project:acmeapp' }])

    expect((await fetch(`${base}/api/memory/browse?role=user&tool_name=Bash&limit=0&window=today`)).status).toBe(200)
    expect(calls.at(-1)).toEqual([
      'browse',
      {
        role: 'user',
        agent: undefined,
        toolName: 'Bash',
        tag: undefined,
        window: 'today',
        since: undefined,
        before: undefined,
        limit: 1,
      },
    ])
    // A request the backend calls wrong is a 400; a backend failure is a 500.
    const window = await fetch(`${base}/api/memory/browse?window=someday`)
    expect(window.status).toBe(400)
    expect(await window.json()).toEqual({ error: 'Unknown window="someday"' })
    expect((await fetch(`${base}/api/memory/stats`)).status).toBe(500)
    expect((await fetch(`${base}/api/memory/health`)).status).toBe(200)
    expect((await fetch(`${base}/api/memory/nope`)).status).toBe(404)
    expect((await post(`${base}/api/memory/search?q=x`, {})).status).toBe(405)
  })

  it('runs a named tool and 404s an unknown one', async () => {
    const { backend } = fakeBackend()
    const base = await serve(backend)
    const res = await post(`${base}/api/memory/tool/memory_stats`, { agent: 'rivet' })
    expect(await res.json()).toEqual({ ok: true, result: 'stats for rivet' })
    expect((await post(`${base}/api/memory/tool/memory_nope`, {})).status).toBe(404)
    expect((await post(`${base}/api/memory/tool/memory_stats`, '[1]')).status).toBe(400)
    expect((await fetch(`${base}/api/memory/tool/memory_stats`)).status).toBe(405)
  })

  it('serves the tag review loop with the same validation as the Postgres route', async () => {
    const { backend, calls } = fakeBackend()
    const base = await serve(backend)
    expect((await fetch(`${base}/api/memory/tags?state=bogus`)).status).toBe(400)
    expect((await fetch(`${base}/api/memory/tags?entity_id=not-a-uuid`)).status).toBe(400)
    const list = await fetch(`${base}/api/memory/tags?key=project&state=accepted,suggested`)
    expect(((await list.json()) as { tags: unknown[] }).tags).toHaveLength(1)
    expect(calls.at(-1)).toEqual([
      'tags.list',
      { entityId: undefined, key: 'project', value: undefined, states: ['accepted', 'suggested'], limit: 200 },
    ])

    expect((await post(`${base}/api/memory/tags/decide`, { ids: ['x'], state: 'accepted' })).status).toBe(400)
    expect((await post(`${base}/api/memory/tags/decide`, { ids: [TAG.id], state: 'maybe' })).status).toBe(400)
    const decided = await post(`${base}/api/memory/tags/decide`, { ids: [TAG.id], state: 'rejected', decided_by: ' alice ' })
    expect(await decided.json()).toEqual({ changed: [TAG.id] })
    expect(calls.at(-1)).toEqual(['tags.decide', [TAG.id], 'rejected', 'alice'])

    expect((await post(`${base}/api/memory/tags/add`, { entity_type: 'conversation' })).status).toBe(400)
    await post(`${base}/api/memory/tags/add`, { entity_type: 'conversation', session_key: 's1', tag: 'project:acmeapp' })
    expect(calls.at(-1)?.[2]).toBe('owner')

    const lookup = await post(`${base}/api/memory/tags/lookup`, { session_keys: ['s1'] })
    expect(Object.keys(((await lookup.json()) as { sessions: object }).sessions)).toEqual(['s1'])
  })

  it('answers 501 for vocabulary edits a backend does not offer, and runs them when it does', async () => {
    const base = await serve(fakeBackend().backend)
    const res = await post(`${base}/api/memory/tags/taxonomy`, { key: 'project', value: 'acmeapp' })
    expect(res.status).toBe(501)
    expect((await post(`${base}/api/memory/tags/taxonomy/merge`, { key: 'k', from: 'a', into: 'b' })).status).toBe(501)
    await new Promise<void>((done) => server?.close(() => done()))

    const withEdits = fakeBackend({
      mergeTaxonomy: async (_key, _from, into) => ({ moved: 2, dropped: 0, into }),
    })
    const base2 = await serve(withEdits.backend)
    const merged = await post(`${base2}/api/memory/tags/taxonomy/merge`, { key: 'k', from: 'a', into: 'b' })
    expect(await merged.json()).toEqual({ moved: 2, dropped: 0, into: 'b' })
  })
})

describe('parseCaptureBatch', () => {
  const base = { session_key: 's', agent: 'a', messages: [] as unknown[] }
  it('accepts the full shape and keeps only known fields', () => {
    const parsed = parseCaptureBatch({
      ...base,
      channel: 'cli',
      title: 't',
      settings: { cwd: '/work' },
      task_id: 'T1',
      finalize: true,
      extra: 'dropped',
      messages: [
        {
          event_id: 'e',
          role: 'tool',
          content: '',
          tool_name: 'Bash',
          tool_args: { cmd: 'ls' },
          tool_result: 'ok',
          metadata: { source: 'hook' },
          created_at: '2026-10-04T10:00:00+02:00',
          junk: 1,
        },
      ],
    })
    expect(parsed).toEqual({
      session_key: 's',
      agent: 'a',
      channel: 'cli',
      title: 't',
      settings: { cwd: '/work' },
      task_id: 'T1',
      finalize: true,
      messages: [
        {
          event_id: 'e',
          role: 'tool',
          content: '',
          tool_name: 'Bash',
          tool_args: { cmd: 'ls' },
          tool_result: 'ok',
          metadata: { source: 'hook' },
          created_at: '2026-10-04T10:00:00+02:00',
        },
      ],
    })
  })

  it.each([
    [{ ...base, session_key: '  ' }, 'session_key is required'],
    [{ ...base, agent: 7 }, 'agent is required'],
    [{ ...base, settings: [] }, 'settings must be an object'],
    [{ ...base, messages: 'x' }, 'messages must be an array'],
    [{ ...base, messages: [{ event_id: 'e', role: 'robot', content: '' }] }, 'messages[0].role is invalid'],
    [{ ...base, messages: [{ event_id: 'e', role: 'user' }] }, 'messages[0].content must be a string'],
    [
      { ...base, messages: [{ event_id: 'e', role: 'user', content: '', created_at: '2026-10-04 10:00' }] },
      'messages[0].created_at must be an ISO timestamp with an offset',
    ],
    [[], 'body must be a JSON object'],
  ])('rejects %j', (body, message) => {
    expect(parseCaptureBatch(body)).toBe(message)
  })
})
