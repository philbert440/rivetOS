import { describe, it, expect, vi } from 'vitest'
import {
  buildRetryFailedWhere,
  parseRetryFailedFlags,
  parseRequeueFlags,
  requeueDeadJobs,
  REQUEUE_PRIORITY,
  REQUEUE_RESCHEDULE_SQL,
  REQUEUE_SELECT_SQL,
  UNLOCK_STALE_LOCKED_SQL,
  REQUEUE_DEFAULT_LIMIT,
  REQUEUE_MAX_LIMIT,
} from './memory.js'

describe('parseRetryFailedFlags', () => {
  it('requires at least one --task', () => {
    expect(() => parseRetryFailedFlags(['--dry-run'])).toThrow(/--task/)
  })

  it('parses task, error, limit, dry-run, json', () => {
    const flags = parseRetryFailedFlags([
      '--task',
      'extract-wiki',
      '--error',
      'text[] &',
      '--limit',
      '100',
      '--dry-run',
      '--json',
    ])
    expect(flags).toEqual({
      tasks: ['extract-wiki'],
      errorSubstr: 'text[] &',
      limit: 100,
      dryRun: true,
      json: true,
    })
  })

  it('accepts repeated --task', () => {
    const flags = parseRetryFailedFlags([
      '--task',
      'extract-wiki',
      '--task',
      'compact-conversation',
    ])
    expect(flags.tasks).toEqual(['extract-wiki', 'compact-conversation'])
  })

  it('rejects unknown options', () => {
    expect(() => parseRetryFailedFlags(['--task', 'x', '--nope'])).toThrow(/Unknown option/)
  })

  it('rejects --task without a value', () => {
    expect(() => parseRetryFailedFlags(['--task'])).toThrow(/--task requires/)
  })

  it('treats non-positive --limit as unbounded', () => {
    const flags = parseRetryFailedFlags(['--task', 'extract-wiki', '--limit', '0'])
    expect(flags.limit).toBeNull()
  })
})

describe('buildRetryFailedWhere', () => {
  it('binds tasks as $1 and locks the dead/unlocked filter', () => {
    const { whereSql, params, limitSql } = buildRetryFailedWhere({
      tasks: ['extract-wiki'],
      errorSubstr: null,
      limit: null,
      dryRun: false,
      json: false,
    })
    expect(params).toEqual([['extract-wiki']])
    expect(whereSql).toContain('j.attempts >= j.max_attempts')
    expect(whereSql).toContain('t.identifier = ANY($1::text[])')
    expect(whereSql).toContain('j.locked_at IS NULL')
    expect(whereSql).not.toContain('last_error')
    expect(limitSql).toBe('')
  })

  it('adds error substring and limit as later params', () => {
    const { whereSql, params, limitSql } = buildRetryFailedWhere({
      tasks: ['extract-wiki', 'compact-conversation'],
      errorSubstr: 'text[] &',
      limit: 50,
      dryRun: true,
      json: false,
    })
    expect(params).toEqual([['extract-wiki', 'compact-conversation'], 'text[] &', 50])
    expect(whereSql).toContain("j.last_error ILIKE '%' || $2::text || '%'")
    expect(limitSql).toBe(' LIMIT $3')
  })
})

// ---------------------------------------------------------------------------
// requeue
// ---------------------------------------------------------------------------

describe('parseRequeueFlags', () => {
  it('requires at least one --task', () => {
    expect(() => parseRequeueFlags(['--dry-run'])).toThrow(/--task/)
  })

  it('parses task, limit, dry-run, json', () => {
    const flags = parseRequeueFlags([
      '--task',
      'extract-wiki',
      '--limit',
      '500',
      '--dry-run',
      '--json',
    ])
    expect(flags).toEqual({
      tasks: ['extract-wiki'],
      limit: 500,
      dryRun: true,
      json: true,
    })
  })

  it('defaults omitted --limit to the sweep bound, not null', () => {
    const flags = parseRequeueFlags(['--task', 'extract-wiki'])
    expect(flags.limit).toBe(REQUEUE_DEFAULT_LIMIT)
  })

  it('accepts repeated --task', () => {
    const flags = parseRequeueFlags(['--task', 'extract-wiki', '--task', 'compact-conversation'])
    expect(flags.tasks).toEqual(['extract-wiki', 'compact-conversation'])
  })

  it('rejects unknown options and valueless --task', () => {
    expect(() => parseRequeueFlags(['--task', 'extract-wiki', '--error', 'y'])).toThrow(
      /Unknown option/,
    )
    expect(() => parseRequeueFlags(['--task'])).toThrow(/--task requires/)
  })

  it('rejects an unknown --task name', () => {
    expect(() => parseRequeueFlags(['--task', 'nope'])).toThrow(/not an allowed memory task/)
  })

  it('rejects invalid --limit (zero, negative, flag-as-value, missing)', () => {
    expect(() => parseRequeueFlags(['--task', 'extract-wiki', '--limit', '0'])).toThrow(/limit/)
    expect(() => parseRequeueFlags(['--task', 'extract-wiki', '--limit', '-1'])).toThrow(/limit/)
    expect(() => parseRequeueFlags(['--task', 'extract-wiki', '--limit', '--dry-run'])).toThrow(
      /limit/,
    )
    expect(() => parseRequeueFlags(['--task', 'extract-wiki', '--limit'])).toThrow(/limit/)
    expect(() => parseRequeueFlags(['--task', 'extract-wiki', '--limit', 'abc'])).toThrow(/limit/)
  })

  it('caps --limit at REQUEUE_MAX_LIMIT', () => {
    const flags = parseRequeueFlags(['--task', 'extract-wiki', '--limit', '99999'])
    expect(flags.limit).toBe(REQUEUE_MAX_LIMIT)
  })
})

describe('REQUEUE_RESCHEDULE_SQL', () => {
  it('revives via reschedule_jobs with attempts=0 and omits the 5th arg', () => {
    expect(REQUEUE_RESCHEDULE_SQL).toContain('graphile_worker.reschedule_jobs($1::bigint[]')
    expect(REQUEUE_RESCHEDULE_SQL).toContain('now(), $2, 0)')
    expect(REQUEUE_RESCHEDULE_SQL).not.toMatch(/,\s*null\s*\)/)
  })

  it('requeues at low priority so live work wins', () => {
    expect(REQUEUE_PRIORITY).toBe(10)
  })
})

describe('REQUEUE_SELECT_SQL', () => {
  it('selects dead stealable keyed rows with a mandatory LIMIT', () => {
    expect(REQUEUE_SELECT_SQL).toContain('j.attempts >= j.max_attempts')
    expect(REQUEUE_SELECT_SQL).toContain('j.key IS NOT NULL')
    expect(REQUEUE_SELECT_SQL).toContain(
      "(j.locked_at IS NULL OR j.locked_at < now() - interval '4 hours')",
    )
    expect(REQUEUE_SELECT_SQL).toContain('t.identifier = ANY($1::text[])')
    expect(REQUEUE_SELECT_SQL).toContain('LIMIT $2')
  })
})

describe('requeueDeadJobs', () => {
  it('dry-run never calls reschedule_jobs', async () => {
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      expect(sql).toBe(REQUEUE_SELECT_SQL)
      expect(params).toEqual([['extract-wiki'], 200])
      return {
        rows: [{ id: '1', task: 'extract-wiki', last_error: 'boom' }],
        rowCount: 1,
      }
    })
    const result = await requeueDeadJobs(
      { query },
      { tasks: ['extract-wiki'], limit: 200, dryRun: true, json: false },
    )
    expect(result.matched).toBe(1)
    expect(result.requeued).toBe(0)
    expect(query.mock.calls.every((c) => !String(c[0]).includes('reschedule_jobs'))).toBe(true)
    expect(query.mock.calls.every((c) => !String(c[0]).includes('SET locked_at = NULL'))).toBe(true)
  })

  it('happy path uses reschedule_jobs rowCount, not the SELECT count', async () => {
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql === UNLOCK_STALE_LOCKED_SQL) {
        expect(params).toEqual([['1', '2']])
        return { rows: [], rowCount: 2 }
      }
      if (sql === REQUEUE_RESCHEDULE_SQL) {
        expect(params?.[0]).toEqual(['1', '2'])
        expect(params?.[1]).toBe(REQUEUE_PRIORITY)
        return { rows: [{ id: '1' }], rowCount: 1 }
      }
      return {
        rows: [
          { id: '1', task: 'extract-wiki', last_error: 'a' },
          { id: '2', task: 'extract-wiki', last_error: 'b' },
        ],
        rowCount: 2,
      }
    })
    const result = await requeueDeadJobs(
      { query },
      { tasks: ['extract-wiki'], limit: 200, dryRun: false, json: false },
    )
    expect(result.matched).toBe(2)
    expect(result.requeued).toBe(1)
    expect(result.skipped).toBe(1)
    const sqls = query.mock.calls.map((c) => String(c[0]))
    expect(sqls.indexOf(UNLOCK_STALE_LOCKED_SQL)).toBeGreaterThan(-1)
    expect(sqls.indexOf(UNLOCK_STALE_LOCKED_SQL)).toBeLessThan(sqls.indexOf(REQUEUE_RESCHEDULE_SQL))
  })

  it('unlocks stale-locked rows before reschedule_jobs', async () => {
    expect(UNLOCK_STALE_LOCKED_SQL).toContain('SET locked_at = NULL, locked_by = NULL')
    expect(UNLOCK_STALE_LOCKED_SQL).toContain("locked_at < now() - interval '4 hours'")
    const query = vi.fn(async (sql: string) => {
      if (sql === UNLOCK_STALE_LOCKED_SQL) return { rows: [], rowCount: 1 }
      if (sql === REQUEUE_RESCHEDULE_SQL) return { rows: [{ id: '1' }], rowCount: 1 }
      return { rows: [{ id: '1', task: 'extract-wiki', last_error: null }], rowCount: 1 }
    })
    await requeueDeadJobs(
      { query },
      { tasks: ['extract-wiki'], limit: 200, dryRun: false, json: false },
    )
    expect(query).toHaveBeenCalledWith(UNLOCK_STALE_LOCKED_SQL, [['1']])
  })

  it('propagates 42P01 so the CLI can print a friendly error', async () => {
    const query = vi.fn(async () => {
      throw Object.assign(new Error('undefined table'), { code: '42P01' })
    })
    await expect(
      requeueDeadJobs(
        { query },
        { tasks: ['extract-wiki'], limit: 200, dryRun: false, json: false },
      ),
    ).rejects.toMatchObject({ code: '42P01' })
  })
})
