/**
 * enqueue-idle task — cron-driven (every 5 min).
 *
 * Finds conversations with unsummarized messages and enqueues a
 * compact-conversation job for each. A conversation qualifies when EITHER:
 *
 *   - it has a full leaf window ready (>= leafBatchSize unsummarized) — summarize
 *     now, even if the conversation is still active; OR
 *   - it has gone idle (no update for idleMinutes) and has enough unsummarized
 *     messages to form a leaf (>= MIN_BATCH_SIZE) — mop up the remainder.
 *
 * The first clause is what keeps long-running, never-idle conversations (e.g. a
 * multi-thousand-message agent session updating every couple of minutes) from
 * accumulating an unbounded backlog: each cron tick drains one window. The
 * second clause sweeps the small tails of conversations that have quieted down.
 *
 * Conversations with fewer than MIN_BATCH_SIZE unsummarized messages are not
 * enqueued — compactLeaf cannot form a leaf summary below that floor, so
 * enqueuing them would be a no-op.
 *
 * Replaces the SQL function enqueue_idle_sessions(idle_minutes, min_unsummarized)
 * which is dropped in step 9b.4 — the logic now lives entirely in the worker.
 *
 * graphile-worker dedup via job_key=conversationId means we can safely
 * enqueue without checking for an existing pending job.
 */

import type { Task } from 'graphile-worker'
import { MIN_BATCH_SIZE } from '@rivetos/memory-postgres'
import { config } from '../config.js'

interface IdleConvRow {
  conversation_id: string
  unsummarized: string | number
}

const ENQUEUE_LIMIT = 10

export const enqueueIdleTask: Task = async (_payload, helpers) => {
  const idleMinutes = config.idleMinutes
  // A full leaf window is ready: summarize immediately regardless of activity.
  const fullWindow = config.leafBatchSize
  // The minimum unsummarized count that can still form a leaf summary.
  const leafFloor = MIN_BATCH_SIZE

  await helpers.withPgClient(async (client) => {
    const idleRows = await client.query<IdleConvRow>(
      `SELECT c.id::text AS conversation_id, COUNT(m.id) AS unsummarized
         FROM ros_conversations c
         JOIN ros_messages m ON m.conversation_id = c.id
         LEFT JOIN ros_summary_sources ss ON ss.message_id = m.id
        WHERE ss.summary_id IS NULL
          AND ((m.content IS NOT NULL AND LENGTH(m.content) > 10) OR m.tool_name IS NOT NULL)
        GROUP BY c.id
       HAVING COUNT(m.id) >= $2
          AND (
                COUNT(m.id) >= $3
                OR c.updated_at < NOW() - ($1 || ' minutes')::interval
              )
        ORDER BY c.updated_at ASC
        LIMIT $4`,
      [idleMinutes, leafFloor, fullWindow, ENQUEUE_LIMIT],
    )

    if (idleRows.rows.length === 0) return

    for (const row of idleRows.rows) {
      await helpers.addJob(
        'compact-conversation',
        { conversationId: row.conversation_id, triggerType: 'session_idle' },
        { jobKey: row.conversation_id, jobKeyMode: 'preserve_run_at', maxAttempts: 3 },
      )
    }

    helpers.logger.info(`[enqueue-idle] enqueued ${idleRows.rows.length} conversation(s)`)
  })
}
