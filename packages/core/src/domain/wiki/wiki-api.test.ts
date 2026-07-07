/**
 * /api/wiki + /wiki (3e) — http-level over a fake WikiIndexLike and a real
 * tmpdir wiki repo (files parsed by wiki-core exactly as in prod).
 */

import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect, afterEach, beforeAll, afterAll } from 'vitest'
import { serializeWikiPage } from '@rivetos/wiki-core'
import { createWikiApiRoute, type WikiIndexLike } from './wiki-api.js'
import { createWikiHtmlRoute, renderMarkdown } from './wiki-html.js'

const TOPIC = {
  slug: 'rivetos-task-engine',
  title: 'RivetOS Task Engine',
  aliases: ['task-engine'],
  tags: ['rivetos'],
  entities: ['project:rivetos'],
  currentState: 'ros_tasks is the only engine. Port :5174.',
  gitSha: 'abc1234',
  lastVerifiedAt: '2026-07-07T00:00:00.000Z',
  updatedAt: '2026-07-07T00:00:00.000Z',
}

function fakeIndex(): WikiIndexLike {
  return {
    getTopic: async (slug) => (slug === TOPIC.slug ? TOPIC : undefined),
    listTopics: async () => ({ topics: [TOPIC], total: 1 }),
    searchTopics: async (q) => (q.toLowerCase().includes('task') ? [TOPIC] : []),
    gaps: async () => ({
      redLinks: [{ entity: 'host:ct999', referencedBy: [TOPIC.slug] }],
      stalest: [TOPIC],
    }),
  }
}

let wikiDir: string
beforeAll(() => {
  wikiDir = mkdtempSync(join(tmpdir(), 'wiki-api-'))
  mkdirSync(join(wikiDir, 'topics'), { recursive: true })
  writeFileSync(
    join(wikiDir, 'topics', `${TOPIC.slug}.md`),
    serializeWikiPage({
      meta: {
        title: TOPIC.title,
        slug: TOPIC.slug,
        aliases: TOPIC.aliases,
        tags: TOPIC.tags,
        entities: TOPIC.entities,
        lastVerified: TOPIC.lastVerifiedAt,
        sources: [{ kind: 'summary', ids: ['8f3a0000-0000-0000-0000-000000000001'] }],
      },
      currentState: TOPIC.currentState,
      history: [{ date: '2026-07-06', title: 'Cutover', body: '- shipped' }],
    }),
  )
})
afterAll(() => {
  rmSync(wikiDir, { recursive: true, force: true })
})

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn()
})

async function serve(): Promise<string> {
  const api = createWikiApiRoute({ index: fakeIndex(), wikiDir })
  const page = createWikiHtmlRoute({ index: fakeIndex(), wikiDir, nodeName: 'testnode' })
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const route = url.pathname.startsWith('/api/wiki') ? api : page
    void route.handler(req, res)
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  cleanups.push(() => new Promise((r) => server.close(r)))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

describe('/api/wiki', () => {
  it('index, search, and gaps', async () => {
    const base = await serve()
    const idx = (await (await fetch(`${base}/api/wiki`)).json()) as { total: number; topics: unknown[] }
    expect(idx.total).toBe(1)
    const search = (await (await fetch(`${base}/api/wiki?q=task+engine`)).json()) as {
      topics: Array<{ slug: string; excerpt: string }>
    }
    expect(search.topics[0].slug).toBe(TOPIC.slug)
    expect(search.topics[0].excerpt).toContain('only engine')
    const gaps = (await (await fetch(`${base}/api/wiki/gaps`)).json()) as {
      redLinks: Array<{ entity: string }>
    }
    expect(gaps.redLinks[0].entity).toBe('host:ct999')
  })

  it('full page merges file + index; raw serves markdown; 404s and validation', async () => {
    const base = await serve()
    const page = (await (await fetch(`${base}/api/wiki/${TOPIC.slug}`)).json()) as {
      currentState: string
      history: Array<{ date: string }>
      gitSha: string
      sources: Array<{ kind: string }>
      related: string[]
    }
    expect(page.currentState).toContain('only engine')
    expect(page.history[0].date).toBe('2026-07-06')
    expect(page.gitSha).toBe('abc1234')
    expect(page.sources[0].kind).toBe('summary')
    expect(page.related).not.toContain(TOPIC.slug)

    const raw = await fetch(`${base}/api/wiki/${TOPIC.slug}/raw`)
    expect(raw.headers.get('content-type')).toContain('text/markdown')
    expect(await raw.text()).toContain('## Current state')

    expect((await fetch(`${base}/api/wiki/no-such-page`)).status).toBe(404)
    expect((await fetch(`${base}/api/wiki/Bad_Slug!`)).status).toBe(400)
    expect((await fetch(`${base}/api/wiki`, { method: 'POST' })).status).toBe(405)
  })
})

describe('/wiki HTML', () => {
  it('index page shows gaps panel + topics; page renders state and history', async () => {
    const base = await serve()
    const index = await (await fetch(`${base}/wiki`)).text()
    expect(index).toContain('Gaps — worth a conversation')
    expect(index).toContain('host:ct999')
    expect(index).toContain(`/wiki/${TOPIC.slug}`)

    const page = await (await fetch(`${base}/wiki/${TOPIC.slug}`)).text()
    expect(page).toContain('Current state')
    expect(page).toContain('only engine')
    expect(page).toContain('2026-07-06')

    const missing = await fetch(`${base}/wiki/never-heard-of-it`)
    expect(missing.status).toBe(404)
    expect(await missing.text()).toContain('red link')
  })

  it('renderMarkdown escapes HTML and handles the subset', () => {
    const out = renderMarkdown(
      '# H\n- a **bold** `code`\n\n```\n<script>alert(1)</script>\n```\nsee [[other-topic]] and https://example.com',
    )
    expect(out).toContain('<h3>H</h3>')
    expect(out).toContain('<strong>bold</strong>')
    expect(out).toContain('&lt;script&gt;')
    expect(out).not.toContain('<script>')
    expect(out).toContain('href="/wiki/other-topic"')
    expect(out).toContain('href="https://example.com"')
  })
})
