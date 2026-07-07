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
  targetTable: 'ros_messages' | 'ros_summaries' | 'ros_wiki_topics'
  targetId: string
}

/** Per-table column spec — wiki topics key on slug and embed search_text. */
const TABLE_SPECS: Record<
  EmbedTargetPayload['targetTable'],
  { idCol: string; contentCol: string }
> = {
  ros_messages: { idCol: 'id', contentCol: 'content' },
  ros_summaries: { idCol: 'id', contentCol: 'content' },
  ros_wiki_topics: { idCol: 'slug', contentCol: 'search_text' },
}

interface ContentRow {
  id: string
  content: string | null
}

export const embedTargetTask: Task = async (payload, helpers) => {
  const { targetTable, targetId } = payload as EmbedTargetPayload

  const spec = TABLE_SPECS[targetTable]
  if (!spec) {
    helpers.logger.error(`[embed-target] invalid target_table: ${String(targetTable)}`)
    return
  }

  await helpers.withPgClient(async (client) => {
    const result = await client.query<ContentRow>(
      `SELECT ${spec.idCol} AS id, ${spec.contentCol} AS content FROM ${targetTable}
        WHERE ${spec.idCol} = $1
          AND ${spec.contentCol} IS NOT NULL
          AND LENGTH(${spec.contentCol}) > 0`,
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
          WHERE ${spec.idCol} = $2`,
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
          WHERE ${spec.idCol} = $3`,
        ['Embedding returned null', config.maxFailures, targetId],
      )
      throw new Error('Embedding returned null')
    }

    const truncatedVec =
      pooled.length > config.truncateDims ? pooled.slice(0, config.truncateDims) : pooled

    // Clear any prior failure state on success — a row that failed transiently
    // and later embedded must not stay flagged 'failed' forever.
    await client.query(
      `UPDATE ${targetTable}
          SET embedding = $1,
              embed_status = NULL,
              embed_error = NULL,
              embed_failures = 0
        WHERE ${spec.idCol} = $2`,
      [`[${truncatedVec.join(',')}]`, targetId],
    )

    helpers.logger.info(
      `[embed-target] embedded ${targetTable} ${targetId.slice(0, 8)} (${truncatedVec.length} dims)`,
    )
  })
}
