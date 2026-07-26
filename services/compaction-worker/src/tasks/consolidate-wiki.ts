/**
 * consolidate-wiki (memory v6) — one-shot / batch merge of near-duplicate
 * topic pages into durable canonical topics.
 *
 * Clusters by 2-token slug stem (deckard-40b-*), merges markdown via
 * mergePages, writes the canonical page, deletes losers, records redirects.
 *
 * Payload:
 *   { dryRun?: boolean, limitClusters?: number, minClusterSize?: number }
 *
 * Safe to re-run: already-merged clusters (size 1) are skipped.
 */

import type { Task } from 'graphile-worker'
import { existsSync } from 'node:fs'
import { unlink } from 'node:fs/promises'
import { join } from 'node:path'
import pg from 'pg'
import {
  clusterSlugsByStem,
  mergePages,
  serializeWikiPage,
  type WikiPage,
} from '@rivetos/wiki-core'
import { WikiIndex } from '@rivetos/memory-postgres'
import { config } from '../config.js'
import { WikiWriter } from '../wiki-writer.js'

export interface ConsolidateWikiPayload {
  dryRun?: boolean
  /** Max clusters to merge this run (default 50). */
  limitClusters?: number
  /** Only merge clusters with at least this many pages (default 2). */
  minClusterSize?: number
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

function pickCanonical(slugs: string[]): string {
  // Prefer shortest slug (durable parent); ties break lexicographically.
  return [...slugs].sort((a, b) => a.length - b.length || a.localeCompare(b))[0]
}

export const consolidateWikiTask: Task = async (payload, helpers) => {
  const opts = (payload ?? {}) as ConsolidateWikiPayload
  const dryRun = opts.dryRun === true
  const limitClusters = opts.limitClusters ?? 50
  const minClusterSize = opts.minClusterSize ?? 2

  const { index, writer } = deps()
  if (!(await index.isReady())) {
    helpers.logger.warn('consolidate-wiki: wiki index not ready')
    return
  }

  await writer.ensureRepo()
  const allSlugs = await index.listAllSlugs()
  const groups = clusterSlugsByStem(allSlugs)

  const clusters = [...groups.entries()]
    .filter(([, slugs]) => slugs.length >= minClusterSize)
    .sort((a, b) => b[1].length - a[1].length)

  helpers.logger.info(
    `consolidate-wiki: ${allSlugs.length} topics, ${clusters.length} multi-page stem clusters` +
      (dryRun ? ' (dry-run)' : ''),
  )

  let merged = 0
  let pagesRemoved = 0

  for (const [key, slugs] of clusters.slice(0, limitClusters)) {
    const canonicalSlug = pickCanonical(slugs)
    const losers = slugs.filter((s) => s !== canonicalSlug)
    if (losers.length === 0) continue

    helpers.logger.info(
      `consolidate-wiki: cluster ${key} → ${canonicalSlug} (+${losers.length} merges): ${slugs.join(', ')}`,
    )

    if (dryRun) {
      merged++
      pagesRemoved += losers.length
      continue
    }

    const pages: WikiPage[] = []
    for (const s of slugs) {
      const p = await writer.readPage(s)
      if (p) pages.push(p)
    }
    if (pages.length === 0) continue

    const canonPage = pages.find((p) => p.meta.slug === canonicalSlug) ?? pages[0]
    const loserPages = pages.filter((p) => p.meta.slug !== canonPage.meta.slug)
    const mergedPage = mergePages(
      { ...canonPage, meta: { ...canonPage.meta, slug: canonicalSlug } },
      loserPages,
    )
    // Ensure canonical slug on meta after merge
    mergedPage.meta.slug = canonicalSlug
    mergedPage.meta.aliases = [
      ...new Set([
        ...mergedPage.meta.aliases,
        ...losers,
        ...loserPages.flatMap((p) => p.meta.aliases),
      ]),
    ]

    const { writeFile } = await import('node:fs/promises')
    await writeFile(writer.pagePath(canonicalSlug), serializeWikiPage(mergedPage))
    await index.upsertTopic(mergedPage)

    for (const loser of losers) {
      await index.setRedirect(loser, canonicalSlug)
      await index.deleteTopic(loser)
      const path = writer.pagePath(loser)
      if (existsSync(path)) {
        await unlink(path)
        // stage deletion in git
        try {
          // WikiWriter git helper is private — shell via writer root
          const { execFile } = await import('node:child_process')
          const { promisify } = await import('node:util')
          const execFileAsync = promisify(execFile)
          await execFileAsync('git', ['-C', config.wikiDir, 'rm', '-f', join('topics', `${loser}.md`)]).catch(
            async () => {
              // file may already be untracked after unlink
              await execFileAsync('git', [
                '-C',
                config.wikiDir,
                'add',
                '-u',
                join('topics', `${loser}.md`),
              ]).catch(() => undefined)
            },
          )
        } catch {
          /* best-effort git rm */
        }
      }
      pagesRemoved++
    }

    try {
      const { execFile } = await import('node:child_process')
      const { promisify } = await import('node:util')
      const execFileAsync = promisify(execFile)
      await execFileAsync('git', [
        '-C',
        config.wikiDir,
        'add',
        join('topics', `${canonicalSlug}.md`),
      ])
      await execFileAsync('git', [
        '-C',
        config.wikiDir,
        'commit',
        '-m',
        `wiki(${canonicalSlug}): consolidate ${losers.length} near-duplicate topics\n\nMerged: ${losers.join(', ')}\nPipeline: wiki-v6-consolidate`,
      ]).catch(() => undefined) // empty commit ok
    } catch (err: unknown) {
      helpers.logger.warn(
        `consolidate-wiki: git commit failed for ${canonicalSlug}: ${err instanceof Error ? err.message : String(err)}`,
      )
    }

    merged++
  }

  helpers.logger.info(
    `consolidate-wiki: done — clusters merged ${merged}, pages removed ${pagesRemoved}` +
      (dryRun ? ' (dry-run, no writes)' : ''),
  )
}
