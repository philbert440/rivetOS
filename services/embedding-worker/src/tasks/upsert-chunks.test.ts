/**
 * Unit tests for the ros_message_chunks upsert.
 */

import { describe, it, expect, vi } from 'vitest'

import { upsertMessageChunks, hashEmbedContent } from './upsert-chunks.js'
import type { TextChunk } from '../chunking.js'

const chunk = (text: string, start: number): TextChunk =>
  ({ text, charStart: start, charEnd: start + text.length }) as TextChunk

/** Fake pg client: no existing chunk rows, so the delete+insert path runs. */
function freshClient() {
  const sqls: string[] = []
  const query = vi.fn(async (sql: string, _params?: unknown[]) => {
    sqls.push(sql)
    if (/FROM ros_messages/i.test(sql)) {
      return { rows: [{ content_hash: null, chunk_count: 0, null_embed_count: 0 }], rowCount: 1 }
    }
    return { rows: [], rowCount: 0 }
  })
  return { sqls, query }
}

describe('upsertMessageChunks', () => {
  // embed-target (trigger-driven) and the enqueue-unchunked sweep both call
  // this for the same message. A racer re-inserting between our DELETE and our
  // INSERT used to raise a unique violation on (message_id, idx) and kill the
  // job, so every insert must upsert instead of failing.
  it('upserts on the (message_id, idx) unique constraint rather than raising', async () => {
    const { sqls, query } = freshClient()

    const outcome = await upsertMessageChunks(query, {
      messageId: 'm1',
      content: 'abcdef',
      chunks: [chunk('abc', 0), chunk('def', 3)],
      vectors: [[0.5, 0.25], null],
      truncateDims: 2,
    })

    expect(outcome).toBe('inserted')
    const inserts = sqls.filter((s) => /INSERT INTO ros_message_chunks/i.test(s))
    expect(inserts).toHaveLength(2)
    for (const sql of inserts) {
      expect(sql).toMatch(/ON CONFLICT \(message_id, idx\) DO UPDATE/i)
    }
  })

  it('keeps a vector a concurrent writer already computed', async () => {
    const { sqls, query } = freshClient()

    await upsertMessageChunks(query, {
      messageId: 'm1',
      content: 'abcdef',
      chunks: [chunk('abc', 0), chunk('def', 3)],
      // second chunk has no vector — its upsert must not null out a vector the
      // racer wrote, hence COALESCE rather than a bare EXCLUDED.embedding.
      vectors: [[0.5, 0.25], null],
      truncateDims: 2,
    })

    const inserts = sqls.filter((s) => /INSERT INTO ros_message_chunks/i.test(s))
    for (const sql of inserts) {
      expect(sql).toMatch(/COALESCE\(EXCLUDED\.embedding, ros_message_chunks\.embedding\)/i)
    }
  })

  it('still deletes before reinserting when the content hash moved', async () => {
    const sqls: string[] = []
    const query = vi.fn(async (sql: string, _params?: unknown[]) => {
      sqls.push(sql)
      if (/FROM ros_messages/i.test(sql)) {
        return {
          rows: [{ content_hash: hashEmbedContent('stale'), chunk_count: 2, null_embed_count: 0 }],
          rowCount: 1,
        }
      }
      return { rows: [], rowCount: 0 }
    })

    await upsertMessageChunks(query, {
      messageId: 'm1',
      content: 'abcdef',
      chunks: [chunk('abcdef', 0)],
      truncateDims: 2,
    })

    const deleteIdx = sqls.findIndex((s) => /DELETE FROM ros_message_chunks/i.test(s))
    const insertIdx = sqls.findIndex((s) => /INSERT INTO ros_message_chunks/i.test(s))
    expect(deleteIdx).toBeGreaterThanOrEqual(0)
    expect(insertIdx).toBeGreaterThan(deleteIdx)
  })
})
