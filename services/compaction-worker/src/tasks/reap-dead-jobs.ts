/**
 * reap-dead-jobs — hourly corpse collector.
 *
 * graphile-worker 0.17 `add_jobs` nulls `key` on a dead key-conflicting row
 * and inserts a fresh job. The abandoned row stays in `_private_jobs` with
 * `key IS NULL` and `attempts >= max_attempts` forever, so memory_stats /
 * doctor keep reporting the 510-compact / 3,435-wiki piles even though they
 * no longer block enqueue. This task DELETEs those keyless corpses (same
 * effect as complete_jobs on an unlocked row) once they are >=7 days old.
 *
 * Never touches keyed rows — those still mean "this identity is stuck" and
 * belong to reschedule-dead / `rivetos memory requeue`.
 *
 * The same tick also sweeps orphaned ros_tags rows (see reapOrphanTagsSql).
 */

import type { Task } from 'graphile-worker'
import { config } from '../config.js'
import { clampSweepLimit } from './reschedule-dead.js'

/**
 * Same allowlist as `rivetos memory requeue`. Duplicated: this service cannot
 * import the CLI package. Restricts the DELETE to memory tasks so a shared
 * graphile_worker schema cannot lose unrelated jobs.
 */
export const REAP_TASK_ALLOWLIST = [
  'extract-wiki',
  'compact-conversation',
  'embed-target',
  'synthesize-tool-call',
  'suggest-tags',
] as const

/**
 * DELETE ... WHERE ctid IN (SELECT ... LIMIT $2) — Postgres has no DELETE LIMIT.
 * Task-scoped via $1 so we never reap unrelated jobs in a shared schema.
 * Exported so unit tests can lock the corpse predicate.
 */
export function reapDeadJobsSql(): string {
  return `DELETE FROM graphile_worker._private_jobs
    WHERE ctid IN (
      SELECT ctid FROM graphile_worker._private_jobs j
       WHERE j.key IS NULL
         AND j.attempts >= j.max_attempts
         AND j.locked_at IS NULL
         AND j.updated_at < now() - interval '7 days'
         AND j.task_id IN (SELECT id FROM graphile_worker._private_tasks WHERE identifier = ANY($1::text[]))
       ORDER BY j.updated_at ASC
       LIMIT $2
    )`
}

/**
 * Tag rows whose entity is gone. ros_tags.entity_id is polymorphic (no FK),
 * so a deleted conversation or summary leaves its tags behind; this is the
 * sweep migration 0019's header refers to. Bounded like the job reap.
 */
export function reapOrphanTagsSql(): string {
  return `DELETE FROM ros_tags
    WHERE ctid IN (
      SELECT t.ctid FROM ros_tags t
       WHERE (t.entity_type = 'conversation'
              AND NOT EXISTS (SELECT 1 FROM ros_conversations c WHERE c.id = t.entity_id))
          OR (t.entity_type = 'summary'
              AND NOT EXISTS (SELECT 1 FROM ros_summaries s WHERE s.id = t.entity_id))
       LIMIT $1
    )`
}

export const reapDeadJobsTask: Task = async (_payload, helpers) => {
  const cap = clampSweepLimit(config.reapDeadLimit)
  if (cap <= 0) return
  await helpers.withPgClient(async (client) => {
    const res = await client.query(reapDeadJobsSql(), [[...REAP_TASK_ALLOWLIST], cap])
    const n = res.rowCount ?? 0
    if (n > 0) {
      helpers.logger.info(`[reap-dead-jobs] deleted ${String(n)} keyless dead job(s)`)
    }
    // Same hourly tick, separate concern: never let a tag-table problem
    // (0019 not applied yet) fail the job reap.
    try {
      const tags = await client.query(reapOrphanTagsSql(), [cap])
      const orphans = tags.rowCount ?? 0
      if (orphans > 0) {
        helpers.logger.info(`[reap-dead-jobs] deleted ${String(orphans)} orphaned tag row(s)`)
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (!/does not exist/i.test(msg)) {
        helpers.logger.warn(`[reap-dead-jobs] orphan tag sweep failed: ${msg}`)
      }
    }
  })
}
