/**
 * /api/wiki + /wiki (3e) — http-level over a fake WikiIndexLike and a real
 * tmpdir wiki repo (files parsed by wiki-core exactly as in prod).
 */

import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect, afterEach, beforeAll, afterAll, vi } from 'vitest'
import { CITATIONS_MAX, HISTORY_MAX, serializeWikiPage, SOURCES_MAX } from '@rivetos/wiki-core'
import { createWikiApiRoute, resolveWikiSurface, type WikiIndexLike } from './wiki-api.js'
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
      citations: [
        {
          summaryId: '8f3a0000-0000-0000-0000-000000000001',
          date: '2026-07-06',
          kind: 'leaf',
          note: 'cutover leaf',
        },
      ],
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
    const idx = (await (await fetch(`${base}/api/wiki`)).json()) as {
      total: number
      topics: unknown[]
    }
    expect(idx.total).toBe(1)
    const search = (await (await fetch(`${base}/api/wiki?q=task+engine`)).json()) as {
      topics: Array<{ slug: string; excerpt: string }>
    }
    expect(search.topics[0].slug).toBe(TOPIC.slug)
    expect(search.topics[0].excerpt).toContain('only engine')
    const gaps = (await (await fetch(`${base}/api/wiki/_gaps`)).json()) as {
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
    expect(await raw.text()).toMatch(/## (Summary|Current state)/)

    expect((await fetch(`${base}/api/wiki/no-such-page`)).status).toBe(404)
    expect((await fetch(`${base}/api/wiki/Bad_Slug!`)).status).toBe(400)
    expect((await fetch(`${base}/api/wiki`, { method: 'POST' })).status).toBe(405)
  })

  it('caps aliases/tags/entities on already-bloated hub pages', async () => {
    writeFileSync(join(wikiDir, 'topics', 'hub-bloat.md'), fatHubMarkdown())
    const base = await serve()
    const page = (await (await fetch(`${base}/api/wiki/hub-bloat`)).json()) as {
      aliases: string[]
      tags: string[]
      entities: string[]
      seeAlso: string[]
    }
    expect(page.aliases).toHaveLength(32)
    expect(page.aliases[0]).toBe('alias-0')
    expect(page.aliases).not.toContain('alias-49')
    expect(page.tags).toHaveLength(24)
    expect(page.entities).toHaveLength(32)
    expect(page.seeAlso.length).toBeLessThanOrEqual(48)
  })

  it('caps history/citations/sources on already-bloated hub pages', async () => {
    writeFileSync(join(wikiDir, 'topics', 'hub-provenance.md'), fatProvenanceMarkdown())
    const base = await serve()
    const page = (await (await fetch(`${base}/api/wiki/hub-provenance`)).json()) as {
      history: Array<{ title: string }>
      citations: Array<{ summaryId: string }>
      sources: Array<{ ids: string[] }>
    }
    expect(page.history).toHaveLength(HISTORY_MAX)
    expect(page.history[0].title).toBe('entry-0')
    expect(page.history.map((h) => h.title)).not.toContain(`entry-${HISTORY_MAX + 5}`)
    expect(page.citations).toHaveLength(CITATIONS_MAX)
    expect(page.sources).toHaveLength(SOURCES_MAX)
    // Oldest-first sources: JSON keeps the newest tail.
    expect(page.sources[0].ids[0]).toContain(String(20).padStart(12, '0'))
  })
})

describe('/wiki HTML', () => {
  it('index page shows gaps panel + topics; page renders state and history', async () => {
    const base = await serve()
    const index = await (await fetch(`${base}/wiki`)).text()
    expect(index).toContain('Gaps — worth a conversation')
    expect(index).toContain('host:ct999')
    expect(index).toContain(`/wiki/${TOPIC.slug}`)
    expect(index).toContain('RivetOS Wiki') // sidebar shell
    expect(index).toContain('/wiki/_recent')

    const page = await (await fetch(`${base}/wiki/${TOPIC.slug}`)).text()
    expect(page).toContain('only engine')
    expect(page).toContain('2026-07-06')
    expect(page).toContain('infobox')
    expect(page).toContain('?view=history')
    const history = await (await fetch(`${base}/wiki/${TOPIC.slug}?view=history`)).text()
    expect(history).toContain('Provenance')
    const raw = await fetch(`${base}/wiki/${TOPIC.slug}?view=raw`)
    expect(raw.headers.get('content-type')).toContain('text/markdown')
    const recent = await (await fetch(`${base}/wiki/_recent`)).text()
    expect(recent).toContain(TOPIC.slug)
    const rnd = await fetch(`${base}/wiki/_random`, { redirect: 'manual' })
    expect(rnd.status).toBe(302)

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
    const amp = renderMarkdown('see https://x.dev/?a=1&b=2 now')
    expect(amp).toContain('href="https://x.dev/?a=1&amp;b=2"')
  })

  it('infobox and catbar do not dump thousands of aliases/tags', async () => {
    writeFileSync(join(wikiDir, 'topics', 'hub-bloat.md'), fatHubMarkdown())
    const base = await serve()
    const html = await (await fetch(`${base}/wiki/hub-bloat`)).text()
    expect(html).toContain('alias-0')
    expect(html).toContain('alias-7')
    expect(html).not.toContain('alias-8')
    expect(html).toMatch(/\+42 more/)
    expect(html).toContain('tag-0')
    expect(html).not.toContain('tag-20')
    expect(html).toContain('Hub Bloat')
  })

  it('history view does not dump thousands of entries or sources', async () => {
    writeFileSync(join(wikiDir, 'topics', 'hub-provenance.md'), fatProvenanceMarkdown())
    const base = await serve()
    const html = await (await fetch(`${base}/wiki/hub-provenance?view=history`)).text()
    expect(html).toContain('entry-0')
    expect(html).toContain(`Showing ${String(HISTORY_MAX)} most recent of`)
    expect(html).not.toContain(`entry-${HISTORY_MAX + 5}`)
    expect(html).toMatch(/\+\d[\d,]* older sources omitted/)
    expect(html).not.toContain('00000000-0000-0000-0000-000000000000')
    expect(html).toContain(`00000000-0000-0000-0000-${String(SOURCES_MAX + 19).padStart(12, '0')}`)
  })
})

describe('per-user routing (x-rivetos-user)', () => {
  const COCO_TOPIC = {
    ...TOPIC,
    slug: 'coco-first-topic',
    title: 'Coco First Topic',
    currentState: 'Coco-only wiki content.',
  }
  const cocoIndex = (): WikiIndexLike => ({
    getTopic: async (slug) => (slug === COCO_TOPIC.slug ? COCO_TOPIC : undefined),
    listTopics: async () => ({ topics: [COCO_TOPIC], total: 1 }),
    searchTopics: async () => [COCO_TOPIC],
    gaps: async () => ({ redLinks: [], stalest: [COCO_TOPIC] }),
  })

  let cocoDir: string
  beforeAll(() => {
    cocoDir = mkdtempSync(join(tmpdir(), 'wiki-coco-'))
    mkdirSync(join(cocoDir, 'topics'), { recursive: true })
    writeFileSync(
      join(cocoDir, 'topics', `${COCO_TOPIC.slug}.md`),
      serializeWikiPage({
        meta: {
          title: COCO_TOPIC.title,
          slug: COCO_TOPIC.slug,
          aliases: [],
          tags: ['coco'],
          entities: [],
          sources: [],
        },
        currentState: COCO_TOPIC.currentState,
        history: [],
        citations: [],
      }),
    )
  })
  afterAll(() => rmSync(cocoDir, { recursive: true, force: true }))

  const forUser = (userId: string): { index: WikiIndexLike; wikiDir: string } | null =>
    userId === 'coco' ? { index: cocoIndex(), wikiDir: cocoDir } : null

  async function serveRouted(): Promise<string> {
    const api = createWikiApiRoute({ index: fakeIndex(), wikiDir, forUser })
    const page = createWikiHtmlRoute({ index: fakeIndex(), wikiDir, nodeName: 'testnode', forUser })
    const server: Server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const route = url.pathname.startsWith('/api/wiki') ? api : page
      void route.handler(req, res)
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    cleanups.push(() => new Promise((r) => server.close(r)))
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  }

  const routed = { headers: { 'x-rivetos-user': 'coco' } }

  it('routes the index, page file, and HTML view by the stamped user', async () => {
    const base = await serveRouted()
    const owner = (await (await fetch(`${base}/api/wiki`)).json()) as {
      topics: Array<{ slug: string }>
    }
    expect(owner.topics[0].slug).toBe(TOPIC.slug)
    const coco = (await (await fetch(`${base}/api/wiki`, routed)).json()) as {
      topics: Array<{ slug: string }>
    }
    expect(coco.topics[0].slug).toBe(COCO_TOPIC.slug)

    // page content comes from the routed user's file root
    const pageRes = (await (
      await fetch(`${base}/api/wiki/${COCO_TOPIC.slug}`, routed)
    ).json()) as { currentState: string }
    expect(pageRes.currentState).toContain('Coco-only')
    // …and the owner's root does not serve it
    expect((await fetch(`${base}/api/wiki/${COCO_TOPIC.slug}`)).status).toBe(404)

    const html = await (await fetch(`${base}/wiki`, routed)).text()
    expect(html).toContain(COCO_TOPIC.title)
    expect(html).not.toContain(TOPIC.title)
  })

  it('refuses an unknown stamped user on both surfaces — never the owner wiki', async () => {
    const base = await serveRouted()
    const stranger = { headers: { 'x-rivetos-user': 'stranger' } }
    expect((await fetch(`${base}/api/wiki`, stranger)).status).toBe(503)
    expect((await fetch(`${base}/wiki`, stranger)).status).toBe(503)
  })

  it('keeps the owner surfaces owner-only under the forUser injection', async () => {
    const base = await serveRouted()
    const ownerHtml = await (await fetch(`${base}/wiki`)).text()
    expect(ownerHtml).toContain(TOPIC.title)
    expect(ownerHtml).not.toContain(COCO_TOPIC.title)
  })

  it('serves the /wiki/:slug article from the routed file root only', async () => {
    const base = await serveRouted()
    const routedArticle = await fetch(`${base}/wiki/${COCO_TOPIC.slug}`, routed)
    expect(routedArticle.status).toBe(200)
    expect(await routedArticle.text()).toContain('Coco-only')
    expect((await fetch(`${base}/wiki/${COCO_TOPIC.slug}`)).status).toBe(404)
  })

  it('refuses a present-but-malformed header instead of defaulting to owner', async () => {
    const base = await serveRouted()
    const emptyApi = await fetch(`${base}/api/wiki`, { headers: { 'x-rivetos-user': '' } })
    expect(emptyApi.status).toBe(503)
    const emptyHtml = await fetch(`${base}/wiki`, { headers: { 'x-rivetos-user': '' } })
    expect(emptyHtml.status).toBe(503)
    expect(emptyHtml.headers.get('content-type')).toContain('application/json')
    const emptyBody = (await emptyHtml.json()) as { error: string }
    expect(emptyBody.error).toBe('malformed routing identity')
    expect(JSON.stringify(emptyBody)).not.toContain(TOPIC.title)

    // duplicated header (array form) via direct handler invocation, both surfaces
    const badHeaders = { 'x-rivetos-user': ['coco', 'phil'] }
    for (const route of [
      createWikiApiRoute({ index: fakeIndex(), wikiDir, forUser }),
      createWikiHtmlRoute({ index: fakeIndex(), wikiDir, forUser }),
    ]) {
      let code = 0
      let body = ''
      await route.handler(
        { method: 'GET', url: route.prefix, headers: badHeaders } as never,
        {
          writeHead: (c: number) => {
            code = c
          },
          end: (b?: unknown) => {
            body = typeof b === 'string' ? b : ''
          },
        } as never,
      )
      expect(code).toBe(503)
      expect(body).not.toContain(TOPIC.title)
    }
  })

  it('refuses hostile stamped userIds before any lookup or path join', async () => {
    const base = await serveRouted()
    for (const evil of ['..', '../..', 'coco/../../..', '/etc/passwd', '%2e%2e']) {
      const headers = { 'x-rivetos-user': evil }
      const api = await fetch(`${base}/api/wiki`, { headers })
      expect(api.status).toBe(503)
      expect(await api.text()).not.toContain(TOPIC.slug)
      const html = await fetch(`${base}/wiki`, { headers })
      expect(html.status).toBe(503)
      expect(html.headers.get('content-type')).toContain('application/json')
      const htmlBody = await html.text()
      expect((JSON.parse(htmlBody) as { error: string }).error).toBe('invalid routing identity')
      expect(htmlBody).not.toContain(TOPIC.title)
      expect(htmlBody).not.toContain('Port :5174')
      const file = await fetch(`${base}/wiki/${TOPIC.slug}`, { headers })
      expect(file.status).toBe(503)
      expect(await file.text()).not.toContain('ros_tasks')
    }
  })

  it('resolveWikiSurface: refusal classes split by message, guard proven load-bearing', () => {
    // A stub that would happily serve ANY id — if the unsafe-id regex were
    // deleted, '..' would fall through to this and the test would fail on
    // the message (not silently pass via unknown-503). #584 audit item 1.
    const promiscuous = vi.fn(() => ({ index: fakeIndex(), wikiDir: '/never' }))
    const opts = { index: fakeIndex(), forUser: promiscuous }

    const ok = resolveWikiSurface(opts, '/owner', {})
    expect(ok).toEqual({ ok: true, index: opts.index, wikiDir: '/owner' })

    // malformed header shapes
    for (const headers of [
      { 'x-rivetos-user': '' },
      { 'x-rivetos-user': ['coco', 'phil'] as never },
    ]) {
      const r = resolveWikiSurface(opts, '/owner', headers)
      expect(r).toEqual({ ok: false, error: 'malformed routing identity' })
    }

    // unsafe ids: refused BEFORE forUser — the promiscuous stub must never run
    const unsafe = ['..', '../..', 'a/b', 'a\\b', '.hidden', '/etc/passwd', '%2e%2e', 'a\0b']
    for (const bad of unsafe) {
      const r = resolveWikiSurface(opts, '/owner', { 'x-rivetos-user': bad })
      expect(r).toEqual({ ok: false, error: 'invalid routing identity' })
    }
    expect(promiscuous).not.toHaveBeenCalled()

    // dotted-but-safe id reaches forUser (regex allows interior dots, not '..')
    const dotted = resolveWikiSurface(opts, '/owner', { 'x-rivetos-user': 'foo.bar' })
    expect(dotted.ok).toBe(true)
    expect(promiscuous).toHaveBeenCalledTimes(1)

    // safe unknown id: distinct message via the real forUser
    const stranger = resolveWikiSurface(
      { index: fakeIndex(), forUser },
      '/owner',
      { 'x-rivetos-user': 'stranger' },
    )
    expect(stranger).toEqual({ ok: false, error: 'wiki is not available for user "stranger"' })

    const coco = resolveWikiSurface({ index: fakeIndex(), forUser }, '/owner', {
      'x-rivetos-user': 'coco',
    })
    expect(coco.ok && coco.wikiDir === cocoDir).toBe(true)
  })
})

function fatHubMarkdown(): string {
  const aliases = Array.from({ length: 50 }, (_, i) => `  - alias-${i}`).join('\n')
  const tags = Array.from({ length: 40 }, (_, i) => `  - tag-${i}`).join('\n')
  const entities = Array.from({ length: 40 }, (_, i) => `  - ent:${i}`).join('\n')
  const related = Array.from({ length: 60 }, (_, i) => `  - rel-${i}`).join('\n')
  return `---
title: Hub Bloat
slug: hub-bloat
aliases:
${aliases}
tags:
${tags}
entities:
${entities}
related:
${related}
sources: []
---

## Summary

Lead about a hub topic.

## History

### 2026-08-22 — Grew too big

- extractor unioned every synonym
`
}

function fatProvenanceMarkdown(): string {
  const sources = Array.from({ length: SOURCES_MAX + 20 }, (_, i) => {
    const id = `00000000-0000-0000-0000-${String(i).padStart(12, '0')}`
    return `  - kind: summary\n    ids:\n      - ${id}`
  }).join('\n')
  const history = Array.from(
    { length: HISTORY_MAX + 20 },
    (_, i) => `### 2026-08-22 — entry-${i}\n\n- note ${i}\n`,
  ).join('\n')
  const citations = [
    '| Date | Kind | Summary | Note |',
    '|------|------|---------|------|',
    ...Array.from({ length: CITATIONS_MAX + 10 }, (_, i) => {
      const id = `11111111-1111-1111-1111-${String(i).padStart(12, '0')}`
      return `| 2026-08-22 | leaf | \`${id}\` | c-${i} |`
    }),
  ].join('\n')
  return `---
title: Hub Provenance
slug: hub-provenance
aliases: []
tags: []
entities: []
related: []
sources:
${sources}
---

## Summary

Lead about a hub topic whose provenance lists grew without a ceiling.

## History

${history}

## Citations

${citations}
`
}
