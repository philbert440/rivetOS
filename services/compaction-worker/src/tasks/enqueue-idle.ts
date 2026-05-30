/**
 * enqueue-idle task — cron-driven (every 5 min).
 *
 * Finds conversations with unsummarized messages and enqueues a
 * compact-conversation job for each. A conversation qualifies when ANY of:
 *
 *   - it has a full leaf window ready (>= leafBatchSize unsummarized) — summarize
 *     now, even if the conversation is still active; OR
 *   - it has gone idle (no update for idleMinutes) and has enough unsummarized
 *     messages to form a leaf (>= MIN_BATCH_SIZE) — mop up the remainder; OR
 *   - it has gone STALE (no update for staleMinutes, default 4 days) and has at
 *     least staleMinBatch unsummarized messages — flush the below-floor tail
 *     (1..MIN_BATCH_SIZE-1 messages) that the idle clause skips by design. Once
 *     a conversation has been silent for days it is treated as final, so its
 *     orphan tail is summarized rather than left findable only at raw-message
 *     granularity. Tagged triggerType 'session_stale' so the worker lowers its
 *     leaf floor to staleMinBatch for this job.
 *
 * The first clause is what keeps long-running, never-idle conversations (e.g. a
 * multi-thousand-message agent session updating every couple of minutes) from
 * accumulating an unbounded backlog: each cron tick drains one window. The
 * second clause sweeps the small tails of conversations that have quieted down;
 * the third sweeps the still-smaller tails that never reached the leaf floor.
 *
 * Conversations with fewer than staleMinBatch unsummarized messages are never
 * enqueued — compactLeaf cannot form a leaf below that floor, so enqueuing them
 * would be a no-op.
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
  trigger: 'session_idle' | 'session_stale'
}

const ENQUEUE_LIMIT = 10

export const enqueueIdleTask: Task = async (_payload, helpers) => {
  const idleMinutes = config.idleMinutes
  // A full leaf window is ready: summarize immediately regardless of activity.
  const fullWindow = config.leafBatchSize
  // The minimum unsummarized count that can still form a normal leaf summary.
  const leafFloor = MIN_BATCH_SIZE
  // Stale flush: after this long idle, summarize even a below-floor tail down
  // to staleMinBatch messages.
  const staleMinutes = config.staleMinutes
  const staleFloor = config.staleMinBatch

  await helpers.withPgClient(async (client) => {
    const idleRows = await client.query<IdleConvRow>(
      `SELECT c.id::text AS conversation_id, COUNT(m.id) AS unsummarized,
              CASE WHEN COUNT(m.id) >= $2 THEN 'session_idle' ELSE 'session_stale' END AS trigger
         FROM ros_conversations c
         JOIN ros_messages m ON m.conversation_id = c.id
         LEFT JOIN ros_summary_sources ss ON ss.message_id = m.id
        WHERE ss.summary_id IS NULL
          AND ((m.content IS NOT NULL AND LENGTH(m.content) > 10) OR m.tool_name IS NOT NULL)
        GROUP BY c.id
       HAVING (
                COUNT(m.id) >= $2
                AND (
                      COUNT(m.id) >= $3
                      OR c.updated_at < NOW() - ($1 || ' minutes')::interval
                    )
              )
           OR (
                COUNT(m.id) >= $5
                AND c.updated_at < NOW() - ($4 || ' minutes')::interval
              )
        ORDER BY c.updated_at ASC
        LIMIT $6`,
      [idleMinutes, leafFloor, fullWindow, staleMinutes, staleFloor, ENQUEUE_LIMIT],
    )

    if (idleRows.rows.length === 0) return

    let staleCount = 0
    for (const row of idleRows.rows) {
      if (row.trigger === 'session_stale') staleCount += 1
      await helpers.addJob(
        'compact-conversation',
        { conversationId: row.conversation_id, triggerType: row.trigger },
        { jobKey: row.conversation_id, jobKeyMode: 'preserve_run_at', maxAttempts: 3 },
      )
    }

    helpers.logger.info(
      `[enqueue-idle] enqueued ${idleRows.rows.length} conversation(s)` +
        (staleCount > 0 ? ` (${staleCount} stale-partial)` : ''),
    )
  })
}
