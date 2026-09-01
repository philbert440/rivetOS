/**
 * Unit tests for reschedule-dead: SQL predicates, clamp, and result count.
 */

import { describe, it, expect, vi } from 'vitest'
import {
  clampSweepLimit,
  deadJobsSelectSql,
  rescheduleDeadJobs,
  SWEEP_LIMIT_MAX,
  UNLOCK_STALE_LOCKED_SQL,
} from './reschedule-dead.js'

describe('clampSweepLimit', () => {
  it('fails closed on non-numeric / non-positive', () => {
    expect(clampSweepLimit(Number.NaN)).toBe(0)
    expect(clampSweepLimit(0)).toBe(0)
    expect(clampSweepLimit(-5)).toBe(0)
    expect(clampSweepLimit(undefined as unknown as number)).toBe(0)
  })

  it('caps at SWEEP_LIMIT_MAX', () => {
    expect(clampSweepLimit(20)).toBe(20)
    expect(clampSweepLimit(200)).toBe(200)
    expect(clampSweepLimit(9999)).toBe(SWEEP_LIMIT_MAX)
  })
})

describe('deadJobsSelectSql', () => {
  const sql = deadJobsSelectSql()

  it('binds the task identifier and LIMIT', () => {
    expect(sql).toContain('t.identifier = $1')
    expect(sql).toContain('LIMIT $2')
  })

  it('requires attempts >= max_attempts, a remaining key, 24h idle, and the 4h lock predicate', () => {
    expect(sql).toContain('j.attempts >= j.max_attempts')
    expect(sql).toContain('j.key IS NOT NULL')
    expect(sql).toContain("j.updated_at < now() - interval '24 hours'")
    expect(sql).toContain(
      "(j.locked_at IS NULL OR j.locked_at < now() - interval '4 hours')",
    )
  })
})

describe('rescheduleDeadJobs', () => {
  it('does not call reschedule_jobs when the SELECT is empty', async () => {
    const query = vi.fn(async () => ({ rows: [], rowCount: 0 }))
    const logger = { info: vi.fn(), warn: vi.fn() }
    const n = await rescheduleDeadJobs({ query }, logger, 'extract-wiki', 20, 10)
    expect(n).toBe(0)
    expect(query).toHaveBeenCalledTimes(1)
    expect(query.mock.calls[0][1]).toEqual(['extract-wiki', 20])
    expect(String(query.mock.calls[0][0])).not.toContain('reschedule_jobs')
  })

  it('passes ids as bigint[] in graphile 0.17 argument order and counts the SETOF result', async () => {
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql.includes('reschedule_jobs')) {
        expect(sql).toContain('reschedule_jobs($1::bigint[], now(), $2, 0)')
        expect(sql).not.toContain('null')
        expect(params).toEqual([['11', '12'], 10])
        return { rows: [{ id: '11' }], rowCount: 1 }
      }
      if (sql === UNLOCK_STALE_LOCKED_SQL || sql.includes('SET locked_at = NULL')) {
        expect(params).toEqual([['11', '12']])
        return { rows: [], rowCount: 2 }
      }
      expect(params).toEqual(['extract-wiki', 20])
      return { rows: [{ id: '11' }, { id: '12' }], rowCount: 2 }
    })
    const logger = { info: vi.fn(), warn: vi.fn() }
    const n = await rescheduleDeadJobs({ query }, logger, 'extract-wiki', 20, 10)
    expect(n).toBe(1)
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('revived 1 dead extract-wiki'))
  })

  it('unlocks stale-locked rows before reschedule_jobs', async () => {
    const sqls: string[] = []
    const query = vi.fn(async (sql: string) => {
      sqls.push(sql)
      if (sql.includes('reschedule_jobs')) return { rows: [{ id: '11' }], rowCount: 1 }
      if (sql.includes('SET locked_at = NULL')) return { rows: [], rowCount: 1 }
      return { rows: [{ id: '11' }], rowCount: 1 }
    })
    await rescheduleDeadJobs({ query }, { info: vi.fn(), warn: vi.fn() }, 'extract-wiki', 20, 10)
    const unlockIdx = sqls.findIndex((s) => s.includes('SET locked_at = NULL'))
    const reschedIdx = sqls.findIndex((s) => s.includes('reschedule_jobs'))
    expect(unlockIdx).toBeGreaterThan(-1)
    expect(unlockIdx).toBeLessThan(reschedIdx)
    expect(sqls[unlockIdx]).toBe(UNLOCK_STALE_LOCKED_SQL)
    expect(sqls[unlockIdx]).toContain("locked_at < now() - interval '4 hours'")
    expect(query.mock.calls[unlockIdx][1]).toEqual([['11']])
  })

  it('no-ops when the clamped limit is 0', async () => {
    const query = vi.fn(async () => ({ rows: [{ id: '1' }], rowCount: 1 }))
    const n = await rescheduleDeadJobs(
      { query },
      { info: vi.fn(), warn: vi.fn() },
      'extract-wiki',
      0,
      10,
    )
    expect(n).toBe(0)
    expect(query).not.toHaveBeenCalled()
  })

  it('propagates a reschedule_jobs throw', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('reschedule_jobs')) throw new Error('boom')
      return { rows: [{ id: '11' }], rowCount: 1 }
    })
    await expect(
      rescheduleDeadJobs({ query }, { info: vi.fn(), warn: vi.fn() }, 'extract-wiki', 20, 10),
    ).rejects.toThrow('boom')
  })
})
