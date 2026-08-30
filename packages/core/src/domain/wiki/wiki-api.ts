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
import {
  ALIASES_MAX,
  CITATIONS_MAX,
  ENTITIES_MAX,
  HISTORY_MAX,
  parseWikiPage,
  RELATED_MAX,
  SOURCES_MAX,
  TAGS_MAX,
} from '@rivetos/wiki-core'
import {
  routedUserResult,
  sharedPath,
  type GatewayRoute,
  type WikiGapsResponse,
  type WikiIndexResponse,
  type WikiPageResponse,
} from '@rivetos/types'
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
  /** Per-user wiki for a den-stamped `x-rivetos-user` (#571's memory-api
   *  trust model, applied to the wiki — the last unrouted read surface).
   *  Returns the routed user's index + file root, or null when the user is
   *  unknown or tombstoned; the route then refuses rather than ever serving
   *  the owner's wiki. Absent header = owner (den stamps only resolved
   *  non-owners); a PRESENT-but-malformed value is refused. */
  forUser?: (userId: string) => { index: WikiIndexLike; wikiDir: string } | null
}

const SLUG_RE = /^[a-z0-9-]{1,80}$/

function json(res: ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

/** A userId that may participate in a file-root path join. Anything with a
 *  separator or dot-dot is refused before forUser is even consulted — den +
 *  USER_DBS are the real gate, but the path seam must not depend on them
 *  (defense in depth; #579 review finding 4). */
const SAFE_USER_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/

/** Resolve which wiki surface (index + file root) a request may see — the
 *  ONE resolver for both /api/wiki and /wiki so the #571 trichotomy cannot
 *  drift between them: absent den-stamped header = owner; stamped user =
 *  their forUser entry; malformed header, unsafe id, unknown or tombstoned
 *  user = refusal, NEVER the owner's wiki. Refusals are JSON on both
 *  surfaces. */
export function resolveWikiSurface(
  opts: Pick<WikiApiOptions, 'index' | 'forUser'>,
  ownerDir: string,
  headers: Record<string, string | string[] | undefined>,
): { ok: true; index: WikiIndexLike; wikiDir: string } | { ok: false; error: string } {
  const routed = routedUserResult(headers)
  if (routed.kind === 'invalid') return { ok: false, error: 'malformed routing identity' }
  if (routed.kind === 'owner') return { ok: true, index: opts.index, wikiDir: ownerDir }
  if (!SAFE_USER_ID_RE.test(routed.id) || routed.id.includes('..')) {
    return { ok: false, error: 'invalid routing identity' }
  }
  const user = opts.forUser?.(routed.id) ?? null
  if (!user) return { ok: false, error: `wiki is not available for user "${routed.id}"` }
  return { ok: true, index: user.index, wikiDir: user.wikiDir }
}

export function createWikiApiRoute(opts: WikiApiOptions): GatewayRoute {
  const ownerDir = opts.wikiDir ?? sharedPath('wiki')

  return {
    prefix: '/api/wiki',
    handler: async (req, res) => {
      try {
        if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' })
        const surface = resolveWikiSurface(opts, ownerDir, req.headers)
        if (!surface.ok) return json(res, 503, { error: surface.error })
        const { index, wikiDir } = surface
        const url = new URL(req.url ?? '/', 'http://localhost')
        const rest = url.pathname.slice('/api/wiki'.length).replace(/^\//, '')
        const [slug, sub] = rest === '' ? [undefined, undefined] : rest.split('/')

        // GET /api/wiki — index or search
        if (!slug) {
          const q = url.searchParams.get('q')
          if (q) {
            const hits = await index.searchTopics(q, { limit: intParam(url, 'limit', 10) })
            return json(res, 200, {
              topics: hits.map(toIndexEntry),
              total: hits.length,
            } satisfies WikiIndexResponse)
          }
          const { topics, total } = await index.listTopics({
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

        // GET /api/wiki/_gaps — underscore keeps it outside SLUG_RE, so no
        // topic slug can ever shadow it (#289 review).
        if (slug === '_gaps' && !sub) {
          const gaps = await index.gaps({ staleLimit: intParam(url, 'limit', 10) })
          return json(res, 200, {
            redLinks: gaps.redLinks,
            stalest: gaps.stalest.map(toIndexEntry),
          } satisfies WikiGapsResponse)
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
        const row = await index.getTopic(slug).catch(() => undefined)
        // Related: explicit seeAlso/related first, then title search fill.
        const explicit = [
          ...new Set([...(page.seeAlso ?? []), ...(page.meta.related ?? [])]),
        ].filter((s) => s && s !== slug)
        const searched = await index
          .searchTopics(page.meta.title, { limit: 6 })
          .then((hits) => hits.map((h) => h.slug).filter((s) => s !== slug))
          .catch(() => [] as string[])
        const related = [...new Set([...explicit, ...searched])].slice(0, 12)
        return json(res, 200, {
          slug: page.meta.slug,
          title: page.meta.title,
          aliases: page.meta.aliases.slice(0, ALIASES_MAX),
          tags: page.meta.tags.slice(0, TAGS_MAX),
          entities: page.meta.entities.slice(0, ENTITIES_MAX),
          currentState: page.currentState,
          article: page.article ?? '',
          seeAlso: (page.seeAlso ?? []).slice(0, RELATED_MAX),
          history: page.history.slice(0, HISTORY_MAX),
          citations: page.citations.slice(0, CITATIONS_MAX).map((c) => ({
            summaryId: c.summaryId,
            date: c.date,
            kind: c.kind,
            note: c.note,
          })),
          markdown,
          sources: page.meta.sources.slice(-SOURCES_MAX).map((s) => ({
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
  // Cap: a ?limit=1e9 must not turn a read-only endpoint into a memory hog.
  return Number.isFinite(n) && n >= 0 ? Math.min(n, 500) : fallback
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
