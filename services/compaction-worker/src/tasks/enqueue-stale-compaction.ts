/**
 * enqueue-stale-compaction task — cron-driven backstop sweep (every 15 min).
 *
 * graphile-worker 0.17 `add_jobs` releases the key on a dead conflict
 * (`key = null, attempts = max_attempts`) and inserts a fresh job. A dead
 * compact-conversation row is therefore a keyless corpse, not a blockage:
 * enqueue-idle has been re-enqueueing all along. Rescheduling those corpses
 * would run a second concurrent compaction for the same conversation.
 *
 * This sweep therefore does NOT revive dead rows. It only re-adds jobs for
 * enqueue-idle-eligible conversations that have no job row at all (row
 * dropped/vacuumed). Keyless corpses are deleted by reap-dead-jobs.
 *
 * Bounded per tick (COMPACTION_SWEEP_LIMIT, default 20).
 */

import type { Task } from 'graphile-worker'
import { MIN_BATCH_SIZE, sqlNotHeartbeatConversation } from '@rivetos/memory-postgres'
import { config } from '../config.js'
import { clampSweepLimit } from './reschedule-dead.js'
import {
  compactConversationJobOptions,
  compactConversationPayload,
} from './enqueue-idle.js'

/**
 * Below live compaction (priority 0): re-added jobs are backfill and must not
 * starve fresh enqueue-idle work.
 */
const SWEEP_PRIORITY = 10

interface MissingConvRow {
  conversation_id: string
  trigger: 'session_idle' | 'session_stale'
}

/**
 * enqueue-idle-eligible conversations with no compact-conversation job row
 * (job_key = conversation id). Candidate conversations are limited *before*
 * the message aggregate so a large ros_messages table is not fully grouped
 * each tick. The inner WHERE includes the same unsummarized-message EXISTS
 * as the leaf query so the LIMIT cannot be spent on already-summarized
 * ancient conversations (updated_at is bumped per message; successful jobs
 * are deleted). GROUP BY includes updated_at (PK functional dependency, but
 * cheaper to prove). Params $1..$5 match enqueue-idle; $6 is the sweep cap.
 * Exported so unit tests can lock the eligibility + missing-job predicates.
 */
export function staleCompactionMissingSql(): string {
  return `SELECT c.id::text AS conversation_id,
              CASE WHEN COUNT(m.id) >= $2 THEN 'session_idle' ELSE 'session_stale' END AS trigger
         FROM (
              SELECT c.id, c.updated_at
                FROM ros_conversations c
               WHERE ${sqlNotHeartbeatConversation('c')}
                 AND NOT EXISTS (
                       SELECT 1 FROM graphile_worker._private_jobs j
                        WHERE j.key = c.id::text
                     )
                 AND EXISTS (
                       SELECT 1 FROM ros_messages m
                       LEFT JOIN ros_summary_sources ss ON ss.message_id = m.id
                       WHERE m.conversation_id = c.id
                         AND ss.summary_id IS NULL
                         AND ((m.content IS NOT NULL AND LENGTH(m.content) > 10) OR m.tool_name IS NOT NULL)
                     )
               ORDER BY c.updated_at ASC
               LIMIT $6
              ) c
         JOIN ros_messages m ON m.conversation_id = c.id
         LEFT JOIN ros_summary_sources ss ON ss.message_id = m.id
        WHERE ss.summary_id IS NULL
          AND ((m.content IS NOT NULL AND LENGTH(m.content) > 10) OR m.tool_name IS NOT NULL)
        GROUP BY c.id, c.updated_at
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
        LIMIT $6`
}

export const enqueueStaleCompactionTask: Task = async (_payload, helpers) => {
  const cap = clampSweepLimit(config.compactionSweepLimit)
  if (cap <= 0) return

  let missing: MissingConvRow[] = []
  await helpers.withPgClient(async (client) => {
    const { rows } = await client.query<MissingConvRow>(staleCompactionMissingSql(), [
      config.idleMinutes,
      MIN_BATCH_SIZE,
      config.leafBatchSize,
      config.staleMinutes,
      config.staleMinBatch,
      cap,
    ])
    missing = rows
  })

  let added = 0
  try {
    for (const row of missing) {
      await helpers.addJob(
        'compact-conversation',
        compactConversationPayload(row.conversation_id, row.trigger),
        compactConversationJobOptions(row.conversation_id, { priority: SWEEP_PRIORITY }),
      )
      added += 1
    }
  } catch (err) {
    helpers.logger.warn(
      `[enqueue-stale-compaction] addJob failed after re-adding ${String(added)}/${String(missing.length)} missing job(s)`,
    )
    throw err
  }
  if (added > 0) {
    helpers.logger.info(`[enqueue-stale-compaction] re-added ${String(added)} missing job(s)`)
  }
}
