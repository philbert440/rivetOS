/**
 * extract-wiki task (phase 3c) — mine one leaf summary into topic-page
 * patches. New consumer of compaction output: enqueued after each leaf
 * insert (and by the 3h backfill), gated on WIKI_EXTRACTION, idempotent on
 * summary_id, per-slug write serialization via the single WikiWriter.
 *
 * Skip rules (marked 'skipped', never retried): extraction already done,
 * summary below WIKI_MIN_SUMMARY_CHARS, heartbeat conversations, non-leaf
 * summaries. LLM/git failures mark 'failed' (re-enqueueable).
 */

import type { Task } from 'graphile-worker'
import pg from 'pg'
import {
  WikiIndex,
  WIKI_EXTRACT_SYSTEM_PROMPT,
  WIKI_EXTRACT_MAX_TOKENS,
  WIKI_MIN_SUMMARY_CHARS,
  WIKI_PIPELINE_VERSION,
  formatExtractionPrompt,
  parseWikiPatches,
  type ExtractionCandidate,
} from '@rivetos/memory-postgres'
import { config } from '../config.js'
import { callLlm } from '../llm.js'
import { WikiWriter } from '../wiki-writer.js'

export interface ExtractWikiPayload {
  summaryId: string
  conversationId?: string
}

interface SummaryRow {
  id: string
  conversation_id: string | null
  content: string
  kind: string
  latest_at: Date | null
  created_at: Date
  session_key: string | null
  agent: string | null
}

/** Module-level singletons — one pool/writer per worker process. */
let pool: pg.Pool | undefined
let index: WikiIndex | undefined
let writer: WikiWriter | undefined

function deps(): { pool: pg.Pool; index: WikiIndex; writer: WikiWriter } {
  pool ??= new pg.Pool({ connectionString: config.pgUrl, max: 3 })
  index ??= new WikiIndex(pool)
  writer ??= new WikiWriter(config.wikiDir)
  return { pool, index, writer }
}

export const extractWikiTask: Task = async (payload, helpers) => {
  if (!config.wikiExtraction) return // flag off — dark
  const { summaryId } = payload as ExtractWikiPayload
  if (typeof summaryId !== 'string' || summaryId === '') {
    helpers.logger.warn(`extract-wiki: invalid payload ${JSON.stringify(payload)}`)
    return
  }
  const { index, writer, pool } = deps()

  if (await index.extractionDone(summaryId)) return

  const { rows } = await pool.query<SummaryRow>(
    `SELECT s.id, s.conversation_id, s.content, s.kind, s.latest_at, s.created_at,
            c.session_key, c.agent
     FROM ros_summaries s
     LEFT JOIN ros_conversations c ON c.id = s.conversation_id
     WHERE s.id = $1`,
    [summaryId],
  )
  const summary = rows[0]
  if (!summary) {
    helpers.logger.warn(`extract-wiki: summary ${summaryId} not found`)
    return
  }

  const skip = async (reason: string): Promise<void> => {
    helpers.logger.info(`extract-wiki: skip ${summaryId.slice(0, 8)} — ${reason}`)
    await index.markExtraction({
      summaryId,
      status: 'skipped',
      pipelineVersion: WIKI_PIPELINE_VERSION,
      error: reason,
    })
  }

  if (summary.kind !== 'leaf') return skip(`kind=${summary.kind} (v1 mines leaves only)`)
  if (summary.content.length < WIKI_MIN_SUMMARY_CHARS) return skip('summary too short')
  if (summary.session_key?.startsWith('heartbeat:')) return skip('heartbeat conversation')

  try {
    // Candidate pages for identity resolution — search on the summary text.
    const hits = await index.searchTopics(summary.content.slice(0, 500), { limit: 3 })
    const candidates: ExtractionCandidate[] = hits.map((h) => ({
      slug: h.slug,
      title: h.title,
      aliases: h.aliases,
      currentState: h.currentState,
    }))

    const summaryDate = (summary.latest_at ?? summary.created_at).toISOString().slice(0, 10)
    const raw = await callLlm(
      WIKI_EXTRACT_SYSTEM_PROMPT,
      formatExtractionPrompt({
        summary: summary.content,
        summaryDate,
        agent: summary.agent ?? undefined,
        candidates,
      }),
      WIKI_EXTRACT_MAX_TOKENS,
    )
    if (!raw) throw new Error('empty LLM response')

    const verifiedAt = (summary.latest_at ?? summary.created_at).toISOString()
    const { patches, rejected } = parseWikiPatches(raw, verifiedAt)
    for (const r of rejected) helpers.logger.warn(`extract-wiki: rejected patch — ${r}`)

    if (patches.length === 0) {
      await index.markExtraction({
        summaryId,
        status: 'done',
        pipelineVersion: WIKI_PIPELINE_VERSION,
        topicsTouched: [],
      })
      return
    }

    await writer.ensureRepo()
    const touched: string[] = []
    let lastSha: string | undefined
    for (const patch of patches) {
      // Identity resolution: an alias/exact match redirects the patch onto
      // the existing slug so the LLM can't mint near-duplicates.
      const resolved = await index.resolveTopic(patch.slug)
      const slug = resolved.exact?.slug ?? patch.slug
      const applied = await writer.apply({ ...patch, slug }, { summaryId })
      await index.upsertTopic(applied.page, applied.gitSha)
      await index.recordProvenance(
        slug,
        [
          {
            kind: 'summary',
            ids: [summaryId],
            conversationId: summary.conversation_id ?? undefined,
          },
        ],
        applied.gitSha,
      )
      touched.push(slug)
      lastSha = applied.gitSha
    }

    await index.markExtraction({
      summaryId,
      status: 'done',
      pipelineVersion: WIKI_PIPELINE_VERSION,
      topicsTouched: touched,
      gitSha: lastSha,
    })
    helpers.logger.info(
      `extract-wiki: ${summaryId.slice(0, 8)} → ${touched.length > 0 ? touched.join(', ') : 'no topics'}`,
    )
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    helpers.logger.error(`extract-wiki: ${summaryId.slice(0, 8)} failed — ${msg}`)
    await index.markExtraction({
      summaryId,
      status: 'failed',
      pipelineVersion: WIKI_PIPELINE_VERSION,
      error: msg.slice(0, 500),
    })
    throw err // let graphile retry within maxAttempts
  }
}
