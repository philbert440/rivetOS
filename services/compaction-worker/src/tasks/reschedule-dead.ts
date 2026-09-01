/**
 * reschedule-dead — shared helper for the wiki backstop sweep (and CLI).
 *
 * graphile-worker 0.17 `add_jobs` does NOT leave a dead row holding its key.
 * On a key conflict with an unavailable row it sets `key = null, attempts =
 * max_attempts` and inserts a fresh job. Live datahub (phil_memory): all 510
 * dead compact-conversation and 65 dead embed-target rows are keyless
 * corpses; enqueue-idle has been re-enqueueing all along. Rescheduling those
 * corpses would mint a second concurrent job for the same conversation
 * (no job_key → no dedupe) and reset attempts every tick, bypassing the
 * 24 h poison backoff.
 *
 * This helper therefore revives ONLY keyed dead rows that have been sitting
 * for ≥24 h (genuinely stuck, not a keyless corpse and not a just-failed
 * poison). Compaction's stale sweep does not call it; wiki's does, because
 * a few extract-wiki rows can still hold a key. Keyless corpses are deleted
 * by reap-dead-jobs, not revived.
 *
 * graphile-worker 0.17.3 ships reschedule_jobs(job_ids bigint[], run_at
 * timestamptz, priority int, attempts int, max_attempts int) — passing
 * attempts=0 makes the row is_available again while preserving the key.
 * The 5th argument is omitted so a STRICT definition cannot no-op the
 * UPDATE (null would).
 *
 * reschedule_jobs never clears locked_at/locked_by. is_available is a
 * generated column = locked_at IS NULL AND attempts < max_attempts, so a
 * stale-locked dead row stays dead after revival unless we unlock it first.
 * Only locks older than graphile's 4 h steal window are cleared.
 */

/** Unlock stale locks so reschedule_jobs can make the row is_available. */
export const UNLOCK_STALE_LOCKED_SQL = `UPDATE graphile_worker._private_jobs SET locked_at = NULL, locked_by = NULL WHERE id = ANY($1::bigint[]) AND locked_at < now() - interval '4 hours'`

/** A client shaped like the pg client graphile's withPgClient hands out. */
export interface SweepPgClient {
  query(sql: string, values?: unknown[]): Promise<{ rows: unknown[]; rowCount: number | null }>
}

export interface SweepLogger {
  info: (msg: string) => void
  warn: (msg: string) => void
}

interface DeadJobRow {
  id: string
}

/** Hard cap so a missing/undefined config value can never mean LIMIT ALL. */
export const SWEEP_LIMIT_MAX = 200

/**
 * Fail closed: non-numeric / ≤0 → 0 (no-op). Ceiling SWEEP_LIMIT_MAX.
 */
export function clampSweepLimit(limit: number): number {
  const n = Number(limit)
  if (!Number.isFinite(n)) return 0
  return Math.min(Math.max(n, 0), SWEEP_LIMIT_MAX)
}

/**
 * Dead = at max attempts, still holding a key, idle ≥24 h, and not held by a
 * live worker (unlocked, or lock older than graphile's 4 h steal window).
 * Exported so unit tests can lock the filter.
 */
export function deadJobsSelectSql(): string {
  return `SELECT j.id::text AS id
       FROM graphile_worker._private_jobs j
       JOIN graphile_worker._private_tasks t ON t.id = j.task_id
      WHERE t.identifier = $1
        AND j.attempts >= j.max_attempts
        AND j.key IS NOT NULL
        AND j.updated_at < now() - interval '24 hours'
        AND (j.locked_at IS NULL OR j.locked_at < now() - interval '4 hours')
      ORDER BY j.run_at ASC
      LIMIT $2`
}

/**
 * Reschedule up to `limit` keyed-dead jobs of `task` at low priority (they
 * are backfill, live work must win). Returns how many jobs reschedule_jobs
 * actually updated — not the preimage SELECT count.
 */
export async function rescheduleDeadJobs(
  client: SweepPgClient,
  logger: SweepLogger,
  task: string,
  limit: number,
  priority: number,
): Promise<number> {
  const cap = clampSweepLimit(limit)
  if (cap <= 0) return 0
  const { rows } = await client.query(deadJobsSelectSql(), [task, cap])
  if (rows.length === 0) return 0
  const ids = (rows as DeadJobRow[]).map((r) => r.id)

  // reschedule_jobs never clears locked_at, so is_available stays false on
  // stale-locked rows. Unlock those (4 h steal window) before reviving.
  // Count comes from the SETOF result, not the preimage — a race with a
  // fresh lock must not be reported as a revival.
  await client.query(UNLOCK_STALE_LOCKED_SQL, [ids])
  const { rows: revived } = await client.query(
    `SELECT id FROM graphile_worker.reschedule_jobs($1::bigint[], now(), $2, 0)`,
    [ids, priority],
  )
  const n = revived.length
  if (n > 0) {
    logger.info(`[reschedule-dead] revived ${String(n)} dead ${task} job(s)`)
  }
  return n
}
