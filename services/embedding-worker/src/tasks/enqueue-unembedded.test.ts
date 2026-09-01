/**
 * Unit tests for the enqueue-unembedded backstop sweep.
 */

import { describe, it, expect, vi } from 'vitest'

vi.mock('../config.js', () => ({
  config: {
    sweepLimit: 200,
    sweepMaxAttempts: 5,
    embedChunksEnabled: true,
  },
}))

import { enqueueUnembeddedTask, healFailedNullSql } from './enqueue-unembedded.js'
import { NULL_EMBED_ERROR, PERMANENT_NULL_EMBED_ERROR } from './embed-target.js'
import { config } from '../config.js'

interface MockHelpers {
  withPgClient: (
    fn: (client: { query: ReturnType<typeof vi.fn> }) => Promise<void>,
  ) => Promise<void>
  addJob: ReturnType<typeof vi.fn>
  logger: { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn> }
}

/** Build helpers whose pg client returns `byTable[table]` rows for each table. */
function makeHelpers(byTable: Record<string, Array<{ id: string }>>): MockHelpers {
  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    const table = sql.includes('ros_message_chunks')
      ? 'ros_message_chunks'
      : sql.includes('ros_wiki_topics')
        ? 'ros_wiki_topics'
        : sql.includes('ros_messages')
          ? 'ros_messages'
          : 'ros_summaries'
    if (/^\s*UPDATE/i.test(sql)) {
      expect(params).toEqual([NULL_EMBED_ERROR])
      return { rows: [], rowCount: 0 }
    }
    expect(params).toEqual([200]) // sweepLimit threaded as $1
    return { rows: byTable[table] ?? [], rowCount: (byTable[table] ?? []).length }
  })
  return {
    withPgClient: async (fn) => fn({ query }),
    addJob: vi.fn(async () => undefined),
    logger: { info: vi.fn(), warn: vi.fn() },
  }
}

describe('enqueue-unembedded', () => {
  it('enqueues an embed-target job per unembedded row with the right key and max_attempts', async () => {
    const helpers = makeHelpers({
      ros_messages: [{ id: 'm1' }, { id: 'm2' }],
      ros_summaries: [{ id: 's1' }],
    })

    await enqueueUnembeddedTask({} as any, helpers as any)

    expect(helpers.addJob).toHaveBeenCalledTimes(3)
    expect(helpers.addJob).toHaveBeenCalledWith(
      'embed-target',
      { targetTable: 'ros_messages', targetId: 'm1' },
      { jobKey: 'embed-ros_messages-m1', jobKeyMode: 'preserve_run_at', maxAttempts: 5 },
    )
    expect(helpers.addJob).toHaveBeenCalledWith(
      'embed-target',
      { targetTable: 'ros_summaries', targetId: 's1' },
      { jobKey: 'embed-ros_summaries-s1', jobKeyMode: 'preserve_run_at', maxAttempts: 5 },
    )
    expect(helpers.logger.info).toHaveBeenCalledWith(expect.stringContaining('re-enqueued 3'))
  })

  it('heals failed-null rows so a recovered embed API can pick them up', () => {
    const sql = healFailedNullSql('ros_messages')
    expect(sql).toMatch(/UPDATE ros_messages/)
    expect(sql).toMatch(/embed_status = NULL/)
    expect(sql).toMatch(/embed_failures = 0/)
    expect(sql).toMatch(/embed_error = \$1/)
    expect(sql).not.toContain(NULL_EMBED_ERROR)
    expect(sql).not.toContain(PERMANENT_NULL_EMBED_ERROR)
    expect(sql).toMatch(/LENGTH\(content\) > 20/)
    expect(sql).toMatch(/LENGTH\(tool_result\) > 20/)
  })

  it('includes each table length predicate on the heal WHERE', () => {
    expect(healFailedNullSql('ros_summaries')).toMatch(/LENGTH\(content\) > 20/)
    expect(healFailedNullSql('ros_wiki_topics')).toMatch(/LENGTH\(search_text\) > 20/)
  })

  it('runs the failed-null heal UPDATE before the unembedded SELECT', async () => {
    const sqls: string[] = []
    const paramLog: unknown[][] = []
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      sqls.push(sql)
      if (params) paramLog.push(params)
      if (/^\s*UPDATE/i.test(sql)) return { rows: [], rowCount: 0 }
      expect(params).toEqual([200])
      return { rows: [], rowCount: 0 }
    })
    const helpers = {
      withPgClient: async (fn: (c: { query: typeof query }) => Promise<void>) => fn({ query }),
      addJob: vi.fn(async () => undefined),
      logger: { info: vi.fn(), warn: vi.fn() },
    }

    await enqueueUnembeddedTask({} as any, helpers as any)

    const msgSqls = sqls.filter((s) => s.includes('ros_messages'))
    expect(msgSqls.length).toBeGreaterThanOrEqual(2)
    expect(msgSqls[0]).toMatch(/^\s*UPDATE/i)
    expect(msgSqls[0]).toMatch(/embed_error = \$1/)
    expect(msgSqls[0]).not.toContain(NULL_EMBED_ERROR)
    expect(msgSqls[0]).toMatch(/LENGTH\(content\) > 20/)
    expect(paramLog[0]).toEqual([NULL_EMBED_ERROR])
    expect(msgSqls[1]).toMatch(/SELECT/)
  })

  it('logs healed rowCount when the failed-null UPDATE matches rows', async () => {
    const query = vi.fn(async (sql: string) => {
      if (/^\s*UPDATE/i.test(sql) && sql.includes('ros_messages')) {
        return { rows: [], rowCount: 4 }
      }
      return { rows: [], rowCount: 0 }
    })
    const helpers = {
      withPgClient: async (fn: (c: { query: typeof query }) => Promise<void>) => fn({ query }),
      addJob: vi.fn(async () => undefined),
      logger: { info: vi.fn(), warn: vi.fn() },
    }

    await enqueueUnembeddedTask({} as any, helpers as any)

    expect(helpers.logger.info).toHaveBeenCalledWith(
      expect.stringContaining('healed 4 failed-null row(s) in ros_messages'),
    )
  })

  it('logs a warning and continues when a table sweep throws', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('ros_messages')) throw new Error('relation does not exist')
      return { rows: [], rowCount: 0 }
    })
    const helpers = {
      withPgClient: async (fn: (c: { query: typeof query }) => Promise<void>) => fn({ query }),
      addJob: vi.fn(async () => undefined),
      logger: { info: vi.fn(), warn: vi.fn() },
    }

    await enqueueUnembeddedTask({} as any, helpers as any)

    expect(helpers.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('ros_messages sweep failed'),
    )
    expect(helpers.addJob).not.toHaveBeenCalled()
  })

  it('message sweep SQL includes tool_result eligibility (not content alone)', async () => {
    const sqls: string[] = []
    const query = vi.fn(async (sql: string) => {
      sqls.push(sql)
      return { rows: [], rowCount: 0 }
    })
    const helpers = {
      withPgClient: async (fn: (c: { query: typeof query }) => Promise<void>) => fn({ query }),
      addJob: vi.fn(async () => undefined),
      logger: { info: vi.fn(), warn: vi.fn() },
    }

    await enqueueUnembeddedTask({} as any, helpers as any)

    const msgSql = sqls.find((s) => s.includes('ros_messages') && /SELECT/i.test(s))
    expect(msgSql).toBeDefined()
    expect(msgSql).toMatch(/tool_result/)
    expect(msgSql).toMatch(/LENGTH\(tool_result\) > 20/)
  })

  it('sweeps ros_wiki_topics keyed on slug (3d)', async () => {
    const helpers = makeHelpers({ ros_wiki_topics: [{ id: 'gerty-vllm-stack' }] })

    await enqueueUnembeddedTask({} as any, helpers as any)

    expect(helpers.addJob).toHaveBeenCalledOnce()
    expect(helpers.addJob).toHaveBeenCalledWith(
      'embed-target',
      { targetTable: 'ros_wiki_topics', targetId: 'gerty-vllm-stack' },
      expect.objectContaining({ jobKey: 'embed-ros_wiki_topics-gerty-vllm-stack' }),
    )
  })

  it('is a no-op (no jobs, no log) when nothing is unembedded', async () => {
    const helpers = makeHelpers({ ros_messages: [], ros_summaries: [] })

    await enqueueUnembeddedTask({} as any, helpers as any)

    expect(helpers.addJob).not.toHaveBeenCalled()
    expect(helpers.logger.info).not.toHaveBeenCalled()
  })

  it('sweeps both tables even when only one has rows', async () => {
    const helpers = makeHelpers({ ros_messages: [], ros_summaries: [{ id: 's9' }] })

    await enqueueUnembeddedTask({} as any, helpers as any)

    expect(helpers.addJob).toHaveBeenCalledOnce()
    expect(helpers.addJob).toHaveBeenCalledWith(
      'embed-target',
      { targetTable: 'ros_summaries', targetId: 's9' },
      expect.objectContaining({ jobKey: 'embed-ros_summaries-s9' }),
    )
  })

  it('chunk sweep SQL excludes terminal embed_status', async () => {
    const sqls: string[] = []
    const query = vi.fn(async (sql: string) => {
      sqls.push(sql)
      if (/^\s*UPDATE/i.test(sql)) return { rows: [], rowCount: 0 }
      return { rows: [], rowCount: 0 }
    })
    const helpers = {
      withPgClient: async (fn: (c: { query: typeof query }) => Promise<void>) => fn({ query }),
      addJob: vi.fn(async () => undefined),
      logger: { info: vi.fn(), warn: vi.fn() },
    }

    await enqueueUnembeddedTask({} as any, helpers as any)

    const chunkSelect = sqls.find((s) => s.includes('ros_message_chunks') && /SELECT/i.test(s))
    expect(chunkSelect).toBeDefined()
    expect(chunkSelect).toMatch(/embed_status IS NULL/)
    expect(chunkSelect).toMatch(/embedding IS NULL/)
  })

  it('sweeps ros_message_chunks with the trigger job_key (dedupes live trigger jobs)', async () => {
    const helpers = makeHelpers({ ros_message_chunks: [{ id: 'c1' }] })

    await enqueueUnembeddedTask({} as any, helpers as any)

    expect(helpers.addJob).toHaveBeenCalledOnce()
    expect(helpers.addJob).toHaveBeenCalledWith(
      'embed-target',
      { targetTable: 'ros_message_chunks', targetId: 'c1' },
      {
        jobKey: 'embed-ros_message_chunks-c1',
        jobKeyMode: 'preserve_run_at',
        maxAttempts: 5,
      },
    )
  })

  it('skips the chunk backstop when EMBED_CHUNKS_ENABLED=false', async () => {
    const cfg = config as { embedChunksEnabled: boolean }
    const prev = cfg.embedChunksEnabled
    cfg.embedChunksEnabled = false
    try {
      const helpers = makeHelpers({ ros_message_chunks: [{ id: 'c1' }] })
      await enqueueUnembeddedTask({} as any, helpers as any)
      expect(helpers.addJob).not.toHaveBeenCalled()
    } finally {
      cfg.embedChunksEnabled = prev
    }
  })

  it('logs a warning and continues when the chunk table is missing', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('ros_message_chunks')) throw new Error('relation does not exist')
      if (/^\s*UPDATE/i.test(sql)) return { rows: [], rowCount: 0 }
      return { rows: [], rowCount: 0 }
    })
    const helpers = {
      withPgClient: async (fn: (c: { query: typeof query }) => Promise<void>) => fn({ query }),
      addJob: vi.fn(async () => undefined),
      logger: { info: vi.fn(), warn: vi.fn() },
    }

    await enqueueUnembeddedTask({} as any, helpers as any)

    expect(helpers.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('ros_message_chunks sweep failed'),
    )
    expect(helpers.addJob).not.toHaveBeenCalled()
  })
})
