/**
 * memory_browse — chronological message browsing tool.
 */

import pg from 'pg'
import type { Tool } from '@rivetos/types'
import type { MessageRow } from './helpers.js'

export function createBrowseTool(pool: pg.Pool): Tool {
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
        conditions.push(`m.conversation_id = $${String(pi)}`)
        params.push(args.conversation_id)
        pi++
      }

      if (args.agent) {
        conditions.push(`m.agent = $${String(pi)}`)
        params.push(args.agent)
        pi++
      }

      if (args.since) {
        conditions.push(`m.created_at >= $${String(pi)}`)
        params.push(args.since)
        pi++
      }

      if (args.before) {
        conditions.push(`m.created_at < $${String(pi)}`)
        params.push(args.before)
        pi++
      }

      const limit = Math.min(Math.max((args.limit as number | undefined) ?? 50, 1), 200)
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
        LIMIT $${String(limitIdx)}
      `

      try {
        const result = await pool.query<MessageRow>(sql, params)

        if (result.rows.length === 0) return 'No messages found.'

        const lines = result.rows.map((r) => {
          const ts = r.created_at.toISOString().replace('T', ' ').slice(0, 19)
          const tool = r.tool_name ? ` [tool: ${r.tool_name}]` : ''
          const content = r.content.length > 500 ? r.content.slice(0, 500) + '…' : r.content
          return `[${ts}] ${r.agent}/${r.role}${tool}\n${content}`
        })

        return (
          `## Messages (${String(result.rows.length)} returned, ${order === 'DESC' ? 'newest' : 'oldest'} first)\n\n` +
          lines.join('\n\n---\n\n')
        )
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error)
        return `Browse failed: ${msg}`
      }
    },
  }
}
