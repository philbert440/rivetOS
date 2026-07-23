/**
 * memory_browse — chronological message browsing tool.
 */

import pg from 'pg'
import type { Tool } from '@rivetos/types'
import { applyWindowArgs, truncationHint, WINDOW_CHOICES, type MessageRow } from './helpers.js'

export function createBrowseTool(pool: pg.Pool): Tool {
  return {
    name: 'memory_browse',
    description:
      'Browse conversation messages chronologically. Unlike memory_search (which ranks by relevance), ' +
      'this returns messages in time order. Use to review what happened in a session, ' +
      'catch up on recent activity, or read a specific conversation. ' +
      'For time-bounded questions ("today", "yesterday", "this morning"), prefer window= ' +
      'over raw since/before so local-timezone midnights convert correctly to UTC.',
    parameters: {
      type: 'object',
      properties: {
        conversation_id: {
          type: 'string',
          description: 'Browse a specific conversation by ID',
        },
        since: {
          type: 'string',
          description:
            'Show messages after this time (ISO timestamp, e.g. 2025-03-15T10:00:00Z). ' +
            'Must be UTC — bare dates like "2025-03-15" are UTC midnight (= previous evening US local). Prefer window=.',
        },
        before: {
          type: 'string',
          description:
            'Show messages before this time (ISO timestamp, e.g. 2025-03-16). Same UTC gotcha as since. Prefer window=.',
        },
        window: {
          type: 'string',
          enum: [...WINDOW_CHOICES],
          description:
            'Shortcut for time-bounded windows (today, yesterday, this_morning, this_week, last_24h). ' +
            'Resolves to (since, before) in the SERVER local timezone — no TZ math required. ' +
            'Used only when neither since nor before is provided.',
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
        conditions.push(`m.conversation_id = $${String(pi)}`)
        params.push(args.conversation_id)
        pi++
      }

      if (args.agent) {
        conditions.push(`m.agent = $${String(pi)}`)
        params.push(args.agent)
        pi++
      }

      let since: string | undefined
      let before: string | undefined
      try {
        ;({ since, before } = applyWindowArgs(args))
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error)
        return `Browse failed: ${msg}`
      }

      if (since) {
        conditions.push(`m.created_at >= $${String(pi)}`)
        params.push(since)
        pi++
      }

      if (before) {
        conditions.push(`m.created_at < $${String(pi)}`)
        params.push(before)
        pi++
      }

      const limit = Math.min(Math.max((args.limit as number | undefined) ?? 50, 1), 200)
      params.push(limit)
      const limitIdx = pi

      const order = (args.order as string) === 'asc' ? 'ASC' : 'DESC'
      const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''

      const sql = `
        SELECT m.id, m.role, m.agent, m.content, m.created_at,
               m.conversation_id, m.tool_name, m.metadata
        FROM ros_messages m
        ${where}
        ORDER BY m.created_at ${order}
        LIMIT $${String(limitIdx)}
      `

      try {
        const result = await pool.query<MessageRow>(sql, params)

        if (result.rows.length === 0) return 'No messages found.'

        const hitLimit = result.rows.length >= limit
        const lines = result.rows.map((r) => {
          const ts = r.created_at.toISOString().replace('T', ' ').slice(0, 19)
          const tool = r.tool_name ? ` [tool: ${r.tool_name}]` : ''
          const content = r.content.length > 500 ? r.content.slice(0, 500) + '…' : r.content
          return `[${ts}] ${r.agent}/${r.role}${tool}\n${content}${truncationHint(r.metadata, r.id)}`
        })

        let header = `## Messages (${String(result.rows.length)} returned, ${order === 'DESC' ? 'newest' : 'oldest'} first)`
        if (typeof args.window === 'string' && args.window && (since || before)) {
          header +=
            `\n_window="${args.window}"` +
            (since ? ` since=${since}` : '') +
            (before ? ` before=${before}` : '') +
            '_'
        }
        if (hitLimit) {
          header += `\n_Hit limit=${String(limit)}. Flip order, raise limit (max 200), or narrow since/before/window._`
        }

        return header + '\n\n' + lines.join('\n\n---\n\n')
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error)
        return `Browse failed: ${msg}`
      }
    },
  }
}
