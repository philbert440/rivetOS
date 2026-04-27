/**
 * Search utility tools — `search_glob`, `search_grep`.
 *
 * Wraps the in-process tools from `@rivetos/tool-search` so external MCP
 * clients can find files (glob) and search file contents (grep) through the
 * same surface a local agent uses. Path resolution mirrors the in-process
 * behavior — absolute paths are used verbatim; relative paths resolve
 * against the MCP server's cwd.
 *
 * Read-only surface — safe to enable alongside `memory_*` and `web_*` tools.
 *
 * Disabled by default — pass `enabled: true` (or set
 * `RIVETOS_MCP_ENABLE_SEARCH=1` in the CLI) to opt in.
 */

import {
  createSearchGlobTool,
  createSearchGrepTool,
  type SearchGlobConfig,
  type SearchGrepConfig,
} from '@rivetos/tool-search'
import { z } from 'zod'

import type { ToolRegistration } from '../server.js'
import { adaptRivetTool } from './adapt.js'

export interface SearchToolsOptions extends SearchGlobConfig, SearchGrepConfig {
  /** Override the wire-name prefix. Default `` (no prefix). claude-cli prefixes MCP tools as `mcp__<server>__<name>` so we keep the wire name clean. */
  prefix?: string
}

export interface SearchToolsHandle {
  /** All MCP tool registrations — pass into `createMcpServer({ tools: [...] })`. */
  tools: ToolRegistration[]
  /** No-op for search tools, included for symmetry with other factories. */
  close: () => Promise<void>
}

/**
 * Build the full search tool surface — `search_glob`, `search_grep` —
 * wrapping the in-process implementations from `@rivetos/tool-search`.
 */
export function createSearchTools(options: SearchToolsOptions = {}): SearchToolsHandle {
  const { prefix = '', ...searchConfig } = options

  const tools: ToolRegistration[] = [
    adaptRivetTool(createSearchGlobTool(searchConfig), searchGlobInputSchema, {
      name: `${prefix}search_glob`,
      description:
        'Find files matching a glob pattern. Searches from the MCP server cwd ' +
        'unless `cwd` is provided. Excludes node_modules, .git, dist, build, ' +
        '.next, coverage by default. Mirrors the in-process `search_glob` tool.',
    }),
    adaptRivetTool(createSearchGrepTool(searchConfig), searchGrepInputSchema, {
      name: `${prefix}search_grep`,
      description:
        'Search file contents by regex or literal string. Returns matching ' +
        'lines with `file:line:match` format. Shells out to grep -rn. ' +
        'Mirrors the in-process `search_grep` tool.',
    }),
  ]

  return {
    tools,
    async close() {
      /* nothing to drain */
    },
  }
}

// ---------------------------------------------------------------------------
// Input schemas — hand-mapped from plugins/tools/search/src/tools/*.ts
// ---------------------------------------------------------------------------

export const searchGlobInputSchema = {
  pattern: z.string().describe('Glob pattern (e.g. "**/*.ts", "src/**/*.test.ts")'),
  cwd: z
    .string()
    .optional()
    .describe('Directory to search from (optional, defaults to MCP server cwd)'),
} satisfies z.ZodRawShape

export const searchGrepInputSchema = {
  pattern: z.string().describe('Search pattern (regex supported by default)'),
  path: z.string().optional().describe('Directory or file to search (defaults to MCP server cwd)'),
  include: z.string().optional().describe('File pattern to include (e.g. "*.ts")'),
  fixed_strings: z
    .boolean()
    .optional()
    .describe('Treat pattern as literal string, not regex (default: false)'),
  case_insensitive: z.boolean().optional().describe('Case-insensitive search (default: false)'),
} satisfies z.ZodRawShape
