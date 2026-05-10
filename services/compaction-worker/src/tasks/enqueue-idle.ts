/**
 * enqueue-idle task — cron-driven (every 5 min).
 *
 * Finds conversations idle for N minutes with at least M unsummarized
 * messages, and enqueues a compact-conversation job for each.
 *
 * Replaces the SQL function enqueue_idle_sessions(idle_minutes, min_unsummarized)
 * which is dropped in step 9b.4 — the logic now lives entirely in the worker.
 *
 * graphile-worker dedup via job_key=conversationId means we can safely
 * enqueue without checking for an existing pending job.
 */

import type { Task } from 'graphile-worker'
import { config } from '../config.js'

interface IdleConvRow {
  conversation_id: string
  unsummarized: string | number
}

const ENQUEUE_LIMIT = 10

export const enqueueIdleTask: Task = async (_payload, helpers) => {
  const idleMinutes = config.idleMinutes
  const minUnsummarized = config.minUnsummarized

  await helpers.withPgClient(async (client) => {
    const idleRows = await client.query<IdleConvRow>(
      `SELECT c.id::text AS conversation_id, COUNT(m.id) AS unsummarized
         FROM ros_conversations c
         JOIN ros_messages m ON m.conversation_id = c.id
         LEFT JOIN ros_summary_sources ss ON ss.message_id = m.id
        WHERE c.updated_at < NOW() - ($1 || ' minutes')::interval
          AND ss.summary_id IS NULL
          AND m.content IS NOT NULL
          AND LENGTH(m.content) > 10
        GROUP BY c.id
       HAVING COUNT(m.id) >= $2
        ORDER BY c.updated_at ASC
        LIMIT $3`,
      [idleMinutes, minUnsummarized, ENQUEUE_LIMIT],
    )

    if (idleRows.rows.length === 0) return

    for (const row of idleRows.rows) {
      await helpers.addJob(
        'compact-conversation',
        { conversationId: row.conversation_id, triggerType: 'session_idle' },
        { jobKey: row.conversation_id, jobKeyMode: 'preserve_run_at', maxAttempts: 3 },
      )
    }

    helpers.logger.info(`[enqueue-idle] enqueued ${idleRows.rows.length} idle conversation(s)`)
  })
}
