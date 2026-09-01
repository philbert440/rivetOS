/**
 * enqueue-wiki-backfill (phase 3h) — sweep leaf summaries that have no
 * extraction row (or a failed / stale-pipeline one) into extract-wiki jobs.
 * ALL history per Phil's call: no date floor — the wiki starts complete,
 * even if the first pass takes days on the local LLM.
 *
 * Cron (every 10 min) while WIKI_EXTRACTION=1; each sweep enqueues a
 * bounded batch (WIKI_BACKFILL_BATCH, default 25) at low priority so live
 * compaction always wins. Naturally terminates: once every leaf has a
 * done/skipped row at the current WIKI_PIPELINE_VERSION the sweep enqueues
 * nothing. Also mops up deploy-window dead jobs (#287 review) since failed
 * rows stay re-eligible, and re-mines leaves done under an older pipeline
 * contract (#420 residual — status-only filter left v1 done rows stranded).
 * Heartbeat conversations are excluded up front (extract-wiki would skip
 * them) so they do not occupy backfill slots.
 */

import type { Task } from 'graphile-worker'
import { WIKI_PIPELINE_VERSION, sqlNotHeartbeatConversation } from '@rivetos/memory-postgres'
import { config } from '../config.js'

/** Shared with enqueue-stale-wiki so payload/key/attempts cannot drift. */
export const WIKI_JOB_MAX_ATTEMPTS = 2
export const WIKI_JOB_PRIORITY = 10
export const WIKI_JOB_KEY_MODE = 'preserve_run_at' as const

export function wikiExtractJobKey(summaryId: string): string {
  return `wiki-ext-${summaryId}`
}

export function wikiExtractJobPayload(
  summaryId: string,
  conversationId: string | null | undefined,
): { summaryId: string; conversationId: string | undefined } {
  return { summaryId, conversationId: conversationId ?? undefined }
}

export function wikiExtractJobOptions(
  summaryId: string,
  extra?: { priority?: number },
): {
  jobKey: string
  jobKeyMode: 'preserve_run_at'
  maxAttempts: number
  priority: number
} {
  return {
    jobKey: wikiExtractJobKey(summaryId),
    jobKeyMode: WIKI_JOB_KEY_MODE,
    maxAttempts: WIKI_JOB_MAX_ATTEMPTS,
    priority: extra?.priority ?? WIKI_JOB_PRIORITY,
  }
}

/**
 * SQL eligibility for wiki extract backfill.
 *
 * Exported for unit tests — keep the filter in one place so extract-wiki's
 * `extractionDone` and this sweep never drift on pipeline-version policy.
 */
export function wikiBackfillSelectSql(): string {
  return `SELECT s.id, s.conversation_id
       FROM ros_summaries s
       LEFT JOIN ros_wiki_extractions e ON e.summary_id = s.id
       LEFT JOIN ros_conversations c ON c.id = s.conversation_id
       WHERE s.kind = 'leaf'
         AND ${sqlNotHeartbeatConversation('c')}
         AND (
           e.summary_id IS NULL
           -- failed rows re-sweep on a 24h backoff: a poison summary
           -- costs at most one LLM call per day instead of one per
           -- 10-minute tick (#292 review).
           OR (e.status = 'failed' AND e.extracted_at < now() - interval '24 hours')
           -- Pipeline bumps must re-mine leaves already marked done at an
           -- older contract. WIKI_PIPELINE_VERSION's docstring claims a bump
           -- re-extracts everything; status-only filtering broke that
           -- (#420 residual). skipped stays terminal (too-short/heartbeat).
           OR (e.status = 'done' AND e.pipeline_version < $2)
         )
       ORDER BY
         -- Prefer never-attempted, then failed, then stale-pipeline upgrades
         -- so first-time coverage is not starved by a mass re-pipeline.
         CASE
           WHEN e.summary_id IS NULL THEN 0
           WHEN e.status = 'failed' THEN 1
           ELSE 2
         END,
         s.created_at ASC
       LIMIT $1`
}

export const enqueueWikiBackfillTask: Task = async (_payload, helpers) => {
  if (!config.wikiExtraction) return
  await helpers.withPgClient(async (client) => {
    const { rows } = await client.query<{ id: string; conversation_id: string | null }>(
      wikiBackfillSelectSql(),
      [config.wikiBackfillBatch, WIKI_PIPELINE_VERSION],
    )
    for (const row of rows) {
      await helpers.addJob(
        'extract-wiki',
        wikiExtractJobPayload(row.id, row.conversation_id),
        wikiExtractJobOptions(row.id),
      )
    }
    if (rows.length > 0) {
      helpers.logger.info(
        `[wiki-backfill] enqueued ${String(rows.length)} leaf summaries (pipeline v${String(WIKI_PIPELINE_VERSION)})`,
      )
    }
  })
}
