/**
 * Memory data-plane tools — `memory_search`, `memory_browse`,
 * `memory_stats`, `memory_get_full`, plus Grok Bot write tools.
 *
 * Wraps the in-process tools exported by `@rivetos/memory-postgres` so external
 * MCP clients (claude-cli, MCP Inspector, Grok Build, etc.) can hit the same
 * surface a local agent has. All four tools share a single `PostgresMemory`
 * instance (and its pg pool) for the server's lifetime; callers must invoke
 * the returned `close()` during shutdown to drain the pool.
 *
 * `memory_get_full` is required for parity: search/browse append
 * `→ memory_get_full id=<uuid>` on capture-truncated rows. Without this
 * registration, MCP clients follow a dead handle and re-search instead of
 * recovering the full payload (daily friction for long tool outputs).
 */

import { PostgresMemory, createMemoryTools as createPgMemoryTools } from '@rivetos/memory-postgres'
import type { Tool } from '@rivetos/types'
import { z } from 'zod'

import type { ToolRegistration } from '@rivetos/mcp'
import { adaptRivetTool } from '@rivetos/mcp'
import { createMemoryWriteTools } from './memory-write.js'

export interface MemoryToolsOptions {
  /** Postgres connection string (e.g. value of `RIVETOS_PG_URL`). Required. */
  pgUrl: string
  /** Optional embedding service URL — enables hybrid (FTS + semantic) ranking. */
  embedEndpoint?: string
  /** Embedding model name. Default `nemotron`. */
  embedModel?: string
  /** Override the wire-name prefix. Default `` (no prefix). claude-cli prefixes MCP tools as `mcp__<server>__<name>` so we keep the wire name clean. */
  prefix?: string
  /** When true, also register memory_append / memory_ingest_session. */
  enableWrite?: boolean
}

export interface MemoryToolsHandle {
  /** All MCP tool registrations — pass into `createMcpServer({ tools: [...] })`. */
  tools: ToolRegistration[]
  /** Drain the underlying Postgres pool. Must be called on shutdown. */
  close: () => Promise<void>
}

/**
 * Build the full memory tool surface — `memory_search`, `memory_browse`,
 * `memory_stats`, `memory_get_full` — bootstrapping a `PostgresMemory` adapter
 * and adapting each tool to the MCP wire shape. One pool, four tools, single
 * shutdown path.
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
        'Mirrors the in-process `memory_search` tool exposed to local agents. ' +
        'Truncated hits include a `memory_get_full id=` handle — call that tool to ' +
        'recover the full capture payload.',
      annotations: { readOnlyHint: true, idempotentHint: true },
    }),
    adaptRivetTool(find('memory_browse'), memoryBrowseInputSchema, {
      name: `${prefix}memory_browse`,
      description:
        'Browse RivetOS conversation messages chronologically. Unlike memory_search ' +
        '(which ranks by relevance), this returns messages in time order. By default ' +
        'excludes role=tool rows (pass include_tools=true to see tool calls/results). Use to ' +
        'review what happened in a session, catch up on recent activity, or read a ' +
        'specific conversation by ID. For time-bounded questions ("today", "yesterday", ' +
        '"this morning"), prefer window= over raw since/before so local midnights convert correctly to UTC. ' +
        'Capture-truncated rows append `→ memory_get_full id=` — use that tool for the full payload.',
      annotations: { readOnlyHint: true, idempotentHint: true },
    }),
    adaptRivetTool(find('memory_stats'), memoryStatsInputSchema, {
      name: `${prefix}memory_stats`,
      description:
        'RivetOS memory system health check — message/summary counts, embedding queue ' +
        'depth, unsummarized messages, compaction status, missing summaries, and ' +
        'breakdowns by agent/role/kind. Use to diagnose memory issues or check if ' +
        'background jobs are keeping up.',
      annotations: { readOnlyHint: true, idempotentHint: true },
    }),
    adaptRivetTool(find('memory_get_full'), memoryGetFullInputSchema, {
      name: `${prefix}memory_get_full`,
      description:
        'Fetch the complete, untruncated payload for a memory row whose content or ' +
        'tool_result was elided at capture time (rows marked "…[truncated]" / ' +
        '"⚠ truncated at capture" by memory_search or memory_browse). Pass the row ' +
        'id from that hint. Re-reads the original capture JSONL line from disk — not ' +
        'a generic file reader. Mirrors the in-process `memory_get_full` tool.',
      annotations: { readOnlyHint: true, idempotentHint: true },
    }),
    ...(options.enableWrite ? createMemoryWriteTools(memory, prefix) : []),
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
    .enum(['hybrid', 'fts', 'trigram', 'regex', 'vector'])
    .optional()
    .describe(
      'Search mode (default hybrid). hybrid: fuses full-text + trigram + vector with RRF — best general recall, robust to dotted/literal terms (domains, IPs, model ids). fts: full-text only. trigram: fuzzy/literal-token match. regex: pattern match. vector: pure semantic (ANN over HNSW).',
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
    .describe(
      'Only return results after this date (ISO UTC timestamp). Prefer window= for local-day bounds.',
    ),
  before: z
    .string()
    .optional()
    .describe(
      'Only return results before this date (ISO UTC timestamp). Prefer window= for local-day bounds.',
    ),
  window: z
    .enum(['today', 'yesterday', 'this_morning', 'this_week', 'last_24h', 'last_7d', 'last_14d'])
    .optional()
    .describe(
      'Shortcut for time-bounded filters — resolves in the SERVER local timezone. last_7d/last_14d are rolling (prefer over this_week early in the week). Used only when neither since nor before is provided.',
    ),
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
    .describe(
      'Show messages after this time (ISO UTC timestamp). Bare dates are UTC midnight (= previous evening US local). Prefer window=.',
    ),
  before: z
    .string()
    .optional()
    .describe(
      'Show messages before this time (ISO UTC timestamp). Same UTC gotcha as since. Prefer window=.',
    ),
  window: z
    .enum(['today', 'yesterday', 'this_morning', 'this_week', 'last_24h', 'last_7d', 'last_14d'])
    .optional()
    .describe(
      'Shortcut for time-bounded windows — resolves to (since, before) in the SERVER local timezone, no TZ math required. last_7d/last_14d are rolling (prefer over this_week early in the week). Used only when neither since nor before is provided.',
    ),
  agent: z.string().optional().describe('Filter by agent (opus, grok, etc.)'),
  include_tools: z
    .boolean()
    .optional()
    .describe(
      'Include role=tool rows (tool calls/results). Default false — browse returns user/assistant/system only so a limit=50 window is not flooded by tool noise. Set true when debugging capture, harness wiring, or tool failures.',
    ),
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

export const memoryGetFullInputSchema = {
  id: z
    .string()
    .min(1)
    .describe('Row id, as shown by memory_search / memory_browse truncation hints'),
} satisfies z.ZodRawShape
