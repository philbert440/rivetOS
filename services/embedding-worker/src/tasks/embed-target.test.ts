/**
 * Unit tests for embed-target null-vector handling.
 *
 * A null vector must not mark embed_status='failed' — that used to orphan
 * the row from enqueue-unembedded after a transient API blip.
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
import { embedTargetTask, NULL_EMBED_ERROR } from './embed-target.js'

describe('embed-target null vector', () => {
  it('records the error and throws without setting embed_status=failed', async () => {
    vi.mocked(embedBatch).mockResolvedValueOnce([null])

    const sqls: string[] = []
    const params: unknown[][] = []
    const query = vi.fn(async (sql: string, values?: unknown[]) => {
      sqls.push(sql)
      if (values) params.push(values)
      if (/SELECT/i.test(sql)) {
        return { rows: [{ id: 'msg-1', content: 'hello there, this is embeddable text' }] }
      }
      return { rows: [], rowCount: 1 }
    })

    const helpers = {
      withPgClient: async (fn: (client: { query: typeof query }) => Promise<void>) => fn({ query }),
      logger: { info: vi.fn(), error: vi.fn() },
    }

    await expect(
      embedTargetTask({ targetTable: 'ros_messages', targetId: 'msg-1' }, helpers as never),
    ).rejects.toThrow(NULL_EMBED_ERROR)

    const update = sqls.find((s) => /UPDATE ros_messages/i.test(s) && s.includes('embed_error'))
    expect(update).toBeDefined()
    expect(update).not.toMatch(/embed_status/)
    expect(params.some((p) => p.includes(NULL_EMBED_ERROR))).toBe(true)
  })
})
