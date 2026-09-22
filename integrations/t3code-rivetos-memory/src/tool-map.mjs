/**
 * Map informal "recall / store / summarize" names onto the tools the
 * RivetOS MCP sidecar actually registers. Do not invent wire names.
 *
 * Source of truth: services/mcp-sidecar/src/memory.ts and memory-write.ts.
 */

/** Informal intent → real MCP tool name. `null` means no such tool. */
export const INTENT_TO_MCP = Object.freeze({
  recall: 'memory_search',
  recall_chronological: 'memory_browse',
  recall_full: 'memory_get_full',
  stats: 'memory_stats',
  store: 'memory_append',
  ingest: 'memory_ingest_session',
  summarize: null,
})

export const RECALL_TOOLS = Object.freeze([
  'memory_search',
  'memory_browse',
  'memory_get_full',
  'memory_stats',
])

export const WRITE_TOOLS = Object.freeze(['memory_append', 'memory_ingest_session'])

export const SUMMARIZE_NOTE =
  'RivetOS MCP has no summarize tool. The compaction worker writes summaries; ' +
  'read them with memory_search (scope=summaries) or check health with memory_stats.'

/**
 * @param {string} intent
 * @returns {string | null}
 */
export function resolveIntent(intent) {
  if (!Object.prototype.hasOwnProperty.call(INTENT_TO_MCP, intent)) {
    throw new Error(`unknown memory intent: ${intent}`)
  }
  return INTENT_TO_MCP[intent]
}
