/**
 * embed-target task — embed one row from ros_messages, ros_summaries,
 * ros_wiki_topics, or ros_message_chunks.
 *
 * Job key (passed via add_job's job_key) is `embed-<table>-<id>` to dedupe
 * pending jobs for the same row.
 *
 * For oversized parent content (> EMBED_CHARS_PER_CHUNK), we chunk the content,
 * embed each chunk, mean-pool into the parent row vector (compat), and — when
 * EMBED_CHUNKS_ENABLED — upsert ros_message_chunks (content + offsets + the
 * already-computed vectors so the insert trigger does not double-embed).
 *
 * ros_message_chunks: embed just that chunk's content; no mean-pool. Same
 * embed_status / embed_error / embed_failures terminal path as the parent.
 *
 * ros_messages: embed content + tool_result (FTS parity after #440). Tool rows
 * store the real payload in tool_result; content is often a short placeholder.
 */

import type { Task } from 'graphile-worker'
import { config } from '../config.js'
import { safeSlice } from '../safe-slice.js'
import { splitIntoChunksWithOffsets, meanPool } from '../chunking.js'
import { classifyUnembeddable } from '../classify.js'
import { embedBatch } from '../embed-api.js'
import { composeMessageEmbedText } from '../compose-embed-text.js'
import { formatHalfvec, truncateVec } from '../halfvec.js'
import { upsertMessageChunks } from './upsert-chunks.js'

/** Must stay in lockstep with enqueue-unembedded's failed-null heal. */
export const NULL_EMBED_ERROR = 'Embedding returned null'

/**
 * Terminal marker after config.maxFailures consecutive null vectors.
 * Must not match the heal, which only reopens NULL_EMBED_ERROR.
 */
export const PERMANENT_NULL_EMBED_ERROR = 'Embedding returned null (permanent)'

export interface EmbedTargetPayload {
  targetTable: 'ros_messages' | 'ros_summaries' | 'ros_wiki_topics' | 'ros_message_chunks'
  targetId: string
}

/** Per-table column spec — wiki topics key on slug and embed search_text. */
const TABLE_SPECS: Record<
  Exclude<EmbedTargetPayload['targetTable'], 'ros_message_chunks'>,
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

  if (targetTable === 'ros_message_chunks') {
    if (!config.embedChunksEnabled) {
      helpers.logger.info(
        `[embed-target] ros_message_chunks ${targetId.slice(0, 8)} skipped — EMBED_CHUNKS_ENABLED=false`,
      )
      return
    }
    await helpers.withPgClient(async (client) => {
      const query = (sql: string, values?: unknown[]) => client.query(sql, values)
      await embedChunkRow(query, targetId, helpers)
    })
    return
  }

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
    let parts = splitIntoChunksWithOffsets(content, config.charsPerChunk)
    let vectors: Array<number[] | null> = []
    if (content.length <= config.charsPerChunk) {
      const truncated = safeSlice(content, config.charsPerChunk)
      vectors = await embedBatch([truncated])
      pooled = vectors[0] ?? null
    } else {
      vectors = await embedBatch(parts.map((p) => p.text))
      pooled = meanPool(vectors)
      helpers.logger.info(
        `[embed-target] mean-pooled ${parts.length} chunks for ${targetTable} ${targetId.slice(0, 8)} (${content.length} chars)`,
      )
    }

    if (!pooled) {
      // Null vectors are almost always a transient API blip (429/5xx after
      // retries, empty payload) — classifyUnembeddable already filtered poison
      // content. Leave embed_status non-terminal and throw so graphile retries;
      // the 10-min sweep also re-enqueues. After maxFailures consecutive nulls
      // the row is poison (non-retryable 4xx / missing embedding): mark
      // 'failed' with PERMANENT_NULL_EMBED_ERROR so the heal will not match,
      // and return without throwing so graphile does not keep retrying it.
      const counted = await client.query<{ embed_failures: number }>(
        `UPDATE ${targetTable}
            SET embed_failures = COALESCE(embed_failures, 0) + 1,
                embed_error = $1
          WHERE ${spec.idCol} = $2
          RETURNING embed_failures`,
        [NULL_EMBED_ERROR, targetId],
      )
      const failures = counted.rows[0]?.embed_failures ?? 0
      if (failures >= config.maxFailures) {
        await client.query(
          `UPDATE ${targetTable}
              SET embed_status = 'failed',
                  embed_error = $1
            WHERE ${spec.idCol} = $2`,
          [PERMANENT_NULL_EMBED_ERROR, targetId],
        )
        helpers.logger.warn(
          `[embed-target] ${targetTable} ${targetId.slice(0, 8)} poisoned after ${String(failures)} null embeddings — marking failed`,
        )
        return
      }
      throw new Error(NULL_EMBED_ERROR)
    }

    const truncatedVec = truncateVec(pooled, config.truncateDims)

    // Clear any prior failure state on success — a row that failed transiently
    // and later embedded must not stay flagged 'failed' forever.
    await client.query(
      `UPDATE ${targetTable}
          SET embedding = $1,
              embed_status = NULL,
              embed_error = NULL,
              embed_failures = 0
        WHERE ${spec.idCol} = $2`,
      [formatHalfvec(truncatedVec), targetId],
    )

    if (
      config.embedChunksEnabled &&
      targetTable === 'ros_messages' &&
      content.length > config.charsPerChunk
    ) {
      const outcome = await upsertMessageChunks(
        (sql, values) => client.query(sql, values),
        {
          messageId: targetId,
          content,
          chunks: parts,
          vectors,
          truncateDims: config.truncateDims,
        },
      )
      helpers.logger.info(
        `[embed-target] chunks ${outcome} for ros_messages ${targetId.slice(0, 8)} (${parts.length} parts)`,
      )
    }

    helpers.logger.info(
      `[embed-target] embedded ${targetTable} ${targetId.slice(0, 8)} (${truncatedVec.length} dims)`,
    )
  })
}

async function embedChunkRow(
  query: (
    sql: string,
    values?: unknown[],
  ) => Promise<{ rows: Array<Record<string, unknown>>; rowCount?: number | null }>,
  targetId: string,
  helpers: { logger: { info: (msg: string) => void; warn: (msg: string) => void } },
): Promise<void> {
  const result = await query(
    `SELECT id, content FROM ros_message_chunks
      WHERE id = $1
        AND embedding IS NULL
        AND embed_status IS NULL
        AND content IS NOT NULL AND LENGTH(btrim(content)) > 0`,
    [targetId],
  )
  if (result.rows.length === 0) {
    helpers.logger.info(
      `[embed-target] ros_message_chunks ${targetId.slice(0, 8)} not found, empty, already embedded, or terminal — dropping`,
    )
    return
  }

  const content = String(result.rows[0].content ?? '')
  const unembeddable = classifyUnembeddable(content)
  if (unembeddable) {
    await query(
      `UPDATE ros_message_chunks
          SET embed_status = 'unembeddable',
              embed_error = $1
        WHERE id = $2`,
      [`unembeddable: ${unembeddable}`, targetId],
    )
    helpers.logger.info(
      `[embed-target] ros_message_chunks ${targetId.slice(0, 8)} unembeddable: ${unembeddable}`,
    )
    return
  }

  const truncated = safeSlice(content, config.charsPerChunk)
  const vectors = await embedBatch([truncated])
  const vec = vectors[0] ?? null
  if (!vec) {
    const counted = await query(
      `UPDATE ros_message_chunks
          SET embed_failures = COALESCE(embed_failures, 0) + 1,
              embed_error = $1
        WHERE id = $2
        RETURNING embed_failures`,
      [NULL_EMBED_ERROR, targetId],
    )
    const failures = Number(counted.rows[0]?.embed_failures ?? 0)
    if (failures >= config.maxFailures) {
      await query(
        `UPDATE ros_message_chunks
            SET embed_status = 'failed',
                embed_error = $1
          WHERE id = $2`,
        [PERMANENT_NULL_EMBED_ERROR, targetId],
      )
      helpers.logger.warn(
        `[embed-target] ros_message_chunks ${targetId.slice(0, 8)} poisoned after ${String(failures)} null embeddings — marking failed`,
      )
      return
    }
    throw new Error(NULL_EMBED_ERROR)
  }
  const truncatedVec = truncateVec(vec, config.truncateDims)
  await query(
    `UPDATE ros_message_chunks
        SET embedding = $1,
            embed_status = NULL,
            embed_error = NULL,
            embed_failures = 0
      WHERE id = $2 AND embedding IS NULL`,
    [formatHalfvec(truncatedVec), targetId],
  )
  helpers.logger.info(
    `[embed-target] embedded ros_message_chunks ${targetId.slice(0, 8)} (${truncatedVec.length} dims)`,
  )
}
