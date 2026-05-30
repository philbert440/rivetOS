/**
 * memory_stats — system health diagnostics tool.
 */

import pg from 'pg'
import type { Tool } from '@rivetos/types'
import { MIN_BATCH_SIZE } from '../compactor/types.js'
import {
  fmtDate,
  timeSince,
  type CountRow,
  type AgentCountRow,
  type RoleCountRow,
  type ConversationTotalRow,
  type SummaryKindRow,
  type EmbedQueueRow,
  type EmbedCoverageRow,
  type UnsummarizedRow,
  type UnsummarizedBucketRow,
  type EligibleConvRow,
  type StuckJobRow,
  type TreeDepthRow,
  type FreshnessRow,
} from './helpers.js'

// Mirrors compaction-worker's COMPACT_LEAF_BATCH default. Used for bucketing
// only — if the deployed worker overrides it, the eligibility buckets will be
// slightly off but the rank order still holds.
const FULL_WINDOW = 10
const IDLE_MINUTES = 15
// Mirrors COMPACT_STALE_MINUTES / COMPACT_STALE_MIN_BATCH — long-idle convs get
// their below-floor tail flushed down to this many messages.
const STALE_MINUTES = 4 * 24 * 60
const STALE_MIN_BATCH = 2

export function createStatsTool(pool: pg.Pool): Tool {
  return {
    name: 'memory_stats',
    description:
      'Memory system health check — message/summary counts, embedding queue depth, ' +
      'unsummarized messages, compaction status, missing summaries, and breakdowns by agent/role/kind. ' +
      'Use to diagnose memory issues or check if background jobs are keeping up.',
    parameters: {
      type: 'object',
      properties: {
        agent: {
          type: 'string',
          description: 'Filter stats to a specific agent (optional)',
        },
      },
      required: [],
    },
    async execute(args: Record<string, unknown>): Promise<string> {
      const agentFilter = args.agent as string | undefined

      try {
        const sections: string[] = ['## Memory System Health']

        const msgWhere = agentFilter ? 'WHERE agent = $1' : ''
        const msgParams = agentFilter ? [agentFilter] : []

        // Message totals + date range
        const msgTotals = await pool.query<CountRow>(
          `SELECT COUNT(*) AS total, MIN(created_at) AS oldest, MAX(created_at) AS newest
           FROM ros_messages ${msgWhere}`,
          msgParams,
        )
        const mt = msgTotals.rows[0]
        sections.push(
          `\n**Messages:** ${Number(mt.total).toLocaleString()}` +
            `\n**Date range:** ${fmtDate(mt.oldest)} → ${fmtDate(mt.newest)}`,
        )

        // Messages by agent
        const byAgent = await pool.query<AgentCountRow>(
          `SELECT agent, COUNT(*) AS count FROM ros_messages ${msgWhere} GROUP BY agent ORDER BY count DESC`,
          msgParams,
        )
        if (byAgent.rows.length > 0) {
          sections.push(
            '\n**By agent:**\n' +
              byAgent.rows
                .map((r) => `  ${r.agent}: ${Number(r.count).toLocaleString()}`)
                .join('\n'),
          )
        }

        // Messages by role
        const byRole = await pool.query<RoleCountRow>(
          `SELECT role, COUNT(*) AS count FROM ros_messages ${msgWhere} GROUP BY role ORDER BY count DESC`,
          msgParams,
        )
        if (byRole.rows.length > 0) {
          sections.push(
            '\n**By role:**\n' +
              byRole.rows.map((r) => `  ${r.role}: ${Number(r.count).toLocaleString()}`).join('\n'),
          )
        }

        // Conversations
        const convTotals = await pool.query<ConversationTotalRow>(
          `SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE active) AS active FROM ros_conversations`,
        )
        const ct = convTotals.rows[0]
        sections.push(`\n**Conversations:** ${ct.total} total, ${ct.active} active`)

        // Summary counts by kind
        const byKind = await pool.query<SummaryKindRow>(
          `SELECT kind, COUNT(*) AS count, MAX(depth) AS max_depth FROM ros_summaries GROUP BY kind ORDER BY count DESC`,
        )
        if (byKind.rows.length > 0) {
          const totalSummaries = byKind.rows.reduce((sum, r) => sum + Number(r.count), 0)
          sections.push(
            `\n**Summaries:** ${totalSummaries.toLocaleString()} total\n` +
              byKind.rows
                .map(
                  (r) =>
                    `  ${r.kind}: ${Number(r.count).toLocaleString()} (max depth: ${String(r.max_depth)})`,
                )
                .join('\n'),
          )
        } else {
          sections.push('\n**Summaries:** 0 ⚠️ No summaries — compactor may not be running')
        }

        // Embedding queue
        const embedQueue = await pool.query<EmbedQueueRow>(`
          SELECT
            (SELECT COUNT(*) FROM ros_messages WHERE embedding IS NULL AND content IS NOT NULL AND LENGTH(content) > 0) AS msg_queue,
            (SELECT COUNT(*) FROM ros_summaries WHERE embedding IS NULL AND content IS NOT NULL) AS sum_queue
        `)
        const eq = embedQueue.rows[0]
        const msgQueue = Number(eq.msg_queue)
        const sumQueue = Number(eq.sum_queue)
        const queueTotal = msgQueue + sumQueue
        const queueStatus =
          queueTotal === 0
            ? '✅ caught up'
            : queueTotal < 50
              ? `⏳ ${String(queueTotal)} pending`
              : `⚠️ ${String(queueTotal)} pending (backlog)`

        sections.push(
          `\n**Embedding queue:** ${queueStatus}` +
            `\n  Messages awaiting embedding: ${msgQueue.toLocaleString()}` +
            `\n  Summaries awaiting embedding: ${sumQueue.toLocaleString()}`,
        )

        // Embedding coverage
        const msgEmbed = await pool.query<EmbedCoverageRow>(
          `SELECT COUNT(*) AS total, COUNT(embedding) AS embedded FROM ros_messages`,
        )
        const me = msgEmbed.rows[0]
        const sumEmbed = await pool.query<EmbedCoverageRow>(
          `SELECT COUNT(*) AS total, COUNT(embedding) AS embedded FROM ros_summaries`,
        )
        const se = sumEmbed.rows[0]
        const msgPct =
          Number(me.total) > 0 ? ((Number(me.embedded) / Number(me.total)) * 100).toFixed(1) : '0'
        const sumPct =
          Number(se.total) > 0 ? ((Number(se.embedded) / Number(se.total)) * 100).toFixed(1) : '0'
        sections.push(
          `\n**Embedding coverage:**` +
            `\n  Messages: ${Number(me.embedded).toLocaleString()}/${Number(me.total).toLocaleString()} (${msgPct}%)` +
            `\n  Summaries: ${Number(se.embedded).toLocaleString()}/${Number(se.total).toLocaleString()} (${sumPct}%)`,
        )

        // Unsummarized messages — bucketed by compactor eligibility.
        //   eligible:    will be picked by the next enqueue-idle pass
        //                (full window: >= FULL_WINDOW unsummarized, OR
        //                 idle floor:  >= MIN_BATCH_SIZE AND idle >= IDLE_MINUTES, OR
        //                 stale flush: >= STALE_MIN_BATCH AND idle >= STALE_MINUTES)
        //   active_tail: still-active conversation with MIN_BATCH_SIZE..FULL_WINDOW-1
        //                unsummarized — will flush once it goes idle or fills the window
        //   below_floor: too few qualifying messages to compact yet — < STALE_MIN_BATCH,
        //                or < MIN_BATCH_SIZE and not yet stale. Flushed only once idle
        //                reaches STALE_MINUTES (if >= STALE_MIN_BATCH); a singleton tail
        //                never compacts by design.
        // The filter (LENGTH > 10 OR tool_name IS NOT NULL) matches enqueue-idle.ts.
        const buckets = await pool.query<UnsummarizedBucketRow>(
          `WITH per_conv AS (
             SELECT c.id AS conversation_id, c.updated_at,
                    COUNT(m.id) AS qualifying
             FROM ros_conversations c
             JOIN ros_messages m ON m.conversation_id = c.id
             LEFT JOIN ros_summary_sources ss ON ss.message_id = m.id
             WHERE ss.summary_id IS NULL
               AND ((m.content IS NOT NULL AND LENGTH(m.content) > 10)
                    OR m.tool_name IS NOT NULL)
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
        const b = buckets.rows[0]
        const eligibleMsgs = Number(b.eligible_msgs)
        const eligibleConvs = Number(b.eligible_convs)
        const activeTailMsgs = Number(b.active_tail_msgs)
        const activeTailConvs = Number(b.active_tail_convs)
        const belowFloorMsgs = Number(b.below_floor_msgs)
        const belowFloorConvs = Number(b.below_floor_convs)
        const totalUnsum = eligibleMsgs + activeTailMsgs + belowFloorMsgs
        // Warn only when the actionable bucket (eligible) is large — the global
        // total is dominated by below-floor tails which the compactor will never
        // touch by design.
        const eligibleStatus = eligibleConvs === 0 ? '✅' : eligibleMsgs < 100 ? '⏳' : '⚠️'
        sections.push(
          `\n**Unsummarized messages:** ${totalUnsum.toLocaleString()} total` +
            `\n  Eligible for compaction: ${eligibleMsgs.toLocaleString()} msgs in ${eligibleConvs.toLocaleString()} convs ${eligibleStatus}` +
            `\n    (≥${String(FULL_WINDOW)} unsummarized, OR ≥${String(MIN_BATCH_SIZE)} + idle ≥${String(IDLE_MINUTES)}m, OR ≥${String(STALE_MIN_BATCH)} + idle ≥${String(Math.round(STALE_MINUTES / 1440))}d)` +
            `\n  Active tail: ${activeTailMsgs.toLocaleString()} msgs in ${activeTailConvs.toLocaleString()} convs (will flush when idle)` +
            `\n  Below floor: ${belowFloorMsgs.toLocaleString()} msgs in ${belowFloorConvs.toLocaleString()} convs (<${String(STALE_MIN_BATCH)} qualifying, or not yet stale — won't compact yet)`,
        )

        // Top conversations the next enqueue-idle pass will pick (matches the
        // worker's own SELECT in enqueue-idle.ts, sorted oldest-first).
        const eligible = await pool.query<EligibleConvRow>(
          `SELECT c.id::text AS conversation_id, c.agent,
                  COUNT(m.id)::text AS unsummarized,
                  CASE WHEN COUNT(m.id) >= $1 THEN 'full_window'
                       WHEN COUNT(m.id) >= $2 THEN 'idle_floor'
                       ELSE 'stale_partial' END AS trigger
             FROM ros_conversations c
             JOIN ros_messages m ON m.conversation_id = c.id
             LEFT JOIN ros_summary_sources ss ON ss.message_id = m.id
            WHERE ss.summary_id IS NULL
              AND ((m.content IS NOT NULL AND LENGTH(m.content) > 10)
                   OR m.tool_name IS NOT NULL)
            GROUP BY c.id, c.agent, c.updated_at
           HAVING (COUNT(m.id) >= $2
                   AND (COUNT(m.id) >= $1
                        OR c.updated_at < NOW() - ($3 || ' minutes')::interval))
               OR (COUNT(m.id) >= $4
                   AND c.updated_at < NOW() - ($5 || ' minutes')::interval)
            ORDER BY c.updated_at ASC LIMIT 5`,
          [FULL_WINDOW, MIN_BATCH_SIZE, IDLE_MINUTES, STALE_MIN_BATCH, STALE_MINUTES],
        )
        if (eligible.rows.length > 0) {
          sections.push(
            `\n**Top conversations eligible for compaction:**\n` +
              eligible.rows
                .map(
                  (r) =>
                    `  ${r.agent}: ${Number(r.unsummarized).toLocaleString()} unsummarized [${r.trigger}] (conv: ${r.conversation_id.slice(0, 8)}…)`,
                )
                .join('\n'),
          )
        }

        // Stuck graphile-worker jobs — silent rot. Skip gracefully if the
        // schema isn't present (e.g., test fixtures without the worker).
        const hasGraphileWorker = await pool.query<{ present: boolean }>(
          `SELECT EXISTS (
             SELECT 1 FROM information_schema.tables
             WHERE table_schema='graphile_worker' AND table_name='_private_jobs'
           ) AS present`,
        )
        if (hasGraphileWorker.rows[0]?.present) {
          const stuck = await pool.query<StuckJobRow>(
            `SELECT t.identifier AS task,
                    COUNT(*)::text AS count,
                    MIN(j.run_at) AS oldest_run_at,
                    LEFT(MAX(j.last_error), 120) AS sample_error
               FROM graphile_worker._private_jobs j
               JOIN graphile_worker._private_tasks t ON t.id = j.task_id
              WHERE j.attempts >= j.max_attempts
              GROUP BY t.identifier
              ORDER BY COUNT(*) DESC`,
          )
          if (stuck.rows.length > 0) {
            sections.push(
              `\n**⚠️ Stuck queue jobs (at max attempts, won't retry):**\n` +
                stuck.rows
                  .map(
                    (r) =>
                      `  ${r.task}: ${Number(r.count).toLocaleString()} dead since ${fmtDate(r.oldest_run_at)}` +
                      (r.sample_error ? ` — ${r.sample_error}` : ''),
                  )
                  .join('\n'),
            )
          }
        }

        // Orphan summaries
        const orphanSums = await pool.query<UnsummarizedRow>(`
          SELECT COUNT(*) AS count FROM ros_summaries s
          LEFT JOIN ros_summary_sources ss ON ss.summary_id = s.id
          WHERE ss.summary_id IS NULL AND s.kind = 'leaf'
        `)
        const orphanCount = Number(orphanSums.rows[0].count)
        if (orphanCount > 0) {
          sections.push(
            `\n**⚠️ Orphan leaf summaries (no source messages):** ${String(orphanCount)}`,
          )
        }

        // Summary tree depth
        const treeDepth = await pool.query<TreeDepthRow>(`
          SELECT MAX(depth) AS max_depth,
                 COUNT(*) FILTER (WHERE parent_id IS NULL AND kind != 'leaf') AS root_count,
                 COUNT(*) FILTER (WHERE parent_id IS NOT NULL) AS child_count
          FROM ros_summaries
        `)
        const td = treeDepth.rows[0]
        sections.push(
          `\n**Summary tree:**` +
            `\n  Max depth: ${String(td.max_depth ?? 0)}` +
            `\n  Root summaries: ${td.root_count}` +
            `\n  Child summaries: ${td.child_count}`,
        )

        // Freshness
        const freshness = await pool.query<FreshnessRow>(`
          SELECT
            (SELECT MAX(created_at) FROM ros_messages) AS newest_message,
            (SELECT MAX(created_at) FROM ros_summaries) AS newest_summary
        `)
        const f = freshness.rows[0]
        const newestMsg = f.newest_message ? timeSince(f.newest_message) : 'never'
        const newestSum = f.newest_summary ? timeSince(f.newest_summary) : 'never'
        sections.push(
          `\n**Freshness:**` +
            `\n  Newest message: ${newestMsg}` +
            `\n  Newest summary: ${newestSum}`,
        )

        return sections.join('\n')
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error)
        return `Stats query failed: ${msg}`
      }
    },
  }
}
