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

/** Run `fn` inside a BEGIN/COMMIT, rolling back (best-effort) on any throw. */
export async function withTransaction<T>(client: PgClient, fn: () => Promise<T>): Promise<T> {
  await client.query('BEGIN')
  try {
    const result = await fn()
    await client.query('COMMIT')
    return result
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  }
}

interface SummaryInsert {
  conversationId: string
  depth: number
  kind: 'leaf' | 'branch' | 'root'
  content: string
  messageCount: number
  earliestAt: unknown
  latestAt: unknown
}

/** Insert one ros_summaries row and return its id. Caller owns the transaction. */
export async function insertSummary(client: PgClient, s: SummaryInsert): Promise<string> {
  const res = await client.query<{ id: string }>(
    `INSERT INTO ros_summaries
       (conversation_id, depth, content, kind, message_count, earliest_at, latest_at, model, pipeline_version)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
    [
      s.conversationId,
      s.depth,
      s.content,
      s.kind,
      s.messageCount,
      s.earliestAt,
      s.latestAt,
      config.llmModel,
      PIPELINE_VERSION,
    ],
  )
  return res.rows[0].id
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

  return withTransaction(client, async () => {
    const summaryId = await insertSummary(client, {
      conversationId,
      depth: 0,
      kind: 'leaf',
      content: summaryText,
      messageCount: messages.rows.length,
      earliestAt: messages.rows[0].created_at,
      latestAt: messages.rows[messages.rows.length - 1].created_at,
    })

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

    console.log(
      `[CompactWorker] Leaf ${summaryId} (${messages.rows.length} msgs, conv ${conversationId.slice(0, 8)})`,
    )
    return 1
  })
}

interface ParentLevelConfig {
  /** kind of the child summaries this level rolls up */
  childKind: 'leaf' | 'branch'
  /** depth/kind of the summary this level produces */
  depth: number
  kind: 'branch' | 'root'
  batchSize: number
  minChildren: number
  systemPrompt: string
  maxTokens: number
  formatPrompt: (meta: ConversationMeta, rows: SummaryRow[]) => string
  /** Display label, e.g. 'Branch' / 'Root' */
  label: string
}

/**
 * Roll a batch of child summaries (leaves→branch, branches→root) up into one
 * parent summary and re-parent the children. Branch and root differ only by the
 * config passed in.
 */
async function compactParentLevel(
  client: PgClient,
  convMeta: ConversationMeta,
  conversationId: string,
  cfg: ParentLevelConfig,
): Promise<number> {
  const children = await client.query<SummaryRow>(
    `SELECT id, content, kind, earliest_at, latest_at, message_count, created_at
     FROM ros_summaries
     WHERE conversation_id = $1 AND kind = $2 AND parent_id IS NULL
     ORDER BY created_at ASC LIMIT $3`,
    [conversationId, cfg.childKind, cfg.batchSize],
  )

  if (children.rows.length < cfg.minChildren) return 0

  const formatted = cfg.formatPrompt(convMeta, children.rows)

  console.log(
    `[CompactWorker] ${cfg.label}: ${children.rows.length} ${cfg.childKind}s for ${conversationId.slice(0, 8)}`,
  )

  const summaryText = await callLlm(cfg.systemPrompt, formatted, cfg.maxTokens)
  if (!summaryText) {
    console.error(`[CompactWorker] Empty ${cfg.kind} summary for ${conversationId}`)
    return 0
  }

  const totalMessages = children.rows.reduce((sum, r) => sum + Number(r.message_count ?? 0), 0)
  const earliestAt = children.rows[0].earliest_at ?? children.rows[0].created_at
  const lastChild = children.rows[children.rows.length - 1]
  const latestAt = lastChild.latest_at ?? lastChild.created_at

  return withTransaction(client, async () => {
    const parentId = await insertSummary(client, {
      conversationId,
      depth: cfg.depth,
      kind: cfg.kind,
      content: summaryText,
      messageCount: totalMessages,
      earliestAt,
      latestAt,
    })

    const childIds = children.rows.map((r) => r.id)
    await client.query(`UPDATE ros_summaries SET parent_id = $1 WHERE id = ANY($2::uuid[])`, [
      parentId,
      childIds,
    ])

    console.log(
      `[CompactWorker] ${cfg.kind} ${parentId} (${children.rows.length} ${cfg.childKind}s, ${totalMessages} msgs, conv ${conversationId.slice(0, 8)})`,
    )
    return 1
  })
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

    totalCreated += await compactParentLevel(client, convMeta, conversationId, {
      childKind: 'leaf',
      depth: 1,
      kind: 'branch',
      batchSize: config.branchBatchSize,
      minChildren: config.minLeavesForBranch,
      systemPrompt: BRANCH_SYSTEM_PROMPT,
      maxTokens: BRANCH_MAX_TOKENS,
      formatPrompt: formatBranchPrompt,
      label: 'Branch',
    })
    totalCreated += await compactParentLevel(client, convMeta, conversationId, {
      childKind: 'branch',
      depth: 2,
      kind: 'root',
      batchSize: config.rootBatchSize,
      minChildren: config.minBranchesForRoot,
      systemPrompt: ROOT_SYSTEM_PROMPT,
      maxTokens: ROOT_MAX_TOKENS,
      formatPrompt: formatRootPrompt,
      label: 'Root',
    })

    if (totalCreated > 0) {
      helpers.logger.info(
        `[compact-conversation] conv ${conversationId.slice(0, 8)} → ${totalCreated} summaries`,
      )
    }
  })
}
