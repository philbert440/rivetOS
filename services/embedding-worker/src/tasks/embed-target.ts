/**
 * embed-target task — embed one row from ros_messages or ros_summaries.
 *
 * Job key (passed via add_job's job_key) is `embed-<table>-<id>` to dedupe
 * pending jobs for the same row.
 *
 * Replaces the LISTEN/NOTIFY-driven JS embedding worker. Per-row jobs
 * mean graphile-worker handles concurrency, retry, and dedup at the queue
 * level — we just embed one row per task invocation.
 *
 * For oversized content (> EMBED_CHARS_PER_CHUNK), we chunk the content,
 * embed each chunk, and mean-pool the vectors into a single row vector.
 */

import type { Task } from 'graphile-worker'
import { config } from '../config.js'
import { safeSlice } from '../safe-slice.js'
import { splitIntoChunks, meanPool } from '../chunking.js'
import { classifyUnembeddable } from '../classify.js'
import { embedBatch } from '../embed-api.js'

export interface EmbedTargetPayload {
  targetTable: 'ros_messages' | 'ros_summaries'
  targetId: string
}

interface ContentRow {
  id: string
  content: string | null
}

export const embedTargetTask: Task = async (payload, helpers) => {
  const { targetTable, targetId } = payload as EmbedTargetPayload

  if (targetTable !== 'ros_messages' && targetTable !== 'ros_summaries') {
    helpers.logger.error(`[embed-target] invalid target_table: ${targetTable}`)
    return
  }

  await helpers.withPgClient(async (client) => {
    const result = await client.query<ContentRow>(
      `SELECT id, content FROM ${targetTable}
        WHERE id = $1
          AND content IS NOT NULL
          AND LENGTH(content) > 0`,
      [targetId],
    )

    if (result.rows.length === 0) {
      helpers.logger.info(
        `[embed-target] ${targetTable} ${targetId.slice(0, 8)} not found or empty — dropping`,
      )
      return
    }

    const row = result.rows[0]
    const content = row.content ?? ''

    const unembeddable = classifyUnembeddable(content)
    if (unembeddable) {
      await client.query(
        `UPDATE ${targetTable}
            SET embed_status = 'unembeddable',
                embed_error = $1
          WHERE id = $2`,
        [`unembeddable: ${unembeddable}`, targetId],
      )
      helpers.logger.info(
        `[embed-target] ${targetTable} ${targetId.slice(0, 8)} unembeddable: ${unembeddable}`,
      )
      return
    }

    let pooled: number[] | null
    if (content.length <= config.charsPerChunk) {
      const truncated = safeSlice(content, config.charsPerChunk)
      const vectors = await embedBatch([truncated])
      pooled = vectors[0] ?? null
    } else {
      const chunks = splitIntoChunks(content, config.charsPerChunk)
      const vectors = await embedBatch(chunks)
      pooled = meanPool(vectors)
      helpers.logger.info(
        `[embed-target] mean-pooled ${chunks.length} chunks for ${targetTable} ${targetId.slice(0, 8)} (${content.length} chars)`,
      )
    }

    if (!pooled) {
      // Throw → graphile-worker will retry with backoff (max_attempts in trigger config).
      // After max_attempts the job remains stuck and we mark embed_status='failed'.
      await client.query(
        `UPDATE ${targetTable}
            SET embed_failures = COALESCE(embed_failures, 0) + 1,
                embed_error = $1,
                embed_status = CASE
                  WHEN COALESCE(embed_failures, 0) + 1 >= $2 THEN 'failed'
                  ELSE embed_status
                END
          WHERE id = $3`,
        ['Embedding returned null', config.maxFailures, targetId],
      )
      throw new Error('Embedding returned null')
    }

    const truncatedVec =
      pooled.length > config.truncateDims ? pooled.slice(0, config.truncateDims) : pooled

    await client.query(`UPDATE ${targetTable} SET embedding = $1 WHERE id = $2`, [
      `[${truncatedVec.join(',')}]`,
      targetId,
    ])

    helpers.logger.info(
      `[embed-target] embedded ${targetTable} ${targetId.slice(0, 8)} (${truncatedVec.length} dims)`,
    )
  })
}
