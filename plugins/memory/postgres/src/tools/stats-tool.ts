/**
 * memory_stats — system health diagnostics tool.
 */

import pg from 'pg'
import type { Tool } from '@rivetos/types'
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
  type CompactionRow,
  type TreeDepthRow,
  type FreshnessRow,
} from './helpers.js'

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

        // Unsummarized messages
        const unsummarized = await pool.query<UnsummarizedRow>(`
          SELECT COUNT(*) AS count FROM ros_messages m
          LEFT JOIN ros_summary_sources ss ON ss.message_id = m.id
          WHERE ss.summary_id IS NULL AND m.content IS NOT NULL AND LENGTH(m.content) > 10
        `)
        const unsumCount = Number(unsummarized.rows[0].count)
        const unsumStatus = unsumCount < 50 ? '✅' : unsumCount < 200 ? '⏳' : '⚠️'
        sections.push(
          `\n**Unsummarized messages:** ${unsumCount.toLocaleString()} ${unsumStatus}` +
            (unsumCount >= 50 ? `\n  (compactor triggers at 50, batches of 25)` : ''),
        )

        // Conversations needing compaction
        const needsCompaction = await pool.query<CompactionRow>(`
          SELECT m.conversation_id, c.agent, COUNT(*) AS unsummarized
          FROM ros_messages m
          LEFT JOIN ros_summary_sources ss ON ss.message_id = m.id
          JOIN ros_conversations c ON c.id = m.conversation_id
          WHERE ss.summary_id IS NULL AND m.content IS NOT NULL AND LENGTH(m.content) > 10
          GROUP BY m.conversation_id, c.agent
          HAVING COUNT(*) >= 50
          ORDER BY COUNT(*) DESC LIMIT 5
        `)
        if (needsCompaction.rows.length > 0) {
          sections.push(
            `\n**Conversations needing compaction (≥50 unsummarized):**\n` +
              needsCompaction.rows
                .map(
                  (r) =>
                    `  ${r.agent}: ${Number(r.unsummarized).toLocaleString()} unsummarized (conv: ${r.conversation_id.slice(0, 8)}…)`,
                )
                .join('\n'),
          )
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
