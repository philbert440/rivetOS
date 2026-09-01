/**
 * Unit tests for the enqueue-unchunked backfill sweep.
 */

import { describe, it, expect, vi } from 'vitest'

vi.mock('../config.js', () => ({
  config: {
    charsPerChunk: 6000,
    chunkBackfillLimit: 200,
    embedChunksEnabled: true,
    truncateDims: 1024,
    sweepMaxAttempts: 5,
  },
}))

import { enqueueUnchunkedTask } from './enqueue-unchunked.js'
import { config } from '../config.js'
import { hashEmbedContent } from './upsert-chunks.js'
import { composeMessageEmbedText } from '../compose-embed-text.js'

const LONG = 'y'.repeat(7000)

describe('enqueue-unchunked', () => {
  it('bounds the sweep by CHUNK_BACKFILL_LIMIT and uses composed-length SQL', async () => {
    const sqls: string[] = []
    const paramLog: unknown[][] = []
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      sqls.push(sql)
      if (params) paramLog.push(params)
      return { rows: [], rowCount: 0 }
    })
    const helpers = {
      withPgClient: async (fn: (c: { query: typeof query }) => Promise<void>) => fn({ query }),
      addJob: vi.fn(async () => undefined),
      logger: { info: vi.fn(), warn: vi.fn() },
    }

    await enqueueUnchunkedTask({} as never, helpers as never)

    const select = sqls.find((s) => /LIMIT \$2/.test(s))
    expect(select).toBeDefined()
    expect(select).toMatch(/ros_messages/)
    expect(select).toMatch(/ros_message_chunks/)
    expect(select).toMatch(/LENGTH\(btrim\(COALESCE\(m\.content,''\), E' \\t\\n\\r\\f\\v'\)\)/)
    expect(select).toMatch(
      /LEAST\(LENGTH\(btrim\(COALESCE\(m\.tool_result,''\), E' \\t\\n\\r\\f\\v'\)\), 32768\)/,
    )
    expect(select).toMatch(/E' \\t\\n\\r\\f\\v'/)
    expect(select).toMatch(/unembeddable/)
    expect(paramLog[0]).toEqual([6000, 200])
    expect(helpers.addJob).not.toHaveBeenCalled()
  })

  it('inserts chunk rows for a long unchunked message and enqueues embed-target per chunk', async () => {
    const inserted: string[] = []
    const query = vi.fn(async (sql: string, _params?: unknown[]) => {
      if (/LIMIT \$2/.test(sql)) {
        return { rows: [{ id: 'm1', content: LONG, tool_result: null }], rowCount: 1 }
      }
      if (/content_hash/i.test(sql) || /chunk_count/i.test(sql)) {
        return { rows: [{ content_hash: null, chunk_count: 0 }] }
      }
      if (/INSERT INTO ros_message_chunks/i.test(sql)) {
        const id = `chunk-${String(inserted.length)}`
        inserted.push(id)
        return { rows: [], rowCount: 1 }
      }
      if (/FROM ros_message_chunks/i.test(sql) && /ORDER BY idx/i.test(sql)) {
        return { rows: inserted.map((id) => ({ id })), rowCount: inserted.length }
      }
      return { rows: [], rowCount: 1 }
    })
    const helpers = {
      withPgClient: async (fn: (c: { query: typeof query }) => Promise<void>) => fn({ query }),
      addJob: vi.fn(async () => undefined),
      logger: { info: vi.fn(), warn: vi.fn() },
    }

    await enqueueUnchunkedTask({} as never, helpers as never)

    expect(inserted.length).toBeGreaterThan(1)
    expect(helpers.addJob).toHaveBeenCalledTimes(inserted.length)
    expect(helpers.addJob).toHaveBeenCalledWith(
      'embed-target',
      { targetTable: 'ros_message_chunks', targetId: 'chunk-0' },
      expect.objectContaining({
        jobKey: 'embed-ros_message_chunks-chunk-0',
        jobKeyMode: 'preserve_run_at',
        maxAttempts: 5,
      }),
    )
    expect(helpers.logger.info).toHaveBeenCalledWith(expect.stringContaining('chunked 1 message'))
  })

  it('skips delete-and-reinsert when content_hash still matches', async () => {
    const content = composeMessageEmbedText(LONG, null)
    const hash = hashEmbedContent(content)
    const query = vi.fn(async (sql: string, _params?: unknown[]) => {
      if (/LIMIT \$2/.test(sql)) {
        return { rows: [{ id: 'm1', content: LONG, tool_result: null }], rowCount: 1 }
      }
      if (/content_hash/i.test(sql) || /chunk_count/i.test(sql)) {
        return { rows: [{ content_hash: hash, chunk_count: 2 }] }
      }
      return { rows: [], rowCount: 0 }
    })
    const helpers = {
      withPgClient: async (fn: (c: { query: typeof query }) => Promise<void>) => fn({ query }),
      addJob: vi.fn(async () => undefined),
      logger: { info: vi.fn(), warn: vi.fn() },
    }

    await enqueueUnchunkedTask({} as never, helpers as never)

    expect(query.mock.calls.some(([sql]) => /DELETE FROM ros_message_chunks/i.test(sql))).toBe(
      false,
    )
    expect(query.mock.calls.some(([sql]) => /INSERT INTO ros_message_chunks/i.test(sql))).toBe(
      false,
    )
    expect(helpers.addJob).not.toHaveBeenCalled()
  })

  it('is a no-op when EMBED_CHUNKS_ENABLED=false', async () => {
    const cfg = config as { embedChunksEnabled: boolean }
    const prev = cfg.embedChunksEnabled
    cfg.embedChunksEnabled = false
    try {
      const query = vi.fn(async () => ({ rows: [], rowCount: 0 }))
      const helpers = {
        withPgClient: async (fn: (c: { query: typeof query }) => Promise<void>) => fn({ query }),
        addJob: vi.fn(async () => undefined),
        logger: { info: vi.fn(), warn: vi.fn() },
      }

      await enqueueUnchunkedTask({} as never, helpers as never)

      expect(query).not.toHaveBeenCalled()
      expect(helpers.addJob).not.toHaveBeenCalled()
    } finally {
      cfg.embedChunksEnabled = prev
    }
  })

  it('continues the batch when one message hits a UNIQUE-violation race', async () => {
    const inserted: string[] = []
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      if (/LIMIT \$2/.test(sql)) {
        return {
          rows: [
            { id: 'm-race', content: LONG, tool_result: null },
            { id: 'm-ok', content: LONG, tool_result: null },
          ],
          rowCount: 2,
        }
      }
      if (/content_hash/i.test(sql) || /chunk_count/i.test(sql)) {
        const messageId = params?.[0]
        if (messageId === 'm-race') {
          throw new Error('duplicate key value violates unique constraint')
        }
        return { rows: [{ content_hash: null, chunk_count: 0 }] }
      }
      if (/INSERT INTO ros_message_chunks/i.test(sql)) {
        const id = `chunk-${String(inserted.length)}`
        inserted.push(id)
        return { rows: [], rowCount: 1 }
      }
      if (/FROM ros_message_chunks/i.test(sql) && /ORDER BY idx/i.test(sql)) {
        return { rows: inserted.map((id) => ({ id })), rowCount: inserted.length }
      }
      return { rows: [], rowCount: 1 }
    })
    const helpers = {
      withPgClient: async (fn: (c: { query: typeof query }) => Promise<void>) => fn({ query }),
      addJob: vi.fn(async () => undefined),
      logger: { info: vi.fn(), warn: vi.fn() },
    }

    await enqueueUnchunkedTask({} as never, helpers as never)

    expect(helpers.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('message m-race failed'),
    )
    expect(helpers.addJob).toHaveBeenCalled()
    expect(helpers.logger.info).toHaveBeenCalledWith(expect.stringContaining('chunked 1 message'))
  })

  it('logs a warning and does not throw when the sweep query fails', async () => {
    const query = vi.fn(async () => {
      throw new Error('relation "ros_message_chunks" does not exist')
    })
    const helpers = {
      withPgClient: async (fn: (c: { query: typeof query }) => Promise<void>) => fn({ query }),
      addJob: vi.fn(async () => undefined),
      logger: { info: vi.fn(), warn: vi.fn() },
    }

    await enqueueUnchunkedTask({} as never, helpers as never)

    expect(helpers.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('enqueue-unchunked] sweep failed'),
    )
    expect(helpers.addJob).not.toHaveBeenCalled()
  })
})
