/**
 * Web data-plane tools — `rivetos.internet_search`, `rivetos.web_fetch`.
 *
 * Wraps the in-process tools from `@rivetos/tool-web-search` so external MCP
 * clients can search the web and fetch URLs through the same surface a local
 * agent uses. These tools are stateless beyond an in-memory cache; no shutdown
 * cleanup is required.
 *
 * Both tools are always enabled — `internet_search` falls back to DuckDuckGo
 * when no Google CSE credentials are configured, and `web_fetch` needs no
 * configuration at all.
 */

import { WebSearchTool, WebFetchTool } from '@rivetos/tool-web-search'
import { z } from 'zod'

import type { ToolRegistration } from '../server.js'
import { adaptRivetTool } from './adapt.js'

export interface WebToolsOptions {
  /** Google Custom Search API key — falls back to `GOOGLE_CSE_API_KEY` / `GOOGLE_API_KEY`. */
  googleApiKey?: string
  /** Google Custom Search Engine ID — falls back to `GOOGLE_CSE_ID`. */
  googleCseId?: string
  /** Max results per search (default: 5). */
  maxResults?: number
  /** Custom user agent for `web_fetch` — falls back to `RIVETOS_USER_AGENT`. */
  userAgent?: string
  /** Default truncation cap for `web_fetch` (default: 5000). */
  defaultMaxChars?: number
  /** Override the wire-name prefix. Default `rivetos.`. */
  prefix?: string
}

export interface WebToolsHandle {
  /** All MCP tool registrations — pass into `createMcpServer({ tools: [...] })`. */
  tools: ToolRegistration[]
  /** No-op for web tools, included for symmetry with memory tools. */
  close: () => Promise<void>
}

/**
 * Build the full web tool surface — `internet_search`, `web_fetch` —
 * wrapping the in-process implementations from `@rivetos/tool-web-search`.
 */
export function createWebTools(options: WebToolsOptions = {}): WebToolsHandle {
  const prefix = options.prefix ?? 'rivetos.'

  const search = new WebSearchTool({
    googleApiKey: options.googleApiKey,
    googleCseId: options.googleCseId,
    maxResults: options.maxResults,
  })
  const fetchTool = new WebFetchTool({
    userAgent: options.userAgent,
    defaultMaxChars: options.defaultMaxChars,
  })

  const tools: ToolRegistration[] = [
    adaptRivetTool(search, internetSearchInputSchema, {
      name: `${prefix}internet_search`,
      description:
        'Search the web. Tries Google Custom Search when configured, falls back to ' +
        'DuckDuckGo. Returns titles, snippets, and URLs. Use when you need current ' +
        'information, facts, or to find resources. Mirrors the in-process ' +
        '`internet_search` tool exposed to local agents.',
    }),
    adaptRivetTool(fetchTool, webFetchInputSchema, {
      name: `${prefix}web_fetch`,
      description:
        'Fetch and extract readable content from a URL. Returns the text/markdown ' +
        'content of a web page (HTML is converted to markdown). Use when you need to ' +
        'read a specific webpage. PDFs are detected but not extracted.',
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
// Input schemas — hand-mapped from plugins/tools/web-search/src/index.ts
// ---------------------------------------------------------------------------

export const internetSearchInputSchema = {
  query: z.string().describe('Search query'),
  count: z
    .number()
    .int()
    .min(1)
    .max(10)
    .optional()
    .describe('Number of results (default: 5, max: 10)'),
} satisfies z.ZodRawShape

export const webFetchInputSchema = {
  url: z.string().describe('URL to fetch'),
  max_chars: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe('Max characters to return (default: 5000)'),
} satisfies z.ZodRawShape
