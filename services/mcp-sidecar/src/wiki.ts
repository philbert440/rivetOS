/**
 * Wiki tools (phase 3g) — `wiki_search`, `wiki_read`.
 *
 * The curated layer beside memory_search's raw layer: search topic pages
 * (PG index) and read one page in full (NFS repo file). Read-only — pages
 * are written only by the datahub extractor; humans edit files directly.
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import pg from 'pg'
import { WikiIndex } from '@rivetos/memory-postgres'
import { parseWikiPage } from '@rivetos/wiki-core'
import { z } from 'zod'

import type { ToolRegistration } from '@rivetos/mcp-v1'

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
        'Returns slugs — read a full page (dated history + provenance) with wiki_read.',
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
        'Read one RivetOS wiki topic page in full: current state, dated history ' +
        'of changes, and provenance ids (summary/message UUIDs usable with ' +
        'memory tools for drill-down). Use the slug from wiki_search.',
      inputSchema: {
        slug: z.string().describe('Topic slug, e.g. rivetos-task-engine'),
      },
      async execute(args: Record<string, unknown>): Promise<string> {
        const { slug } = args as { slug: string }
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
        // Serve the file verbatim — history + provenance included; parse only
        // to validate it's a real page.
        parseWikiPage(markdown)
        return markdown
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
