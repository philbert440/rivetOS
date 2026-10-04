/**
 * Tagging on SQLite: the rule-based project tag at capture, the vocabulary
 * and its edits, and tag suggestions on the job loop. Real in-memory
 * database, fake chat endpoint.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TAG_SYSTEM_PROMPT } from '@rivetos/memory-core'
import type { CaptureBatchRequest, ProjectRuleResult } from '@rivetos/types'
import { SqliteMemory } from './adapter.js'

const noWait = async (): Promise<void> => {}

const project = (value: string): ProjectRuleResult => ({
  key: 'project',
  value,
  display: value,
  rule: 'git-root',
  reason: 'git root',
})

function batch(over: Partial<CaptureBatchRequest> = {}): CaptureBatchRequest {
  return {
    session_key: 'sess-1',
    agent: 'rivet',
    settings: { cwd: '/work/acmeapp' },
    messages: [{ event_id: 'e1', role: 'user', content: 'working on the acmeapp deploy scripts today' }],
    ...over,
  }
}

describe('rule-based project tag at capture', () => {
  let memory: SqliteMemory
  const resolver = vi.fn(async (cwd: string) => (cwd === '/work/acmeapp' ? project('acmeapp') : null))

  beforeEach(() => {
    resolver.mockClear()
    memory = new SqliteMemory({ path: ':memory:', log: () => {}, projectRule: resolver })
  })
  afterEach(() => {
    memory.close()
  })

  it('tags the conversation once, born accepted, and never again', async () => {
    const backend = memory.backend()
    await backend.capture(batch())
    const tags = memory.tags().list({ entityType: 'conversation' })
    expect(tags).toHaveLength(1)
    expect(tags[0]).toMatchObject({
      key: 'project',
      value: 'acmeapp',
      state: 'accepted',
      source: 'rule',
      proposedBy: 'cwd-git-root',
    })
    // A later batch from another directory does not add a second rule tag.
    await backend.capture(
      batch({ settings: { cwd: '/work/other' }, messages: [{ event_id: 'e2', role: 'user', content: 'more work' }] }),
    )
    expect(memory.tags().list({ entityType: 'conversation' })).toHaveLength(1)
    // Rejecting it sticks: the rule does not put it back.
    memory.tags().decide([tags[0].id], 'rejected', 'owner')
    await backend.capture(batch({ messages: [{ event_id: 'e3', role: 'user', content: 'and more' }] }))
    expect(memory.tags().list({ entityType: 'conversation', states: ['accepted'] })).toEqual([])
    expect((await backend.search('deploy', { scope: 'messages', limit: 5 })).results[0].tags).toBeUndefined()
  })

  it('follows the vocabulary: a merged value is written as its target, a rejected one is not written', async () => {
    const vocab = memory.vocabulary()
    vocab.upsert({ key: 'project', value: 'acme', aliases: ['acmeapp'] })
    await memory.backend().capture(batch())
    expect(memory.tags().list({})[0]).toMatchObject({ value: 'acme' })

    vocab.upsert({ key: 'project', value: 'secret', state: 'rejected' })
    resolver.mockResolvedValueOnce(project('secret'))
    await memory.backend().capture(batch({ session_key: 'sess-2', settings: { cwd: '/work/acmeapp' } }))
    expect(memory.tags().forSessionKeys(['sess-2']).get('sess-2') ?? []).toEqual([])
  })

  it('a batch from another machine is never resolved against this filesystem', async () => {
    await memory.backend().capture(batch({ settings: { cwd: '/srv/checkout/widgetshop' } }), { allowFilesystem: false })
    expect(resolver).not.toHaveBeenCalled()
    // Only the basename rule applies.
    expect(memory.tags().list({})[0]).toMatchObject({ key: 'project', value: 'widgetshop', source: 'rule' })
  })

  it('no cwd, an unsafe cwd, or the rule turned off: no tag, and the capture still lands', async () => {
    await memory.backend().capture(batch({ settings: {} }))
    await memory.backend().capture(batch({ session_key: 's2', settings: { cwd: 'relative/path' } }))
    expect(memory.tags().list({})).toEqual([])
    const off = new SqliteMemory({ path: ':memory:', log: () => {}, projectRule: null })
    expect((await off.backend().capture(batch())).inserted).toBe(1)
    expect(off.tags().list({})).toEqual([])
    off.close()
  })

  it('a resolver that throws costs the tag, not the capture', async () => {
    resolver.mockRejectedValueOnce(new Error('disk gone'))
    expect((await memory.backend().capture(batch())).inserted).toBe(1)
    expect(memory.tags().list({})).toEqual([])
  })
})

describe('vocabulary', () => {
  let memory: SqliteMemory
  beforeEach(() => {
    memory = new SqliteMemory({ path: ':memory:', log: () => {}, projectRule: null })
  })
  afterEach(() => {
    memory.close()
  })

  it('adds, updates, nests and lists entries', () => {
    const vocab = memory.vocabulary()
    expect(vocab.upsert({ key: 'Topic', value: 'Memory Compaction', display: 'Memory compaction' })).toMatchObject({
      key: 'topic',
      value: 'memory-compaction',
      display: 'Memory compaction',
      state: 'accepted',
      aliases: [],
    })
    vocab.upsert({ key: 'topic', value: 'memory', aliases: ['mem', 'memory'] })
    const child = vocab.upsert({ key: 'topic', value: 'memory-compaction', parentValue: 'memory', reason: 'nested' })
    expect(child).toMatchObject({ parentValue: 'memory', display: 'Memory compaction', reason: 'nested' })
    expect(vocab.list({ key: 'topic' }).map((e) => e.value)).toEqual(['memory', 'memory-compaction'])
    expect(vocab.list({ key: 'topic' })[0].aliases).toEqual(['mem'])
    // Clearing the parent.
    expect(vocab.upsert({ key: 'topic', value: 'memory-compaction', parentValue: null }).parentValue).toBeUndefined()
  })

  it('refuses a parent that is missing, itself, or would make a cycle', () => {
    const vocab = memory.vocabulary()
    vocab.upsert({ key: 'topic', value: 'a' })
    vocab.upsert({ key: 'topic', value: 'b', parentValue: 'a' })
    expect(() => vocab.upsert({ key: 'topic', value: 'c', parentValue: 'nope' })).toThrow(/not in the vocabulary/)
    expect(() => vocab.upsert({ key: 'topic', value: 'a', parentValue: 'a' })).toThrow(/own parent/)
    expect(() => vocab.upsert({ key: 'topic', value: 'a', parentValue: 'b' })).toThrow(/cycle/)
    expect(() => vocab.upsert({ key: '', value: 'x' })).toThrow(/required/)
    // A refused edit leaves the entry as it was.
    expect(vocab.list({ key: 'topic' }).find((e) => e.value === 'a')?.parentValue).toBeUndefined()
  })

  it('decides entries and reports how many changed', () => {
    const vocab = memory.vocabulary()
    vocab.propose([{ key: 'topic', value: 'wiki' }, { key: 'topic', value: 'tags' }], 'tagger-v1')
    expect(vocab.list({ states: ['suggested'] })).toHaveLength(2)
    expect(vocab.decide([{ key: 'topic', value: 'wiki' }, { key: 'topic', value: 'nope' }], 'accepted')).toBe(1)
    expect(vocab.decide([{ key: 'topic', value: 'wiki' }], 'accepted')).toBe(0)
    expect(vocab.list({ states: ['accepted'] }).map((e) => e.value)).toEqual(['wiki'])
    // A proposal never overwrites a decided entry.
    expect(vocab.propose([{ key: 'topic', value: 'wiki' }], 'tagger-v1')).toBe(0)
  })

  it('merges one value into another: tags move, the later decision wins, aliases follow', async () => {
    const vocab = memory.vocabulary()
    const tags = memory.tags()
    for (const key of ['s1', 's2', 's3']) {
      await memory.append({ sessionId: key, agent: 'rivet', channel: 'cli', role: 'user', content: 'hello there' })
    }
    vocab.upsert({ key: 'project', value: 'acme-app', aliases: ['acme-old'] })
    vocab.upsert({ key: 'project', value: 'acme' })
    vocab.upsert({ key: 'project', value: 'acme-child', parentValue: 'acme-app' })
    // s1 has only the old value; s2 has both; s3 has only the target.
    tags.add({ entityType: 'conversation', sessionKey: 's1', tag: 'project:acme-app' }, 'owner')
    tags.add({ entityType: 'conversation', sessionKey: 's2', tag: 'project:acme-app' }, 'owner')
    const kept = tags.add({ entityType: 'conversation', sessionKey: 's2', tag: 'project:acme' }, 'owner')
    tags.decide([kept.id], 'rejected', 'owner')
    tags.add({ entityType: 'conversation', sessionKey: 's3', tag: 'project:acme' }, 'owner')

    expect(vocab.merge('project', 'acme-app', 'acme')).toEqual({ moved: 1, dropped: 1, into: 'acme' })
    const values = (key: string): string[] =>
      (tags.forSessionKeys([key], ['accepted', 'rejected', 'suggested']).get(key) ?? []).map(
        (t) => `${t.value}:${t.state}`,
      )
    expect(values('s1')).toEqual(['acme:accepted'])
    expect(values('s2')).toEqual(['acme:rejected'])
    expect(values('s3')).toEqual(['acme:accepted'])
    const all = vocab.list({ key: 'project', states: ['accepted', 'rejected'] })
    expect(all.find((e) => e.value === 'acme')?.aliases.sort()).toEqual(['acme-app', 'acme-old'])
    expect(all.find((e) => e.value === 'acme-app')).toMatchObject({ state: 'rejected', aliases: [] })
    expect(all.find((e) => e.value === 'acme-child')?.parentValue).toBe('acme')
    // Merging into an alias lands on the value that owns it.
    vocab.upsert({ key: 'project', value: 'legacy' })
    expect(vocab.merge('project', 'legacy', 'acme-old').into).toBe('acme')

    expect(() => vocab.merge('project', 'acme', 'acme')).toThrow(/two different values/)
    expect(() => vocab.merge('project', 'ghost', 'acme')).toThrow(/not in the vocabulary or in use/)
    expect(() => vocab.merge('project', 'acme', 'acme-child')).toThrow(/nested under/)
  })
})

describe('tag suggestions on the job loop', () => {
  let memory: SqliteMemory
  afterEach(() => {
    ;(memory as SqliteMemory | undefined)?.close()
  })

  const LEAF =
    'The team reworked the acmeapp deploy scripts: blue-green rollout from the release branch, a health check ' +
    'before the traffic switch, and a documented rollback. Memory compaction settings were tuned as well.'

  function fakeChat(tagAnswer: () => { content?: string; status?: number }) {
    const calls: Array<{ system: string; user: string }> = []
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> }
      const system = body.messages[0].content
      calls.push({ system, user: body.messages[1].content })
      const out = system === TAG_SYSTEM_PROMPT ? tagAnswer() : { content: LEAF }
      if (out.status && out.status !== 200) return new Response('no', { status: out.status })
      return Response.json({ choices: [{ finish_reason: 'stop', message: { content: out.content } }] })
    })
    return { fetch: fetch as unknown as typeof globalThis.fetch, calls }
  }

  async function fill(m: SqliteMemory, sessionId: string): Promise<void> {
    for (let i = 0; i < 10; i += 1) {
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
      // compaction, then suggestions
    }
  }

  const ANSWER = JSON.stringify([
    { key: 'project', value: 'AcmeApp', confidence: 0.9, reason: 'deploy scripts for it' },
    { key: 'topic', value: 'blue-green deploys', confidence: 0.7 },
  ])

  it('proposes tags on the summary and its session, for review, and feeds the vocabulary', async () => {
    const chat = fakeChat(() => ({ content: ANSWER }))
    memory = new SqliteMemory({
      path: ':memory:',
      workers: false,
      log: () => {},
      projectRule: null,
      tagging: { enabled: true },
      compactor: { endpoint: 'https://llm.test/v1', model: 'tagger-v1', fetch: chat.fetch, sleep: noWait },
    })
    memory.vocabulary().upsert({ key: 'topic', value: 'memory-compaction' })
    await fill(memory, 's1')
    await drain(memory)

    const pending = memory.tags().pending(20)
    expect(pending).toHaveLength(4)
    const onSummary = pending.filter((t) => t.entityType === 'summary')
    expect(onSummary).toHaveLength(2)
    expect(onSummary[0]).toMatchObject({ source: 'model', proposedBy: 'tagger-v1', state: 'suggested', sessionKey: 's1' })
    expect(onSummary[0].excerpt).toMatch(/^The team reworked the acmeapp deploy scripts/)
    expect(onSummary[0].conversationId).toBe(memory.conversationIdForTest('s1', 'rivet'))
    expect(pending.map((t) => `${t.key}:${t.value}`).sort()).toEqual([
      'project:acmeapp',
      'project:acmeapp',
      'topic:blue-green-deploys',
      'topic:blue-green-deploys',
    ])
    // New values are suggested for the vocabulary; the model saw the existing one.
    expect(memory.vocabulary().list({ states: ['suggested'] }).map((e) => `${e.key}:${e.value}`)).toEqual([
      'project:acmeapp',
      'topic:blue-green-deploys',
    ])
    expect(chat.calls.find((c) => c.system === TAG_SYSTEM_PROMPT)?.user).toMatch(/- topic:memory-compaction/)
    // Suggestions do not filter or count until someone accepts them.
    expect(memory.tags().conversationIdsWithTag('project', 'acmeapp')).toEqual([])
    expect(memory.tags().counts()).toEqual([])
  })

  it('an accepted summary tag makes its conversation match the tag filter and the counts', async () => {
    const chat = fakeChat(() => ({ content: ANSWER }))
    memory = new SqliteMemory({
      path: ':memory:',
      workers: false,
      log: () => {},
      projectRule: null,
      tagging: { enabled: true },
      compactor: { endpoint: 'https://llm.test/v1', model: 'tagger-v1', fetch: chat.fetch, sleep: noWait },
    })
    await fill(memory, 's1')
    await drain(memory)
    const summaryTag = memory.tags().pending(20).find((t) => t.entityType === 'summary' && t.key === 'project')
    if (!summaryTag) throw new Error('no summary suggestion')
    memory.tags().decide([summaryTag.id], 'accepted', 'owner')
    const conv = memory.conversationIdForTest('s1', 'rivet')
    expect(memory.tags().conversationIdsWithTag('project', 'acmeapp')).toEqual([conv])
    expect(memory.tags().counts()).toEqual([
      { key: 'project', value: 'acmeapp', display: 'AcmeApp', conversations: 1 },
    ])
    const browse = await memory.backend().browse({ tag: 'project:acmeapp', limit: 5 })
    expect(browse.messages).toHaveLength(5)
    // The hits carry the tag that selected them, though it sits on a summary.
    expect(browse.messages[0].tags).toEqual(['project:AcmeApp'])
    const hits = await memory.backend().search('acmeapp', { scope: 'messages', limit: 3, tag: 'project:acmeapp' })
    expect(hits.results.length).toBeGreaterThan(0)
    expect(hits.results[0].tags).toEqual(['project:AcmeApp'])
  })

  it('a rejected tag is not proposed again, and tagging off proposes nothing', async () => {
    const chat = fakeChat(() => ({ content: ANSWER }))
    memory = new SqliteMemory({
      path: ':memory:',
      workers: false,
      log: () => {},
      projectRule: null,
      tagging: { enabled: true },
      compactor: { endpoint: 'https://llm.test/v1', model: 'tagger-v1', fetch: chat.fetch, sleep: noWait },
    })
    await fill(memory, 's1')
    await drain(memory)
    const pending = memory.tags().pending(20)
    memory.tags().decide(pending.map((t) => t.id), 'rejected', 'owner')
    // A second leaf in the same conversation proposes the same tags.
    await fill(memory, 's1')
    memory.enqueueCompactionForTest('s1', 'rivet')
    await drain(memory)
    const again = memory.tags().pending(20)
    expect(again.every((t) => t.entityType === 'summary')).toBe(true)
    expect(again).toHaveLength(2)
    memory.close()

    const quiet = fakeChat(() => ({ content: ANSWER }))
    memory = new SqliteMemory({
      path: ':memory:',
      workers: false,
      log: () => {},
      projectRule: null,
      compactor: { endpoint: 'https://llm.test/v1', model: 'm', fetch: quiet.fetch, sleep: noWait },
    })
    await fill(memory, 's1')
    await drain(memory)
    expect(quiet.calls.some((c) => c.system === TAG_SYSTEM_PROMPT)).toBe(false)
    expect(memory.tags().pending(20)).toEqual([])
  })

  it('speaks the native classifier shape: one POST with the summary and the vocabulary', async () => {
    const chat = fakeChat(() => ({ content: ANSWER }))
    const posts: Array<{ url: string; body: Record<string, unknown>; auth: string | null }> = []
    const taggerFetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      posts.push({
        url: String(url),
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
        auth: new Headers(init?.headers).get('authorization'),
      })
      return new Response(ANSWER)
    }) as unknown as typeof globalThis.fetch
    memory = new SqliteMemory({
      path: ':memory:',
      workers: false,
      log: () => {},
      projectRule: null,
      tagging: {
        enabled: true,
        native: { url: 'https://classifier.internal/tag', model: 'tagger-v1', apiKey: 'k', fetch: taggerFetch },
      },
      compactor: { endpoint: 'https://llm.test/v1', model: 'm', fetch: chat.fetch, sleep: noWait },
    })
    memory.vocabulary().upsert({ key: 'topic', value: 'memory-compaction' })
    await fill(memory, 's1')
    await drain(memory)
    expect(posts).toHaveLength(1)
    expect(posts[0]).toMatchObject({
      url: 'https://classifier.internal/tag',
      auth: 'Bearer k',
      body: { model: 'tagger-v1', keys: ['project', 'topic'], max: 8, vocabulary: ['topic:memory-compaction'] },
    })
    expect(String(posts[0].body.text)).toMatch(/^The team reworked the acmeapp deploy scripts/)
    // The chat prompt was not used for tagging.
    expect(chat.calls.some((c) => c.system === TAG_SYSTEM_PROMPT)).toBe(false)
    const pending = memory.tags().pending(20)
    expect(pending).toHaveLength(4)
    expect(pending.every((t) => t.proposedBy === 'tagger-v1')).toBe(true)
  })

  it('a failing tagger fails the job and leaves the summary untouched', async () => {
    const chat = fakeChat(() => ({ status: 400 }))
    const logs: string[] = []
    memory = new SqliteMemory({
      path: ':memory:',
      workers: false,
      log: (l) => logs.push(l),
      projectRule: null,
      tagging: { enabled: true },
      compactor: { endpoint: 'https://llm.test/v1', model: 'tagger-v1', fetch: chat.fetch, sleep: noWait },
    })
    await fill(memory, 's1')
    await drain(memory)
    expect(memory.tags().pending(20)).toEqual([])
    expect(memory.summariesForConversation(memory.conversationIdForTest('s1', 'rivet'))).toHaveLength(1)
    expect(logs.join('\n')).toMatch(/suggest-tags .* failed/)
  })
})
