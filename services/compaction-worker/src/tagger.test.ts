import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./config.js', () => ({
  config: {
    llmUrl: 'http://compactor/v1',
    llmModel: 'compactor-model',
    llmApiKey: '',
    llmTransientStatuses: [],
    llmFallbacks: [],
    llmFallbackCooldownMs: 1,
    llmFallbackAttemptTimeoutMs: 1000,
  },
}))
vi.mock('@rivetos/memory-postgres', () => ({
  LLM_TIMEOUT_MS: 1000,
  LLM_TEMPERATURE: 0,
  LLM_RETRIES: 0,
  LLM_RETRY_BACKOFF_MS: 1,
}))
const fetchMock = vi.fn()
vi.mock('undici', () => ({
  Agent: class {},
  fetch: (...args: unknown[]) => fetchMock(...args),
}))

import {
  TAG_MAX_PROPOSALS,
  TAG_SUMMARY_MAX_CHARS,
  callNativeTagger,
  formatTagPrompt,
  parseTagProposals,
  suggestTags,
} from './tagger.js'

describe('parseTagProposals', () => {
  it('normalizes keys and values, keeps display casing and clamps confidence', () => {
    const { proposals, rejected } = parseTagProposals(
      '[{"key":"Project","value":"AcmeApp","confidence":1.7,"reason":"the summary is about AcmeApp"}]',
    )
    expect(rejected).toEqual([])
    expect(proposals).toEqual([
      {
        key: 'project',
        value: 'acmeapp',
        display: 'AcmeApp',
        confidence: 1,
        reason: 'the summary is about AcmeApp',
      },
    ])
  })

  it('accepts fenced output, an object wrapper, and tag literals', () => {
    expect(parseTagProposals('```json\n[{"tag":"topic:Memory Compaction"}]\n```').proposals).toEqual([
      { key: 'topic', value: 'memory-compaction', display: 'Memory Compaction' },
    ])
    expect(parseTagProposals('{"tags":[{"key":"topic","value":"wiki"}]}').proposals).toEqual([
      { key: 'topic', value: 'wiki' },
    ])
  })

  it('tolerates chatter around the array', () => {
    const raw = 'Sure, here are the tags:\n[{"key":"topic","value":"x"}]\nHope that helps.'
    expect(parseTagProposals(raw).proposals).toEqual([{ key: 'topic', value: 'x' }])
  })

  it('dedupes on normalized key:value and caps the list', () => {
    const items = Array.from({ length: 20 }, (_, i) => ({ key: 'topic', value: `t${i % 12}` }))
    const { proposals } = parseTagProposals(JSON.stringify(items))
    expect(proposals).toHaveLength(TAG_MAX_PROPOSALS)
    expect(new Set(proposals.map((p) => p.value)).size).toBe(TAG_MAX_PROPOSALS)
  })

  it('rejects malformed rows and bad keys without dropping the good ones', () => {
    const { proposals, rejected } = parseTagProposals(
      '[{"key":"topic","value":"ok"}, 7, {"key":"1bad","value":"x"}, {"key":"topic","value":"   "}]',
    )
    expect(proposals).toEqual([{ key: 'topic', value: 'ok' }])
    expect(rejected).toHaveLength(3)
  })

  it('strips control characters from display and reason, and never ends a value on a dash', () => {
    const { proposals } = parseTagProposals(
      JSON.stringify([
        { key: 'topic', value: 'Line\nBreak\u0007', reason: 'why\r\n\tnot\u200B here' },
        { key: 'topic', value: 'a'.repeat(63) + ' bcd' },
      ]),
    )
    expect(proposals[0]).toEqual({ key: 'topic', value: 'line-break', display: 'Line Break', reason: 'why not here' })
    expect(proposals[1].value).toBe('a'.repeat(63))
  })

  it('keeps a removal as a suggestion and rejects an unknown action', () => {
    const { proposals, rejected } = parseTagProposals(
      '[{"key":"project","value":"rivetos","action":"remove","reason":"wrong repo"},{"key":"topic","value":"wiki","action":"drop"}]',
    )
    expect(proposals).toEqual([{ key: 'project', value: 'rivetos', reason: 'wrong repo', action: 'remove' }])
    expect(rejected).toEqual(['bad action for "topic:wiki"'])
  })

  it('returns nothing for non-JSON, non-array, or empty answers', () => {
    expect(parseTagProposals('no tags here').proposals).toEqual([])
    expect(parseTagProposals('"just a string"').proposals).toEqual([])
    expect(parseTagProposals('[]')).toEqual({ proposals: [], rejected: [] })
  })
})

describe('formatTagPrompt', () => {
  it('offers the vocabulary and the summary, and says when there is none', () => {
    const withVocab = formatTagPrompt({
      summary: 'S',
      title: 'T',
      agent: 'rivet',
      vocabulary: { accepted: ['project:rivetOS', 'topic:wiki'] },
    })
    expect(withVocab).toContain('Conversation title: T')
    expect(withVocab).toContain('- project:rivetOS')
    expect(withVocab).toContain('Summary:\nS')
    expect(formatTagPrompt({ summary: 'S', vocabulary: { accepted: [] } })).toContain('(none yet)')
  })
})

describe('suggestTags transport', () => {
  beforeEach(() => fetchMock.mockReset())

  it('openai shape: chat completion against the tagger target, parsed as proposals', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ finish_reason: 'stop', message: { content: '[{"key":"topic","value":"wiki"}]' } }],
      }),
    })
    const out = await suggestTags(
      { wireShape: 'openai', target: { url: 'http://tagger/v1', model: 'm', apiKey: 'k', transientStatuses: [] } },
      { summary: 'S', vocabulary: { accepted: [] } },
    )
    expect(out.proposals).toEqual([{ key: 'topic', value: 'wiki' }])
    const [url, init] = fetchMock.mock.calls[0] as [string, { headers: Record<string, string>; body: string }]
    expect(url).toBe('http://tagger/v1/chat/completions')
    expect(init.headers.Authorization).toBe('Bearer k')
    expect(JSON.parse(init.body).model).toBe('m')
  })

  it('native shape: POSTs the classifier contract and reads {tags}', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => '{"tags":[{"key":"project","value":"AcmeApp","confidence":0.9}]}',
    })
    const tokenSource = { getToken: vi.fn(async () => 'minted') }
    const out = await suggestTags(
      {
        wireShape: 'native',
        target: {
          url: 'https://classifier.test/classify',
          model: 'tagger-v1',
          apiKey: 'ignored',
          transientStatuses: [],
          tokenSource: tokenSource as never,
        },
      },
      { summary: 'S', title: 'T', vocabulary: { accepted: ['project:rivetOS'] } },
    )
    expect(out.proposals).toEqual([
      { key: 'project', value: 'acmeapp', display: 'AcmeApp', confidence: 0.9 },
    ])
    const [url, init] = fetchMock.mock.calls[0] as [string, { headers: Record<string, string>; body: string }]
    expect(url).toBe('https://classifier.test/classify')
    expect(init.headers.Authorization).toBe('Bearer minted')
    expect(JSON.parse(init.body)).toMatchObject({
      model: 'tagger-v1',
      text: 'S',
      title: 'T',
      keys: ['project', 'topic'],
      vocabulary: ['project:rivetOS'],
      max: TAG_MAX_PROPOSALS,
    })
  })

  it('native shape: re-mints once on 401, then succeeds', async () => {
    const tokens = ['stale', 'fresh']
    const tokenSource = {
      getToken: vi.fn(async () => tokens[0]),
      invalidate: vi.fn(() => {
        tokens.shift()
      }),
    }
    fetchMock
      .mockResolvedValueOnce({ ok: false, status: 401, statusText: 'Unauthorized', text: async () => '' })
      .mockResolvedValueOnce({ ok: true, status: 200, text: async () => '{"tags":[]}' })
    const raw = await callNativeTagger(
      { url: 'https://classifier.test/classify', model: 'tagger-v1', apiKey: '', transientStatuses: [], tokenSource: tokenSource as never },
      { summary: 'S', vocabulary: { accepted: [] } },
    )
    expect(raw).toBe('{"tags":[]}')
    expect(tokenSource.invalidate).toHaveBeenCalledExactlyOnceWith('stale')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('openai shape passes the short tagger timeout to the call', async () => {
    const spy = vi.spyOn(globalThis, 'setTimeout')
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ finish_reason: 'stop', message: { content: '[]' } }] }),
    })
    await suggestTags(
      { wireShape: 'openai', target: { url: 'http://tagger/v1', model: 'm', apiKey: '', transientStatuses: [] }, timeoutMs: 432 },
      { summary: 'S', vocabulary: { accepted: [] } },
    )
    const delays = spy.mock.calls.map((c) => c[1])
    spy.mockRestore()
    expect(delays).toContain(432)
  })

  it('native shape: summary is bounded and title/agent are cleaned, like the chat prompt', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, text: async () => '{"tags":[]}' })
    await callNativeTagger(
      { url: 'https://classifier.test/classify', model: 'tagger-v1', apiKey: '', transientStatuses: [] },
      { summary: 's'.repeat(TAG_SUMMARY_MAX_CHARS + 500), title: 'a\n## b', agent: 'x\u202Ey', vocabulary: { accepted: [] } },
    )
    const body = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body) as {
      text: string
      title: string
      agent: string
    }
    expect(body.text).toHaveLength(TAG_SUMMARY_MAX_CHARS)
    expect(body.title).toBe('a ## b')
    expect(body.agent).toBe('x y')
  })

  it('native shape: a non-2xx answer throws', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 503, statusText: 'down', text: async () => '' })
    await expect(
      callNativeTagger({ url: 'https://classifier.test/classify', model: 'tagger-v1', apiKey: '', transientStatuses: [] }, {
        summary: 'S',
        vocabulary: { accepted: [] },
      }),
    ).rejects.toThrow(/tagger HTTP 503/)
  })
})
