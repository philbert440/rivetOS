/**
 * Unit tests for the enqueue-unembedded backstop sweep.
 */

import { describe, it, expect, vi } from 'vitest'

vi.mock('../config.js', () => ({
  config: {
    sweepLimit: 200,
    sweepMaxAttempts: 5,
  },
}))

import { enqueueUnembeddedTask } from './enqueue-unembedded.js'

interface MockHelpers {
  withPgClient: (
    fn: (client: { query: ReturnType<typeof vi.fn> }) => Promise<void>,
  ) => Promise<void>
  addJob: ReturnType<typeof vi.fn>
  logger: { info: ReturnType<typeof vi.fn> }
}

/** Build helpers whose pg client returns `byTable[table]` rows for each table. */
function makeHelpers(byTable: Record<string, Array<{ id: string }>>): MockHelpers {
  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    const table = sql.includes('ros_messages')
      ? 'ros_messages'
      : sql.includes('ros_wiki_topics')
        ? 'ros_wiki_topics'
        : 'ros_summaries'
    expect(params).toEqual([200]) // sweepLimit threaded as $1
    return { rows: byTable[table] ?? [], rowCount: (byTable[table] ?? []).length }
  })
  return {
    withPgClient: async (fn) => fn({ query }),
    addJob: vi.fn(async () => undefined),
    logger: { info: vi.fn() },
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

  it('message sweep SQL includes tool_result eligibility (not content alone)', async () => {
    const sqls: string[] = []
    const query = vi.fn(async (sql: string) => {
      sqls.push(sql)
      return { rows: [], rowCount: 0 }
    })
    const helpers = {
      withPgClient: async (fn: (c: { query: typeof query }) => Promise<void>) => fn({ query }),
      addJob: vi.fn(async () => undefined),
      logger: { info: vi.fn() },
    }

    await enqueueUnembeddedTask({} as any, helpers as any)

    const msgSql = sqls.find((s) => s.includes('ros_messages'))
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
})
