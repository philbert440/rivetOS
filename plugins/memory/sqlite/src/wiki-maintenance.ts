/**
 * Wiki maintenance on SQLite: the two on-demand tasks the Postgres pipeline
 * has. `consolidate` merges pages whose slugs are variants of one stem into
 * one page (no model involved); `recompile` asks the model to rewrite a
 * page's summary and article from its own history. Same rules, prompts and
 * page operations as `services/compaction-worker/src/tasks/consolidate-wiki.ts`
 * and `recompile-wiki.ts`.
 */

import { existsSync } from 'node:fs'
import { unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import {
  WIKI_EXTRACT_MAX_TOKENS,
  WIKI_RECOMPILE_SYSTEM_PROMPT,
  formatRecompilePrompt,
  parseRecompileResult,
} from '@rivetos/memory-core'
import {
  clusterSlugsByStem,
  mergePages,
  serializeWikiPage,
  type WikiPage,
  type WikiWriter,
} from '@rivetos/wiki-core'
import type { LlmClient } from './llm.js'
import type { SqliteWikiIndex } from './wiki.js'

export const CONSOLIDATE_WIKI_TASK = 'consolidate-wiki'
export const RECOMPILE_WIKI_TASK = 'recompile-wiki'

/** The marker the Postgres task writes as the source of a recompile. */
const RECOMPILE_SOURCE_ID = '00000000-0000-0000-0000-000000000007'

/** What `normalizeSlug` produces, with room for the longer slugs older pages have. */
const SLUG = /^[a-z0-9][a-z0-9-]{0,199}$/

export interface ConsolidateOptions {
  dryRun?: boolean
  limitClusters?: number
  minClusterSize?: number
}

export interface RecompileOptions {
  slug?: string
  slugs?: string[]
  limit?: number
  dryRun?: boolean
}

function pickCanonical(slugs: string[], clusterKey: string): string {
  if (slugs.includes(clusterKey)) return clusterKey
  if (
    clusterKey.includes('-') &&
    slugs.every((s) => s === clusterKey || s.startsWith(`${clusterKey}-`))
  ) {
    return clusterKey
  }
  return [...slugs].sort((a, b) => a.length - b.length || a.localeCompare(b))[0]
}

/** Superseded and merged entries first, then the longest; bounded. */
function historyExcerpts(page: WikiPage): string {
  const ranked = [...page.history].sort((a, b) => {
    const aSuper = /superseded|merged from/i.test(a.title) ? 1 : 0
    const bSuper = /superseded|merged from/i.test(b.title) ? 1 : 0
    if (aSuper !== bSuper) return bSuper - aSuper
    return b.body.length - a.body.length
  })
  const parts: string[] = []
  let budget = 40_000
  for (const h of ranked.slice(0, 40)) {
    const chunk = `### ${h.date} — ${h.title}\n\n${h.body.trim()}\n`
    if (chunk.length > budget) {
      parts.push(chunk.slice(0, budget))
      break
    }
    parts.push(chunk)
    budget -= chunk.length
  }
  return parts.join('\n')
}

export class SqliteWikiMaintenance {
  constructor(
    private readonly db: DatabaseSync,
    private readonly index: SqliteWikiIndex,
    private readonly writer: WikiWriter,
    /** Needed by `recompile` only. */
    private readonly llm: LlmClient | undefined,
    private readonly log: (line: string) => void = () => {},
  ) {}

  /** Merge near-duplicate pages. Returns how many clusters and pages were folded. */
  async consolidate(
    opts: ConsolidateOptions = {},
  ): Promise<{ merged: number; pagesRemoved: number }> {
    const dryRun = opts.dryRun === true
    const limitClusters = opts.limitClusters ?? 50
    const minClusterSize = opts.minClusterSize ?? 2
    await this.writer.ensureRepo()
    const clusters = [...clusterSlugsByStem(this.index.listAllSlugs()).entries()]
      .filter(([, slugs]) => slugs.length >= minClusterSize)
      .sort((a, b) => b[1].length - a[1].length)

    let merged = 0
    let pagesRemoved = 0
    for (const [key, slugs] of clusters.slice(0, limitClusters)) {
      const canonicalSlug = pickCanonical(slugs, key)
      const losers = slugs.filter((s) => s !== canonicalSlug)
      if (losers.length === 0) continue
      this.log(
        `[memory.sqlite] wiki consolidate: ${key} → ${canonicalSlug} (+${String(losers.length)})${dryRun ? ' (dry run)' : ''}`,
      )
      if (dryRun) {
        merged += 1
        pagesRemoved += losers.length
        continue
      }

      const pages: WikiPage[] = []
      for (const s of slugs) {
        const p = await this.writer.readPage(s)
        if (p) pages.push(p)
      }
      if (!pages.some((p) => p.meta.slug === canonicalSlug)) {
        const orphan = await this.writer.readPage(canonicalSlug)
        if (orphan) pages.push(orphan)
      }
      if (pages.length === 0) continue

      const seed =
        pages.find((p) => p.meta.slug === canonicalSlug) ??
        [...pages].sort((a, b) => b.currentState.length - a.currentState.length)[0]
      const loserPages = pages.filter((p) => p.meta.slug !== seed.meta.slug)
      const mergedPage = mergePages(
        {
          ...seed,
          meta: {
            ...seed.meta,
            slug: canonicalSlug,
            title: seed.meta.title.replace(/\s*[—–-]\s*.+$/, '') || key,
          },
        },
        loserPages,
      )
      mergedPage.meta.slug = canonicalSlug
      if (!mergedPage.meta.title || mergedPage.meta.title === seed.meta.slug) {
        mergedPage.meta.title = key
          .split('-')
          .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
          .join(' ')
      }
      mergedPage.meta.aliases = [
        ...new Set([
          ...mergedPage.meta.aliases,
          ...losers,
          ...loserPages.flatMap((p) => p.meta.aliases),
        ]),
      ]

      const writer = this.writer
      await writer.withLock(async () => {
        await writeFile(writer.pagePath(canonicalSlug), serializeWikiPage(mergedPage))
        for (const loser of losers) {
          const path = writer.pagePath(loser)
          if (!existsSync(path)) continue
          await unlink(path)
          await writer
            .git('rm', '-f', '--cached', join('topics', `${loser}.md`))
            .catch(() => writer.git('add', '-u', 'topics').catch(() => undefined))
        }
        try {
          await writer.git('add', join('topics', `${canonicalSlug}.md`))
          await writer
            .git(
              'commit',
              '-m',
              `wiki(${canonicalSlug}): consolidate ${String(losers.length)} near-duplicate topics\n\nMerged: ${losers.join(', ')}\nPipeline: wiki-v6-consolidate`,
            )
            .catch(() => undefined)
        } catch (err) {
          this.log(
            `[memory.sqlite] wiki consolidate: git commit failed for ${canonicalSlug}: ${err instanceof Error ? err.message : String(err)}`,
          )
        }
      })

      this.index.upsertTopic(mergedPage)
      for (const loser of losers) {
        this.index.setRedirect(loser, canonicalSlug)
        this.index.deleteTopic(loser)
        pagesRemoved += 1
      }
      merged += 1
    }
    return { merged, pagesRemoved }
  }

  /** Rewrite pages from their own history. Without slugs: the pages with the most history and the thinnest summary. */
  async recompile(opts: RecompileOptions = {}): Promise<{ ok: number; failed: number }> {
    const llm = this.llm
    if (!llm) throw new Error('wiki recompile needs a summarization endpoint (compactor)')
    const dryRun = opts.dryRun === true
    const asked = [...(opts.slug ? [opts.slug] : []), ...(opts.slugs ?? [])]
      .map((s) => s.trim())
      .filter(Boolean)
    // A slug names a file under topics/: one that is not a plain slug is
    // counted as failed and never becomes a path.
    let slugs = [...new Set(asked.filter((s) => SLUG.test(s)))]
    const refused = asked.filter((s) => !SLUG.test(s)).length
    const limit = Number.isFinite(opts.limit)
      ? Math.min(Math.max(Math.trunc(opts.limit as number), 1), 100)
      : 5
    if (asked.length === 0) {
      slugs = (
        this.db
          .prepare(
            `SELECT slug FROM ros_wiki_topics
              ORDER BY history_count DESC, length(current_state) ASC, slug LIMIT ?`,
          )
          .all(limit) as unknown as Array<{ slug: string }>
      ).map((r) => r.slug)
    }
    await this.writer.ensureRepo()
    const peerSlugs = (await this.index.listTopics({ limit: 200 })).topics.map((t) => t.slug)

    let ok = 0
    let failed = refused
    for (const slug of slugs) {
      try {
        const page = await this.writer.readPage(slug)
        if (!page) {
          this.log(`[memory.sqlite] wiki recompile: no file for ${slug}`)
          failed += 1
          continue
        }
        const verifiedAt = new Date().toISOString()
        const answer = await llm.chat(
          WIKI_RECOMPILE_SYSTEM_PROMPT,
          formatRecompilePrompt({
            slug: page.meta.slug,
            title: page.meta.title,
            aliases: page.meta.aliases,
            entities: page.meta.entities,
            currentState: page.currentState,
            article: page.article,
            historyExcerpts: historyExcerpts(page),
            peerSlugs: peerSlugs.filter((s) => s !== slug).slice(0, 80),
            today: verifiedAt.slice(0, 10),
          }),
          Math.max(WIKI_EXTRACT_MAX_TOKENS, 8000),
          { minChars: 2 },
        )
        // An answer that does not parse is a failure here. (The Postgres task
        // hands it to a fallback model first; this client has one model.)
        const { patch, rejected } = parseRecompileResult(answer.content, slug, verifiedAt)
        if (!patch) {
          this.log(`[memory.sqlite] wiki recompile: ${slug} rejected — ${String(rejected)}`)
          failed += 1
          continue
        }
        if (!dryRun) {
          const applied = await this.writer.apply(
            { ...patch, slug, action: 'update' },
            { summaryId: RECOMPILE_SOURCE_ID },
          )
          this.index.upsertTopic(applied.page, applied.gitSha)
        }
        ok += 1
      } catch (err) {
        failed += 1
        this.log(
          `[memory.sqlite] wiki recompile: ${slug} failed — ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    }
    return { ok, failed }
  }
}
