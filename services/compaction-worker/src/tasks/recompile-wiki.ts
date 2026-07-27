/**
 * recompile-wiki (memory v7) — rebuild Wikipedia-style Summary + Article for
 * one or more durable topics from buried History / superseded states.
 *
 * Payload:
 *   { slug?: string, slugs?: string[], limit?: number, dryRun?: boolean }
 *
 * When slug(s) omitted: picks topics with largest history_count (default 5).
 */

import type { Task } from 'graphile-worker'
import pg from 'pg'
import {
  WIKI_EXTRACT_MAX_TOKENS,
  WIKI_RECOMPILE_SYSTEM_PROMPT,
  formatRecompilePrompt,
  parseRecompileResult,
  WikiIndex,
} from '@rivetos/memory-postgres'
import { config } from '../config.js'
import { callLlm } from '../llm.js'
import { WikiWriter } from '../wiki-writer.js'

export interface RecompileWikiPayload {
  slug?: string
  slugs?: string[]
  /** Max topics when selecting by history size (default 5). */
  limit?: number
  dryRun?: boolean
}

let pool: pg.Pool | undefined
let index: WikiIndex | undefined
let writer: WikiWriter | undefined

function deps(): { pool: pg.Pool; index: WikiIndex; writer: WikiWriter } {
  pool ??= new pg.Pool({ connectionString: config.pgUrl, max: 3 })
  index ??= new WikiIndex(pool)
  writer ??= new WikiWriter(config.wikiDir)
  return { pool, index, writer }
}

function historyExcerpts(page: {
  history: Array<{ date: string; title: string; body: string }>
}): string {
  // Prefer densest superseded / merged blobs first, then recent deltas.
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

export const recompileWikiTask: Task = async (payload, helpers) => {
  const opts = (payload ?? {}) as RecompileWikiPayload
  const dryRun = opts.dryRun === true
  const { index, writer, pool } = deps()

  if (!(await index.isReady())) {
    helpers.logger.warn('recompile-wiki: wiki index not ready')
    return
  }

  let slugs: string[] = []
  if (opts.slug) slugs.push(opts.slug)
  if (opts.slugs?.length) slugs.push(...opts.slugs)
  slugs = [...new Set(slugs.map((s) => s.trim()).filter(Boolean))]

  if (slugs.length === 0) {
    const limit = opts.limit ?? 5
    const { rows } = await pool.query<{ slug: string }>(
      `SELECT slug FROM ros_wiki_topics
       ORDER BY history_count DESC, length(current_state) ASC
       LIMIT $1`,
      [limit],
    )
    slugs = rows.map((r) => r.slug)
  }

  helpers.logger.info(
    `recompile-wiki: ${slugs.length} topic(s)${dryRun ? ' (dry-run)' : ''}: ${slugs.join(', ')}`,
  )

  await writer.ensureRepo()
  const peerHits = await index.listTopics({ limit: 200 })
  const peerSlugs = peerHits.topics.map((t) => t.slug)

  let ok = 0
  let failed = 0

  for (const slug of slugs) {
    try {
      const page = await writer.readPage(slug)
      if (!page) {
        helpers.logger.warn(`recompile-wiki: no file for ${slug}`)
        failed++
        continue
      }

      const today = new Date().toISOString().slice(0, 10)
      const verifiedAt = new Date().toISOString()
      const raw = await callLlm(
        WIKI_RECOMPILE_SYSTEM_PROMPT,
        formatRecompilePrompt({
          slug: page.meta.slug,
          title: page.meta.title,
          aliases: page.meta.aliases,
          entities: page.meta.entities,
          currentState: page.currentState,
          article: page.article ?? '',
          historyExcerpts: historyExcerpts(page),
          peerSlugs: peerSlugs.filter((s) => s !== slug).slice(0, 80),
          today,
        }),
        Math.max(WIKI_EXTRACT_MAX_TOKENS, 8000),
      )
      if (!raw) throw new Error('empty LLM response')

      const { patch, rejected } = parseRecompileResult(raw, slug, verifiedAt)
      if (!patch) {
        helpers.logger.warn(`recompile-wiki: ${slug} rejected — ${rejected}`)
        failed++
        continue
      }

      helpers.logger.info(
        `recompile-wiki: ${slug} summary ${page.currentState.length}→${(patch.currentState ?? '').length} chars` +
          (dryRun ? ' (dry-run, skip write)' : ''),
      )

      if (dryRun) {
        ok++
        continue
      }

      const applied = await writer.apply(
        {
          ...patch,
          slug,
          action: 'update',
        },
        { summaryId: '00000000-0000-0000-0000-000000000007' },
      )
      await index.upsertTopic(applied.page, applied.gitSha)
      ok++
    } catch (err: unknown) {
      failed++
      helpers.logger.error(
        `recompile-wiki: ${slug} failed — ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  helpers.logger.info(`recompile-wiki: done — ok=${ok} failed=${failed}`)
}
