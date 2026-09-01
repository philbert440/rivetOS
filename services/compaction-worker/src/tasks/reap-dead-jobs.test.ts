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

import { REAP_TASK_ALLOWLIST, reapDeadJobsSql, reapDeadJobsTask } from './reap-dead-jobs.js'

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
    ])
  })
})

describe('reapDeadJobsTask', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('binds the reap cap and logs the deleted count', async () => {
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      expect(sql).toContain('DELETE FROM graphile_worker._private_jobs')
      expect(params).toEqual([[...REAP_TASK_ALLOWLIST], 200])
      return { rows: [], rowCount: 17 }
    })
    const logger = { info: vi.fn(), warn: vi.fn() }
    await reapDeadJobsTask(
      {},
      {
        withPgClient: async (fn: (c: { query: typeof query }) => Promise<void>) => fn({ query }),
        logger,
      } as never,
    )
    expect(logger.info).toHaveBeenCalledWith('[reap-dead-jobs] deleted 17 keyless dead job(s)')
  })

  it('stays quiet when nothing was deleted', async () => {
    const query = vi.fn(async () => ({ rows: [], rowCount: 0 }))
    const logger = { info: vi.fn(), warn: vi.fn() }
    await reapDeadJobsTask(
      {},
      {
        withPgClient: async (fn: (c: { query: typeof query }) => Promise<void>) => fn({ query }),
        logger,
      } as never,
    )
    expect(logger.info).not.toHaveBeenCalled()
  })
})
