/**
 * embed-target task — embed one row from ros_messages or ros_summaries.
 *
 * Job key (passed via add_job's job_key) is `embed-<table>-<id>` to dedupe
 * pending jobs for the same row.
 *
 * Replaces the LISTEN/NOTIFY-driven JS embedding worker. Per-row jobs
 * mean graphile-worker handles concurrency, retry, and dedup at the queue
 * level — we just embed one row per task invocation.
 *
 * For oversized content (> EMBED_CHARS_PER_CHUNK), we chunk the content,
 * embed each chunk, and mean-pool the vectors into a single row vector.
 *
 * ros_messages: embed content + tool_result (FTS parity after #440). Tool rows
 * store the real payload in tool_result; content is often a short placeholder.
 */

import type { Task } from 'graphile-worker'
import { config } from '../config.js'
import { safeSlice } from '../safe-slice.js'
import { splitIntoChunks, meanPool } from '../chunking.js'
import { classifyUnembeddable } from '../classify.js'
import { embedBatch } from '../embed-api.js'
import { composeMessageEmbedText } from '../compose-embed-text.js'

/** Must stay in lockstep with enqueue-unembedded's failed-null heal. */
export const NULL_EMBED_ERROR = 'Embedding returned null'

export interface EmbedTargetPayload {
  targetTable: 'ros_messages' | 'ros_summaries' | 'ros_wiki_topics'
  targetId: string
}

/** Per-table column spec — wiki topics key on slug and embed search_text. */
const TABLE_SPECS: Record<
  EmbedTargetPayload['targetTable'],
  { idCol: string; contentCol: string; includeToolResult: boolean }
> = {
  ros_messages: { idCol: 'id', contentCol: 'content', includeToolResult: true },
  ros_summaries: { idCol: 'id', contentCol: 'content', includeToolResult: false },
  ros_wiki_topics: { idCol: 'slug', contentCol: 'search_text', includeToolResult: false },
}

interface ContentRow {
  id: string
  content: string | null
  tool_result?: string | null
}

export const embedTargetTask: Task = async (payload, helpers) => {
  const { targetTable, targetId } = payload as EmbedTargetPayload

  const spec = TABLE_SPECS[targetTable]
  if (!spec) {
    helpers.logger.error(`[embed-target] invalid target_table: ${targetTable}`)
    return
  }

  await helpers.withPgClient(async (client) => {
    // Messages: allow rows that only have tool_result (content may be empty or
    // a short `[tool] name` placeholder). Other tables stay content-only.
    const selectCols = spec.includeToolResult
      ? `${spec.idCol} AS id, ${spec.contentCol} AS content, tool_result`
      : `${spec.idCol} AS id, ${spec.contentCol} AS content`
    const eligibility = spec.includeToolResult
      ? `((${spec.contentCol} IS NOT NULL AND LENGTH(btrim(${spec.contentCol})) > 0)
         OR (tool_result IS NOT NULL AND LENGTH(btrim(tool_result)) > 0))`
      : `${spec.contentCol} IS NOT NULL AND LENGTH(${spec.contentCol}) > 0`

    const result = await client.query<ContentRow>(
      `SELECT ${selectCols} FROM ${targetTable}
        WHERE ${spec.idCol} = $1
          AND ${eligibility}`,
      [targetId],
    )

    if (result.rows.length === 0) {
      helpers.logger.info(
        `[embed-target] ${targetTable} ${targetId.slice(0, 8)} not found or empty — dropping`,
      )
      return
    }

    const row = result.rows[0]
    const content = spec.includeToolResult
      ? composeMessageEmbedText(row.content, row.tool_result)
      : (row.content ?? '')

    if (!content) {
      helpers.logger.info(
        `[embed-target] ${targetTable} ${targetId.slice(0, 8)} empty after compose — dropping`,
      )
      return
    }

    const unembeddable = classifyUnembeddable(content)
    if (unembeddable) {
      await client.query(
        `UPDATE ${targetTable}
            SET embed_status = 'unembeddable',
                embed_error = $1
          WHERE ${spec.idCol} = $2`,
        [`unembeddable: ${unembeddable}`, targetId],
      )
      helpers.logger.info(
        `[embed-target] ${targetTable} ${targetId.slice(0, 8)} unembeddable: ${unembeddable}`,
      )
      return
    }

    let pooled: number[] | null
    if (content.length <= config.charsPerChunk) {
      const truncated = safeSlice(content, config.charsPerChunk)
      const vectors = await embedBatch([truncated])
      pooled = vectors[0] ?? null
    } else {
      const chunks = splitIntoChunks(content, config.charsPerChunk)
      const vectors = await embedBatch(chunks)
      pooled = meanPool(vectors)
      helpers.logger.info(
        `[embed-target] mean-pooled ${chunks.length} chunks for ${targetTable} ${targetId.slice(0, 8)} (${content.length} chars)`,
      )
    }

    if (!pooled) {
      // Null vectors are almost always a transient API blip (429/5xx after
      // retries, empty payload) — classifyUnembeddable already filtered poison
      // content. Do NOT set embed_status='failed': that permanently excludes
      // the row from enqueue-unembedded, which is how live jobs sat dead after
      // a 2026-08-23 API incident.
      // Throw so graphile retries this job; if it still dies, the 10-min
      // sweep re-enqueues because embed_status stays non-terminal.
      await client.query(
        `UPDATE ${targetTable}
            SET embed_failures = COALESCE(embed_failures, 0) + 1,
                embed_error = $1
          WHERE ${spec.idCol} = $2`,
        [NULL_EMBED_ERROR, targetId],
      )
      throw new Error(NULL_EMBED_ERROR)
    }

    const truncatedVec =
      pooled.length > config.truncateDims ? pooled.slice(0, config.truncateDims) : pooled

    // Clear any prior failure state on success — a row that failed transiently
    // and later embedded must not stay flagged 'failed' forever.
    await client.query(
      `UPDATE ${targetTable}
          SET embedding = $1,
              embed_status = NULL,
              embed_error = NULL,
              embed_failures = 0
        WHERE ${spec.idCol} = $2`,
      [`[${truncatedVec.join(',')}]`, targetId],
    )

    helpers.logger.info(
      `[embed-target] embedded ${targetTable} ${targetId.slice(0, 8)} (${truncatedVec.length} dims)`,
    )
  })
}
