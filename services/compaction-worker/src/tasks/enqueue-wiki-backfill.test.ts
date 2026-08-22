/**
 * Unit tests for wiki extract backfill eligibility (pipeline-version re-mine).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../config.js', () => ({
  config: {
    wikiExtraction: true,
    wikiBackfillBatch: 25,
    pgUrl: 'postgresql://localhost/test',
  },
}))

vi.mock('@rivetos/memory-postgres', () => ({
  WIKI_PIPELINE_VERSION: 3,
  sqlNotHeartbeatConversation: (alias = 'c') =>
    `(${alias}.session_key IS NULL OR ${alias}.session_key NOT LIKE 'heartbeat:%')`,
}))

import { enqueueWikiBackfillTask, wikiBackfillSelectSql } from './enqueue-wiki-backfill.js'

describe('wikiBackfillSelectSql', () => {
  const sql = wikiBackfillSelectSql()

  it('re-mines done rows below the current pipeline version', () => {
    expect(sql).toMatch(/e\.status = 'done' AND e\.pipeline_version < \$2/)
  })

  it('still re-sweeps failed rows on a 24h backoff', () => {
    expect(sql).toMatch(/e\.status = 'failed' AND e\.extracted_at < now\(\) - interval '24 hours'/)
  })

  it('does not treat skipped as re-eligible by pipeline version', () => {
    // Skipped reasons (too short, heartbeat) are version-independent.
    expect(sql).not.toMatch(/status = 'skipped'/)
  })

  it('never backfills heartbeat conversations (extract-wiki would skip them)', () => {
    expect(sql).toMatch(/LEFT JOIN ros_conversations c ON c\.id = s\.conversation_id/)
    expect(sql).toMatch(/c\.session_key NOT LIKE 'heartbeat:%'/)
  })

  it('prefers never-attempted over failed over stale-pipeline upgrades', () => {
    expect(sql).toMatch(/WHEN e\.summary_id IS NULL THEN 0/)
    expect(sql).toMatch(/WHEN e\.status = 'failed' THEN 1/)
    expect(sql).toMatch(/ELSE 2/)
  })
})

describe('enqueueWikiBackfillTask', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('passes batch size and WIKI_PIPELINE_VERSION to the sweep query', async () => {
    const query = vi.fn(async () => ({
      rows: [{ id: 'sum-1', conversation_id: 'conv-1' }],
    }))
    const addJob = vi.fn(async () => undefined)
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }

    await enqueueWikiBackfillTask({}, {
      withPgClient: async (fn: (client: { query: typeof query }) => Promise<void>) => fn({ query }),
      addJob,
      logger,
    } as never)

    expect(query).toHaveBeenCalledTimes(1)
    const [sql, params] = query.mock.calls[0] as [string, unknown[]]
    expect(sql).toContain("e.status = 'done' AND e.pipeline_version < $2")
    expect(params).toEqual([25, 3])
    expect(addJob).toHaveBeenCalledWith(
      'extract-wiki',
      { summaryId: 'sum-1', conversationId: 'conv-1' },
      expect.objectContaining({
        jobKey: 'wiki-ext-sum-1',
        priority: 10,
      }),
    )
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining('enqueued 1 leaf summaries (pipeline v3)'),
    )
  })

  it('enqueues nothing when the sweep returns no rows', async () => {
    const query = vi.fn(async () => ({ rows: [] }))
    const addJob = vi.fn(async () => undefined)
    const logger = { info: vi.fn() }

    await enqueueWikiBackfillTask({}, {
      withPgClient: async (fn: (client: { query: typeof query }) => Promise<void>) => fn({ query }),
      addJob,
      logger,
    } as never)

    expect(addJob).not.toHaveBeenCalled()
    expect(logger.info).not.toHaveBeenCalled()
  })
})
