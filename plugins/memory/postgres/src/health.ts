/** Shared memory diagnostics for MCP and the authenticated HTTP surface. */
import type pg from 'pg'
import { MIN_BATCH_SIZE } from './compactor/types.js'
import {
  sqlNotHeartbeatConversation,
  type QueueHealthRow,
  type EmbedQueueRow,
  type UnsummarizedBucketRow,
} from './tools/helpers.js'
const FULL_WINDOW = 10
const IDLE_MINUTES = 15
const STALE_MINUTES = 4 * 24 * 60
const STALE_MIN_BATCH = 2
export const QUEUE_HEALTH_SQL = `SELECT t.identifier AS task,
                    COUNT(*) FILTER (WHERE j.attempts < j.max_attempts
                      AND (j.locked_at IS NULL OR j.locked_at < now() - interval '4 hours')
                      AND j.run_at <= now())::text AS pending,
                    COUNT(*) FILTER (WHERE j.attempts >= j.max_attempts)::text AS dead,
                    COUNT(*) FILTER (WHERE j.attempts < j.max_attempts AND j.locked_at >= now() - interval '4 hours')::text AS running,
                    COUNT(*) FILTER (WHERE j.attempts < j.max_attempts AND (j.locked_at IS NULL OR j.locked_at < now() - interval '4 hours') AND j.run_at > now())::text AS scheduled,
                    CASE WHEN MIN(j.run_at) FILTER (
                      WHERE j.attempts < j.max_attempts
                        AND (j.locked_at IS NULL OR j.locked_at < now() - interval '4 hours')
                        AND j.run_at <= now()
                    ) IS NULL THEN NULL ELSE GREATEST(0, EXTRACT(EPOCH FROM (now() - MIN(j.run_at) FILTER (
                      WHERE j.attempts < j.max_attempts
                        AND (j.locked_at IS NULL OR j.locked_at < now() - interval '4 hours')
                        AND j.run_at <= now()
                    ))) / 60) END AS oldest_pending_age_min,
                    LEFT((array_agg(j.last_error ORDER BY j.updated_at DESC NULLS LAST)
                      FILTER (WHERE j.attempts >= j.max_attempts))[1], 120) AS last_error
               FROM graphile_worker._private_jobs j
               JOIN graphile_worker._private_tasks t ON t.id = j.task_id
              GROUP BY t.identifier
              ORDER BY COUNT(*) FILTER (WHERE j.attempts >= j.max_attempts) DESC,
                       COUNT(*) FILTER (WHERE j.attempts < j.max_attempts) DESC`

export function isMissingRelationError(err: unknown): boolean {
  return Boolean(
    err && typeof err === 'object' && 'code' in err && (err as { code?: string }).code === '42P01',
  )
}

/**
 * Run QUEUE_HEALTH_SQL. Returns null when graphile_worker is absent (42P01)
 * so the caller can omit the block; [] means schema present and empty.
 */
export async function queryQueueHealth(
  query: (sql: string) => Promise<{ rows: QueueHealthRow[] }>,
): Promise<QueueHealthRow[] | null> {
  try {
    const { rows } = await query(QUEUE_HEALTH_SQL)
    return rows.map((row) => ({
      ...row,
      oldest_pending_age_min:
        row.oldest_pending_age_min === null ? null : parseFloat(String(row.oldest_pending_age_min)),
    }))
  } catch (err) {
    if (isMissingRelationError(err)) return null
    throw err
  }
}

export const EMBEDDING_HEALTH_SQL = `
          SELECT
            (SELECT COUNT(*) FROM ros_messages
              WHERE embedding IS NULL
                AND embed_status IS DISTINCT FROM 'unembeddable'
                AND embed_status IS DISTINCT FROM 'failed'
                AND (
                  (content IS NOT NULL AND LENGTH(content) > 0)
                  OR (tool_result IS NOT NULL AND LENGTH(tool_result) > 0)
                )) AS msg_queue,
            (SELECT COUNT(*) FROM ros_summaries
              WHERE embedding IS NULL
                AND embed_status IS DISTINCT FROM 'unembeddable'
                AND embed_status IS DISTINCT FROM 'failed'
                AND content IS NOT NULL) AS sum_queue,
            (SELECT COUNT(*) FROM ros_messages
              WHERE embedding IS NULL AND embed_status = 'unembeddable') +
            (SELECT COUNT(*) FROM ros_summaries
              WHERE embedding IS NULL AND embed_status = 'unembeddable') AS unembeddable,
            (SELECT COUNT(*) FROM ros_messages WHERE embedding IS NULL AND embed_status = 'failed') +
            (SELECT COUNT(*) FROM ros_summaries WHERE embedding IS NULL AND embed_status = 'failed') AS failed
        `
export function queryEmbeddingHealth(pool: pg.Pool) {
  return pool.query<EmbedQueueRow & { failed: string }>(EMBEDDING_HEALTH_SQL)
}
export function queryCompactionHealth(pool: pg.Pool) {
  const notHeartbeat = sqlNotHeartbeatConversation('c')
  return pool.query<UnsummarizedBucketRow>(
    `WITH per_conv AS (
             SELECT c.id AS conversation_id, c.updated_at,
                    COUNT(m.id) AS qualifying
             FROM ros_conversations c
             JOIN ros_messages m ON m.conversation_id = c.id
             LEFT JOIN ros_summary_sources ss ON ss.message_id = m.id
             WHERE ss.summary_id IS NULL
               AND ((m.content IS NOT NULL AND LENGTH(m.content) > 10)
                    OR m.tool_name IS NOT NULL)
               AND ${notHeartbeat}
             GROUP BY c.id
           )
           SELECT
             COALESCE(SUM(qualifying) FILTER (
               WHERE qualifying >= $1
                  OR (qualifying >= $2 AND updated_at < NOW() - ($3 || ' minutes')::interval)
                  OR (qualifying >= $4 AND updated_at < NOW() - ($5 || ' minutes')::interval)
             ), 0) AS eligible_msgs,
             COUNT(*) FILTER (
               WHERE qualifying >= $1
                  OR (qualifying >= $2 AND updated_at < NOW() - ($3 || ' minutes')::interval)
                  OR (qualifying >= $4 AND updated_at < NOW() - ($5 || ' minutes')::interval)
             ) AS eligible_convs,
             COALESCE(SUM(qualifying) FILTER (
               WHERE qualifying >= $2 AND qualifying < $1
                 AND updated_at >= NOW() - ($3 || ' minutes')::interval
             ), 0) AS active_tail_msgs,
             COUNT(*) FILTER (
               WHERE qualifying >= $2 AND qualifying < $1
                 AND updated_at >= NOW() - ($3 || ' minutes')::interval
             ) AS active_tail_convs,
             COALESCE(SUM(qualifying) FILTER (
               WHERE qualifying < $2
                 AND NOT (qualifying >= $4 AND updated_at < NOW() - ($5 || ' minutes')::interval)
             ), 0) AS below_floor_msgs,
             COUNT(*) FILTER (
               WHERE qualifying < $2
                 AND NOT (qualifying >= $4 AND updated_at < NOW() - ($5 || ' minutes')::interval)
             ) AS below_floor_convs
           FROM per_conv`,
    [FULL_WINDOW, MIN_BATCH_SIZE, IDLE_MINUTES, STALE_MIN_BATCH, STALE_MINUTES],
  )
}
