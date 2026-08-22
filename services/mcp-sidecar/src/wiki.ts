/**
 * Wiki tools (phase 3g) — `wiki_search`, `wiki_read`.
 *
 * The curated layer beside memory_search's raw layer: search topic pages
 * (PG index) and read one page (NFS repo file). Oversized hub topics are
 * bounded so MCP truncation cannot hide Summary behind YAML aliases.
 * Read-only — pages are written only by the datahub extractor; humans
 * edit files directly.
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import pg from 'pg'
import { WikiIndex } from '@rivetos/memory-postgres'
import { z } from 'zod'

import type { ToolRegistration } from '@rivetos/mcp'
import {
  formatWikiRead,
  WIKI_READ_SECTIONS,
  WIKI_READ_VERBATIM_MAX_CHARS,
  type WikiReadSection,
} from './wiki-read-format.js'

const READ_ONLY = { readOnlyHint: true, idempotentHint: true } as const

export interface WikiToolsOptions {
  pgUrl: string
  embedEndpoint?: string
  embedModel?: string
  /** Wiki repo root (default /rivet-shared/wiki). */
  wikiDir?: string
  prefix?: string
}

export interface WikiToolsHandle {
  tools: ToolRegistration[]
  close: () => Promise<void>
}

const SLUG_RE = /^[a-z0-9-]{1,80}$/

export function createWikiTools(options: WikiToolsOptions): WikiToolsHandle {
  if (!options.pgUrl) throw new Error('createWikiTools: pgUrl is required')
  const prefix = options.prefix ?? ''
  const wikiDir = options.wikiDir ?? '/rivet-shared/wiki'
  const pool = new pg.Pool({ connectionString: options.pgUrl, max: 3 })
  const index = new WikiIndex(pool, {
    embedEndpoint: options.embedEndpoint,
    embedModel: options.embedModel,
  })

  const tools: ToolRegistration[] = [
    {
      name: `${prefix}wiki_search`,
      description:
        'Search the RivetOS memory wiki — curated topic pages distilled from ' +
        'conversation memory ("what is currently true about X"). Higher signal ' +
        'than memory_search for standing facts about projects, hosts, and ' +
        'services; use memory_search when you need what was actually said. ' +
        'Returns slugs — read the page (dated history + provenance) with wiki_read.',
      annotations: READ_ONLY,
      inputSchema: {
        query: z.string().describe('Topic to look for (name, alias, or content terms)'),
        limit: z.number().int().min(1).max(20).optional().describe('Max results (default 5)'),
      },
      async execute(args: Record<string, unknown>): Promise<string> {
        const { query, limit } = args as { query: string; limit?: number }
        const hits = await index.searchTopics(query, { limit: limit ?? 5 })
        if (hits.length === 0) {
          return 'No wiki topics match — a gap worth filling, or try memory_search for raw history.'
        }
        return hits
          .map(
            (h) =>
              `## ${h.title} (${h.slug})${h.lastVerifiedAt ? ` — verified ${h.lastVerifiedAt.slice(0, 10)}` : ''}\n${h.currentState.slice(0, 600)}`,
          )
          .join('\n\n')
      },
    },
    {
      name: `${prefix}wiki_read`,
      description:
        'Read one RivetOS wiki topic page: Wikipedia-style Summary (lead), ' +
        'Article body, See also crosslinks, dated History, and Citations ' +
        '(summary UUIDs usable with memory tools for drill-down). Use the slug ' +
        'from wiki_search. Small pages are returned verbatim. Pages larger than ' +
        `${WIKI_READ_VERBATIM_MAX_CHARS.toLocaleString('en-US')} characters ` +
        '(hub topics with thousands of YAML aliases) return a bounded ' +
        'encyclopedia view so MCP/capture truncation cannot hide Summary ' +
        'behind the alias dump. Pass section=summary|article|history|aliases|' +
        'citations for a slice; section=full is refused on oversized pages.',
      annotations: READ_ONLY,
      inputSchema: {
        slug: z.string().describe('Topic slug, e.g. rivetos-task-engine'),
        section: z
          .enum(WIKI_READ_SECTIONS)
          .optional()
          .describe(
            'Slice of an oversized page. Default: verbatim when small, encyclopedia ' +
              'view (Summary + Article + recent history) when large. full is refused ' +
              'while the page exceeds 24,000 characters.',
          ),
      },
      async execute(args: Record<string, unknown>): Promise<string> {
        const { slug, section } = args as { slug: string; section?: WikiReadSection }
        if (!SLUG_RE.test(slug)) return `Invalid slug "${slug}" — lowercase kebab-case only.`
        const markdown = await readFile(join(wikiDir, 'topics', `${slug}.md`), 'utf8').catch(
          () => undefined,
        )
        if (markdown === undefined) {
          const { candidates } = await index.resolveTopic(slug).catch(() => ({ candidates: [] }))
          const hint =
            candidates.length > 0
              ? ` Did you mean: ${candidates.map((c) => c.slug).join(', ')}?`
              : ''
          return `No page for "${slug}" — a red link.${hint}`
        }
        // Small pages stay verbatim. Oversized / malformed pages are bounded
        // so a 3 MB alias dump cannot occupy the entire truncated MCP payload.
        return formatWikiRead(markdown, { slug, section })
      },
    },
  ]

  return {
    tools,
    async close() {
      await pool.end().catch(() => {
        /* draining twice is fine */
      })
    },
  }
}
