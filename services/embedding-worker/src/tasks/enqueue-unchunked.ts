/**
 * enqueue-unchunked task — cron-driven backfill (every 15 min).
 *
 * Finds long ros_messages (composed embed text longer than charsPerChunk)
 * that have no ros_message_chunks rows yet, inserts the chunk rows (content +
 * offsets, embedding NULL), and enqueues embed-target per chunk. The insert
 * trigger does the same add_job; job_key dedupes.
 *
 * Bounded by CHUNK_BACKFILL_LIMIT (default 200). No-op when EMBED_CHUNKS_ENABLED
 * is false. Missing ros_message_chunks (migration 0014_chunks not applied) is
 * logged and skipped, not a crash. Skips embed_status='unembeddable'.
 */

import type { Task } from 'graphile-worker'
import { config } from '../config.js'
import { splitIntoChunksWithOffsets } from '../chunking.js'
import { TOOL_RESULT_EMBED_CAP, composeMessageEmbedText } from '../compose-embed-text.js'
import { upsertMessageChunks } from './upsert-chunks.js'

interface UnchunkedRow {
  id: string
  content: string | null
  tool_result: string | null
}

export const enqueueUnchunkedTask: Task = async (_payload, helpers) => {
  if (!config.embedChunksEnabled) {
    return
  }

  await helpers.withPgClient(async (client) => {
    let rows: UnchunkedRow[] = []
    try {
      // Composed length must match composeMessageEmbedText exactly so a row
      // cannot be selected every tick and then skipped in JS.
      const selected = await client.query<UnchunkedRow>(
        `SELECT m.id::text AS id, m.content, m.tool_result
           FROM ros_messages m
          WHERE NOT EXISTS (
                  SELECT 1 FROM ros_message_chunks c WHERE c.message_id = m.id
                )
            AND COALESCE(m.embed_status, '') <> 'unembeddable'
            AND (
                  CASE
                    WHEN LENGTH(btrim(COALESCE(m.content,''), E' \\t\\n\\r\\f\\v')) = 0
                      THEN LEAST(LENGTH(btrim(COALESCE(m.tool_result,''), E' \\t\\n\\r\\f\\v')), ${String(TOOL_RESULT_EMBED_CAP)})
                    WHEN LENGTH(btrim(COALESCE(m.tool_result,''), E' \\t\\n\\r\\f\\v')) = 0
                      THEN LENGTH(btrim(COALESCE(m.content,''), E' \\t\\n\\r\\f\\v'))
                    ELSE LENGTH(btrim(COALESCE(m.content,''), E' \\t\\n\\r\\f\\v'))
                         + LEAST(LENGTH(btrim(COALESCE(m.tool_result,''), E' \\t\\n\\r\\f\\v')), ${String(TOOL_RESULT_EMBED_CAP)})
                         + 1
                  END
                ) > $1
          ORDER BY m.created_at DESC
          LIMIT $2`,
        [config.charsPerChunk, config.chunkBackfillLimit],
      )
      rows = selected.rows
    } catch (err) {
      helpers.logger.warn(
        `[enqueue-unchunked] sweep failed: ${err instanceof Error ? err.message : String(err)}`,
      )
      return
    }

    let insertedMessages = 0
    let insertedChunks = 0

    for (const row of rows) {
      try {
        const content = composeMessageEmbedText(row.content, row.tool_result)
        if (content.length <= config.charsPerChunk) continue
        const parts = splitIntoChunksWithOffsets(content, config.charsPerChunk)
        const outcome = await upsertMessageChunks(
          (sql, values) => client.query(sql, values),
          {
            messageId: row.id,
            content,
            chunks: parts,
            truncateDims: config.truncateDims,
          },
        )
        if (outcome === 'skipped') continue
        insertedMessages += 1
        insertedChunks += parts.length
        // Re-read chunk ids so we can enqueue even if the sibling trigger is
        // not installed yet (job_key dedupes with the trigger when both fire).
        const chunkIds = await client.query<{ id: string }>(
          `SELECT id::text AS id FROM ros_message_chunks
            WHERE message_id = $1 AND embedding IS NULL
            ORDER BY idx`,
          [row.id],
        )
        for (const chunk of chunkIds.rows) {
          await helpers.addJob(
            'embed-target',
            { targetTable: 'ros_message_chunks', targetId: chunk.id },
            {
              jobKey: `embed-ros_message_chunks-${chunk.id}`,
              jobKeyMode: 'preserve_run_at',
              maxAttempts: config.sweepMaxAttempts,
            },
          )
        }
      } catch (err) {
        helpers.logger.warn(
          `[enqueue-unchunked] message ${row.id} failed: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    }

    if (insertedMessages > 0) {
      helpers.logger.info(
        `[enqueue-unchunked] chunked ${insertedMessages} message(s) into ${insertedChunks} row(s)`,
      )
    }
  })
}
