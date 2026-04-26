/**
 * `rivetos.memory_search` — first real data-plane tool on the MCP server.
 *
 * Wraps the existing in-process `memory_search` tool from
 * `@rivetos/memory-postgres` so that external MCP clients (claude-cli,
 * MCP Inspector, etc.) can search RivetOS's persistent memory the same
 * way an in-process agent does.
 *
 * The factory owns a `PostgresMemory` instance for the server's lifetime;
 * callers must invoke the returned `close()` during shutdown to drain the
 * pg pool.
 */

import { PostgresMemory, createMemoryTools } from '@rivetos/memory-postgres'
import type { Tool } from '@rivetos/types'
import { z } from 'zod'

import type { ToolRegistration } from '../server.js'
import { adaptRivetTool } from './adapt.js'

export interface MemorySearchToolOptions {
  /** Postgres connection string (e.g. value of `RIVETOS_PG_URL`). Required. */
  pgUrl: string
  /** Optional embedding service URL — enables hybrid (FTS + semantic) ranking. */
  embedEndpoint?: string
  /** Embedding model name. Default `nemotron`. */
  embedModel?: string
  /** Override the wire name. Default `rivetos.memory_search`. */
  name?: string
}

export interface MemorySearchToolHandle {
  /** The MCP tool registration — pass this into `createMcpServer({ tools: [...] })`. */
  tool: ToolRegistration
  /** Drain the underlying Postgres pool. Must be called on shutdown. */
  close: () => Promise<void>
}

/**
 * Build the `rivetos.memory_search` tool — bootstraps a `PostgresMemory`
 * adapter, plucks the `memory_search` tool from `createMemoryTools`, and
 * adapts it to the MCP wire shape.
 */
export function createMemorySearchTool(options: MemorySearchToolOptions): MemorySearchToolHandle {
  if (!options.pgUrl) {
    throw new Error('createMemorySearchTool: pgUrl is required')
  }

  const memory = new PostgresMemory({
    connectionString: options.pgUrl,
    embedEndpoint: options.embedEndpoint,
    embedModel: options.embedModel,
  })

  const searchEngine = memory.getSearchEngine()
  const expander = memory.getExpander()
  const pool = memory.getPool()

  const tools = createMemoryTools(searchEngine, expander, { pool })
  const searchTool = tools.find((t: Tool) => t.name === 'memory_search')
  if (!searchTool) {
    throw new Error(
      'createMemorySearchTool: memory_search tool not found in @rivetos/memory-postgres',
    )
  }

  const adapted = adaptRivetTool(searchTool, memorySearchInputSchema, {
    name: options.name ?? 'rivetos.memory_search',
    description:
      'Search RivetOS persistent memory (conversation history + summaries). ' +
      'Hybrid FTS + semantic + temporal scoring with auto-expansion of summary hits ' +
      'to their source messages. Use this to find past decisions, prior context, ' +
      'or "what did we say about X" before asking the user. ' +
      'Mirrors the in-process `memory_search` tool exposed to local agents.',
  })

  return {
    tool: adapted,
    async close() {
      await pool.end().catch(() => {
        /* swallow — best-effort */
      })
    },
  }
}

// ---------------------------------------------------------------------------
// Input schema — hand-mapped from plugins/memory/postgres/src/tools/search-tool.ts
// ---------------------------------------------------------------------------

export const memorySearchInputSchema = {
  query: z.string().describe('Search query — natural language question or keywords'),
  mode: z
    .enum(['fts', 'trigram', 'regex'])
    .optional()
    .describe(
      'Search mode: fts (full-text, default), trigram (fuzzy/typo-tolerant), regex (pattern match)',
    ),
  scope: z
    .enum(['messages', 'summaries', 'both'])
    .optional()
    .describe('Where to search (default: both)'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(50)
    .optional()
    .describe('Max top-level results (1–50, default: 10)'),
  agent: z.string().optional().describe('Filter by agent (opus, grok, etc.)'),
  since: z
    .string()
    .optional()
    .describe('Only return results after this date (ISO timestamp, e.g. 2025-01-15)'),
  before: z
    .string()
    .optional()
    .describe('Only return results before this date (ISO timestamp, e.g. 2025-06-01)'),
  expand: z
    .boolean()
    .optional()
    .describe('Auto-expand top summary hits to show source messages (default: true)'),
  synthesize: z
    .boolean()
    .optional()
    .describe(
      'Use LLM to synthesize a focused answer from results (default: false). Requires a configured compactor endpoint.',
    ),
} satisfies z.ZodRawShape
