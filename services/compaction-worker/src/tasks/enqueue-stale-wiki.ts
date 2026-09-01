/**
 * enqueue-stale-wiki task — cron-driven backstop sweep (every 15 min).
 *
 * graphile-worker 0.17 `add_jobs` releases the key on a dead conflict, so
 * most dead extract-wiki rows are keyless corpses (the 3,435-row pile) and
 * must not be rescheduled — that would duplicate live work and reset the
 * 24 h poison backoff. This sweep revives only keyed dead rows idle ≥24 h
 * (the rare still-stuck identity) and re-adds jobs for never-extracted
 * leaves with no job row at all.
 *
 * Both halves share one cap per tick (WIKI_SWEEP_LIMIT, default 20): the
 * missing half gets `cap - revived` so the two SELECTs cannot spend 2× the
 * bound. Gated on WIKI_EXTRACTION=1 in lockstep with enqueue-wiki-backfill —
 * in dark deployments extract-wiki is not consumed, so reviving its jobs
 * would just re-grow the dead pile. Cron registration is also flag-gated.
 */

import type { Task } from 'graphile-worker'
import { sqlNotHeartbeatConversation } from '@rivetos/memory-postgres'
import { config } from '../config.js'
import { clampSweepLimit, rescheduleDeadJobs } from './reschedule-dead.js'
import {
  wikiExtractJobOptions,
  wikiExtractJobPayload,
} from './enqueue-wiki-backfill.js'

/** Priority below live extraction (5), matching enqueue-wiki-backfill. */
const SWEEP_PRIORITY = 10

interface MissingLeafRow {
  id: string
  conversation_id: string | null
}

/**
 * Never-extracted leaves that also have no extract-wiki job row. Orphaned
 * leaves (no conversation row) stay eligible: heartbeat exclusion is
 * `(c.id IS NULL OR not-heartbeat)` so a NULL-hostile `!=` cannot drop them.
 * Exported so unit tests can lock the eligibility + missing-job predicates.
 */
export function staleWikiMissingSql(): string {
  return `SELECT s.id::text AS id, s.conversation_id::text AS conversation_id
       FROM ros_summaries s
       LEFT JOIN ros_conversations c ON c.id = s.conversation_id
      WHERE s.kind = 'leaf'
        AND (c.id IS NULL OR ${sqlNotHeartbeatConversation('c')})
        AND NOT EXISTS (
              SELECT 1 FROM ros_wiki_extractions e WHERE e.summary_id = s.id
            )
        AND NOT EXISTS (
              SELECT 1 FROM graphile_worker._private_jobs j
               WHERE j.key = 'wiki-ext-' || s.id::text
            )
      ORDER BY s.created_at ASC
      LIMIT $1`
}

export const enqueueStaleWikiTask: Task = async (_payload, helpers) => {
  if (!config.wikiExtraction) return
  const cap = clampSweepLimit(config.wikiSweepLimit)
  if (cap <= 0) return

  let missing: MissingLeafRow[] = []
  await helpers.withPgClient(async (client) => {
    const revived = await rescheduleDeadJobs(
      client,
      helpers.logger,
      'extract-wiki',
      cap,
      SWEEP_PRIORITY,
    )
    const missingCap = cap - revived
    if (missingCap > 0) {
      const { rows } = await client.query<MissingLeafRow>(staleWikiMissingSql(), [missingCap])
      missing = rows
    }
  })

  let added = 0
  try {
    for (const row of missing) {
      await helpers.addJob(
        'extract-wiki',
        wikiExtractJobPayload(row.id, row.conversation_id),
        wikiExtractJobOptions(row.id, { priority: SWEEP_PRIORITY }),
      )
      added += 1
    }
  } catch (err) {
    helpers.logger.warn(
      `[enqueue-stale-wiki] addJob failed after re-adding ${String(added)}/${String(missing.length)} missing job(s)`,
    )
    throw err
  }
  if (added > 0) {
    helpers.logger.info(`[enqueue-stale-wiki] re-added ${String(added)} missing job(s)`)
  }
}
