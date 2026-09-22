/**
 * On-demand recall: call RivetOS MCP memory_search and wrap the result so a
 * T3-launched agent can put it in context. T3 has no hook that injects this
 * automatically — the agent (or this helper) has to call the tool.
 */

import { resolveIntent, SUMMARIZE_NOTE } from './tool-map.mjs'

/**
 * @param {unknown} raw
 * @param {string} query
 */
export function formatMemoriesAsContext(raw, query) {
  const body = typeof raw === 'string' ? raw.trim() : JSON.stringify(raw, null, 2)
  if (!body) {
    return `## RivetOS memory\n\nNo memories matched ${JSON.stringify(query)}.`
  }
  return `## RivetOS memory\n\nQuery: ${query}\n\n${body}`
}

/**
 * @param {(name: string, args: Record<string, unknown>) => Promise<unknown>} callTool
 * @param {string} query
 * @param {Record<string, unknown>} [extra]
 */
export async function recallIntoContext(callTool, query, extra = {}) {
  if (typeof query !== 'string' || query.trim() === '') {
    throw new Error('recallIntoContext: query is required')
  }
  const text = await callTool('memory_search', { query, ...extra })
  return formatMemoriesAsContext(text, query)
}

/**
 * @param {(name: string, args: Record<string, unknown>) => Promise<unknown>} callTool
 * @param {string} intent
 * @param {Record<string, unknown>} [args]
 */
export async function invokeIntent(callTool, intent, args = {}) {
  const tool = resolveIntent(intent)
  if (!tool) {
    return { tool: null, text: SUMMARIZE_NOTE }
  }
  const text = await callTool(tool, args)
  return { tool, text }
}
