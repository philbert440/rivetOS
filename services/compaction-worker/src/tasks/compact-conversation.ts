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
  isHeartbeatSessionKey,
  type ConversationMeta,
  type CompactMessageRow,
  type SummaryRow,
} from '@rivetos/memory-postgres'
import { config } from '../config.js'
import { callLlm, LlmCallError } from '../llm.js'
import {
  shouldSkip,
  recordFailure,
  recordSuccess,
  recordTerminal,
  logBreakerSkip,
  breakerThreshold,
  type CompactKind,
} from '../circuit-breaker.js'

export interface CompactConversationPayload {
  conversationId: string
  triggerType?: 'threshold' | 'session_idle' | 'session_stale' | 'explicit'
}

/**
 * Leaf floor for a compaction job: a 'session_stale' flush treats the
 * conversation as final and drops to staleMinBatch so its leftover below-floor
 * tail gets summarized; every other trigger holds the normal MIN_BATCH_SIZE.
 */
export function leafFloorFor(
  triggerType: CompactConversationPayload['triggerType'],
  staleMinBatch: number,
): number {
  return triggerType === 'session_stale' ? staleMinBatch : MIN_BATCH_SIZE
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
): Promise<ConversationMeta & { session_key: string | null }> {
  const { rows } = await client.query<ConversationMeta & { session_key: string | null }>(
    `SELECT id::text AS id, agent, channel, channel_id, title, session_key
       FROM ros_conversations
      WHERE id = $1`,
    [conversationId],
  )
  if (rows.length === 0) {
    throw new Error(`Conversation not found: ${conversationId}`)
  }
  return rows[0]
}

/** True when this conversation is scheduled-heartbeat noise, not user work. */
export function isHeartbeatConversation(meta: { session_key?: string | null }): boolean {
  return isHeartbeatSessionKey(meta.session_key)
}

/** Postgres deadlock SQLSTATE. node-pg puts this on `err.code`. */
export const PG_DEADLOCK_CODE = '40P01'

/** How many times to re-run a summary write after 40P01. */
export const DEADLOCK_RETRIES = 3

export function isPgDeadlockError(err: unknown): boolean {
  if (
    err &&
    typeof err === 'object' &&
    'code' in err &&
    (err as { code?: string }).code === PG_DEADLOCK_CODE
  ) {
    return true
  }
  const msg = err instanceof Error ? err.message : String(err)
  return /deadlock detected/i.test(msg)
}

function deadlockBackoffMs(attempt: number): number {
  return 25 * (attempt + 1) * (attempt + 1)
}

/**
 * Human-readable message for a thrown value. Prefer Error.message, then a
 * `.message` field, then JSON — `String({…})` is `[object Object]`.
 */
export function formatThrown(err: unknown): string {
  if (err instanceof Error) return err.message
  if (typeof err === 'string') return err
  if (err && typeof err === 'object') {
    const message = (err as { message?: unknown }).message
    if (typeof message === 'string' && message.length > 0) return message
    try {
      const json = JSON.stringify(err)
      if (json && json !== '{}') return json
    } catch {
      // circular / bigint
    }
  }
  return String(err)
}

/**
 * True on the job's last graphile attempt (`attempts >= max_attempts`).
 * Missing job metadata is treated as final so an un-instrumented caller still
 * records a breaker failure rather than retrying forever with no skip.
 */
export function isJobFinalAttempt(job: { attempts?: number; max_attempts?: number }): boolean {
  const attempts = job.attempts ?? 1
  const maxAttempts = job.max_attempts ?? 1
  return attempts >= maxAttempts
}

const TRUNCATION_RE = /truncated at max_tokens=/i

/** True when callLlm exhausted the output budget — same prompt will not help. */
export function isLlmTruncationError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return TRUNCATION_RE.test(msg)
}

/**
 * Next smaller leaf batch after a truncated LLM response.
 * Null when the batch is already at the floor (cannot shrink further).
 */
export function shrinkLeafBatch(current: number, minBatch: number): number | null {
  if (current <= minBatch) return null
  const next = Math.max(minBatch, Math.floor(current / 2))
  return next < current ? next : null
}

/**
 * LLM failures must fail the graphile job so it retries with backoff.
 *
 * Returning 0 used to mark the job successful: enqueue-idle saw no problem
 * while conversations sat unsummarized (live: 2,966 rivet-claude messages
 * eligible; compact-conversation last_error stayed empty). The in-process
 * circuit breaker still trips so a down LLM is not hammered every 5 minutes
 * after THRESHOLD failures. Callers that already skip via `shouldSkip` keep
 * exiting cleanly — this is only for an in-flight `callLlm` throw.
 *
 * Breaker semantics (findings 1+2, one coherent design):
 * - Entries are keyed `${conversationId}:${kind}` (leaf / branch / root).
 *   `shouldSkip` is consulted per level; a successful leaf cannot wipe a
 *   failing parent.
 * - Transient failures increment the breaker only on the job's *final*
 *   graphile attempt. One job's maxAttempts:3 retries therefore count as a
 *   single failure; THRESHOLD=3 still means ~3 exhausted jobs (enqueue-idle
 *   revival) before a 1-hour skip. Intermediate attempts still rethrow so
 *   graphile last_error stays honest and backoff still runs.
 * - Non-retryable LlmCallError (permanent 4xx) records a *terminal* skip for
 *   that level immediately — no threshold, no 1-hour expiry — and still
 *   throws so this attempt's last_error is recorded. Later jobs skip the LLM.
 */
export function propagateLlmFailure(
  conversationId: string,
  err: unknown,
  kind: CompactKind,
  opts: { isFinalAttempt: boolean },
): never {
  const msg = formatThrown(err)
  const permanent = err instanceof LlmCallError && !err.retryable

  if (permanent) {
    recordTerminal(conversationId, kind)
    console.error(
      `[CompactWorker] ${kind} LLM permanent failure for ${conversationId.slice(0, 8)}: ${msg} (terminal; skipping further attempts at this level)`,
    )
  } else if (opts.isFinalAttempt) {
    const failures = recordFailure(conversationId, kind)
    console.error(
      `[CompactWorker] ${kind} LLM failed for ${conversationId.slice(0, 8)}: ${msg} (failure ${failures}/${breakerThreshold})`,
    )
  } else {
    console.error(
      `[CompactWorker] ${kind} LLM failed for ${conversationId.slice(0, 8)}: ${msg} (graphile will retry; breaker not incremented)`,
    )
  }

  throw err instanceof Error ? err : new Error(msg)
}

/**
 * Run `fn` inside a BEGIN/COMMIT, rolling back (best-effort) on any throw.
 *
 * `40P01 deadlock detected` is retried with short backoff. Leaf inserts fire
 * the embed-target trigger (`graphile_worker.add_job`) while they also write
 * `ros_summary_sources`; concurrent ingest/embed jobs take the same job-table
 * locks in a different order and abort the whole compact job. graphile then
 * burns max_attempts and the conversation sits in memory_stats as a stuck
 * compact-conversation row — live: 5 dead since 2026-08-22.
 */
export async function withTransaction<T>(client: PgClient, fn: () => Promise<T>): Promise<T> {
  let lastErr: unknown
  for (let attempt = 0; attempt <= DEADLOCK_RETRIES; attempt++) {
    await client.query('BEGIN')
    try {
      const result = await fn()
      await client.query('COMMIT')
      return result
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {})
      lastErr = err
      if (!isPgDeadlockError(err) || attempt === DEADLOCK_RETRIES) {
        throw err
      }
      const delay = deadlockBackoffMs(attempt)
      console.warn(
        `[CompactWorker] deadlock on summary write, retry ${String(attempt + 1)}/${String(DEADLOCK_RETRIES)} in ${String(delay)}ms`,
      )
      await new Promise((resolve) => setTimeout(resolve, delay))
    }
  }
  throw lastErr
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

/**
 * Enqueue wiki extraction for a committed leaf. Best-effort: extract-wiki is
 * idempotent on summary_id and enqueue-wiki-backfill will pick up a miss.
 *
 * Must NOT run inside the summary INSERT transaction. That INSERT already
 * fires `notify_embedding_queue` → `add_job('embed-target')`. A second
 * `add_job('extract-wiki')` in the same TX holds graphile job-table locks
 * together with ros_summaries / ros_summary_sources, which deadlocks against
 * concurrent ingest/embed workers.
 */
export async function enqueueExtractWiki(
  client: PgClient,
  summaryId: string,
  conversationId: string,
): Promise<void> {
  try {
    await client.query(
      `SELECT graphile_worker.add_job('extract-wiki', $1::json,
              job_key := $2, max_attempts := 2, priority := 5)`,
      [JSON.stringify({ summaryId, conversationId }), `wiki-ext-${summaryId}`],
    )
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.warn(
      `[CompactWorker] extract-wiki enqueue failed for ${summaryId.slice(0, 8)} (backfill will retry): ${msg}`,
    )
  }
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
  minBatch: number = MIN_BATCH_SIZE,
  isFinalAttempt = true,
): Promise<number> {
  if (shouldSkip(conversationId, 'leaf')) {
    logBreakerSkip(conversationId, 'leaf')
    return 0
  }

  const messages = await client.query<CompactMessageRow & { id: string }>(
    `SELECT m.id, m.role, m.content, m.agent, m.created_at, m.tool_name, m.tool_args
     FROM ros_messages m
     LEFT JOIN ros_summary_sources ss ON ss.message_id = m.id
     WHERE ss.summary_id IS NULL AND m.conversation_id = $1
       AND ((m.content IS NOT NULL AND LENGTH(m.content) > 10) OR m.tool_name IS NOT NULL)
     ORDER BY m.created_at ASC LIMIT $2`,
    [conversationId, config.leafBatchSize],
  )

  if (messages.rows.length < minBatch) return 0

  // Truncation at max_tokens is a batch-size problem, not a transient blip:
  // retrying the same 10 huge capture rows just burns graphile attempts
  // (live: 122 dead compact-conversation jobs since 2026-08-28). Shrink the
  // prefix we send; leftover rows stay unsummarized for the next leaf round.
  let batch = messages.rows
  let summaryText: string
  for (;;) {
    const formatted = formatLeafPrompt(convMeta, batch)
    console.log(
      `[CompactWorker] Leaf: ${String(batch.length)} messages for ${conversationId.slice(0, 8)}`,
    )
    try {
      summaryText = await callLlm(LEAF_SYSTEM_PROMPT, formatted, LEAF_MAX_TOKENS)
      break
    } catch (err) {
      const next = shrinkLeafBatch(batch.length, minBatch)
      if (isLlmTruncationError(err) && next !== null) {
        console.warn(
          `[CompactWorker] leaf truncated at ${String(batch.length)} msgs for ${conversationId.slice(0, 8)}, retrying with ${String(next)}`,
        )
        batch = batch.slice(0, next)
        continue
      }
      propagateLlmFailure(conversationId, err, 'leaf', { isFinalAttempt })
    }
  }

  recordSuccess(conversationId, 'leaf')

  const summaryId = await withTransaction(client, async () => {
    const id = await insertSummary(client, {
      conversationId,
      depth: 0,
      kind: 'leaf',
      content: summaryText,
      messageCount: batch.length,
      earliestAt: batch[0].created_at,
      latestAt: batch[batch.length - 1].created_at,
    })

    const valueClauses: string[] = []
    const params: unknown[] = []
    let paramIdx = 1
    for (let i = 0; i < batch.length; i++) {
      valueClauses.push(`($${paramIdx}, $${paramIdx + 1}, $${paramIdx + 2})`)
      params.push(id, batch[i].id, i)
      paramIdx += 3
    }
    await client.query(
      `INSERT INTO ros_summary_sources (summary_id, message_id, ordinal) VALUES ${valueClauses.join(', ')}`,
      params,
    )

    console.log(
      `[CompactWorker] Leaf ${id} (${String(batch.length)} msgs, conv ${conversationId.slice(0, 8)})`,
    )
    return id
  })

  // After COMMIT — extract-wiki is flag-gated + idempotent; backfill covers a miss.
  await enqueueExtractWiki(client, summaryId, conversationId)
  return 1
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
  isFinalAttempt = true,
): Promise<number> {
  if (shouldSkip(conversationId, cfg.kind)) {
    logBreakerSkip(conversationId, cfg.kind)
    return 0
  }

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

  let summaryText: string
  try {
    summaryText = await callLlm(cfg.systemPrompt, formatted, cfg.maxTokens)
  } catch (err) {
    propagateLlmFailure(conversationId, err, cfg.kind, { isFinalAttempt })
  }

  recordSuccess(conversationId, cfg.kind)

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
  const { conversationId, triggerType } = payload as CompactConversationPayload
  const isFinalAttempt = isJobFinalAttempt(helpers.job)

  const leafFloor = leafFloorFor(triggerType, config.staleMinBatch)

  await helpers.withPgClient(async (client) => {
    const convMeta = await loadConversationMeta(client, conversationId)
    if (isHeartbeatConversation(convMeta)) {
      helpers.logger.info(
        `[compact-conversation] skip heartbeat conversation ${conversationId.slice(0, 8)}`,
      )
      return
    }

    let leafRound = 0
    let totalCreated = 0
    while (leafRound < 10) {
      const created = await compactLeaf(client, convMeta, conversationId, leafFloor, isFinalAttempt)
      if (created === 0) break
      totalCreated += created
      leafRound += 1
    }

    totalCreated += await compactParentLevel(
      client,
      convMeta,
      conversationId,
      {
        childKind: 'leaf',
        depth: 1,
        kind: 'branch',
        batchSize: config.branchBatchSize,
        minChildren: config.minLeavesForBranch,
        systemPrompt: BRANCH_SYSTEM_PROMPT,
        maxTokens: BRANCH_MAX_TOKENS,
        formatPrompt: formatBranchPrompt,
        label: 'Branch',
      },
      isFinalAttempt,
    )
    totalCreated += await compactParentLevel(
      client,
      convMeta,
      conversationId,
      {
        childKind: 'branch',
        depth: 2,
        kind: 'root',
        batchSize: config.rootBatchSize,
        minChildren: config.minBranchesForRoot,
        systemPrompt: ROOT_SYSTEM_PROMPT,
        maxTokens: ROOT_MAX_TOKENS,
        formatPrompt: formatRootPrompt,
        label: 'Root',
      },
      isFinalAttempt,
    )

    if (totalCreated > 0) {
      helpers.logger.info(
        `[compact-conversation] conv ${conversationId.slice(0, 8)} → ${totalCreated} summaries`,
      )
    }
  })
}
