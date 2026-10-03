/**
 * Unit tests for the keyless-corpse reaper.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../config.js', () => ({
  config: {
    reapDeadLimit: 200,
    pgUrl: 'postgresql://localhost/test',
  },
}))

import {
  reapOrphanTagsSql, REAP_TASK_ALLOWLIST, reapDeadJobsSql, reapDeadJobsTask } from './reap-dead-jobs.js'

describe('reapDeadJobsSql', () => {
  const sql = reapDeadJobsSql()

  it('deletes only keyless dead unlocked rows older than 7 days, bounded via ctid', () => {
    expect(sql).toContain('DELETE FROM graphile_worker._private_jobs')
    expect(sql).toContain('WHERE ctid IN')
    expect(sql).toContain('key IS NULL')
    expect(sql).toContain('attempts >= j.max_attempts')
    expect(sql).toContain('locked_at IS NULL')
    expect(sql).toContain("updated_at < now() - interval '7 days'")
    expect(sql).toContain('LIMIT $2')
  })

  it('scopes the DELETE to the requeue task allowlist', () => {
    expect(sql).toContain(
      'j.task_id IN (SELECT id FROM graphile_worker._private_tasks WHERE identifier = ANY($1::text[]))',
    )
    expect([...REAP_TASK_ALLOWLIST]).toEqual([
      'extract-wiki',
      'compact-conversation',
      'embed-target',
      'synthesize-tool-call',
      'suggest-tags',
    ])
  })
})

describe('reapOrphanTagsSql', () => {
  it('deletes only tags whose conversation or summary is gone, bounded via ctid', () => {
    const sql = reapOrphanTagsSql().replace(/\s+/g, ' ')
    expect(sql).toContain('DELETE FROM ros_tags WHERE ctid IN')
    expect(sql).toContain(
      "t.entity_type = 'conversation' AND NOT EXISTS (SELECT 1 FROM ros_conversations c WHERE c.id = t.entity_id)",
    )
    expect(sql).toContain(
      "t.entity_type = 'summary' AND NOT EXISTS (SELECT 1 FROM ros_summaries s WHERE s.id = t.entity_id)",
    )
    expect(sql).toContain('LIMIT $1')
  })
})

describe('reapDeadJobsTask', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  function run(query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number }>) {
    const logger = { info: vi.fn(), warn: vi.fn() }
    const spy = vi.fn(query)
    return reapDeadJobsTask(
      {},
      {
        withPgClient: async (fn: (c: { query: typeof spy }) => Promise<void>) => fn({ query: spy }),
        logger,
      } as never,
    ).then(() => ({ logger, spy }))
  }

  it('binds the reap cap and logs the deleted count, then sweeps orphan tags with the same cap', async () => {
    const { logger, spy } = await run(async (sql) =>
      sql.includes('graphile_worker._private_jobs')
        ? { rows: [], rowCount: 17 }
        : { rows: [], rowCount: 3 },
    )
    expect(spy).toHaveBeenCalledTimes(2)
    expect(spy.mock.calls[0][0]).toContain('DELETE FROM graphile_worker._private_jobs')
    expect(spy.mock.calls[0][1]).toEqual([[...REAP_TASK_ALLOWLIST], 200])
    expect(spy.mock.calls[1][0]).toContain('DELETE FROM ros_tags')
    expect(spy.mock.calls[1][1]).toEqual([200])
    expect(logger.info).toHaveBeenCalledWith('[reap-dead-jobs] deleted 17 keyless dead job(s)')
    expect(logger.info).toHaveBeenCalledWith('[reap-dead-jobs] deleted 3 orphaned tag row(s)')
  })

  it('stays quiet when nothing was deleted', async () => {
    const { logger } = await run(async () => ({ rows: [], rowCount: 0 }))
    expect(logger.info).not.toHaveBeenCalled()
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it('a missing tag table (0019 not applied) is silent and does not fail the job reap', async () => {
    const { logger } = await run(async (sql) => {
      if (sql.includes('ros_tags')) throw new Error('relation "ros_tags" does not exist')
      return { rows: [], rowCount: 5 }
    })
    expect(logger.info).toHaveBeenCalledWith('[reap-dead-jobs] deleted 5 keyless dead job(s)')
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it('any other orphan-sweep failure is logged, not thrown', async () => {
    const { logger } = await run(async (sql) => {
      if (sql.includes('ros_tags')) throw new Error('permission denied for table ros_tags')
      return { rows: [], rowCount: 0 }
    })
    expect(logger.warn).toHaveBeenCalledWith(
      '[reap-dead-jobs] orphan tag sweep failed: permission denied for table ros_tags',
    )
  })
})
