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
 *   - are not terminal: embed_status IS NULL — i.e. NOT 'unembeddable' (skipped
 *     by design) and NOT 'failed' (gave up after maxFailures; needs a manual
 *     reset, not endless re-churn), AND
 *   - carry embeddable content (length > 20) — the same floor the trigger uses,
 *     so empty tool-call / ack rows that are skipped by design are never swept.
 *
 * graphile-worker dedup via job_key='embed-<table>-<id>' (job_key_mode
 * 'preserve_run_at') means a row that already has a live job is coalesced, so
 * the sweep can run unconditionally without piling up duplicates.
 */

import type { Task } from 'graphile-worker'
import { config } from '../config.js'

/** Per-table column spec — wiki topics key on slug and embed search_text. */
const TABLES = [
  { table: 'ros_messages', idCol: 'id', contentCol: 'content' },
  { table: 'ros_summaries', idCol: 'id', contentCol: 'content' },
  { table: 'ros_wiki_topics', idCol: 'slug', contentCol: 'search_text' },
] as const

interface UnembeddedRow {
  id: string
}

export const enqueueUnembeddedTask: Task = async (_payload, helpers) => {
  await helpers.withPgClient(async (client) => {
    let enqueued = 0

    for (const { table, idCol, contentCol } of TABLES) {
      const { rows } = await client
        .query<UnembeddedRow>(
          `SELECT ${idCol}::text AS id
             FROM ${table}
            WHERE embedding IS NULL
              AND embed_status IS NULL
              AND ${contentCol} IS NOT NULL
              AND LENGTH(${contentCol}) > 20
            ORDER BY created_at DESC
            LIMIT $1`,
          [config.sweepLimit],
        )
        // ros_wiki_topics predates some deploys (0005) — missing table is
        // an empty sweep, not a crash.
        .catch(() => ({ rows: [] as UnembeddedRow[] }))

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

    if (enqueued > 0) {
      helpers.logger.info(`[enqueue-unembedded] re-enqueued ${enqueued} unembedded row(s)`)
    }
  })
}
