/**
 * Idempotent upsert of ros_message_chunks for a long message.
 *
 * Delete-and-reinsert only when ros_messages.content_hash no longer matches
 * the sha256 of the composed embed text, or when no chunk rows exist yet.
 * When the hash matches but some chunk rows still have NULL embeddings,
 * already-computed vectors are written in place (no delete).
 */

import { createHash } from 'node:crypto'
import type { TextChunk } from '../chunking.js'
import { formatHalfvec, truncateVec } from '../halfvec.js'

export function hashEmbedContent(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

export type PgQuery = (
  sql: string,
  values?: unknown[],
) => Promise<{ rows: Array<Record<string, unknown>>; rowCount?: number | null }>

export async function upsertMessageChunks(
  query: PgQuery,
  opts: {
    messageId: string
    content: string
    chunks: TextChunk[]
    vectors?: Array<number[] | null>
    truncateDims: number
  },
): Promise<'skipped' | 'inserted' | 'backfilled'> {
  const hash = hashEmbedContent(opts.content)
  const existing = await query(
    `SELECT content_hash,
            (SELECT count(*)::int FROM ros_message_chunks c WHERE c.message_id = ros_messages.id) AS chunk_count,
            (SELECT count(*)::int FROM ros_message_chunks c WHERE c.message_id = ros_messages.id AND c.embedding IS NULL) AS null_embed_count
       FROM ros_messages
      WHERE id = $1`,
    [opts.messageId],
  )
  const row = existing.rows[0]
  const chunkCount = Number(row?.chunk_count ?? 0)
  if (row && row.content_hash === hash && chunkCount > 0) {
    const nullEmbedCount = Number(row.null_embed_count ?? 0)
    if (nullEmbedCount > 0 && opts.vectors) {
      for (let i = 0; i < opts.chunks.length; i++) {
        const raw = opts.vectors[i]
        if (!raw || raw.length === 0) continue
        const vec = truncateVec(raw, opts.truncateDims)
        await query(
          `UPDATE ros_message_chunks SET embedding = $1 WHERE message_id = $2 AND idx = $3 AND embedding IS NULL`,
          [formatHalfvec(vec), opts.messageId, i],
        )
      }
      return 'backfilled'
    }
    return 'skipped'
  }

  await query(`DELETE FROM ros_message_chunks WHERE message_id = $1`, [opts.messageId])

  for (let i = 0; i < opts.chunks.length; i++) {
    const chunk = opts.chunks[i]
    const raw = opts.vectors?.[i]
    if (raw && raw.length > 0) {
      const vec = truncateVec(raw, opts.truncateDims)
      await query(
        `INSERT INTO ros_message_chunks (message_id, idx, char_start, char_end, content, embedding)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [opts.messageId, i, chunk.charStart, chunk.charEnd, chunk.text, formatHalfvec(vec)],
      )
    } else {
      await query(
        `INSERT INTO ros_message_chunks (message_id, idx, char_start, char_end, content)
         VALUES ($1, $2, $3, $4, $5)`,
        [opts.messageId, i, chunk.charStart, chunk.charEnd, chunk.text],
      )
    }
  }

  await query(`UPDATE ros_messages SET content_hash = $1 WHERE id = $2`, [hash, opts.messageId])
  return 'inserted'
}
