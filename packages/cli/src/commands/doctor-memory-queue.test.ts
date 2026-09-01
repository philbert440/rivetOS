import { describe, it, expect, vi } from 'vitest'
import { checkMemoryQueue, MEMORY_QUEUE_DEAD_SQL, type MemoryQueueDeadRow } from './doctor.js'

function fakeClient(handler: (sql: string) => Promise<{ rows: MemoryQueueDeadRow[] }>) {
  return {
    query: vi.fn(handler),
    end: vi.fn(async () => undefined),
  }
}

describe('doctor memory queue check', () => {
  it('passes when no task has dead jobs', async () => {
    const client = fakeClient(async () => ({ rows: [] }))
    const results = await checkMemoryQueue(client)
    expect(results).toHaveLength(1)
    expect(results[0].status).toBe('pass')
    expect(results[0].category).toBe('memory')
    expect(results[0].message).toContain('no dead jobs')
  })

  it('warns per task with count, truncated error, and the keyed requeue hint', async () => {
    const client = fakeClient(async (sql) => {
      expect(sql).toBe(MEMORY_QUEUE_DEAD_SQL)
      return {
        rows: [
          {
            task: 'extract-wiki',
            keyed_dead: '12',
            keyless_dead: '0',
            last_error: 'LLM unreachable at http://pve3:8003/v1 (fetch failed)',
          },
          {
            task: 'compact-conversation',
            keyed_dead: '3',
            keyless_dead: '0',
            last_error: 'deadlock detected',
          },
        ],
      }
    })
    const results = await checkMemoryQueue(client)
    expect(results).toHaveLength(2)
    expect(results.every((r) => r.status === 'warn')).toBe(true)

    const wiki = results.find((r) => r.name === 'queue-extract-wiki')
    expect(wiki?.message).toMatch(/12 dead job\(s\)/)
    expect(wiki?.detail).toContain('LLM unreachable')
    expect(wiki?.detail).toContain('rivetos memory requeue --task extract-wiki')

    const compact = results.find((r) => r.name === 'queue-compact-conversation')
    expect(compact?.message).toContain('3 dead job(s)')
    expect(compact?.detail).toContain('deadlock detected')
  })

  it('does not prescribe memory requeue for a keyless-only pile', async () => {
    const client = fakeClient(async () => ({
      rows: [
        {
          task: 'compact-conversation',
          keyed_dead: '0',
          keyless_dead: '3435',
          last_error: 'deadlock detected',
        },
      ],
    }))
    const results = await checkMemoryQueue(client)
    expect(results).toHaveLength(1)
    expect(results[0].status).toBe('warn')
    expect(results[0].message).toMatch(/3,435 dead job\(s\)|3435 dead job\(s\)/)
    expect(results[0].detail).toContain('keyless dead rows are corpses')
    expect(results[0].detail).toContain('reap-dead-jobs')
    expect(results[0].detail).not.toContain('memory requeue')
    expect(JSON.stringify(results)).not.toContain('memory requeue')
  })

  it('handles a null last_error without crashing', async () => {
    const client = fakeClient(async () => ({
      rows: [{ task: 'embed-target', keyed_dead: '64', keyless_dead: '0', last_error: null }],
    }))
    const results = await checkMemoryQueue(client)
    expect(results[0].status).toBe('warn')
    expect(results[0].detail).toContain('rivetos memory requeue --task embed-target')
    expect(results[0].detail).not.toContain('null')
  })

  it('passes when the graphile_worker schema is absent (42P01)', async () => {
    const client = fakeClient(async () => {
      throw Object.assign(new Error('relation "graphile_worker._private_jobs" does not exist'), {
        code: '42P01',
      })
    })
    const results = await checkMemoryQueue(client)
    expect(results).toHaveLength(1)
    expect(results[0].status).toBe('pass')
    expect(results[0].message).toContain('schema not present')
  })

  it('warns (not fails) on an unexpected query error', async () => {
    const client = fakeClient(async () => {
      throw new Error('connection reset')
    })
    const results = await checkMemoryQueue(client)
    expect(results[0].status).toBe('warn')
    expect(results[0].detail).toBe('connection reset')
  })

  it('the dead-job SQL only counts attempts >= max_attempts, grouped by task', () => {
    expect(MEMORY_QUEUE_DEAD_SQL).toContain('j.attempts >= j.max_attempts')
    expect(MEMORY_QUEUE_DEAD_SQL).toContain('GROUP BY t.identifier')
    expect(MEMORY_QUEUE_DEAD_SQL).toContain(
      'array_agg(j.last_error ORDER BY j.updated_at DESC NULLS LAST)',
    )
    expect(MEMORY_QUEUE_DEAD_SQL).toContain('FILTER (WHERE j.key IS NOT NULL)')
    expect(MEMORY_QUEUE_DEAD_SQL).toContain('FILTER (WHERE j.key IS NULL)')
  })
})
