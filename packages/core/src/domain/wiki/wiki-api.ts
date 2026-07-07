/**
 * /api/wiki — gateway route family (phase 3e).
 *
 * Read-only. The PG index (WikiIndex, memory plugin) serves list/search/
 * gaps; full page content is read from the NFS-synced git repo and parsed
 * with wiki-core — every node has both. Boot injects the index behind the
 * structural WikiIndexLike so core carries no plugin dependency.
 *
 *   GET /api/wiki                 index (?q= search | ?tag= | ?entity=)
 *   GET /api/wiki/gaps            red links + stalest pages (Phil's ask)
 *   GET /api/wiki/:slug           WikiPageResponse (file + index merged)
 *   GET /api/wiki/:slug/raw       text/markdown, verbatim file
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ServerResponse } from 'node:http'
import { parseWikiPage } from '@rivetos/wiki-core'
import type { GatewayRoute, WikiIndexResponse, WikiPageResponse } from '@rivetos/types'
import { logger } from '../../logger.js'

const log = logger('WikiApi')

/** Structural mirror of the memory plugin's WikiIndex (boot injects it). */
export interface WikiIndexLike {
  getTopic(slug: string): Promise<
    | {
        slug: string
        title: string
        aliases: string[]
        tags: string[]
        entities: string[]
        currentState: string
        gitSha: string | null
        lastVerifiedAt?: string
        updatedAt: string
      }
    | undefined
  >
  listTopics(opts?: {
    tag?: string
    entity?: string
    limit?: number
    offset?: number
  }): Promise<{ topics: WikiTopicSummary[]; total: number }>
  searchTopics(query: string, opts?: { limit?: number }): Promise<WikiTopicSummary[]>
  gaps(opts?: { staleLimit?: number }): Promise<{
    redLinks: Array<{ entity: string; referencedBy: string[] }>
    stalest: WikiTopicSummary[]
  }>
}

interface WikiTopicSummary {
  slug: string
  title: string
  tags: string[]
  entities: string[]
  currentState: string
  updatedAt: string
  lastVerifiedAt?: string
}

export interface WikiApiOptions {
  index: WikiIndexLike
  /** Root of the wiki git repo (default /rivet-shared/wiki). */
  wikiDir?: string
}

const SLUG_RE = /^[a-z0-9-]{1,80}$/

function json(res: ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

export function createWikiApiRoute(opts: WikiApiOptions): GatewayRoute {
  const wikiDir = opts.wikiDir ?? '/rivet-shared/wiki'

  return {
    prefix: '/api/wiki',
    handler: async (req, res) => {
      try {
        if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' })
        const url = new URL(req.url ?? '/', 'http://localhost')
        const rest = url.pathname.slice('/api/wiki'.length).replace(/^\//, '')
        const [slug, sub] = rest === '' ? [undefined, undefined] : rest.split('/')

        // GET /api/wiki — index or search
        if (!slug) {
          const q = url.searchParams.get('q')
          if (q) {
            const hits = await opts.index.searchTopics(q, { limit: intParam(url, 'limit', 10) })
            return json(res, 200, {
              topics: hits.map(toIndexEntry),
              total: hits.length,
            } satisfies WikiIndexResponse)
          }
          const { topics, total } = await opts.index.listTopics({
            tag: url.searchParams.get('tag') ?? undefined,
            entity: url.searchParams.get('entity') ?? undefined,
            limit: intParam(url, 'limit', 100),
            offset: intParam(url, 'offset', 0),
          })
          return json(res, 200, {
            topics: topics.map(toIndexEntry),
            total,
          } satisfies WikiIndexResponse)
        }

        // GET /api/wiki/gaps
        if (slug === 'gaps' && !sub) {
          const gaps = await opts.index.gaps({ staleLimit: intParam(url, 'limit', 10) })
          return json(res, 200, {
            redLinks: gaps.redLinks,
            stalest: gaps.stalest.map(toIndexEntry),
          })
        }

        if (!SLUG_RE.test(slug)) return json(res, 400, { error: 'invalid slug' })

        const markdown = await readFile(join(wikiDir, 'topics', `${slug}.md`), 'utf8').catch(
          () => undefined,
        )
        if (markdown === undefined) return json(res, 404, { error: `no topic ${slug}` })

        // GET /api/wiki/:slug/raw
        if (sub === 'raw') {
          res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8' })
          res.end(markdown)
          return
        }
        if (sub !== undefined) return json(res, 404, { error: 'unknown sub-resource' })

        // GET /api/wiki/:slug — parsed page + index metadata
        const page = parseWikiPage(markdown)
        const row = await opts.index.getTopic(slug).catch(() => undefined)
        const related = await opts.index
          .searchTopics(page.meta.title, { limit: 4 })
          .then((hits) => hits.map((h) => h.slug).filter((s) => s !== slug))
          .catch(() => [])
        return json(res, 200, {
          slug: page.meta.slug,
          title: page.meta.title,
          aliases: page.meta.aliases,
          tags: page.meta.tags,
          entities: page.meta.entities,
          currentState: page.currentState,
          history: page.history,
          markdown,
          sources: page.meta.sources.map((s) => ({
            kind: s.kind,
            ids: s.ids,
            conversationId: s.conversationId,
            span: s.span,
          })),
          gitSha: row?.gitSha ?? null,
          lastVerified: page.meta.lastVerified,
          updatedAt: row?.updatedAt ?? page.meta.lastVerified ?? '',
          related,
        } satisfies WikiPageResponse)
      } catch (err: unknown) {
        log.error(`/api/wiki failed: ${err instanceof Error ? err.message : String(err)}`)
        json(res, 500, { error: 'internal error' })
      }
    },
  }
}

function intParam(url: URL, name: string, fallback: number): number {
  const raw = url.searchParams.get(name)
  const n = raw ? Number.parseInt(raw, 10) : NaN
  return Number.isFinite(n) && n >= 0 ? n : fallback
}

function toIndexEntry(t: WikiTopicSummary): {
  slug: string
  title: string
  tags: string[]
  entities: string[]
  updatedAt: string
  excerpt: string
} {
  return {
    slug: t.slug,
    title: t.title,
    tags: t.tags,
    entities: t.entities,
    updatedAt: t.updatedAt,
    excerpt: t.currentState.slice(0, 200),
  }
}
