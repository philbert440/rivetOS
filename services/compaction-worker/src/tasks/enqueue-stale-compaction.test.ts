/**
 * Unit tests for the enqueue-stale-compaction backstop sweep.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../config.js', () => ({
  config: {
    idleMinutes: 15,
    leafBatchSize: 10,
    staleMinutes: 4 * 24 * 60,
    staleMinBatch: 2,
    compactionSweepLimit: 200,
    pgUrl: 'postgresql://localhost/test',
  },
}))

vi.mock('@rivetos/memory-postgres', () => ({
  MIN_BATCH_SIZE: 5,
  sqlNotHeartbeatConversation: (alias = 'c') =>
    `(${alias}.session_key IS NULL OR ${alias}.session_key NOT LIKE 'heartbeat:%')`,
}))

import {
  enqueueStaleCompactionTask,
  staleCompactionMissingSql,
} from './enqueue-stale-compaction.js'
import {
  compactConversationJobOptions,
  compactConversationPayload,
} from './enqueue-idle.js'

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

describe('staleCompactionMissingSql', () => {
  const sql = staleCompactionMissingSql()

  it('keeps the enqueue-idle idle / stale trigger split', () => {
    expect(sql).toMatch(/WHEN COUNT\(m\.id\) >= \$2 THEN 'session_idle' ELSE 'session_stale'/)
    expect(sql).toContain('LIMIT $6')
  })

  it('limits candidate conversations before the message aggregate', () => {
    expect(sql).toMatch(/FROM \(\s*SELECT c\.id, c\.updated_at/)
    expect(sql).toContain('GROUP BY c.id, c.updated_at')
  })

  it('puts the unsummarized EXISTS inside the limited subquery, before its ORDER BY', () => {
    const innerMatch = sql.match(
      /FROM \(\s*SELECT c\.id, c\.updated_at[\s\S]*?ORDER BY c\.updated_at ASC\s*LIMIT \$6/,
    )
    expect(innerMatch).not.toBeNull()
    const inner = innerMatch![0]
    const unsumIdx = inner.indexOf('SELECT 1 FROM ros_messages m')
    const orderIdx = inner.search(/ORDER BY c\.updated_at/)
    expect(unsumIdx).toBeGreaterThan(-1)
    expect(unsumIdx).toBeLessThan(orderIdx)
    expect(inner.slice(0, unsumIdx)).toContain('EXISTS (')
    expect(inner).toContain('ss.summary_id IS NULL')
  })

  it('excludes conversations that already have a job row (key = conversation id)', () => {
    expect(sql).toMatch(/NOT EXISTS \(\s*SELECT 1 FROM graphile_worker\._private_jobs/)
    expect(sql).toContain('j.key = c.id::text')
  })

  it('excludes heartbeat conversations', () => {
    expect(sql).toContain("c.session_key NOT LIKE 'heartbeat:%'")
  })
})

describe('enqueueStaleCompactionTask', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('records SQL whose limited subquery contains the unsummarized EXISTS before ORDER BY', async () => {
    let recorded = ''
    const query = vi.fn(async (sql: string) => {
      recorded = sql
      return { rows: [], rowCount: 0 }
    })
    const helpers = makeHelpers(query)

    await enqueueStaleCompactionTask({}, helpers as never)

    expect(recorded).toBe(staleCompactionMissingSql())
    const innerMatch = recorded.match(
      /FROM \(\s*SELECT c\.id, c\.updated_at[\s\S]*?ORDER BY c\.updated_at ASC\s*LIMIT \$6/,
    )
    expect(innerMatch).not.toBeNull()
    const inner = innerMatch![0]
    const unsumIdx = inner.indexOf('SELECT 1 FROM ros_messages m')
    const orderIdx = inner.search(/ORDER BY c\.updated_at/)
    expect(inner).toContain('EXISTS (')
    expect(inner).toContain('ss.summary_id IS NULL')
    expect(unsumIdx).toBeGreaterThan(-1)
    expect(unsumIdx).toBeLessThan(orderIdx)
    const afterLimit = recorded.slice(recorded.indexOf(inner) + inner.length)
    expect(afterLimit).not.toContain('SELECT 1 FROM ros_messages m LEFT JOIN ros_summary_sources')
  })

  it('does not reschedule dead compact-conversation jobs (corpses must not be revived)', async () => {
    const query = vi.fn(async () => ({ rows: [], rowCount: 0 }))
    const helpers = makeHelpers(query)

    await enqueueStaleCompactionTask({}, helpers as never)

    const rescheduleCalls = query.mock.calls.filter((c) =>
      String(c[0]).includes('reschedule_jobs'),
    )
    expect(rescheduleCalls).toHaveLength(0)
  })

  it('re-adds missing jobs with the conversation-id key shared with enqueue-idle', async () => {
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql.includes('FROM ros_conversations') || sql.includes('FROM (')) {
        expect(params).toEqual([15, 5, 10, 4 * 24 * 60, 2, 200])
        return {
          rows: [{ conversation_id: 'conv-9', trigger: 'session_stale' }],
          rowCount: 1,
        }
      }
      return { rows: [], rowCount: 0 }
    })
    const helpers = makeHelpers(query)

    await enqueueStaleCompactionTask({}, helpers as never)

    expect(helpers.addJob).toHaveBeenCalledWith(
      'compact-conversation',
      compactConversationPayload('conv-9', 'session_stale'),
      compactConversationJobOptions('conv-9', { priority: 10 }),
    )
  })

  it('does not claim a full-batch success when a later addJob throws', async () => {
    const query = vi.fn(async () => ({
      rows: [
        { conversation_id: 'conv-1', trigger: 'session_idle' },
        { conversation_id: 'conv-2', trigger: 'session_idle' },
      ],
      rowCount: 2,
    }))
    const helpers = makeHelpers(query)
    helpers.addJob.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('addJob down'))

    await expect(enqueueStaleCompactionTask({}, helpers as never)).rejects.toThrow('addJob down')
    expect(helpers.logger.warn).toHaveBeenCalledWith(expect.stringContaining('after re-adding 1/2'))
    expect(helpers.logger.info).not.toHaveBeenCalledWith(expect.stringContaining('re-added 2'))
  })

  it('does nothing when there are no missing jobs', async () => {
    const query = vi.fn(async () => ({ rows: [], rowCount: 0 }))
    const helpers = makeHelpers(query)

    await enqueueStaleCompactionTask({}, helpers as never)

    expect(helpers.addJob).not.toHaveBeenCalled()
  })
})
