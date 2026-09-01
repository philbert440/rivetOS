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

export const reapDeadJobsTask: Task = async (_payload, helpers) => {
  const cap = clampSweepLimit(config.reapDeadLimit)
  if (cap <= 0) return
  await helpers.withPgClient(async (client) => {
    const res = await client.query(reapDeadJobsSql(), [[...REAP_TASK_ALLOWLIST], cap])
    const n = res.rowCount ?? 0
    if (n > 0) {
      helpers.logger.info(`[reap-dead-jobs] deleted ${String(n)} keyless dead job(s)`)
    }
  })
}
