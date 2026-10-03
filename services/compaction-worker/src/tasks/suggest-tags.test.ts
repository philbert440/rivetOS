import { beforeEach, describe, expect, it, vi } from 'vitest'
import type pg from 'pg'

const { configMock, suggestTagsMock } = vi.hoisted(() => ({
  configMock: {
    pgUrl: 'postgres://test',
    taggingEnabled: true,
    tagger: { url: 'http://tagger/v1', model: 'tagger-model', apiKey: '', transientStatuses: [] },
    taggerWireShape: 'openai' as const,
    taggerTimeoutMs: 60_000,
  },
  suggestTagsMock: vi.fn(),
}))
vi.mock('../config.js', () => ({ config: configMock }))
vi.mock('../tagger.js', () => ({
  suggestTags: (...args: unknown[]) => suggestTagsMock(...args),
}))

import {
  TAG_MIN_SUMMARY_CHARS,
  insertSuggestions,
  loadVocabulary,
  proposeTaxonomyValues,
  setSuggestTagsPoolForTest,
  suggestTagsTask,
} from './suggest-tags.js'

const LONG = 'x'.repeat(TAG_MIN_SUMMARY_CHARS + 10)

function fakePool(summary: Record<string, unknown> | undefined) {
  const query = vi.fn(async (sql: string) => {
    if (sql.includes('FROM ros_summaries s')) return { rows: summary ? [summary] : [], rowCount: summary ? 1 : 0 }
    if (sql.includes('FROM ros_tag_taxonomy')) {
      return {
        rows: [
          { key: 'project', value: 'rivetos', display: 'rivetOS' },
          { key: 'project', value: 'rivetos', display: 'rivetos' }, // dup from in-use tags
          { key: 'topic', value: 'wiki', display: '' },
        ],
        rowCount: 3,
      }
    }
    if (sql.includes('INSERT INTO ros_tags')) return { rows: [], rowCount: 1 }
    if (sql.includes('INSERT INTO ros_tag_taxonomy')) return { rows: [], rowCount: 0 }
    return { rows: [], rowCount: 0 }
  })
  return { query } as unknown as pg.Pool & { query: typeof query }
}

const helpers = { logger: { info: vi.fn(), warn: vi.fn() } } as never

describe('suggest-tags task', () => {
  beforeEach(() => {
    suggestTagsMock.mockReset()
    configMock.taggingEnabled = true
  })

  it('proposes for a leaf: vocabulary offered, rows on summary + conversation, taxonomy proposed', async () => {
    const pool = fakePool({
      id: 'sum-1',
      conversation_id: 'conv-1',
      content: LONG,
      kind: 'leaf',
      title: 'T',
      session_key: 'claude:abc',
      agent: 'rivet',
    })
    setSuggestTagsPoolForTest(pool)
    suggestTagsMock.mockResolvedValue({
      proposals: [{ key: 'topic', value: 'tagging', display: 'Tagging', confidence: 0.8, reason: 'r' }],
      rejected: [],
    })

    await suggestTagsTask({ summaryId: 'sum-1' }, helpers)

    expect(suggestTagsMock).toHaveBeenCalledWith(
      { wireShape: 'openai', target: configMock.tagger, timeoutMs: 60_000 },
      expect.objectContaining({
        summary: LONG,
        title: 'T',
        agent: 'rivet',
        vocabulary: { accepted: ['project:rivetOS', 'topic:wiki'] },
      }),
    )
    const tagInserts = pool.query.mock.calls.filter(([sql]) => sql.includes('INSERT INTO ros_tags'))
    expect(tagInserts.map(([, p]) => (p as unknown[]).slice(0, 2))).toEqual([
      ['summary', 'sum-1'],
      ['conversation', 'conv-1'],
    ])
    expect(tagInserts[0][1]).toEqual([
      'summary', 'sum-1', 'topic', 'tagging', 'Tagging', 0.8, 'tagger-model', 'r',
    ])
    expect(tagInserts[0][0]).toMatch(/'model', 'suggested'/)
    const taxonomy = pool.query.mock.calls.filter(([sql]) => sql.includes('INSERT INTO ros_tag_taxonomy'))
    expect(taxonomy).toHaveLength(1)
    expect(taxonomy[0][1]).toEqual(['topic', 'tagging', 'Tagging', 'proposed by tagger-model'])
  })

  it('skips non-leaf, short and heartbeat summaries without calling the tagger', async () => {
    for (const row of [
      { kind: 'branch', content: LONG, session_key: 'claude:x' },
      { kind: 'leaf', content: 'short', session_key: 'claude:x' },
      { kind: 'leaf', content: LONG, session_key: 'heartbeat:daily' },
    ]) {
      setSuggestTagsPoolForTest(
        fakePool({ id: 's', conversation_id: 'c', title: null, agent: null, ...row }),
      )
      await suggestTagsTask({ summaryId: 's' }, helpers)
    }
    expect(suggestTagsMock).not.toHaveBeenCalled()
  })

  it('is a no-op when tagging is disabled or the payload is bad', async () => {
    const pool = fakePool({ id: 's', conversation_id: 'c', content: LONG, kind: 'leaf', title: null, session_key: 'k', agent: null })
    setSuggestTagsPoolForTest(pool)
    configMock.taggingEnabled = false
    await suggestTagsTask({ summaryId: 's' }, helpers)
    configMock.taggingEnabled = true
    await suggestTagsTask({ nope: 1 }, helpers)
    expect(pool.query).not.toHaveBeenCalled()
    expect(suggestTagsMock).not.toHaveBeenCalled()
  })

  it('writes nothing when the tagger returns no proposals', async () => {
    const pool = fakePool({ id: 's', conversation_id: 'c', content: LONG, kind: 'leaf', title: null, session_key: 'k', agent: null })
    setSuggestTagsPoolForTest(pool)
    suggestTagsMock.mockResolvedValue({ proposals: [], rejected: ['no JSON found'] })
    await suggestTagsTask({ summaryId: 's' }, helpers)
    expect(pool.query.mock.calls.some(([sql]) => sql.includes('INSERT'))).toBe(false)
  })

  it('a failing write on the final attempt is logged and dropped too, not left dead', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('FROM ros_summaries s')) {
        return {
          rows: [{ id: 's', conversation_id: 'c', content: LONG, kind: 'leaf', title: null, session_key: 'k', agent: null }],
          rowCount: 1,
        }
      }
      if (sql.includes('INSERT INTO ros_tags')) throw new Error('permission denied for table ros_tags')
      return { rows: [], rowCount: 0 }
    })
    setSuggestTagsPoolForTest({ query } as unknown as pg.Pool)
    suggestTagsMock.mockResolvedValue({ proposals: [{ key: 'topic', value: 'x' }], rejected: [] })
    const logger = { info: vi.fn(), warn: vi.fn() }
    await expect(
      suggestTagsTask({ summaryId: 's' }, { logger, job: { attempts: 1, max_attempts: 2 } } as never),
    ).rejects.toThrow(/permission denied/)
    await expect(
      suggestTagsTask({ summaryId: 's' }, { logger, job: { attempts: 2, max_attempts: 2 } } as never),
    ).resolves.toBeUndefined()
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('permission denied'))
  })

  it('writes atomically: a failing statement rolls the whole proposal back', async () => {
    const calls: string[] = []
    const tx = {
      query: vi.fn(async (sql: string) => {
        calls.push(sql.trim().split(/\s+/).slice(0, 3).join(' '))
        if (sql.includes('INSERT INTO ros_tag_taxonomy')) throw new Error('boom')
        return { rows: [], rowCount: 1 }
      }),
      release: vi.fn(),
    }
    const pool = {
      query: vi.fn(async (sql: string) =>
        sql.includes('FROM ros_summaries s')
          ? { rows: [{ id: 's', conversation_id: 'c', content: LONG, kind: 'leaf', title: null, session_key: 'k', agent: null }], rowCount: 1 }
          : { rows: [], rowCount: 0 },
      ),
      connect: vi.fn(async () => tx),
    }
    setSuggestTagsPoolForTest(pool as unknown as pg.Pool)
    suggestTagsMock.mockResolvedValue({ proposals: [{ key: 'topic', value: 'x' }], rejected: [] })
    const retrying = { logger: { info: vi.fn(), warn: vi.fn() }, job: { attempts: 1, max_attempts: 2 } } as never
    await expect(suggestTagsTask({ summaryId: 's' }, retrying)).rejects.toThrow(/boom/)
    expect(calls[0]).toBe('BEGIN')
    expect(calls.at(-1)).toBe('ROLLBACK')
    expect(calls).not.toContain('COMMIT')
    expect(tx.release).toHaveBeenCalledOnce()
  })

  it('tolerates a null payload', async () => {
    await expect(suggestTagsTask(null, helpers)).resolves.toBeUndefined()
  })

  it('skips (no retry, no tagger call) when the tag tables are not migrated yet', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('FROM ros_summaries s')) {
        return {
          rows: [{ id: 's', conversation_id: 'c', content: LONG, kind: 'leaf', title: null, session_key: 'k', agent: null }],
          rowCount: 1,
        }
      }
      throw new Error('relation "ros_tag_taxonomy" does not exist')
    })
    setSuggestTagsPoolForTest({ query } as unknown as pg.Pool)
    await expect(suggestTagsTask({ summaryId: 's' }, helpers)).resolves.toBeUndefined()
    expect(suggestTagsMock).not.toHaveBeenCalled()
  })

  it('rethrows a tagger failure while attempts remain, so graphile retries', async () => {
    const pool = fakePool({ id: 's', conversation_id: 'c', content: LONG, kind: 'leaf', title: null, session_key: 'k', agent: null })
    setSuggestTagsPoolForTest(pool)
    suggestTagsMock.mockRejectedValue(new Error('LLM unreachable'))
    const retrying = { logger: { info: vi.fn(), warn: vi.fn() }, job: { attempts: 1, max_attempts: 2 } } as never
    await expect(suggestTagsTask({ summaryId: 's' }, retrying)).rejects.toThrow(/unreachable/)
  })

  it('on the final attempt logs and completes instead of leaving a dead job', async () => {
    const pool = fakePool({ id: 's', conversation_id: 'c', content: LONG, kind: 'leaf', title: null, session_key: 'k', agent: null })
    setSuggestTagsPoolForTest(pool)
    suggestTagsMock.mockRejectedValue(new Error('LLM unreachable'))
    const logger = { info: vi.fn(), warn: vi.fn() }
    const last = { logger, job: { attempts: 2, max_attempts: 2 } } as never
    await expect(suggestTagsTask({ summaryId: 's' }, last)).resolves.toBeUndefined()
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('giving up on'))
    expect(pool.query.mock.calls.some(([sql]) => sql.includes('INSERT'))).toBe(false)
  })
})

describe('helpers', () => {
  it('loadVocabulary dedupes on key:value and keeps the first display', async () => {
    const pool = fakePool(undefined)
    expect(await loadVocabulary(pool)).toEqual({ accepted: ['project:rivetOS', 'topic:wiki'] })
  })

  it('insertSuggestions and proposeTaxonomyValues count only new rows', async () => {
    const pool = fakePool(undefined)
    const proposals = [{ key: 'topic', value: 'a' }, { key: 'topic', value: 'b' }]
    expect(await insertSuggestions(pool, 'summary', 's', proposals, 'm')).toBe(2)
    expect(await proposeTaxonomyValues(pool, proposals, 'm')).toBe(0)
  })
})
