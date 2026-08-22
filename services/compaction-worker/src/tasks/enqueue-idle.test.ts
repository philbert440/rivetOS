/**
 * Unit tests for enqueue-idle eligibility (heartbeat exclusion).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../config.js', () => ({
  config: {
    idleMinutes: 15,
    leafBatchSize: 10,
    staleMinutes: 4 * 24 * 60,
    staleMinBatch: 2,
    pgUrl: 'postgresql://localhost/test',
  },
}))

vi.mock('@rivetos/memory-postgres', () => ({
  MIN_BATCH_SIZE: 5,
  sqlNotHeartbeatConversation: (alias = 'c') =>
    `(${alias}.session_key IS NULL OR ${alias}.session_key NOT LIKE 'heartbeat:%')`,
}))

import { enqueueIdleSelectSql, enqueueIdleTask } from './enqueue-idle.js'

describe('enqueueIdleSelectSql', () => {
  const sql = enqueueIdleSelectSql()

  it('excludes heartbeat conversations from compaction enqueue', () => {
    expect(sql).toMatch(/c\.session_key IS NULL OR c\.session_key NOT LIKE 'heartbeat:%'/)
  })

  it('still selects on unsummarized messages (content or tool_name)', () => {
    expect(sql).toMatch(/LENGTH\(m\.content\) > 10/)
    expect(sql).toMatch(/m\.tool_name IS NOT NULL/)
  })

  it('keeps the idle / stale trigger split', () => {
    expect(sql).toMatch(/WHEN COUNT\(m\.id\) >= \$2 THEN 'session_idle' ELSE 'session_stale'/)
  })
})

describe('enqueueIdleTask', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('runs the heartbeat-excluding SELECT with the configured floors', async () => {
    const query = vi.fn(async () => ({
      rows: [{ conversation_id: 'conv-1', unsummarized: 12, trigger: 'session_idle' }],
    }))
    const addJob = vi.fn(async () => undefined)
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }

    await enqueueIdleTask({}, {
      withPgClient: async (fn: (client: { query: typeof query }) => Promise<void>) => fn({ query }),
      addJob,
      logger,
    } as never)

    expect(query).toHaveBeenCalledTimes(1)
    const [sql, params] = query.mock.calls[0] as [string, unknown[]]
    expect(sql).toContain("c.session_key NOT LIKE 'heartbeat:%'")
    expect(params).toEqual([15, 5, 10, 4 * 24 * 60, 2, 10])
    expect(addJob).toHaveBeenCalledWith(
      'compact-conversation',
      { conversationId: 'conv-1', triggerType: 'session_idle' },
      expect.objectContaining({ jobKey: 'conv-1' }),
    )
  })

  it('enqueues nothing when no conversations qualify', async () => {
    const query = vi.fn(async () => ({ rows: [] }))
    const addJob = vi.fn(async () => undefined)
    const logger = { info: vi.fn() }

    await enqueueIdleTask({}, {
      withPgClient: async (fn: (client: { query: typeof query }) => Promise<void>) => fn({ query }),
      addJob,
      logger,
    } as never)

    expect(addJob).not.toHaveBeenCalled()
    expect(logger.info).not.toHaveBeenCalled()
  })
})
