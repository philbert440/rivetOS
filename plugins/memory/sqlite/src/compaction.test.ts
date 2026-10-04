/**
 * Summaries on SQLite: the LLM client, leaf / branch / root compaction on the
 * job loop, and summaries in search — against a real in-memory database and a
 * fake chat endpoint.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { SqliteMemory } from './adapter.js'
import { LlmClient, LlmPermanentError, LlmTruncatedError } from './llm.js'

const noWait = async (): Promise<void> => {}

interface ChatCall {
  system: string
  user: string
  maxTokens: number
  auth: string | null
}

/** A chat endpoint whose answers are scripted per call. */
function fakeChat(
  answer: (call: ChatCall, n: number) => { content?: string; finish?: string; status?: number },
) {
  const calls: ChatCall[] = []
  const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as {
      messages: Array<{ role: string; content: string }>
      max_tokens: number
    }
    const call: ChatCall = {
      system: body.messages[0].content,
      user: body.messages[1].content,
      maxTokens: body.max_tokens,
      auth: new Headers(init?.headers).get('authorization'),
    }
    calls.push(call)
    const out = answer(call, calls.length)
    if (out.status && out.status !== 200) return new Response('no', { status: out.status })
    return Response.json({
      choices: [{ finish_reason: out.finish ?? 'stop', message: { content: out.content ?? '' } }],
    })
  })
  return { fetch: fetch as unknown as typeof globalThis.fetch, calls }
}

const SUMMARY = 'Summary of the batch: decided to use sqlite for the local store and wrote the notes.'

describe('LlmClient', () => {
  it('sends system + user, returns the content, and uses the bearer key', async () => {
    const chat = fakeChat(() => ({ content: SUMMARY }))
    const client = new LlmClient({
      endpoint: 'https://llm.test/v1/',
      model: 'summarizer',
      apiKey: 'k',
      fetch: chat.fetch,
      sleep: noWait,
    })
    const out = await client.chat('sys', 'user text', 700)
    expect(out).toEqual({ content: SUMMARY, model: 'summarizer' })
    expect(chat.calls[0]).toEqual({ system: 'sys', user: 'user text', maxTokens: 700, auth: 'Bearer k' })
  })

  it('a truncated answer is its own error and is not retried', async () => {
    const chat = fakeChat(() => ({ content: 'partial', finish: 'length' }))
    const client = new LlmClient({ endpoint: 'https://llm.test/v1', model: 'm', fetch: chat.fetch, sleep: noWait })
    await expect(client.chat('s', 'u', 500)).rejects.toBeInstanceOf(LlmTruncatedError)
    await expect(client.chat('s', 'u', 500)).rejects.toThrow(/truncated at max_tokens=500/)
    expect(chat.calls).toHaveLength(2)
  })

  it('retries a 503 and an empty answer, but not a permanent 4xx', async () => {
    const flaky = fakeChat((_c, n) => (n === 1 ? { status: 503 } : n === 2 ? { content: 'ok' } : { content: SUMMARY }))
    const client = new LlmClient({ endpoint: 'https://llm.test/v1', model: 'm', fetch: flaky.fetch, sleep: noWait })
    expect((await client.chat('s', 'u', 100)).content).toBe(SUMMARY)
    expect(flaky.calls).toHaveLength(3)

    const denied = fakeChat(() => ({ status: 400 }))
    const strict = new LlmClient({ endpoint: 'https://llm.test/v1', model: 'm', fetch: denied.fetch, sleep: noWait })
    await expect(strict.chat('s', 'u', 100)).rejects.toBeInstanceOf(LlmPermanentError)
    expect(denied.calls).toHaveLength(1)
  })

  it('a short structured answer passes when the caller lowers minChars', async () => {
    const chat = fakeChat(() => ({ content: '[]' }))
    const client = new LlmClient({ endpoint: 'https://llm.test/v1', model: 'm', fetch: chat.fetch, sleep: noWait, maxRetries: 0 })
    await expect(client.chat('s', 'u', 100)).rejects.toThrow(/too-short/)
    expect((await client.chat('s', 'u', 100, { minChars: 2 })).content).toBe('[]')
  })
})

describe('compaction on the job loop', () => {
  let memory: SqliteMemory
  afterEach(() => {
    memory.close()
  })

  async function fill(m: SqliteMemory, sessionId: string, count: number, agent = 'rivet'): Promise<void> {
    for (let i = 0; i < count; i += 1) {
      await m.append({
        sessionId,
        agent,
        channel: 'cli',
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: `message number ${String(i)} about the sqlite migration plan`,
      })
    }
  }

  it('writes a leaf once a full window exists, links its messages, and summarizes each message once', async () => {
    const chat = fakeChat(() => ({ content: SUMMARY }))
    memory = new SqliteMemory({
      path: ':memory:',
      workers: false,
      log: () => {},
      compactor: { endpoint: 'https://llm.test/v1', model: 'summarizer', fetch: chat.fetch, sleep: noWait },
    })
    await fill(memory, 's1', 10)
    // Sweep queues the conversation (a full leaf window needs no idle wait), then the job runs.
    expect(await memory.runJobs()).toBe(1)
    const conv = memory.conversationIdForTest('s1', 'rivet')
    const summaries = memory.summariesForConversation(conv)
    expect(summaries).toHaveLength(1)
    expect(summaries[0]).toMatchObject({ kind: 'leaf', depth: 0, messageCount: 10, model: 'summarizer', content: SUMMARY })
    expect(chat.calls).toHaveLength(1)
    expect(chat.calls[0].user).toMatch(/message number 0/)
    expect(chat.calls[0].user).toMatch(/message number 9/)
    // Nothing is left to summarize: a second pass does no LLM work.
    await memory.runJobs()
    expect(chat.calls).toHaveLength(1)
  })

  it('leaves a below-floor conversation alone until it goes stale', async () => {
    let clock = new Date('2026-10-04T12:00:00Z')
    const chat = fakeChat(() => ({ content: SUMMARY }))
    memory = new SqliteMemory({
      path: ':memory:',
      workers: false,
      log: () => {},
      now: () => clock,
      compactor: { endpoint: 'https://llm.test/v1', model: 'm', fetch: chat.fetch, sleep: noWait },
    })
    await fill(memory, 'short', 3)
    expect(await memory.runJobs()).toBe(0)
    // Idle for the 15-minute window: still below the leaf floor of 5.
    clock = new Date(clock.getTime() + 20 * 60_000)
    expect(await memory.runJobs()).toBe(0)
    // Stale (4 days idle): the tail is flushed into a leaf.
    clock = new Date(Date.now() + 5 * 24 * 60 * 60_000)
    expect(await memory.runJobs()).toBe(1)
    const conv = memory.conversationIdForTest('short', 'rivet')
    expect(memory.summariesForConversation(conv)).toMatchObject([{ kind: 'leaf', messageCount: 3 }])
  })

  it('shrinks the batch when the answer is truncated, leaving the rest for the next round', async () => {
    // Only the full ten-message window is too much for the output budget.
    const chat = fakeChat((call) =>
      call.user.includes('message number 0') && call.user.includes('message number 9')
        ? { content: 'cut', finish: 'length' }
        : { content: SUMMARY },
    )
    memory = new SqliteMemory({
      path: ':memory:',
      workers: false,
      log: () => {},
      compactor: { endpoint: 'https://llm.test/v1', model: 'm', fetch: chat.fetch, sleep: noWait },
    })
    await fill(memory, 's1', 10)
    await memory.runJobs()
    const conv = memory.conversationIdForTest('s1', 'rivet')
    const summaries = memory.summariesForConversation(conv)
    // 10 was truncated, 5 fit; the other 5 formed a second leaf in the same job.
    expect(summaries.map((s) => s.messageCount)).toEqual([5, 5])
  })

  it('rolls leaves up into a branch and branches into a root, re-parenting the children', async () => {
    const chat = fakeChat((call) => ({
      content: call.system.includes('ROOT')
        ? 'Root summary of the whole conversation across every branch and arc of it.'
        : call.system.includes('second-level')
          ? 'Branch summary covering several leaves of the sqlite migration conversation.'
          : SUMMARY,
    }))
    memory = new SqliteMemory({
      path: ':memory:',
      workers: false,
      log: () => {},
      compactor: { endpoint: 'https://llm.test/v1', model: 'm', fetch: chat.fetch, sleep: noWait },
      compaction: { leafBatch: 5, minLeavesForBranch: 2, branchBatch: 2, minBranchesForRoot: 2, rootBatch: 2 },
    })
    // 20 messages → 4 leaves → 2 branches (over two jobs) → 1 root.
    await fill(memory, 's1', 20)
    for (let pass = 0; pass < 6; pass += 1) {
      await memory.runJobs()
      memory.enqueueCompactionForTest('s1', 'rivet')
    }
    const conv = memory.conversationIdForTest('s1', 'rivet')
    const all = memory.summariesForConversation(conv)
    const kinds = all.map((s) => s.kind)
    expect(kinds.filter((k) => k === 'leaf')).toHaveLength(4)
    expect(kinds.filter((k) => k === 'branch')).toHaveLength(2)
    expect(kinds.filter((k) => k === 'root')).toHaveLength(1)
    const root = all.find((s) => s.kind === 'root')
    const branches = all.filter((s) => s.kind === 'branch')
    expect(branches.every((b) => b.parentId === root?.id)).toBe(true)
    expect(all.filter((s) => s.kind === 'leaf').every((l) => branches.some((b) => b.id === l.parentId))).toBe(true)
    expect(root?.messageCount).toBe(20)
  })

  it('a failing LLM fails the job (it retries later) and writes nothing; heartbeats are never summarized', async () => {
    const chat = fakeChat(() => ({ status: 503 }))
    const logs: string[] = []
    memory = new SqliteMemory({
      path: ':memory:',
      workers: false,
      log: (l) => logs.push(l),
      compactor: { endpoint: 'https://llm.test/v1', model: 'm', fetch: chat.fetch, sleep: noWait },
    })
    await fill(memory, 's1', 10)
    await fill(memory, 'heartbeat:rivet', 12)
    await memory.runJobs()
    expect(memory.summariesForConversation(memory.conversationIdForTest('s1', 'rivet'))).toEqual([])
    expect(memory.jobs().counts()).toEqual([{ task: 'compact-conversation', state: 'queued', count: 1 }])
    expect(logs.join('\n')).toMatch(/compact-conversation .* failed \(attempt 1\/3, retry\): LLM HTTP 503/)
  })

  it('a compaction job that ran out of attempts is revived by the sweep once the endpoint recovers', async () => {
    let clock = new Date('2026-10-04T12:00:00Z')
    let down = true
    const chat = fakeChat(() => (down ? { status: 400 } : { content: SUMMARY }))
    memory = new SqliteMemory({
      path: ':memory:',
      workers: false,
      log: () => {},
      now: () => clock,
      compactor: { endpoint: 'https://llm.test/v1', model: 'm', fetch: chat.fetch, sleep: noWait },
    })
    await fill(memory, 's1', 10)
    // Three attempts, each past the previous backoff, and the job is dead.
    for (let i = 0; i < 3; i += 1) {
      await memory.runJobs()
      clock = new Date(clock.getTime() + 10 * 60_000)
    }
    expect(memory.jobs().counts()).toEqual([{ task: 'compact-conversation', state: 'dead', count: 1 }])
    // The endpoint is back: the next sweep revives the dead job and it runs.
    down = false
    clock = new Date(clock.getTime() + 10 * 60_000)
    expect(await memory.runJobs()).toBe(1)
    const conv = memory.conversationIdForTest('s1', 'rivet')
    expect(memory.summariesForConversation(conv)).toHaveLength(1)
    expect(memory.jobs().counts()).toEqual([])
  })

  it('summaries are found by search, with and without an embedding endpoint', async () => {
    const chat = fakeChat(() => ({
      content: 'Decided to keep the datastore on a laptop and summarize it nightly with the local model.',
    }))
    memory = new SqliteMemory({
      path: ':memory:',
      workers: false,
      log: () => {},
      compactor: { endpoint: 'https://llm.test/v1', model: 'm', fetch: chat.fetch, sleep: noWait },
    })
    await fill(memory, 's1', 10)
    await memory.runJobs()
    const summaryHits = await memory.search('datastore', { scope: 'summaries' })
    expect(summaryHits).toHaveLength(1)
    expect(summaryHits[0]).toMatchObject({ role: 'summary', agent: 'rivet' })
    // 'both' returns the summary alongside messages; 'messages' leaves it out.
    expect((await memory.search('datastore', { scope: 'both' })).map((h) => h.role)).toContain('summary')
    expect((await memory.search('datastore', { scope: 'messages' })).map((h) => h.role)).not.toContain('summary')
    // Returned summaries are reinforced on the full-text path too.
    expect(memory.summaryAccessCountForTest(summaryHits[0].id)).toBeGreaterThanOrEqual(2)
    // Another agent's filter does not see it.
    expect(await memory.search('datastore', { scope: 'summaries', agent: 'other' })).toEqual([])
    // The turn context includes the summary as relevant context.
    expect(await memory.getContextForTurn('datastore', 'rivet')).toMatch(/\[rivet\/summary\] Decided to keep the datastore/)
  })

  it('embeds summaries and ranks them in hybrid search when an embedding endpoint is set', async () => {
    const chat = fakeChat(() => ({
      content: 'Decided to keep the database on a laptop and summarize it nightly with the local model.',
    }))
    const embedFetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { input: string[] }
      return Response.json({
        data: body.input.map((text, index) => ({
          index,
          embedding: [/database|datastore/i.test(text) ? 1 : 0.01, /migration/i.test(text) ? 1 : 0.01, 0.01],
        })),
      })
    }) as unknown as typeof globalThis.fetch
    memory = new SqliteMemory({
      path: ':memory:',
      workers: false,
      log: () => {},
      embed: { endpoint: 'https://embed.test', model: 'toy', fetch: embedFetch, sleep: noWait },
      compactor: { endpoint: 'https://llm.test/v1', model: 'm', fetch: chat.fetch, sleep: noWait },
    })
    await fill(memory, 's1', 10)
    while ((await memory.runJobs()) > 0) {
      // drain: embed messages, compact, then embed the summary
    }
    const conv = memory.conversationIdForTest('s1', 'rivet')
    const [leaf] = memory.summariesForConversation(conv)
    expect(memory.summaryEmbedDimsForTest(leaf.id)).toBe(3)
    // "datastore" matches nothing by full-text; the vector arm finds the summary.
    const hits = await memory.search('datastore', { scope: 'both', limit: 3 })
    expect(hits[0]).toMatchObject({ id: leaf.id, role: 'summary' })
  })
})
