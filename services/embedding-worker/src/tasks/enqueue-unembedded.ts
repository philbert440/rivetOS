/**
 * enqueue-unembedded task — cron-driven backstop sweep (every 10 min).
 *
 * Embedding is normally driven by an INSERT/UPDATE trigger
 * (notify_embedding_queue) that enqueues one embed-target job per row. That is
 * fire-once: if the job is later dropped, or dies at graphile max_attempts
 * before the task marks embed_status terminal, the row is left with NULL
 * embedding and NO pending job — orphaned forever, since nothing re-enqueues it.
 *
 * This sweep is the safety net the embedding worker otherwise lacks (its sibling
 * compaction worker has enqueue-idle for the same reason). Each pass re-enqueues
 * up to sweepLimit rows per table that:
 *
 *   - have no embedding yet (embedding IS NULL), AND
 *   - are not terminal: embed_status IS NULL (NOT 'unembeddable'). Rows marked
 *     'failed' because 'Embedding returned null' are healed first — that error
 *     is a transient API blip, not poison content, and used to orphan the row
 *     from this sweep. The heal also requires the table's length predicate so
 *     short-content rows are not reopened into a permanent pending state.
 *     Rows marked 'failed' with 'Embedding returned null (permanent)' (the
 *     maxFailures cap) and other 'failed' reasons still need a manual reset, AND
 *   - carry embeddable text (length > 20). For ros_messages that means content
 *     OR tool_result — tool rows store the real payload in tool_result while
 *     content is often a short `[tool] name` placeholder (FTS parity / #440).
 *
 * graphile-worker dedup via job_key='embed-<table>-<id>' (job_key_mode
 * 'preserve_run_at') means a row that already has a live job is coalesced, so
 * the sweep can run unconditionally without piling up duplicates.
 *
 * When EMBED_CHUNKS_ENABLED, also sweeps ros_message_chunks WHERE embedding
 * IS NULL AND embed_status IS NULL (same job_key as the insert trigger:
 * embed-ros_message_chunks-<id>, so a trigger-enqueued live job is not
 * duplicated). Terminal unembeddable/failed chunks stay out of the sweep.
 * Missing table (0014 not applied) is logged, not a crash. Disabled flag
 * skips this arm — trigger jobs are a no-op in embed-target.
 */

import type { Task } from 'graphile-worker'
import { config } from '../config.js'
import { NULL_EMBED_ERROR } from './embed-target.js'

/** Per-table column spec — wiki topics key on slug and embed search_text. */
const TABLES = [
  {
    table: 'ros_messages' as const,
    idCol: 'id',
    // content placeholder OR substantive tool_result (tool-row footgun).
    lengthPredicate: `(
      (content IS NOT NULL AND LENGTH(content) > 20)
      OR (tool_result IS NOT NULL AND LENGTH(tool_result) > 20)
    )`,
  },
  {
    table: 'ros_summaries' as const,
    idCol: 'id',
    lengthPredicate: `content IS NOT NULL AND LENGTH(content) > 20`,
  },
  {
    table: 'ros_wiki_topics' as const,
    idCol: 'slug',
    lengthPredicate: `search_text IS NOT NULL AND LENGTH(search_text) > 20`,
  },
]

/**
 * Re-open rows that were permanently excluded because a transient null vector
 * was recorded as embed_status='failed'. Bind NULL_EMBED_ERROR as $1 — do not
 * interpolate. Exported for unit tests.
 */
export function healFailedNullSql(table: string): string {
  const spec = TABLES.find((t) => t.table === table)
  if (!spec) {
    throw new Error(`[enqueue-unembedded] unknown table for heal: ${table}`)
  }
  return `UPDATE ${table}
             SET embed_status = NULL,
                 embed_error = NULL,
                 embed_failures = 0
           WHERE embedding IS NULL
             AND embed_status = 'failed'
             AND embed_error = $1
             AND ${spec.lengthPredicate}`
}

interface UnembeddedRow {
  id: string
}

export const enqueueUnembeddedTask: Task = async (_payload, helpers) => {
  await helpers.withPgClient(async (client) => {
    let enqueued = 0

    for (const { table, idCol, lengthPredicate } of TABLES) {
      let rows: UnembeddedRow[] = []
      try {
        const healed = await client.query(healFailedNullSql(table), [NULL_EMBED_ERROR])
        if ((healed.rowCount ?? 0) > 0) {
          helpers.logger.info(
            `[enqueue-unembedded] healed ${String(healed.rowCount)} failed-null row(s) in ${table}`,
          )
        }
        const selected = await client.query<UnembeddedRow>(
          `SELECT ${idCol}::text AS id
             FROM ${table}
            WHERE embedding IS NULL
              AND embed_status IS NULL
              AND ${lengthPredicate}
            ORDER BY created_at DESC
            LIMIT $1`,
          [config.sweepLimit],
        )
        rows = selected.rows
      } catch (err) {
        // ros_wiki_topics predates some deploys (0005) — missing table is
        // an empty sweep, not a crash. Log so a real DB error on the heal
        // is not silent.
        helpers.logger.warn(
          `[enqueue-unembedded] ${table} sweep failed: ${err instanceof Error ? err.message : String(err)}`,
        )
        rows = []
      }

      for (const row of rows) {
        await helpers.addJob(
          'embed-target',
          { targetTable: table, targetId: row.id },
          {
            jobKey: `embed-${table}-${row.id}`,
            jobKeyMode: 'preserve_run_at',
            maxAttempts: config.sweepMaxAttempts,
          },
        )
        enqueued += 1
      }
    }

    if (config.embedChunksEnabled) {
      try {
        const chunkRows = await client.query<UnembeddedRow>(
          `SELECT id::text AS id
             FROM ros_message_chunks
            WHERE embedding IS NULL
              AND embed_status IS NULL
              AND content IS NOT NULL AND LENGTH(btrim(content)) > 0
            ORDER BY created_at DESC
            LIMIT $1`,
          [config.sweepLimit],
        )
        for (const row of chunkRows.rows) {
          await helpers.addJob(
            'embed-target',
            { targetTable: 'ros_message_chunks', targetId: row.id },
            {
              // Same key as notify_chunk_embedding_queue — trigger vs sweep dedupes.
              jobKey: `embed-ros_message_chunks-${row.id}`,
              jobKeyMode: 'preserve_run_at',
              maxAttempts: config.sweepMaxAttempts,
            },
          )
          enqueued += 1
        }
      } catch (err) {
        helpers.logger.warn(
          `[enqueue-unembedded] ros_message_chunks sweep failed: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    }

    if (enqueued > 0) {
      helpers.logger.info(`[enqueue-unembedded] re-enqueued ${enqueued} unembedded row(s)`)
    }
  })
}

