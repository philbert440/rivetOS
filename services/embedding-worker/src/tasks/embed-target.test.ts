/**
 * Unit tests for embed-target null-vector handling.
 *
 * A null vector must not mark embed_status='failed' until maxFailures —
 * that used to orphan the row from enqueue-unembedded after a transient
 * API blip. After the cap, 'failed' uses a distinct error the heal will
 * not match.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../config.js', () => ({
  config: {
    charsPerChunk: 6000,
    truncateDims: 1024,
    maxFailures: 3,
    embedChunksEnabled: true,
  },
}))

vi.mock('../embed-api.js', () => ({
  embedBatch: vi.fn(),
}))

vi.mock('../classify.js', () => ({
  classifyUnembeddable: vi.fn(() => null),
}))

vi.mock('../compose-embed-text.js', () => ({
  composeMessageEmbedText: (content: string | null) => content ?? '',
}))

import { embedBatch } from '../embed-api.js'
import { classifyUnembeddable } from '../classify.js'
import {
  embedTargetTask,
  NULL_EMBED_ERROR,
  PERMANENT_NULL_EMBED_ERROR,
} from './embed-target.js'
import { hashEmbedContent, upsertMessageChunks } from './upsert-chunks.js'
import { splitIntoChunksWithOffsets } from '../chunking.js'
import { config } from '../config.js'

beforeEach(() => {
  vi.mocked(classifyUnembeddable).mockReturnValue(null)
})

function makeQuery(opts: { failuresOnNull?: number } = {}) {
  const sqls: string[] = []
  const params: unknown[][] = []
  const query = vi.fn(async (sql: string, values?: unknown[]) => {
    sqls.push(sql)
    if (values) params.push(values)
    if (/SELECT/i.test(sql)) {
      return { rows: [{ id: 'msg-1', content: 'hello there, this is embeddable text' }] }
    }
    if (/RETURNING embed_failures/i.test(sql)) {
      return { rows: [{ embed_failures: opts.failuresOnNull ?? 1 }], rowCount: 1 }
    }
    return { rows: [], rowCount: 1 }
  })
  return { sqls, params, query }
}

describe('embed-target null vector', () => {
  it('records the error and throws without setting embed_status=failed', async () => {
    vi.mocked(embedBatch).mockResolvedValueOnce([null])
    const { sqls, params, query } = makeQuery({ failuresOnNull: 1 })

    const helpers = {
      withPgClient: async (fn: (client: { query: typeof query }) => Promise<void>) => fn({ query }),
      logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
    }

    await expect(
      embedTargetTask({ targetTable: 'ros_messages', targetId: 'msg-1' }, helpers as never),
    ).rejects.toThrow(NULL_EMBED_ERROR)

    const update = sqls.find((s) => /UPDATE ros_messages/i.test(s) && s.includes('embed_error'))
    expect(update).toBeDefined()
    expect(update).not.toMatch(/embed_status/)
    expect(params.some((p) => p.includes(NULL_EMBED_ERROR))).toBe(true)
    expect(helpers.logger.warn).not.toHaveBeenCalled()
  })

  it('marks embed_status=failed with a distinct error after maxFailures nulls', async () => {
    vi.mocked(embedBatch).mockResolvedValueOnce([null])
    const { sqls, params, query } = makeQuery({ failuresOnNull: 3 })

    const helpers = {
      withPgClient: async (fn: (client: { query: typeof query }) => Promise<void>) => fn({ query }),
      logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
    }

    await embedTargetTask({ targetTable: 'ros_messages', targetId: 'msg-1' }, helpers as never)

    const increment = sqls.find((s) => /RETURNING embed_failures/i.test(s))
    expect(increment).toBeDefined()
    expect(increment).not.toMatch(/embed_status/)

    const terminal = sqls.find((s) => s.includes("embed_status = 'failed'"))
    expect(terminal).toBeDefined()
    expect(params.some((p) => p.includes(PERMANENT_NULL_EMBED_ERROR))).toBe(true)
    expect(params.some((p) => p.includes(NULL_EMBED_ERROR))).toBe(true)
    expect(PERMANENT_NULL_EMBED_ERROR).not.toBe(NULL_EMBED_ERROR)
    expect(helpers.logger.warn).toHaveBeenCalledWith(expect.stringContaining('marking failed'))
  })
})

describe('embed-target chunk upsert idempotency', () => {
  const longContent = 'x'.repeat(7000)
  const parts = splitIntoChunksWithOffsets(longContent, 6000)
  const hash = hashEmbedContent(longContent)

  function makeChunkClient(opts: { contentHash?: string | null; chunkCount?: number } = {}) {
    const sqls: string[] = []
    const params: unknown[][] = []
    const query = vi.fn(async (sql: string, values?: unknown[]) => {
      sqls.push(sql)
      if (values) params.push(values)
      if (/chunk_count/i.test(sql) || /content_hash/i.test(sql)) {
        return {
          rows: [{ content_hash: opts.contentHash ?? null, chunk_count: opts.chunkCount ?? 0 }],
        }
      }
      return { rows: [], rowCount: 1 }
    })
    return { sqls, params, query }
  }

  it('delete-and-reinserts when content_hash is missing, then skips on matching hash', async () => {
    const first = makeChunkClient({ contentHash: null, chunkCount: 0 })
    const inserted = await upsertMessageChunks(first.query, {
      messageId: 'msg-1',
      content: longContent,
      chunks: parts,
      vectors: parts.map(() => [0.1, 0.2]),
      truncateDims: 1024,
    })
    expect(inserted).toBe('inserted')
    expect(first.sqls.some((s) => /DELETE FROM ros_message_chunks/i.test(s))).toBe(true)
    expect(first.sqls.filter((s) => /INSERT INTO ros_message_chunks/i.test(s)).length).toBe(
      parts.length,
    )
    expect(first.sqls.some((s) => /SET content_hash/i.test(s))).toBe(true)
    expect(first.params.some((p) => p.includes(hash))).toBe(true)

    const second = makeChunkClient({ contentHash: hash, chunkCount: parts.length })
    const skipped = await upsertMessageChunks(second.query, {
      messageId: 'msg-1',
      content: longContent,
      chunks: parts,
      vectors: parts.map(() => [0.1, 0.2]),
      truncateDims: 1024,
    })
    expect(skipped).toBe('skipped')
    expect(second.sqls.some((s) => /DELETE FROM ros_message_chunks/i.test(s))).toBe(false)
    expect(second.sqls.some((s) => /INSERT INTO ros_message_chunks/i.test(s))).toBe(false)
  })

  it('re-inserts when the hash matches but no chunk rows remain', async () => {
    const client = makeChunkClient({ contentHash: hash, chunkCount: 0 })
    const outcome = await upsertMessageChunks(client.query, {
      messageId: 'msg-1',
      content: longContent,
      chunks: parts,
      truncateDims: 1024,
    })
    expect(outcome).toBe('inserted')
    expect(client.sqls.some((s) => /DELETE FROM ros_message_chunks/i.test(s))).toBe(true)
    expect(client.sqls.filter((s) => /INSERT INTO ros_message_chunks/i.test(s)).length).toBe(
      parts.length,
    )
  })

  it('writes chunk rows from embed-target when the parent message is oversized', async () => {
    vi.mocked(embedBatch).mockResolvedValueOnce(parts.map(() => [0.5, 0.25]))
    const sqls: string[] = []
    const query = vi.fn(async (sql: string, _values?: unknown[]) => {
      sqls.push(sql)
      if (/chunk_count/i.test(sql) || /content_hash/i.test(sql)) {
        return { rows: [{ content_hash: null, chunk_count: 0 }] }
      }
      if (/SELECT/i.test(sql)) {
        return { rows: [{ id: 'msg-1', content: longContent }] }
      }
      return { rows: [], rowCount: 1 }
    })
    const helpers = {
      withPgClient: async (fn: (client: { query: typeof query }) => Promise<void>) => fn({ query }),
      logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
    }

    await embedTargetTask({ targetTable: 'ros_messages', targetId: 'msg-1' }, helpers as never)

    expect(sqls.some((s) => /INSERT INTO ros_message_chunks/i.test(s))).toBe(true)
    expect(helpers.logger.info).toHaveBeenCalledWith(expect.stringContaining('chunks inserted'))
  })

  it('embeds a ros_message_chunks row and clears failure state', async () => {
    vi.mocked(embedBatch).mockResolvedValueOnce([[0.1, 0.2, 0.3]])
    const sqls: string[] = []
    const params: unknown[][] = []
    const query = vi.fn(async (sql: string, values?: unknown[]) => {
      sqls.push(sql)
      if (values) params.push(values)
      if (/SELECT/i.test(sql)) {
        return { rows: [{ id: 'chunk-1', content: 'just one chunk of text' }] }
      }
      return { rows: [], rowCount: 1 }
    })
    const helpers = {
      withPgClient: async (fn: (client: { query: typeof query }) => Promise<void>) => fn({ query }),
      logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
    }

    await embedTargetTask(
      { targetTable: 'ros_message_chunks', targetId: 'chunk-1' },
      helpers as never,
    )

    const select = sqls.find((s) => /SELECT/i.test(s))
    expect(select).toMatch(/embedding IS NULL/)
    expect(select).toMatch(/embed_status IS NULL/)
    const update = sqls.find((s) => /UPDATE ros_message_chunks/i.test(s) && /SET embedding/i.test(s))
    expect(update).toBeDefined()
    expect(update).toMatch(/embedding IS NULL/)
    expect(update).toMatch(/embed_status = NULL/)
    expect(params.some((p) => String(p[0]).startsWith('['))).toBe(true)
  })

  it('marks an unembeddable chunk embed_status so the sweep can exclude it', async () => {
    vi.mocked(classifyUnembeddable).mockReturnValueOnce('media-marker')
    vi.mocked(embedBatch).mockClear()
    const sqls: string[] = []
    const params: unknown[][] = []
    const query = vi.fn(async (sql: string, values?: unknown[]) => {
      sqls.push(sql)
      if (values) params.push(values)
      if (/SELECT/i.test(sql)) {
        return { rows: [{ id: 'chunk-1', content: '[media attached: img]' }] }
      }
      return { rows: [], rowCount: 1 }
    })
    const helpers = {
      withPgClient: async (fn: (client: { query: typeof query }) => Promise<void>) => fn({ query }),
      logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
    }

    await embedTargetTask(
      { targetTable: 'ros_message_chunks', targetId: 'chunk-1' },
      helpers as never,
    )

    expect(embedBatch).not.toHaveBeenCalled()
    const update = sqls.find((s) => /UPDATE ros_message_chunks/i.test(s))
    expect(update).toMatch(/embed_status = 'unembeddable'/)
    expect(update).toMatch(/embed_error/)
    expect(params.some((p) => String(p[0]).includes('unembeddable: media-marker'))).toBe(true)
  })

  it('marks a chunk failed after maxFailures null vectors', async () => {
    vi.mocked(embedBatch).mockResolvedValueOnce([null])
    const sqls: string[] = []
    const params: unknown[][] = []
    const query = vi.fn(async (sql: string, values?: unknown[]) => {
      sqls.push(sql)
      if (values) params.push(values)
      if (/SELECT/i.test(sql) && !/RETURNING/i.test(sql)) {
        return { rows: [{ id: 'chunk-1', content: 'just one chunk of text' }] }
      }
      if (/RETURNING embed_failures/i.test(sql)) {
        return { rows: [{ embed_failures: 3 }], rowCount: 1 }
      }
      return { rows: [], rowCount: 1 }
    })
    const helpers = {
      withPgClient: async (fn: (client: { query: typeof query }) => Promise<void>) => fn({ query }),
      logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
    }

    await embedTargetTask(
      { targetTable: 'ros_message_chunks', targetId: 'chunk-1' },
      helpers as never,
    )

    expect(sqls.some((s) => s.includes("embed_status = 'failed'"))).toBe(true)
    expect(params.some((p) => p.includes(PERMANENT_NULL_EMBED_ERROR))).toBe(true)
    expect(helpers.logger.warn).toHaveBeenCalledWith(expect.stringContaining('marking failed'))
  })

  it('throws on a chunk null vector before maxFailures', async () => {
    vi.mocked(embedBatch).mockResolvedValueOnce([null])
    const query = vi.fn(async (sql: string) => {
      if (/SELECT/i.test(sql) && !/RETURNING/i.test(sql)) {
        return { rows: [{ id: 'chunk-1', content: 'just one chunk of text' }] }
      }
      if (/RETURNING embed_failures/i.test(sql)) {
        return { rows: [{ embed_failures: 1 }], rowCount: 1 }
      }
      return { rows: [], rowCount: 1 }
    })
    const helpers = {
      withPgClient: async (fn: (client: { query: typeof query }) => Promise<void>) => fn({ query }),
      logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
    }

    await expect(
      embedTargetTask(
        { targetTable: 'ros_message_chunks', targetId: 'chunk-1' },
        helpers as never,
      ),
    ).rejects.toThrow(NULL_EMBED_ERROR)
  })

  it('writes already-computed vectors into NULL-embedded chunk rows when the hash matches', async () => {
    const sqls: string[] = []
    const query = vi.fn(async (sql: string, _values?: unknown[]) => {
      sqls.push(sql)
      if (/chunk_count/i.test(sql) || /content_hash/i.test(sql)) {
        return {
          rows: [
            {
              content_hash: hash,
              chunk_count: parts.length,
              null_embed_count: parts.length,
            },
          ],
        }
      }
      return { rows: [], rowCount: 1 }
    })
    const outcome = await upsertMessageChunks(query, {
      messageId: 'msg-1',
      content: longContent,
      chunks: parts,
      vectors: parts.map(() => [0.1, 0.2]),
      truncateDims: 1024,
    })
    expect(outcome).toBe('backfilled')
    expect(sqls.some((s) => /DELETE FROM ros_message_chunks/i.test(s))).toBe(false)
    expect(sqls.some((s) => /INSERT INTO ros_message_chunks/i.test(s))).toBe(false)
    const updates = sqls.filter((s) =>
      /UPDATE ros_message_chunks SET embedding = \$1 WHERE message_id = \$2 AND idx = \$3 AND embedding IS NULL/i.test(
        s,
      ),
    )
    expect(updates.length).toBe(parts.length)
  })

  it('no-ops a trigger-enqueued chunk job when EMBED_CHUNKS_ENABLED=false', async () => {
    const cfg = config as { embedChunksEnabled: boolean }
    const prev = cfg.embedChunksEnabled
    cfg.embedChunksEnabled = false
    vi.mocked(embedBatch).mockClear()
    try {
      const query = vi.fn(async () => ({ rows: [{ id: 'chunk-1', content: 'text' }] }))
      const helpers = {
        withPgClient: async (fn: (client: { query: typeof query }) => Promise<void>) =>
          fn({ query }),
        logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
      }

      await embedTargetTask(
        { targetTable: 'ros_message_chunks', targetId: 'chunk-1' },
        helpers as never,
      )

      expect(query).not.toHaveBeenCalled()
      expect(embedBatch).not.toHaveBeenCalled()
      expect(helpers.logger.info).toHaveBeenCalledWith(
        expect.stringContaining('EMBED_CHUNKS_ENABLED=false'),
      )
    } finally {
      cfg.embedChunksEnabled = prev
    }
  })
})
