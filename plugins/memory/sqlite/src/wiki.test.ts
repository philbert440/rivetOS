/**
 * The wiki on SQLite: the topic index, extraction from leaf summaries into
 * git-backed page files, topic embeddings and the wiki section of the turn
 * context. Real in-memory database, real git repository in a temp dir, fake
 * chat and embedding endpoints.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { applyPatch, type WikiPage } from '@rivetos/wiki-core'
import { WIKI_EXTRACT_SYSTEM_PROMPT, WIKI_PIPELINE_VERSION } from '@rivetos/memory-core'
import { SqliteMemory } from './adapter.js'
import type { SqliteWikiIndex } from './wiki.js'

const noWait = async (): Promise<void> => {}

function page(over: {
  slug: string
  title: string
  aliases?: string[]
  tags?: string[]
  entities?: string[]
  summary?: string
  article?: string
}): WikiPage {
  return applyPatch(undefined, {
    action: 'create',
    slug: over.slug,
    title: over.title,
    addAliases: over.aliases,
    addTags: over.tags,
    addEntities: over.entities,
    currentState: over.summary ?? `${over.title} is described here.`,
    article: over.article,
    verifiedAt: '2026-10-01T00:00:00.000Z',
  })
}

const LEAF =
  'The team decided to deploy the acmeapp service with a blue-green rollout. The release branch is cut on ' +
  'Mondays, the deploy script runs from the release branch, and a health check gates the traffic switch. ' +
  'Rollback is a traffic switch back to the previous colour.'

const PATCH = [
  {
    action: 'create',
    slug: 'acmeapp-deploys',
    title: 'Acmeapp deploys',
    aliases: ['acmeapp-rollout'],
    tags: ['deploy'],
    entities: ['project:acmeapp'],
    summary: 'Acmeapp is deployed blue-green from the release branch; a health check gates the switch.',
    article: '## Process\nCut the release branch on Monday, run the deploy script, watch the health check.',
    history_entry: { date: '2026-10-04', title: 'Blue-green adopted', body: 'Decided to deploy blue-green.' },
  },
]

function fakeChat(wikiAnswer: () => { content?: string; status?: number }) {
  const calls: Array<{ system: string; user: string }> = []
  const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> }
    const system = body.messages[0].content
    calls.push({ system, user: body.messages[1].content })
    const out = system === WIKI_EXTRACT_SYSTEM_PROMPT ? wikiAnswer() : { content: LEAF }
    if (out.status && out.status !== 200) return new Response('no', { status: out.status })
    return Response.json({ choices: [{ finish_reason: 'stop', message: { content: out.content } }] })
  })
  return { fetch: fetch as unknown as typeof globalThis.fetch, calls }
}

describe('SqliteWikiIndex', () => {
  let memory: SqliteMemory
  let index: SqliteWikiIndex
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rivet-sqlite-wiki-'))
    memory = new SqliteMemory({ path: ':memory:', log: () => {}, wiki: { dir } })
    const wiki = memory.wiki()
    if (!wiki) throw new Error('no wiki')
    index = wiki.index
    index.upsertTopic(
      page({
        slug: 'acmeapp-deploys',
        title: 'Acmeapp deploys',
        aliases: ['acmeapp-rollout'],
        tags: ['deploy'],
        entities: ['project:acmeapp', 'tool:deploy_script'],
        summary: 'Acmeapp is deployed blue-green from the release branch.',
      }),
      'sha1',
    )
    index.upsertTopic(
      page({
        slug: 'staging-database',
        title: 'Staging database',
        tags: ['infra'],
        entities: ['project:acmeapp'],
        summary: 'The staging database is restored from a nightly snapshot.',
      }),
    )
  })
  afterEach(() => {
    memory.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('has no wiki without a directory', () => {
    const bare = new SqliteMemory({ path: ':memory:', log: () => {} })
    expect(bare.wiki()).toBeUndefined()
    expect(bare.backend().wiki()).toBeUndefined()
    bare.close()
  })

  it('gets, lists and filters topics', async () => {
    const topic = await index.getTopic('Acmeapp Deploys')
    expect(topic).toMatchObject({
      slug: 'acmeapp-deploys',
      title: 'Acmeapp deploys',
      aliases: ['acmeapp-rollout'],
      tags: ['deploy'],
      gitSha: 'sha1',
      currentState: 'Acmeapp is deployed blue-green from the release branch.',
    })
    expect(await index.getTopic('nope')).toBeUndefined()
    const all = await index.listTopics()
    expect(all.total).toBe(2)
    expect((await index.listTopics({ tag: 'infra' })).topics.map((t) => t.slug)).toEqual(['staging-database'])
    expect((await index.listTopics({ entity: 'project:acmeapp' })).total).toBe(2)
    expect((await index.listTopics({ limit: 1, offset: 1 })).topics).toHaveLength(1)
    expect(index.listAllSlugs()).toEqual(['acmeapp-deploys', 'staging-database'])
  })

  it('searches by text, by title and by alias', async () => {
    expect((await index.searchTopics('nightly snapshot restore'))[0].slug).toBe('staging-database')
    expect((await index.searchTopics('Acmeapp deploys'))[0].slug).toBe('acmeapp-deploys')
    expect((await index.searchTopics('acmeapp-rollout'))[0].slug).toBe('acmeapp-deploys')
    expect(await index.searchTopics('zzzz qqqq')).toEqual([])
    expect(await index.searchTopics('   ')).toEqual([])
    // Operators and quotes in a query are text, not syntax.
    expect(await index.searchTopics('"unbalanced AND (')).toEqual([])
    // A query with no ASCII letters or digits has no slug form. It must not
    // match every topic through an empty pattern.
    for (const q of ['日本語のメモ', '😀😀😀', '---', 'ÄÖÜ']) {
      expect(await index.searchTopics(q)).toEqual([])
    }
    // A non-ASCII title is still found by its own text.
    index.upsertTopic(page({ slug: 'nihongo-notes', title: '日本語のメモ', summary: 'Notes kept in Japanese.' }))
    expect((await index.searchTopics('日本語のメモ')).map((h) => h.slug)).toEqual(['nihongo-notes'])
  })

  it('resolves a proposed slug to the topic it already is', async () => {
    index.setRedirect('acme-releases', 'acmeapp-deploys')
    const reason = async (slug: string, opts?: { entities?: string[] }): Promise<string> => {
      const r = await index.resolveTopicIdentity(slug, opts)
      return `${r.reason}:${r.match?.slug ?? '-'}`
    }
    expect(await reason('acmeapp-deploys')).toBe('exact:acmeapp-deploys')
    expect(await reason('acme-releases')).toBe('redirect:acmeapp-deploys')
    expect(await reason('acmeapp-rollout')).toBe('alias:acmeapp-deploys')
    expect(await reason('brand-new', { entities: ['tool:deploy_script'] })).toBe('entity:acmeapp-deploys')
    expect(await reason('staging-database-restore')).toBe('stem:staging-database')
    expect(await reason('totally-unrelated-thing')).toBe('none:-')
    expect(await index.followRedirect('acme-releases')).toBe('acmeapp-deploys')
    expect((await index.getTopic('acme-releases'))?.slug).toBe('acmeapp-deploys')

    expect(await index.gateTopicWrite('acmeapp-rollout', 'create')).toEqual({
      slug: 'acmeapp-deploys',
      action: 'update',
      reason: 'alias',
    })
    expect(await index.gateTopicWrite('Fresh Topic', 'update')).toEqual({
      slug: 'fresh-topic',
      action: 'create',
      reason: 'none',
    })
  })

  it('a redirect loop ends instead of spinning', async () => {
    index.setRedirect('a-loop', 'acmeapp-deploys')
    memory.rawForTest(`INSERT INTO ros_wiki_redirects (from_slug, to_slug, created_at)
                       VALUES ('acmeapp-deploys', 'staging-database', 'x'), ('staging-database', 'acmeapp-deploys', 'x')`)
    expect(['acmeapp-deploys', 'staging-database']).toContain(await index.followRedirect('a-loop'))
  })

  it('reports red links and the stalest pages', async () => {
    const gaps = await index.gaps({ staleLimit: 1 })
    // `tool:deploy_script` is named by one page and has no page at `deploy-script`.
    expect(gaps.redLinks).toEqual([{ entity: 'tool:deploy_script', referencedBy: ['acmeapp-deploys'] }])
    expect(gaps.stalest).toHaveLength(1)
    index.upsertTopic(page({ slug: 'deploy-script', title: 'Deploy script' }))
    expect((await index.gaps()).redLinks).toEqual([])
  })

  it('records extractions, provenance, citations and deletes with their rows', () => {
    memory.rawForTest(`INSERT INTO ros_conversations (id, session_key, agent, created_at, updated_at)
                       VALUES ('c1', 's', 'rivet', 'x', 'x')`)
    memory.rawForTest(`INSERT INTO ros_summaries (id, conversation_id, content, created_at)
                       VALUES ('sum-1', 'c1', 'text', 'x')`)
    expect(index.extractionDone('sum-1')).toBe(false)
    index.markExtraction({ summaryId: 'sum-1', status: 'failed', pipelineVersion: WIKI_PIPELINE_VERSION, error: 'x' })
    expect(index.extractionDone('sum-1')).toBe(false)
    index.markExtraction({ summaryId: 'sum-1', status: 'done', pipelineVersion: WIKI_PIPELINE_VERSION - 1 })
    expect(index.extractionDone('sum-1')).toBe(false)
    index.markExtraction({ summaryId: 'sum-1', status: 'done', pipelineVersion: WIKI_PIPELINE_VERSION })
    expect(index.extractionDone('sum-1')).toBe(true)
    index.markExtraction({ summaryId: 'sum-1', status: 'skipped', pipelineVersion: 1 })
    expect(index.extractionDone('sum-1')).toBe(true)

    index.recordProvenance('acmeapp-deploys', [{ kind: 'summary', ids: ['sum-1', 'sum-1'], conversationId: 'c1' }])
    index.recordCitations('acmeapp-deploys', [{ summaryId: 'sum-1', kind: 'leaf', note: 'n' }])
    index.recordCitations('acmeapp-deploys', [{ summaryId: 'sum-1' }])
    expect(memory.countForTest('ros_wiki_provenance')).toBe(1)
    expect(memory.countForTest('ros_wiki_citations')).toBe(1)
    index.deleteTopic('acmeapp-deploys')
    expect(memory.countForTest('ros_wiki_provenance')).toBe(0)
    expect(memory.countForTest('ros_wiki_citations')).toBe(0)
    expect(index.listAllSlugs()).toEqual(['staging-database'])
  })
})

describe('wiki extraction on the job loop', () => {
  let memory: SqliteMemory
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rivet-sqlite-wiki-'))
  })
  afterEach(() => {
    ;(memory as SqliteMemory | undefined)?.close()
    rmSync(dir, { recursive: true, force: true })
  })

  async function fill(m: SqliteMemory, sessionId: string, count = 10): Promise<void> {
    for (let i = 0; i < count; i += 1) {
      await m.append({
        sessionId,
        agent: 'rivet',
        channel: 'cli',
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: `message number ${String(i)} about deploying the acmeapp service`,
      })
    }
  }

  async function drain(m: SqliteMemory): Promise<void> {
    for (let i = 0; i < 10 && (await m.runJobs()) > 0; i += 1) {
      // compaction, then extraction, then embedding
    }
  }

  it('mines a leaf summary into a page file, indexes it, and feeds the turn context', async () => {
    const chat = fakeChat(() => ({ content: JSON.stringify(PATCH) }))
    memory = new SqliteMemory({
      path: ':memory:',
      workers: false,
      log: () => {},
      wiki: { dir, extraction: true },
      compactor: { endpoint: 'https://llm.test/v1', model: 'm', fetch: chat.fetch, sleep: noWait },
    })
    await fill(memory, 's1')
    await memory.tags().add({ entityType: 'conversation', sessionKey: 's1', tag: 'project:acmeapp' }, 'owner')
    await drain(memory)

    // The page is a file in a git repository.
    const file = join(dir, 'topics', 'acmeapp-deploys.md')
    expect(existsSync(file)).toBe(true)
    expect(readFileSync(file, 'utf8')).toMatch(/blue-green/)
    expect(existsSync(join(dir, '.git'))).toBe(true)

    const wiki = memory.wiki()
    const topic = await wiki?.index.getTopic('acmeapp-deploys')
    expect(topic).toMatchObject({ title: 'Acmeapp deploys', tags: ['deploy'], entities: ['project:acmeapp'] })
    expect(topic?.gitSha).toMatch(/^[0-9a-f]{40}$/)
    expect(memory.countForTest('ros_wiki_provenance')).toBe(1)
    expect(memory.countForTest('ros_wiki_citations')).toBe(1)
    expect(memory.countForTest('ros_wiki_extractions')).toBe(1)

    // The extraction prompt carried the reviewed tag and the summary.
    const prompt = chat.calls.find((c) => c.system === WIKI_EXTRACT_SYSTEM_PROMPT)?.user ?? ''
    expect(prompt).toMatch(/project:acmeapp/)
    expect(prompt).toMatch(/blue-green rollout/)

    // Nothing is mined twice.
    const before = chat.calls.length
    wiki?.extractor?.enqueueBackfill()
    await drain(memory)
    expect(chat.calls.length).toBe(before)

    const context = await memory.getContextForTurn('deploying acmeapp service', 'rivet')
    expect(context).toMatch(/## Wiki \(curated state\)\n\*\*Acmeapp deploys\*\* \(wiki:acmeapp-deploys\)/)
    // Curated state comes after the recent turns and before raw recall.
    expect(context.indexOf('## Recent')).toBeLessThan(context.indexOf('## Wiki'))
    const relevant = context.indexOf('## Relevant Context')
    if (relevant !== -1) expect(context.indexOf('## Wiki')).toBeLessThan(relevant)
  })

  it('a second summary about the same thing updates the page it already has', async () => {
    let n = 0
    const chat = fakeChat(() => {
      n += 1
      return {
        content: JSON.stringify(
          n === 1
            ? PATCH
            : [
                {
                  action: 'create',
                  slug: 'acmeapp-rollout',
                  title: 'Acmeapp rollout',
                  summary_delta: 'Rollback is a switch back to the previous colour.',
                  history_entry: { date: '2026-10-05', title: 'Rollback noted', body: 'Rollback documented.' },
                },
              ],
        ),
      }
    })
    memory = new SqliteMemory({
      path: ':memory:',
      workers: false,
      log: () => {},
      wiki: { dir, extraction: true },
      compactor: { endpoint: 'https://llm.test/v1', model: 'm', fetch: chat.fetch, sleep: noWait },
    })
    await fill(memory, 's1')
    await drain(memory)
    await fill(memory, 's2')
    // The idle sweep ran moments ago; queue the second conversation directly.
    memory.enqueueCompactionForTest('s2', 'rivet')
    await drain(memory)
    const index = memory.wiki()?.index
    expect(index?.listAllSlugs()).toEqual(['acmeapp-deploys'])
    expect(existsSync(join(dir, 'topics', 'acmeapp-rollout.md'))).toBe(false)
    expect((await index?.getTopic('acmeapp-deploys'))?.historyCount).toBe(2)
    expect(memory.countForTest('ros_wiki_citations')).toBe(2)
  })

  it('an answer that is not JSON fails the job and is retried by the backfill a day later', async () => {
    let clock = new Date('2026-10-04T12:00:00Z')
    let broken = true
    const chat = fakeChat(() => ({ content: broken ? 'I could not find any topics, sorry.' : JSON.stringify(PATCH) }))
    const logs: string[] = []
    memory = new SqliteMemory({
      path: ':memory:',
      workers: false,
      log: (l) => logs.push(l),
      now: () => clock,
      wiki: { dir, extraction: true },
      compactor: { endpoint: 'https://llm.test/v1', model: 'm', fetch: chat.fetch, sleep: noWait },
    })
    await fill(memory, 's1')
    for (let i = 0; i < 4; i += 1) {
      await memory.runJobs()
      clock = new Date(clock.getTime() + 11 * 60_000)
    }
    expect(memory.wiki()?.index.listAllSlugs()).toEqual([])
    expect(memory.extractionStatusForTest()).toEqual(['failed'])
    expect(logs.join('\n')).toMatch(/extract-wiki .* failed .*not JSON/)

    broken = false
    // Within the day nothing is retried; after it the backfill revives the job.
    clock = new Date(clock.getTime() + 60 * 60_000)
    await drain(memory)
    expect(memory.extractionStatusForTest()).toEqual(['failed'])
    clock = new Date(clock.getTime() + 25 * 60 * 60_000)
    await drain(memory)
    expect(memory.extractionStatusForTest()).toEqual(['done'])
    expect(memory.wiki()?.index.listAllSlugs()).toEqual(['acmeapp-deploys'])
  })

  it('an empty array is a finished extraction with no topics', async () => {
    const chat = fakeChat(() => ({ content: '[]' }))
    memory = new SqliteMemory({
      path: ':memory:',
      workers: false,
      log: () => {},
      wiki: { dir, extraction: true },
      compactor: { endpoint: 'https://llm.test/v1', model: 'm', fetch: chat.fetch, sleep: noWait },
    })
    await fill(memory, 's1')
    await drain(memory)
    expect(memory.extractionStatusForTest()).toEqual(['done'])
    expect(existsSync(join(dir, 'topics'))).toBe(false)
  })

  it('without extraction turned on, summaries are written and nothing is mined', async () => {
    const chat = fakeChat(() => ({ content: JSON.stringify(PATCH) }))
    memory = new SqliteMemory({
      path: ':memory:',
      workers: false,
      log: () => {},
      wiki: { dir },
      compactor: { endpoint: 'https://llm.test/v1', model: 'm', fetch: chat.fetch, sleep: noWait },
    })
    await fill(memory, 's1')
    await drain(memory)
    expect(chat.calls.some((c) => c.system === WIKI_EXTRACT_SYSTEM_PROMPT)).toBe(false)
    expect(memory.countForTest('ros_wiki_extractions')).toBe(0)
    expect(memory.wiki()?.extractor).toBeUndefined()
  })

  it('embeds topics and finds them by meaning; a rewritten page is embedded again', async () => {
    const chat = fakeChat(() => ({ content: JSON.stringify(PATCH) }))
    const embedFetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { input: string[] }
      return Response.json({
        data: body.input.map((text, index) => ({
          index,
          embedding: [/deploy|release|shipping/i.test(text) ? 1 : 0.01, /database/i.test(text) ? 1 : 0.01, 0.01],
        })),
      })
    }) as unknown as typeof globalThis.fetch
    memory = new SqliteMemory({
      path: ':memory:',
      workers: false,
      log: () => {},
      wiki: { dir, extraction: true },
      embed: { endpoint: 'https://embed.test', model: 'toy', fetch: embedFetch, sleep: noWait },
      compactor: { endpoint: 'https://llm.test/v1', model: 'm', fetch: chat.fetch, sleep: noWait },
    })
    await fill(memory, 's1')
    await drain(memory)
    expect(memory.topicEmbedDimsForTest('acmeapp-deploys')).toBe(3)
    // No word in common with the page: only the vector leg can find it.
    const hits = await memory.wiki()?.index.searchTopics('shipping')
    expect(hits?.map((h) => h.slug)).toEqual(['acmeapp-deploys'])

    const index = memory.wiki()?.index
    index?.upsertTopic(page({ slug: 'acmeapp-deploys', title: 'Acmeapp deploys', summary: 'Rewritten: release notes.' }))
    expect(memory.topicEmbedDimsForTest('acmeapp-deploys')).toBe(0)
    await drain(memory)
    expect(memory.topicEmbedDimsForTest('acmeapp-deploys')).toBe(3)
  })
})

describe('wiki maintenance', () => {
  let memory: SqliteMemory
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rivet-sqlite-wiki-'))
  })
  afterEach(() => {
    ;(memory as SqliteMemory | undefined)?.close()
    rmSync(dir, { recursive: true, force: true })
  })

  async function seed(m: SqliteMemory, slug: string, title: string, summary: string): Promise<void> {
    const wiki = m.wiki()
    if (!wiki?.maintenance) throw new Error('no wiki')
    const writer = (wiki.maintenance as unknown as { writer: { ensureRepo(): Promise<void>; apply: (p: unknown, o: unknown) => Promise<{ page: WikiPage; gitSha: string }> } }).writer
    await writer.ensureRepo()
    const applied = await writer.apply(
      {
        action: 'create',
        slug,
        title,
        currentState: summary,
        historyEntry: { date: '2026-10-01', title: 'Created', body: `Created ${slug}.` },
        verifiedAt: '2026-10-01T00:00:00.000Z',
      },
      { summaryId: 'seed' },
    )
    wiki.index.upsertTopic(applied.page, applied.gitSha)
  }

  it('consolidate folds slug variants into one page, with redirects, and a dry run changes nothing', async () => {
    memory = new SqliteMemory({ path: ':memory:', log: () => {}, wiki: { dir } })
    await seed(memory, 'acmeapp-deploys', 'Acmeapp deploys', 'Deployed blue-green from the release branch.')
    await seed(memory, 'acmeapp-deploys-rollback', 'Acmeapp deploys rollback', 'Rollback is a traffic switch back.')
    await seed(memory, 'staging-database', 'Staging database', 'Restored nightly.')
    const wiki = memory.wiki()
    const maintenance = wiki?.maintenance
    if (!wiki || !maintenance) throw new Error('no maintenance')

    expect(await maintenance.consolidate({ dryRun: true })).toEqual({ merged: 1, pagesRemoved: 1 })
    expect(wiki.index.listAllSlugs()).toHaveLength(3)

    expect(await maintenance.consolidate()).toEqual({ merged: 1, pagesRemoved: 1 })
    expect(wiki.index.listAllSlugs()).toEqual(['acmeapp-deploys', 'staging-database'])
    expect(existsSync(join(dir, 'topics', 'acmeapp-deploys-rollback.md'))).toBe(false)
    const page = readFileSync(join(dir, 'topics', 'acmeapp-deploys.md'), 'utf8')
    expect(page).toMatch(/blue-green/)
    expect(page).toMatch(/traffic switch back/)
    // The old slug still resolves, by redirect and as an alias.
    expect((await wiki.index.getTopic('acmeapp-deploys-rollback'))?.slug).toBe('acmeapp-deploys')
    expect((await wiki.index.getTopic('acmeapp-deploys'))?.aliases).toContain('acmeapp-deploys-rollback')
    // Nothing left to fold.
    expect(await maintenance.consolidate()).toEqual({ merged: 0, pagesRemoved: 0 })
  })

  it('recompile rewrites a page from its history, counts a bad answer as failed, and needs an endpoint', async () => {
    let good = true
    const fetch = vi.fn(async () =>
      Response.json({
        choices: [
          {
            finish_reason: 'stop',
            message: {
              content: good
                ? JSON.stringify({
                    summary: 'Acmeapp deploys are blue-green; rollback is a traffic switch.',
                    article: '## Process\nCut the branch, deploy, watch the health check.',
                    history_entry: { date: new Date().toISOString().slice(0, 10), title: 'Recompiled', body: 'Rewritten from history.' },
                  })
                : 'not json at all',
            },
          },
        ],
      }),
    ) as unknown as typeof globalThis.fetch
    memory = new SqliteMemory({
      path: ':memory:',
      workers: false,
      log: () => {},
      wiki: { dir },
      compactor: { endpoint: 'https://llm.test/v1', model: 'm', fetch, sleep: noWait, maxRetries: 0 },
    })
    await seed(memory, 'acmeapp-deploys', 'Acmeapp deploys', 'thin')
    const wiki = memory.wiki()
    const maintenance = wiki?.maintenance
    if (!wiki || !maintenance) throw new Error('no maintenance')

    expect(await maintenance.recompile({ dryRun: true })).toEqual({ ok: 1, failed: 0 })
    expect((await wiki.index.getTopic('acmeapp-deploys'))?.currentState).toBe('thin')
    expect(await maintenance.recompile({ slug: 'acmeapp-deploys' })).toEqual({ ok: 1, failed: 0 })
    const topic = await wiki.index.getTopic('acmeapp-deploys')
    expect(topic?.currentState).toMatch(/rollback is a traffic switch/)
    expect(topic?.article).toMatch(/watch the health check/)
    // The rewrite is recorded in the page's history (the old summary may be kept there too).
    const afterFirst = topic?.historyCount ?? 0
    expect(afterFirst).toBeGreaterThan(1)

    good = false
    expect(await maintenance.recompile({ slugs: ['acmeapp-deploys', 'no-such-page'] })).toEqual({ ok: 0, failed: 2 })
    // The job names are the Postgres worker's, and run on the loop.
    good = true
    memory.jobs().enqueue('recompile-wiki', { slug: 'acmeapp-deploys' })
    expect(await memory.runJobs()).toBe(1)
    // The same answer again adds no second history entry.
    expect((await wiki.index.getTopic('acmeapp-deploys'))?.historyCount).toBe(afterFirst)
    expect(memory.jobs().counts()).toEqual([])

    const bare = new SqliteMemory({ path: ':memory:', log: () => {}, wiki: { dir } })
    await expect(bare.wiki()?.maintenance?.recompile({ slug: 'x' })).rejects.toThrow(/needs a summarization endpoint/)
    bare.close()
  })
})
