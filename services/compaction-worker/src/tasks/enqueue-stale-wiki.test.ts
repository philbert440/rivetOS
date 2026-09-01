/**
 * Unit tests for the enqueue-stale-wiki backstop sweep.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  config: {
    wikiExtraction: true,
    wikiSweepLimit: 200,
    pgUrl: 'postgresql://localhost/test',
  },
}))

vi.mock('../config.js', () => ({ config: mocks.config }))

vi.mock('@rivetos/memory-postgres', () => ({
  sqlNotHeartbeatConversation: (alias = 'c') =>
    `(${alias}.session_key IS NULL OR ${alias}.session_key NOT LIKE 'heartbeat:%')`,
}))

import { enqueueStaleWikiTask, staleWikiMissingSql } from './enqueue-stale-wiki.js'
import { wikiExtractJobOptions, wikiExtractJobPayload } from './enqueue-wiki-backfill.js'

interface MockClient {
  query: ReturnType<typeof vi.fn>
}

function makeHelpers(query: MockClient['query']) {
  return {
    withPgClient: async (fn: (client: MockClient) => Promise<void>) => fn({ query }),
    addJob: vi.fn(async () => undefined),
    logger: { info: vi.fn(), warn: vi.fn() },
  }
}

describe('staleWikiMissingSql', () => {
  const sql = staleWikiMissingSql()

  it('targets never-extracted leaf summaries only', () => {
    expect(sql).toContain("s.kind = 'leaf'")
    expect(sql).toMatch(/NOT EXISTS \(\s*SELECT 1 FROM ros_wiki_extractions/)
  })

  it('excludes leaves that already have an extract-wiki job row', () => {
    expect(sql).toMatch(/NOT EXISTS \(\s*SELECT 1 FROM graphile_worker\._private_jobs/)
    expect(sql).toContain("j.key = 'wiki-ext-' || s.id::text")
  })

  it('keeps orphaned leaves (c.id IS NULL) and still excludes heartbeat convos', () => {
    expect(sql).toContain('c.id IS NULL OR')
    expect(sql).toContain("c.session_key NOT LIKE 'heartbeat:%'")
  })

  it('bounds the tick with LIMIT $1', () => {
    expect(sql).toContain('LIMIT $1')
  })
})

describe('enqueueStaleWikiTask', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.config.wikiExtraction = true
    mocks.config.wikiSweepLimit = 200
  })

  it('is a no-op while WIKI_EXTRACTION is dark (matches enqueue-wiki-backfill)', async () => {
    mocks.config.wikiExtraction = false
    const query = vi.fn(async () => ({ rows: [], rowCount: 0 }))
    const helpers = makeHelpers(query)

    await enqueueStaleWikiTask({}, helpers as never)

    expect(query).not.toHaveBeenCalled()
    expect(helpers.addJob).not.toHaveBeenCalled()
  })

  it('reschedules dead extract-wiki jobs with attempts=0 at low priority', async () => {
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql.includes('reschedule_jobs')) {
        expect(params?.[0]).toEqual(['11', '12'])
        expect(params?.[1]).toBe(10)
        expect(sql).toContain('$1::bigint[]')
        expect(sql).toContain('now(), $2, 0)')
        return { rows: [{ id: '11' }, { id: '12' }], rowCount: 2 }
      }
      if (sql.includes('_private_jobs') && sql.includes('_private_tasks')) {
        expect(params).toEqual(['extract-wiki', 200])
        return { rows: [{ id: '11' }, { id: '12' }], rowCount: 2 }
      }
      return { rows: [], rowCount: 0 }
    })
    const helpers = makeHelpers(query)

    await enqueueStaleWikiTask({}, helpers as never)

    expect(query).toHaveBeenCalledWith(expect.stringContaining('reschedule_jobs'), [
      ['11', '12'],
      10,
    ])
    expect(helpers.addJob).not.toHaveBeenCalled()
  })

  it('re-adds missing jobs with the wiki-ext key and backfill options shared with enqueue-wiki-backfill', async () => {
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql.includes('_private_tasks')) return { rows: [], rowCount: 0 }
      if (sql.includes('FROM ros_summaries')) {
        expect(params).toEqual([200])
        return {
          rows: [{ id: 'sum-1', conversation_id: 'conv-1' }],
          rowCount: 1,
        }
      }
      return { rows: [], rowCount: 0 }
    })
    const helpers = makeHelpers(query)

    await enqueueStaleWikiTask({}, helpers as never)

    expect(helpers.addJob).toHaveBeenCalledWith(
      'extract-wiki',
      wikiExtractJobPayload('sum-1', 'conv-1'),
      wikiExtractJobOptions('sum-1', { priority: 10 }),
    )
  })

  it('reschedules dead AND addJobs missing in the same tick', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('reschedule_jobs')) {
        return { rows: [{ id: '11' }], rowCount: 1 }
      }
      if (sql.includes('_private_tasks')) {
        return { rows: [{ id: '11' }], rowCount: 1 }
      }
      if (sql.includes('FROM ros_summaries')) {
        return { rows: [{ id: 'sum-1', conversation_id: 'conv-1' }], rowCount: 1 }
      }
      return { rows: [], rowCount: 0 }
    })
    const helpers = makeHelpers(query)

    await enqueueStaleWikiTask({}, helpers as never)

    expect(query).toHaveBeenCalledWith(expect.stringContaining('reschedule_jobs'), expect.anything())
    expect(helpers.addJob).toHaveBeenCalledTimes(1)
    expect(helpers.addJob.mock.calls[0][2]).toEqual(
      expect.objectContaining({ jobKeyMode: 'preserve_run_at', jobKey: 'wiki-ext-sum-1' }),
    )
  })

  it('does not claim a full-batch success when a later addJob throws', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('_private_tasks')) return { rows: [], rowCount: 0 }
      if (sql.includes('FROM ros_summaries')) {
        return {
          rows: [
            { id: 'sum-1', conversation_id: 'c1' },
            { id: 'sum-2', conversation_id: 'c2' },
          ],
          rowCount: 2,
        }
      }
      return { rows: [], rowCount: 0 }
    })
    const helpers = makeHelpers(query)
    helpers.addJob.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('addJob down'))

    await expect(enqueueStaleWikiTask({}, helpers as never)).rejects.toThrow('addJob down')
    expect(helpers.logger.warn).toHaveBeenCalledWith(expect.stringContaining('after re-adding 1/2'))
    expect(helpers.logger.info).not.toHaveBeenCalledWith(expect.stringContaining('re-added 2'))
  })

  it('gives the missing half the remainder of the cap after revival', async () => {
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql.includes('reschedule_jobs')) {
        return { rows: [{ id: '11' }, { id: '12' }], rowCount: 2 }
      }
      if (sql.includes('_private_tasks')) {
        return { rows: [{ id: '11' }, { id: '12' }], rowCount: 2 }
      }
      if (sql.includes('FROM ros_summaries')) {
        expect(params).toEqual([198])
        return { rows: [], rowCount: 0 }
      }
      return { rows: [], rowCount: 0 }
    })
    const helpers = makeHelpers(query)

    await enqueueStaleWikiTask({}, helpers as never)

    const missingCalls = query.mock.calls.filter((c) => String(c[0]).includes('FROM ros_summaries'))
    expect(missingCalls).toHaveLength(1)
    expect(missingCalls[0][1]).toEqual([198])
  })

  it('does nothing when there are no dead and no missing jobs', async () => {
    const query = vi.fn(async () => ({ rows: [], rowCount: 0 }))
    const helpers = makeHelpers(query)

    await enqueueStaleWikiTask({}, helpers as never)

    const rescheduleCalls = query.mock.calls.filter((c) =>
      String(c[0]).includes('reschedule_jobs'),
    )
    expect(rescheduleCalls).toHaveLength(0)
    expect(helpers.addJob).not.toHaveBeenCalled()
  })
})
