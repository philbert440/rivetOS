/**
 * Memory tools — barrel re-exports.
 *
 * Maintains the same public API as the original tools.ts:
 * - createMemoryTools (factory)
 * - MemoryToolsConfig (type)
 */

import type { Tool } from '@rivetos/types'
import type { SearchEngine } from '../search.js'
import type { Expander } from '../expand.js'
import type { MemoryToolsConfig } from './helpers.js'
import { createSearchTool } from './search-tool.js'
import { createBrowseTool } from './browse-tool.js'
import { createStatsTool } from './stats-tool.js'

export type { MemoryToolsConfig } from './helpers.js'

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
