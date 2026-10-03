/**
 * suggest-tags task — propose `key:value` tags for one committed leaf summary.
 *
 * Enqueued by compactLeaf after COMMIT (job_key `tags-<summaryId>`, so a
 * re-enqueue replaces a queued job; it can duplicate a running one, which is
 * harmless because every write here is idempotent). Reads the summary
 * and its conversation, offers the accepted vocabulary to the tagger, and
 * writes every proposal twice as `state=suggested`: on the summary and on the
 * conversation. The (entity, key, value) unique index keeps this idempotent
 * and silently skips anything the user already accepted or rejected there.
 * A value the taxonomy has never seen is added as a `suggested` taxonomy row
 * so the vocabulary review sees it too.
 *
 * Skip rules (never retried): non-leaf, too short, heartbeat conversations,
 * tagging disabled. Best-effort: a transport/LLM failure is retried by
 * graphile (max_attempts set at enqueue) and then logged and dropped on the
 * final attempt — a tag suggestion is never worth a dead job. There is no
 * backfill: summaries compacted while tagging was off or the tagger was
 * down are not tagged later.
 */

import type { JobHelpers, Task } from 'graphile-worker'
import pg from 'pg'
import { formatTag, type TagProposal } from '@rivetos/types'
import { config } from '../config.js'
import { suggestTags, type TaggerVocabulary } from '../tagger.js'
import { isJobFinalAttempt } from './compact-conversation.js'

export interface SuggestTagsPayload {
  summaryId: string
  conversationId?: string
}

/** Below this the summary is noise and the model would only hallucinate. */
export const TAG_MIN_SUMMARY_CHARS = 120

/** Vocabulary offered to the tagger: accepted taxonomy first, then in-use tags. */
export const TAG_VOCAB_LIMIT = 80

interface SummaryRow {
  id: string
  conversation_id: string | null
  content: string
  kind: string
  title: string | null
  session_key: string | null
  agent: string | null
}

let pool: pg.Pool | undefined
function db(): pg.Pool {
  pool ??= new pg.Pool({ connectionString: config.pgUrl, max: 2 })
  return pool
}

/** Test seam: replace the pool. */
export function setSuggestTagsPoolForTest(next: pg.Pool | undefined): void {
  pool = next
}

export async function loadVocabulary(client: pg.Pool | pg.PoolClient): Promise<TaggerVocabulary> {
  const { rows } = await client.query<{ key: string; value: string; display: string }>(
    `SELECT key, value, display FROM (
       SELECT key, value, display, 0 AS rank, 0::bigint AS uses
         FROM ros_tag_taxonomy WHERE state = 'accepted'
       UNION ALL
       SELECT key, value, max(display) AS display, 1 AS rank, count(*) AS uses
         FROM ros_tags WHERE state = 'accepted' GROUP BY key, value
     ) v
     ORDER BY rank, uses DESC, key, value
     LIMIT $1`,
    [TAG_VOCAB_LIMIT],
  )
  const seen = new Set<string>()
  const accepted: string[] = []
  for (const r of rows) {
    const literal = formatTag({ key: r.key, value: r.value, display: r.display })
    const id = `${r.key}:${r.value}`
    if (seen.has(id)) continue
    seen.add(id)
    accepted.push(literal)
  }
  return { accepted }
}

/** Run `fn` on one connection inside BEGIN/COMMIT; a fake without `connect` (unit tests) runs inline. */
async function inTransaction<T>(
  db: pg.Pool,
  fn: (tx: pg.Pool | pg.PoolClient) => Promise<T>,
): Promise<T> {
  if (typeof (db as Partial<pg.Pool>).connect !== 'function') return fn(db)
  const tx = await db.connect()
  try {
    await tx.query('BEGIN')
    const out = await fn(tx)
    await tx.query('COMMIT')
    return out
  } catch (err) {
    await tx.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    tx.release()
  }
}

/** Write proposals for one entity. Returns rows actually inserted. */
export async function insertSuggestions(
  client: pg.Pool | pg.PoolClient,
  entityType: 'conversation' | 'summary',
  entityId: string,
  proposals: TagProposal[],
  proposedBy: string,
): Promise<number> {
  let inserted = 0
  for (const p of proposals) {
    const { rowCount } = await client.query(
      `INSERT INTO ros_tags
         (entity_type, entity_id, key, value, display, source, state, confidence, proposed_by, reason)
       VALUES ($1, $2, $3, $4, $5, 'model', 'suggested', $6, $7, $8)
       ON CONFLICT (entity_type, entity_id, key, value) DO NOTHING`,
      [
        entityType,
        entityId,
        p.key,
        p.value,
        p.display ?? '',
        p.confidence ?? null,
        proposedBy,
        p.reason ?? '',
      ],
    )
    inserted += rowCount ?? 0
  }
  return inserted
}

/** Add unseen values to the taxonomy as suggestions. Existing rows untouched. */
export async function proposeTaxonomyValues(
  client: pg.Pool | pg.PoolClient,
  proposals: TagProposal[],
  proposedBy: string,
): Promise<number> {
  let inserted = 0
  for (const p of proposals) {
    const { rowCount } = await client.query(
      `INSERT INTO ros_tag_taxonomy (key, value, display, state, source, reason)
       VALUES ($1, $2, $3, 'suggested', 'model', $4)
       ON CONFLICT (key, value) DO NOTHING`,
      [p.key, p.value, p.display ?? '', `proposed by ${proposedBy}`],
    )
    inserted += rowCount ?? 0
  }
  return inserted
}

/** The work itself. Throws on any failure; the task wrapper decides what that means. */
async function runSuggestTags(summaryId: string, helpers: JobHelpers): Promise<void> {
  const client = db()
  const { rows } = await client.query<SummaryRow>(
    `SELECT s.id, s.conversation_id, s.content, s.kind, c.title, c.session_key, c.agent
       FROM ros_summaries s
       LEFT JOIN ros_conversations c ON c.id = s.conversation_id
      WHERE s.id = $1`,
    [summaryId],
  )
  const summary = rows[0]
  if (!summary) {
    helpers.logger.warn(`suggest-tags: summary ${summaryId} not found`)
    return
  }
  const short = summaryId.slice(0, 8)
  if (summary.kind !== 'leaf') {
    helpers.logger.info(`suggest-tags: skip ${short} — kind=${summary.kind}`)
    return
  }
  if (summary.content.length < TAG_MIN_SUMMARY_CHARS) {
    helpers.logger.info(`suggest-tags: skip ${short} — summary too short`)
    return
  }
  if (summary.session_key?.startsWith('heartbeat:')) {
    helpers.logger.info(`suggest-tags: skip ${short} — heartbeat conversation`)
    return
  }

  let vocabulary: TaggerVocabulary
  try {
    vocabulary = await loadVocabulary(client)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    // Worker ahead of the database: migration 0019 not applied yet. Not a
    // job failure — retrying cannot help, and dead jobs would pile up.
    if (/relation "?ros_tag/i.test(msg) && /does not exist/i.test(msg)) {
      helpers.logger.warn(
        `suggest-tags: tag tables missing (migration 0019 not applied) — skipping ${short}`,
      )
      return
    }
    throw err
  }
  const { proposals, rejected } = await suggestTags(
    {
      wireShape: config.taggerWireShape,
      target: config.tagger,
      timeoutMs: config.taggerTimeoutMs,
    },
    {
      summary: summary.content,
      title: summary.title ?? undefined,
      agent: summary.agent ?? undefined,
      vocabulary,
    },
  )
  for (const r of rejected) helpers.logger.warn(`suggest-tags: rejected — ${r}`)
  if (proposals.length === 0) {
    helpers.logger.info(`suggest-tags: ${short} — no tags`)
    return
  }

  const proposedBy = config.tagger.model
  // One transaction: the three writes land together or not at all, so a
  // failure that is later dropped on the final attempt cannot leave a
  // summary tagged without its conversation or its vocabulary entries.
  const conversationId = summary.conversation_id
  const { onSummary, onConversation, taxonomy } = await inTransaction(client, async (tx) => ({
    onSummary: await insertSuggestions(tx, 'summary', summaryId, proposals, proposedBy),
    onConversation: conversationId
      ? await insertSuggestions(tx, 'conversation', conversationId, proposals, proposedBy)
      : 0,
    taxonomy: await proposeTaxonomyValues(tx, proposals, proposedBy),
  }))
  helpers.logger.info(
    `suggest-tags: ${short} — ${String(proposals.length)} proposed, ` +
      `${String(onSummary)} new on summary, ${String(onConversation)} new on conversation, ` +
      `${String(taxonomy)} new taxonomy values`,
  )
}

/**
 * Best-effort wrapper. Any failure — the tagger call or the writes after it —
 * is retried by graphile while attempts remain, then logged and dropped on
 * the final attempt, so a `tags-<summaryId>` job is never left dead (a dead
 * keyed row sits outside both cleanup paths). The tagger's writes are
 * idempotent, so a duplicate run is harmless.
 */
export const suggestTagsTask: Task = async (payload, helpers) => {
  if (!config.taggingEnabled) return
  const summaryId = (payload as { summaryId?: unknown } | null)?.summaryId
  if (typeof summaryId !== 'string' || summaryId === '') {
    helpers.logger.warn(`suggest-tags: invalid payload ${JSON.stringify(payload)}`)
    return
  }
  try {
    await runSuggestTags(summaryId, helpers)
  } catch (err) {
    // Dropping on the final attempt leaves no corpse; the writes are atomic
    // (see inTransaction), so what is dropped is the whole proposal, never half.
    // helpers.job is absent only in unit tests that call the task directly.
    const job = (helpers.job ?? {}) as { attempts?: number; max_attempts?: number }
    if (!isJobFinalAttempt(job)) throw err
    const attempts = job.attempts ?? 1
    const msg = err instanceof Error ? err.message : String(err)
    helpers.logger.warn(
      `suggest-tags: giving up on ${summaryId.slice(0, 8)} after ${String(attempts)} attempt(s) — ${msg}`,
    )
  }
}
