/**
 * Memory Tools — agent-facing tools for searching and exploring memory.
 *
 * Consolidated design (3 tools):
 *   memory_search  — unified search + auto-expand + structured output
 *   memory_browse  — sequential chronological browsing
 *   memory_stats   — system health: counts, embedding queue, compaction status
 *
 * Tools implement the Tool interface from @rivetos/types.
 * They delegate all data access to SearchEngine and Expander.
 */

import pg from 'pg'
import type { Tool } from '@rivetos/types'
import type { SearchEngine, SearchHit } from './search.js'
import type { Expander, SummaryNode } from './expand.js'

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface MemoryToolsConfig {
  /** Rivet Local endpoint for LLM-synthesized answers (e.g., http://10.4.20.12:8000/v1) */
  compactorEndpoint?: string
  /** Model name for synthesis (default: rivet-v0.1) */
  compactorModel?: string
  /** pg.Pool — required for memory_browse and memory_stats */
  pool?: pg.Pool
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

const MS_PER_DAY = 86_400_000

export function createMemoryTools(
  searchEngine: SearchEngine,
  expander: Expander,
  config?: MemoryToolsConfig,
): Tool[] {
  const tools: Tool[] = [createSearchTool(searchEngine, expander, config)]

  if (config?.pool) {
    tools.push(createBrowseTool(config.pool))
    tools.push(createStatsTool(config.pool))
  }

  return tools
}

// ---------------------------------------------------------------------------
// memory_search — unified search + auto-expand
// ---------------------------------------------------------------------------

function createSearchTool(
  searchEngine: SearchEngine,
  expander: Expander,
  config?: MemoryToolsConfig,
): Tool {
  return {
    name: 'memory_search',
    description:
      'Search conversation history and summaries. Automatically expands promising summary hits ' +
      'to show children and source messages. Returns structured, scored results. ' +
      'Use for finding past decisions, discussions, context, or answering "what did we decide about X" questions.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query — natural language question or keywords',
        },
        mode: {
          type: 'string',
          enum: ['fts', 'trigram', 'regex'],
          description:
            'Search mode: fts (full-text, default), trigram (fuzzy/typo-tolerant), regex (pattern match)',
        },
        scope: {
          type: 'string',
          enum: ['messages', 'summaries', 'both'],
          description: 'Where to search (default: both)',
        },
        limit: { type: 'number', description: 'Max top-level results (default: 10)' },
        agent: { type: 'string', description: 'Filter by agent (opus, grok, etc.)' },
        since: {
          type: 'string',
          description: 'Only return results after this date (ISO timestamp, e.g. 2025-01-15)',
        },
        before: {
          type: 'string',
          description: 'Only return results before this date (ISO timestamp, e.g. 2025-06-01)',
        },
        expand: {
          type: 'boolean',
          description: 'Auto-expand top summary hits to show source messages (default: true)',
        },
        synthesize: {
          type: 'boolean',
          description:
            'Use LLM to synthesize a focused answer from results (default: false). Requires Rivet Local.',
        },
      },
      required: ['query'],
    },
    async execute(args: Record<string, unknown>): Promise<string> {
      const query = args.query as string
      const mode = (args.mode as string | undefined) ?? 'fts'
      const scope = (args.scope as string | undefined) ?? 'both'
      const limit = Math.min(Math.max((args.limit as number) ?? 10, 1), 50)
      const agent = args.agent as string | undefined
      const since = args.since as string | undefined
      const before = args.before as string | undefined
      const shouldExpand = args.expand !== false // default true
      const shouldSynthesize = args.synthesize === true

      // 1. Search
      const results = await searchEngine.search(query, {
        mode: mode as 'fts' | 'trigram' | 'regex',
        scope: scope as 'messages' | 'summaries' | 'both',
        limit,
        agent,
        since,
        before,
      })

      if (results.length === 0) return 'No results found.'

      // 2. Separate summaries from messages
      const summaryHits = results.filter((r) => r.type === 'summary')
      const messageHits = results.filter((r) => r.type === 'message')

      // 3. Auto-expand top summary hits
      const expandedSummaries: {
        hit: SearchHit
        children: SummaryNode[]
        sourceMessages: Array<{ role: string; content: string; createdAt: Date }>
      }[] = []

      if (shouldExpand && summaryHits.length > 0) {
        // Expand top 3 summaries (more would be too much output)
        const toExpand = summaryHits.slice(0, 3)
        for (const hit of toExpand) {
          try {
            // Use adaptive depth: high-score hits get deeper expansion
            const depth = hit.score > 0.5 ? 3 : 2
            const expanded = await expander.expandDeep(hit.id, depth)
            if (expanded) {
              expandedSummaries.push({
                hit,
                children: expanded.children,
                sourceMessages: expanded.sourceMessages,
              })
            }
          } catch {
            // Expansion failed — still show the hit as-is
            expandedSummaries.push({
              hit,
              children: [],
              sourceMessages: [],
            })
          }
        }
      }

      // 4. Build structured output
      const sections: string[] = []
      sections.push(`## Memory Search: "${query}"`)
      sections.push(
        `Found ${results.length} results (${summaryHits.length} summaries, ${messageHits.length} messages)\n`,
      )

      // Expanded summaries first (highest signal)
      if (expandedSummaries.length > 0) {
        sections.push('### Summaries (expanded)\n')
        for (const { hit, children, sourceMessages } of expandedSummaries) {
          const age = Math.floor((Date.now() - hit.createdAt.getTime()) / MS_PER_DAY)
          const period =
            hit.earliestAt && hit.latestAt
              ? `${fmtDate(hit.earliestAt)} → ${fmtDate(hit.latestAt)}`
              : fmtDate(hit.createdAt)

          sections.push(
            `**[${hit.kind ?? 'summary'}]** (${age}d ago, score: ${hit.score.toFixed(3)}, period: ${period})`,
          )
          sections.push(hit.content)

          if (children.length > 0) {
            sections.push(`\n  **Children (${children.length}):**`)
            for (const child of children.slice(0, 5)) {
              const preview =
                child.content.length > 200 ? child.content.slice(0, 200) + '…' : child.content
              sections.push(`  - [${child.kind}] ${preview}`)
            }
            if (children.length > 5) {
              sections.push(`  - ... and ${children.length - 5} more`)
            }
          }

          if (sourceMessages.length > 0) {
            sections.push(`\n  **Source messages (${sourceMessages.length}):**`)
            for (const msg of sourceMessages.slice(0, 8)) {
              const msgContent =
                msg.content.length > 300 ? msg.content.slice(0, 300) + '…' : msg.content
              sections.push(`  > [${msg.role}] ${msgContent}`)
            }
            if (sourceMessages.length > 8) {
              sections.push(`  > ... and ${sourceMessages.length - 8} more messages`)
            }
          }

          sections.push('')
        }

        // Show remaining unexpanded summaries
        const remaining = summaryHits.slice(3)
        if (remaining.length > 0) {
          sections.push('### Additional summaries (not expanded)\n')
          for (const hit of remaining) {
            const age = Math.floor((Date.now() - hit.createdAt.getTime()) / MS_PER_DAY)
            const preview = hit.content.length > 300 ? hit.content.slice(0, 300) + '…' : hit.content
            sections.push(
              `- [${hit.kind ?? 'summary'}] (${age}d ago, score: ${hit.score.toFixed(3)}) ${preview}`,
            )
          }
          sections.push('')
        }
      } else if (summaryHits.length > 0) {
        // Not expanded (expand=false)
        sections.push('### Summaries\n')
        for (const hit of summaryHits) {
          const age = Math.floor((Date.now() - hit.createdAt.getTime()) / MS_PER_DAY)
          const preview = hit.content.length > 300 ? hit.content.slice(0, 300) + '…' : hit.content
          sections.push(
            `- [${hit.kind ?? 'summary'}/${hit.id}] (${age}d ago, score: ${hit.score.toFixed(3)}) ${preview}`,
          )
        }
        sections.push('')
      }

      // Messages
      if (messageHits.length > 0) {
        sections.push('### Messages\n')
        for (const hit of messageHits) {
          const age = Math.floor((Date.now() - hit.createdAt.getTime()) / MS_PER_DAY)
          const preview = hit.content.length > 400 ? hit.content.slice(0, 400) + '…' : hit.content
          sections.push(
            `- [${hit.agent}/${hit.role}] (${age}d ago, score: ${hit.score.toFixed(3)}) ${preview}`,
          )
        }
      }

      // 5. Optional LLM synthesis
      if (shouldSynthesize && config?.compactorEndpoint) {
        const contextText = sections.join('\n')
        const answer = await queryLlm(
          config.compactorEndpoint,
          config.compactorModel ?? 'rivet-v0.1',
          query,
          contextText,
          2000,
        )
        return `## Synthesized Answer\n\n${answer}\n\n---\n\n${sections.join('\n')}`
      }

      return sections.join('\n')
    },
  }
}

// ---------------------------------------------------------------------------
// memory_browse — chronological message browsing (unchanged)
// ---------------------------------------------------------------------------

function createBrowseTool(pool: pg.Pool): Tool {
  return {
    name: 'memory_browse',
    description:
      'Browse conversation messages chronologically. Unlike memory_search (which ranks by relevance), ' +
      'this returns messages in time order. Use to review what happened in a session, ' +
      'catch up on recent activity, or read a specific conversation.',
    parameters: {
      type: 'object',
      properties: {
        conversation_id: {
          type: 'string',
          description: 'Browse a specific conversation by ID',
        },
        since: {
          type: 'string',
          description: 'Show messages after this time (ISO timestamp, e.g. 2025-03-15T10:00:00Z)',
        },
        before: {
          type: 'string',
          description: 'Show messages before this time (ISO timestamp, e.g. 2025-03-16)',
        },
        agent: {
          type: 'string',
          description: 'Filter by agent (opus, grok, etc.)',
        },
        limit: {
          type: 'number',
          description: 'Max messages to return (default: 50, max: 200)',
        },
        order: {
          type: 'string',
          enum: ['asc', 'desc'],
          description: 'Chronological order — asc (oldest first) or desc (newest first, default)',
        },
      },
      required: [],
    },
    async execute(args: Record<string, unknown>): Promise<string> {
      const conditions: string[] = []
      const params: unknown[] = []
      let pi = 1

      if (args.conversation_id) {
        conditions.push(`m.conversation_id = $${pi}`)
        params.push(args.conversation_id)
        pi++
      }

      if (args.agent) {
        conditions.push(`m.agent = $${pi}`)
        params.push(args.agent)
        pi++
      }

      if (args.since) {
        conditions.push(`m.created_at >= $${pi}`)
        params.push(args.since)
        pi++
      }

      if (args.before) {
        conditions.push(`m.created_at < $${pi}`)
        params.push(args.before)
        pi++
      }

      const limit = Math.min(Math.max((args.limit as number) ?? 50, 1), 200)
      params.push(limit)
      const limitIdx = pi

      const order = (args.order as string) === 'asc' ? 'ASC' : 'DESC'
      const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''

      const sql = `
        SELECT m.id, m.role, m.agent, m.content, m.created_at,
               m.conversation_id, m.tool_name
        FROM ros_messages m
        ${where}
        ORDER BY m.created_at ${order}
        LIMIT $${limitIdx}
      `

      try {
        const result = await pool.query(sql, params)

        if (result.rows.length === 0) return 'No messages found.'

        const lines = result.rows.map((r: any) => {
          const ts = (r.created_at as Date).toISOString().replace('T', ' ').slice(0, 19)
          const tool = r.tool_name ? ` [tool: ${r.tool_name}]` : ''
          const content = r.content.length > 500 ? r.content.slice(0, 500) + '…' : r.content
          return `[${ts}] ${r.agent}/${r.role}${tool}\n${content}`
        })

        return (
          `## Messages (${result.rows.length} returned, ${order === 'DESC' ? 'newest' : 'oldest'} first)\n\n` +
          lines.join('\n\n---\n\n')
        )
      } catch (err: any) {
        return `Browse failed: ${err.message}`
      }
    },
  }
}

// ---------------------------------------------------------------------------
// memory_stats — system health diagnostics
// ---------------------------------------------------------------------------

function createStatsTool(pool: pg.Pool): Tool {
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

        // --- Message totals + date range ---
        const msgWhere = agentFilter ? 'WHERE agent = $1' : ''
        const msgParams = agentFilter ? [agentFilter] : []
        const msgTotals = await pool.query(
          `SELECT COUNT(*) AS total,
                  MIN(created_at) AS oldest,
                  MAX(created_at) AS newest
           FROM ros_messages ${msgWhere}`,
          msgParams,
        )
        const mt = msgTotals.rows[0]
        sections.push(
          `\n**Messages:** ${Number(mt.total).toLocaleString()}` +
            `\n**Date range:** ${fmtDate(mt.oldest)} → ${fmtDate(mt.newest)}`,
        )

        // --- Messages by agent ---
        const byAgent = await pool.query(
          `SELECT agent, COUNT(*) AS count
           FROM ros_messages
           ${msgWhere}
           GROUP BY agent ORDER BY count DESC`,
          msgParams,
        )
        if (byAgent.rows.length > 0) {
          sections.push(
            '\n**By agent:**\n' +
              byAgent.rows
                .map((r: any) => `  ${r.agent}: ${Number(r.count).toLocaleString()}`)
                .join('\n'),
          )
        }

        // --- Messages by role ---
        const byRole = await pool.query(
          `SELECT role, COUNT(*) AS count
           FROM ros_messages
           ${msgWhere}
           GROUP BY role ORDER BY count DESC`,
          msgParams,
        )
        if (byRole.rows.length > 0) {
          sections.push(
            '\n**By role:**\n' +
              byRole.rows
                .map((r: any) => `  ${r.role}: ${Number(r.count).toLocaleString()}`)
                .join('\n'),
          )
        }

        // --- Conversations ---
        const convTotals = await pool.query(
          `SELECT COUNT(*) AS total,
                  COUNT(*) FILTER (WHERE active) AS active
           FROM ros_conversations`,
        )
        const ct = convTotals.rows[0]
        sections.push(`\n**Conversations:** ${ct.total} total, ${ct.active} active`)

        // --- Summary counts by kind ---
        const byKind = await pool.query(
          `SELECT kind, COUNT(*) AS count, MAX(depth) AS max_depth
           FROM ros_summaries
           GROUP BY kind ORDER BY count DESC`,
        )
        if (byKind.rows.length > 0) {
          const totalSummaries = byKind.rows.reduce(
            (sum: number, r: any) => sum + Number(r.count),
            0,
          )
          sections.push(
            `\n**Summaries:** ${totalSummaries.toLocaleString()} total\n` +
              byKind.rows
                .map(
                  (r: any) =>
                    `  ${r.kind}: ${Number(r.count).toLocaleString()} (max depth: ${r.max_depth})`,
                )
                .join('\n'),
          )
        } else {
          sections.push('\n**Summaries:** 0 ⚠️ No summaries — compactor may not be running')
        }

        // --- HEALTH: Embedding queue ---
        const embedQueue = await pool.query(`
          SELECT
            (SELECT COUNT(*) FROM ros_messages WHERE embedding IS NULL AND content IS NOT NULL AND LENGTH(content) > 20) AS msg_queue,
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
              ? `⏳ ${queueTotal} pending`
              : `⚠️ ${queueTotal} pending (backlog)`

        sections.push(
          `\n**Embedding queue:** ${queueStatus}` +
            `\n  Messages awaiting embedding: ${msgQueue.toLocaleString()}` +
            `\n  Summaries awaiting embedding: ${sumQueue.toLocaleString()}`,
        )

        // --- HEALTH: Embedding coverage ---
        const msgEmbed = await pool.query(
          `SELECT COUNT(*) AS total, COUNT(embedding) AS embedded FROM ros_messages`,
        )
        const me = msgEmbed.rows[0]
        const sumEmbed = await pool.query(
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

        // --- HEALTH: Unsummarized messages ---
        const unsummarized = await pool.query(`
          SELECT COUNT(*) AS count
          FROM ros_messages m
          LEFT JOIN ros_summary_sources ss ON ss.message_id = m.id
          WHERE ss.summary_id IS NULL
            AND m.content IS NOT NULL
            AND LENGTH(m.content) > 10
        `)
        const unsumCount = Number(unsummarized.rows[0].count)
        const unsumStatus = unsumCount < 50 ? '✅' : unsumCount < 200 ? '⏳' : '⚠️'
        sections.push(
          `\n**Unsummarized messages:** ${unsumCount.toLocaleString()} ${unsumStatus}` +
            (unsumCount >= 50 ? `\n  (compactor triggers at 50, batches of 25)` : ''),
        )

        // --- HEALTH: Conversations needing compaction ---
        const needsCompaction = await pool.query(`
          SELECT m.conversation_id, c.agent, COUNT(*) AS unsummarized
          FROM ros_messages m
          LEFT JOIN ros_summary_sources ss ON ss.message_id = m.id
          JOIN ros_conversations c ON c.id = m.conversation_id
          WHERE ss.summary_id IS NULL
            AND m.content IS NOT NULL
            AND LENGTH(m.content) > 10
          GROUP BY m.conversation_id, c.agent
          HAVING COUNT(*) >= 50
          ORDER BY COUNT(*) DESC
          LIMIT 5
        `)
        if (needsCompaction.rows.length > 0) {
          sections.push(
            `\n**Conversations needing compaction (≥50 unsummarized):**\n` +
              needsCompaction.rows
                .map(
                  (r: any) =>
                    `  ${r.agent}: ${Number(r.unsummarized).toLocaleString()} unsummarized (conv: ${r.conversation_id.slice(0, 8)}…)`,
                )
                .join('\n'),
          )
        }

        // --- HEALTH: Orphan summaries (no source messages) ---
        const orphanSums = await pool.query(`
          SELECT COUNT(*) AS count
          FROM ros_summaries s
          LEFT JOIN ros_summary_sources ss ON ss.summary_id = s.id
          WHERE ss.summary_id IS NULL AND s.kind = 'leaf'
        `)
        const orphanCount = Number(orphanSums.rows[0].count)
        if (orphanCount > 0) {
          sections.push(`\n**⚠️ Orphan leaf summaries (no source messages):** ${orphanCount}`)
        }

        // --- HEALTH: Summary tree depth ---
        const treeDepth = await pool.query(`
          SELECT MAX(depth) AS max_depth,
                 COUNT(*) FILTER (WHERE parent_id IS NULL AND kind != 'leaf') AS root_count,
                 COUNT(*) FILTER (WHERE parent_id IS NOT NULL) AS child_count
          FROM ros_summaries
        `)
        const td = treeDepth.rows[0]
        sections.push(
          `\n**Summary tree:**` +
            `\n  Max depth: ${td.max_depth ?? 0}` +
            `\n  Root summaries: ${td.root_count}` +
            `\n  Child summaries: ${td.child_count}`,
        )

        // --- HEALTH: Freshness ---
        const freshness = await pool.query(`
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
      } catch (err: any) {
        return `Stats query failed: ${err.message}`
      }
    },
  }
}

// ---------------------------------------------------------------------------
// LLM call for synthesized answers
// ---------------------------------------------------------------------------

async function queryLlm(
  endpoint: string,
  model: string,
  query: string,
  context: string,
  maxTokens: number,
): Promise<string> {
  try {
    const response = await fetch(`${endpoint}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: 'system',
            content:
              'You are a memory assistant. Answer the question using ONLY the provided context. ' +
              'Be concise and specific. If the context does not contain enough information, say so.',
          },
          {
            role: 'user',
            content: `## Context from conversation history:\n\n${context}\n\n## Question:\n${query}`,
          },
        ],
        max_tokens: maxTokens,
        temperature: 0.3,
      }),
      signal: AbortSignal.timeout(30_000),
    })

    if (!response.ok) {
      return `LLM synthesis failed: ${response.status} ${response.statusText}`
    }

    const data = (await response.json()) as Record<string, unknown>
    return (data as any).choices?.[0]?.message?.content ?? 'No answer generated.'
  } catch (err: any) {
    return `Failed to synthesize answer: ${err.message}`
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmtDate(d: Date | null): string {
  return d?.toISOString().split('T')[0] ?? '?'
}

function timeSince(d: Date): string {
  const ms = Date.now() - d.getTime()
  if (ms < 60_000) return 'just now'
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`
  if (ms < MS_PER_DAY) return `${Math.floor(ms / 3_600_000)}h ago`
  return `${Math.floor(ms / MS_PER_DAY)}d ago`
}
