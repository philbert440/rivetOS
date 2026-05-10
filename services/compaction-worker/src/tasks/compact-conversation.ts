/**
 * compact-conversation task — full bottom-up summarization for one conversation.
 *
 * Job key (passed via add_job's job_key) is the conversation ID, which gives us
 * "only one pending/processing per conversation" deduplication via graphile-worker.
 *
 * Ported from plugins/memory/postgres/workers/compaction/index.js compactConversation +
 * compactLeafConversation + compactBranchConversation + compactRootConversation.
 */

import type { Task } from 'graphile-worker'
import {
  LEAF_SYSTEM_PROMPT,
  BRANCH_SYSTEM_PROMPT,
  ROOT_SYSTEM_PROMPT,
  LEAF_MAX_TOKENS,
  BRANCH_MAX_TOKENS,
  ROOT_MAX_TOKENS,
  PIPELINE_VERSION,
  MIN_BATCH_SIZE,
  formatLeafPrompt,
  formatBranchPrompt,
  formatRootPrompt,
  type ConversationMeta,
  type CompactMessageRow,
  type SummaryRow,
} from '@rivetos/memory-postgres'
import { config } from '../config.js'
import { callLlm } from '../llm.js'
import {
  shouldSkip,
  recordFailure,
  recordSuccess,
  breakerThreshold,
} from '../circuit-breaker.js'

export interface CompactConversationPayload {
  conversationId: string
  triggerType?: 'threshold' | 'session_idle' | 'explicit'
}

interface PgClient {
  query<T = Record<string, unknown>>(
    sql: string,
    values?: unknown[],
  ): Promise<{ rows: T[]; rowCount: number | null }>
}

async function loadConversationMeta(
  client: PgClient,
  conversationId: string,
): Promise<ConversationMeta> {
  const { rows } = await client.query<ConversationMeta>(
    `SELECT id::text AS id, agent, channel, channel_id, title
       FROM ros_conversations
      WHERE id = $1`,
    [conversationId],
  )
  if (rows.length === 0) {
    throw new Error(`Conversation not found: ${conversationId}`)
  }
  return rows[0]
}

async function compactLeaf(
  client: PgClient,
  convMeta: ConversationMeta,
  conversationId: string,
): Promise<number> {
  const messages = await client.query<CompactMessageRow & { id: string }>(
    `SELECT m.id, m.role, m.content, m.agent, m.created_at, m.tool_name, m.tool_args
     FROM ros_messages m
     LEFT JOIN ros_summary_sources ss ON ss.message_id = m.id
     WHERE ss.summary_id IS NULL AND m.conversation_id = $1
       AND ((m.content IS NOT NULL AND LENGTH(m.content) > 10) OR m.tool_name IS NOT NULL)
     ORDER BY m.created_at ASC LIMIT $2`,
    [conversationId, config.leafBatchSize],
  )

  if (messages.rows.length < MIN_BATCH_SIZE) return 0

  const formatted = formatLeafPrompt(convMeta, messages.rows)

  console.log(
    `[CompactWorker] Leaf: ${messages.rows.length} messages for ${conversationId.slice(0, 8)}`,
  )

  const summaryText = await callLlm(LEAF_SYSTEM_PROMPT, formatted, LEAF_MAX_TOKENS)
  if (!summaryText) {
    const failures = recordFailure(conversationId)
    console.error(
      `[CompactWorker] Empty leaf summary for ${conversationId.slice(0, 8)} (failure ${failures}/${breakerThreshold})`,
    )
    return 0
  }

  recordSuccess(conversationId)

  await client.query('BEGIN')
  try {
    const sumResult = await client.query<{ id: string }>(
      `INSERT INTO ros_summaries
         (conversation_id, depth, content, kind, message_count, earliest_at, latest_at, model, pipeline_version)
       VALUES ($1, 0, $2, 'leaf', $3, $4, $5, $6, $7) RETURNING id`,
      [
        conversationId,
        summaryText,
        messages.rows.length,
        messages.rows[0].created_at,
        messages.rows[messages.rows.length - 1].created_at,
        config.llmModel,
        PIPELINE_VERSION,
      ],
    )
    const summaryId = sumResult.rows[0].id

    const valueClauses: string[] = []
    const params: unknown[] = []
    let paramIdx = 1
    for (let i = 0; i < messages.rows.length; i++) {
      valueClauses.push(`($${paramIdx}, $${paramIdx + 1}, $${paramIdx + 2})`)
      params.push(summaryId, messages.rows[i].id, i)
      paramIdx += 3
    }
    await client.query(
      `INSERT INTO ros_summary_sources (summary_id, message_id, ordinal) VALUES ${valueClauses.join(', ')}`,
      params,
    )

    await client.query('COMMIT')
    console.log(
      `[CompactWorker] Leaf ${summaryId} (${messages.rows.length} msgs, conv ${conversationId.slice(0, 8)})`,
    )
    return 1
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  }
}

async function compactBranch(
  client: PgClient,
  convMeta: ConversationMeta,
  conversationId: string,
): Promise<number> {
  const leaves = await client.query<SummaryRow>(
    `SELECT id, content, kind, earliest_at, latest_at, message_count, created_at
     FROM ros_summaries
     WHERE conversation_id = $1 AND kind = 'leaf' AND parent_id IS NULL
     ORDER BY created_at ASC LIMIT $2`,
    [conversationId, config.branchBatchSize],
  )

  if (leaves.rows.length < config.minLeavesForBranch) return 0

  const formatted = formatBranchPrompt(convMeta, leaves.rows)

  console.log(
    `[CompactWorker] Branch: ${leaves.rows.length} leaves for ${conversationId.slice(0, 8)}`,
  )

  const summaryText = await callLlm(BRANCH_SYSTEM_PROMPT, formatted, BRANCH_MAX_TOKENS)
  if (!summaryText) {
    console.error(`[CompactWorker] Empty branch summary for ${conversationId}`)
    return 0
  }

  const totalMessages = leaves.rows.reduce((sum, r) => sum + Number(r.message_count ?? 0), 0)
  const earliestAt = leaves.rows[0].earliest_at ?? leaves.rows[0].created_at
  const lastLeaf = leaves.rows[leaves.rows.length - 1]
  const latestAt = lastLeaf.latest_at ?? lastLeaf.created_at

  await client.query('BEGIN')
  try {
    const sumResult = await client.query<{ id: string }>(
      `INSERT INTO ros_summaries
         (conversation_id, depth, content, kind, message_count, earliest_at, latest_at, model, pipeline_version)
       VALUES ($1, 1, $2, 'branch', $3, $4, $5, $6, $7) RETURNING id`,
      [
        conversationId,
        summaryText,
        totalMessages,
        earliestAt,
        latestAt,
        config.llmModel,
        PIPELINE_VERSION,
      ],
    )
    const branchId = sumResult.rows[0].id

    const leafIds = leaves.rows.map((r) => r.id)
    await client.query(
      `UPDATE ros_summaries SET parent_id = $1 WHERE id = ANY($2::uuid[])`,
      [branchId, leafIds],
    )

    await client.query('COMMIT')
    console.log(
      `[CompactWorker] Branch ${branchId} (${leaves.rows.length} leaves, ${totalMessages} msgs, conv ${conversationId.slice(0, 8)})`,
    )
    return 1
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  }
}

async function compactRoot(
  client: PgClient,
  convMeta: ConversationMeta,
  conversationId: string,
): Promise<number> {
  const branches = await client.query<SummaryRow>(
    `SELECT id, content, kind, earliest_at, latest_at, message_count, created_at
     FROM ros_summaries
     WHERE conversation_id = $1 AND kind = 'branch' AND parent_id IS NULL
     ORDER BY created_at ASC LIMIT $2`,
    [conversationId, config.rootBatchSize],
  )

  if (branches.rows.length < config.minBranchesForRoot) return 0

  const formatted = formatRootPrompt(convMeta, branches.rows)

  console.log(
    `[CompactWorker] Root: ${branches.rows.length} branches for ${conversationId.slice(0, 8)}`,
  )

  const summaryText = await callLlm(ROOT_SYSTEM_PROMPT, formatted, ROOT_MAX_TOKENS)
  if (!summaryText) {
    console.error(`[CompactWorker] Empty root summary for ${conversationId}`)
    return 0
  }

  const totalMessages = branches.rows.reduce((sum, r) => sum + Number(r.message_count ?? 0), 0)
  const earliestAt = branches.rows[0].earliest_at ?? branches.rows[0].created_at
  const lastBranch = branches.rows[branches.rows.length - 1]
  const latestAt = lastBranch.latest_at ?? lastBranch.created_at

  await client.query('BEGIN')
  try {
    const sumResult = await client.query<{ id: string }>(
      `INSERT INTO ros_summaries
         (conversation_id, depth, content, kind, message_count, earliest_at, latest_at, model, pipeline_version)
       VALUES ($1, 2, $2, 'root', $3, $4, $5, $6, $7) RETURNING id`,
      [
        conversationId,
        summaryText,
        totalMessages,
        earliestAt,
        latestAt,
        config.llmModel,
        PIPELINE_VERSION,
      ],
    )
    const rootId = sumResult.rows[0].id

    const branchIds = branches.rows.map((r) => r.id)
    await client.query(
      `UPDATE ros_summaries SET parent_id = $1 WHERE id = ANY($2::uuid[])`,
      [rootId, branchIds],
    )

    await client.query('COMMIT')
    console.log(
      `[CompactWorker] Root ${rootId} (${branches.rows.length} branches, ${totalMessages} msgs, conv ${conversationId.slice(0, 8)})`,
    )
    return 1
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  }
}

export const compactConversationTask: Task = async (payload, helpers) => {
  const { conversationId } = payload as CompactConversationPayload

  if (shouldSkip(conversationId)) {
    helpers.logger.info(
      `[compact-conversation] circuit-breaker open for ${conversationId.slice(0, 8)} — skipping`,
    )
    return
  }

  await helpers.withPgClient(async (client) => {
    const convMeta = await loadConversationMeta(client, conversationId)

    let leafRound = 0
    let totalCreated = 0
    while (leafRound < 10) {
      const created = await compactLeaf(client, convMeta, conversationId)
      if (created === 0) break
      totalCreated += created
      leafRound += 1
    }

    totalCreated += await compactBranch(client, convMeta, conversationId)
    totalCreated += await compactRoot(client, convMeta, conversationId)

    if (totalCreated > 0) {
      helpers.logger.info(
        `[compact-conversation] conv ${conversationId.slice(0, 8)} → ${totalCreated} summaries`,
      )
    }
  })
}
