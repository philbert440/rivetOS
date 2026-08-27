/**
 * Unit tests for embed-target null-vector handling.
 *
 * A null vector must not mark embed_status='failed' until maxFailures —
 * that used to orphan the row from enqueue-unembedded after a transient
 * API blip. After the cap, 'failed' uses a distinct error the heal will
 * not match.
 */

import { describe, expect, it, vi } from 'vitest'

vi.mock('../config.js', () => ({
  config: {
    charsPerChunk: 6000,
    truncateDims: 4000,
    maxFailures: 3,
  },
}))

vi.mock('../embed-api.js', () => ({
  embedBatch: vi.fn(),
}))

vi.mock('../classify.js', () => ({
  classifyUnembeddable: () => null,
}))

vi.mock('../compose-embed-text.js', () => ({
  composeMessageEmbedText: (content: string | null) => content ?? '',
}))

import { embedBatch } from '../embed-api.js'
import {
  embedTargetTask,
  NULL_EMBED_ERROR,
  PERMANENT_NULL_EMBED_ERROR,
} from './embed-target.js'

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
