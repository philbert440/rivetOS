/**
 * Backwards-compatibility shim — the original `createMemorySearchTool` factory.
 *
 * Slice 3 (Phase 1.A.6) extends the memory surface to also include
 * `memory_browse` and `memory_stats`. New code should use `createMemoryTools`
 * from `./memory.js` directly. This shim wraps that factory and exposes only
 * the search tool, keeping any external imports of `createMemorySearchTool`
 * working until they migrate.
 */

import type { ToolRegistration } from '../server.js'
import { createMemoryTools, memorySearchInputSchema, type MemoryToolsOptions } from './memory.js'

export { memorySearchInputSchema }

export interface MemorySearchToolOptions {
  /** Postgres connection string (e.g. value of `RIVETOS_PG_URL`). Required. */
  pgUrl: string
  /** Optional embedding service URL — enables hybrid (FTS + semantic) ranking. */
  embedEndpoint?: string
  /** Embedding model name. Default `nemotron`. */
  embedModel?: string
  /** Override the wire name. Default `memory_search`. */
  name?: string
}

export interface MemorySearchToolHandle {
  tool: ToolRegistration
  close: () => Promise<void>
}

/** @deprecated use `createMemoryTools` from `./memory.js` for the full memory surface. */
export function createMemorySearchTool(options: MemorySearchToolOptions): MemorySearchToolHandle {
  const passthrough: MemoryToolsOptions = {
    pgUrl: options.pgUrl,
    embedEndpoint: options.embedEndpoint,
    embedModel: options.embedModel,
  }
  const handle = createMemoryTools(passthrough)
  const search = handle.tools.find((t) => t.name === 'memory_search')
  if (!search) {
    throw new Error('createMemorySearchTool: memory_search not found (internal)')
  }
  // Optional rename — preserves the old `name` override.
  const tool: ToolRegistration = options.name ? { ...search, name: options.name } : search
  return { tool, close: handle.close }
}
