/**
 * Memory data-plane tools — `memory_search`, `memory_browse`,
 * `memory_stats`.
 *
 * Wraps the in-process tools exported by `@rivetos/memory-postgres` so external
 * MCP clients (claude-cli, MCP Inspector, etc.) can hit the same surface a
 * local agent has. All three tools share a single `PostgresMemory` instance
 * (and its pg pool) for the server's lifetime; callers must invoke the
 * returned `close()` during shutdown to drain the pool.
 *
 * Replaces the original `memory-search.ts` (single-tool factory) — the export
 * is kept as a thin shim for backwards compatibility but new code should call
 * `createMemoryTools`.
 */

import { PostgresMemory, createMemoryTools as createPgMemoryTools } from '@rivetos/memory-postgres'
import type { Tool } from '@rivetos/types'
import { z } from 'zod'

import type { ToolRegistration } from '../server.js'
import { adaptRivetTool } from './adapt.js'

export interface MemoryToolsOptions {
  /** Postgres connection string (e.g. value of `RIVETOS_PG_URL`). Required. */
  pgUrl: string
  /** Optional embedding service URL — enables hybrid (FTS + semantic) ranking. */
  embedEndpoint?: string
  /** Embedding model name. Default `nemotron`. */
  embedModel?: string
  /** Override the wire-name prefix. Default `` (no prefix). claude-cli prefixes MCP tools as `mcp__<server>__<name>` so we keep the wire name clean. */
  prefix?: string
}

export interface MemoryToolsHandle {
  /** All MCP tool registrations — pass into `createMcpServer({ tools: [...] })`. */
  tools: ToolRegistration[]
  /** Drain the underlying Postgres pool. Must be called on shutdown. */
  close: () => Promise<void>
}

/**
 * Build the full memory tool surface — `memory_search`, `memory_browse`,
 * `memory_stats` — bootstrapping a `PostgresMemory` adapter and adapting each
 * tool to the MCP wire shape. One pool, three tools, single shutdown path.
 */
export function createMemoryTools(options: MemoryToolsOptions): MemoryToolsHandle {
  if (!options.pgUrl) {
    throw new Error('createMemoryTools: pgUrl is required')
  }

  const prefix = options.prefix ?? ''

  const memory = new PostgresMemory({
    connectionString: options.pgUrl,
    embedEndpoint: options.embedEndpoint,
    embedModel: options.embedModel,
  })

  const searchEngine = memory.getSearchEngine()
  const expander = memory.getExpander()
  const pool = memory.getPool()

  const rivetTools = createPgMemoryTools(searchEngine, expander, { pool })

  const find = (name: string): Tool => {
    const t = rivetTools.find((tool: Tool) => tool.name === name)
    if (!t) {
      throw new Error(`createMemoryTools: ${name} not found in @rivetos/memory-postgres`)
    }
    return t
  }

  const tools: ToolRegistration[] = [
    adaptRivetTool(find('memory_search'), memorySearchInputSchema, {
      name: `${prefix}memory_search`,
      description:
        'Search RivetOS persistent memory (conversation history + summaries). ' +
        'Hybrid FTS + semantic + temporal scoring with auto-expansion of summary hits ' +
        'to their source messages. Use this to find past decisions, prior context, ' +
        'or "what did we say about X" before asking the user. ' +
        'Mirrors the in-process `memory_search` tool exposed to local agents.',
    }),
    adaptRivetTool(find('memory_browse'), memoryBrowseInputSchema, {
      name: `${prefix}memory_browse`,
      description:
        'Browse RivetOS conversation messages chronologically. Unlike memory_search ' +
        '(which ranks by relevance), this returns messages in time order. Use to ' +
        'review what happened in a session, catch up on recent activity, or read a ' +
        'specific conversation by ID.',
    }),
    adaptRivetTool(find('memory_stats'), memoryStatsInputSchema, {
      name: `${prefix}memory_stats`,
      description:
        'RivetOS memory system health check — message/summary counts, embedding queue ' +
        'depth, unsummarized messages, compaction status, missing summaries, and ' +
        'breakdowns by agent/role/kind. Use to diagnose memory issues or check if ' +
        'background jobs are keeping up.',
    }),
  ]

  return {
    tools,
    async close() {
      await pool.end().catch(() => {
        /* swallow — best-effort */
      })
    },
  }
}

// ---------------------------------------------------------------------------
// Input schemas — hand-mapped from plugins/memory/postgres/src/tools/*.ts
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

export const memoryBrowseInputSchema = {
  conversation_id: z.string().optional().describe('Browse a specific conversation by ID'),
  since: z
    .string()
    .optional()
    .describe('Show messages after this time (ISO timestamp, e.g. 2025-03-15T10:00:00Z)'),
  before: z
    .string()
    .optional()
    .describe('Show messages before this time (ISO timestamp, e.g. 2025-03-16)'),
  agent: z.string().optional().describe('Filter by agent (opus, grok, etc.)'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(200)
    .optional()
    .describe('Max messages to return (1–200, default: 50)'),
  order: z
    .enum(['asc', 'desc'])
    .optional()
    .describe('Chronological order — asc (oldest first) or desc (newest first, default)'),
} satisfies z.ZodRawShape

export const memoryStatsInputSchema = {
  agent: z.string().optional().describe('Filter stats to a specific agent (optional)'),
} satisfies z.ZodRawShape
