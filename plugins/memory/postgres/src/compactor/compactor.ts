/**
 * BackgroundCompactor — v5 memory-quality pipeline.
 *
 * Features:
 * - Rich formatter with conversation metadata, ISO-minute timestamps, agent attribution, tool-call fallback.
 * - v5 battle-tested prompts (verbatim from prompts.mjs).
 * - 7000/14000/20000 token budgets for leaf/branch/root.
 * - Hardened undici Agent (no headersTimeout/bodyTimeout — relies on AbortSignal only).
 * - No content truncation (128k ctx).
 * - Model tag 'rivet-refined-v5' (or config override).
 * - loadConversationMeta for preamble.
 *
 * See /rivet-shared/summary-refine/pr-spec.md for exact requirements.
 */

import pg from 'pg'
import { Agent, fetch as undiciFetch } from 'undici'
import {
  fmtIsoMinute,
  sanitizeForJson,
  MIN_BATCH_SIZE,
  MAX_CONVERSATIONS_PER_CYCLE,
  LEAF_MAX_TOKENS,
  BRANCH_MAX_TOKENS,
  ROOT_MAX_TOKENS,
  LLM_TIMEOUT_MS,
  LLM_TEMPERATURE,
  LLM_RETRIES,
  LLM_RETRY_BACKOFF_MS,
  LEAF_SYSTEM_PROMPT,
  BRANCH_SYSTEM_PROMPT,
  ROOT_SYSTEM_PROMPT,
  type CompactorConfig,
  type CompactorMetrics,
  type CandidateRow,
  type CompactMessageRow,
  type SummaryRow,
  type IdRow,
  type LlmResponse,
  type BranchCandidateRow,
  type RootCandidateRow,
  type ConversationMeta,
} from './types.js'

const httpDispatcher = new Agent({
  headersTimeout: 0, // rely on AbortSignal only
  bodyTimeout: 0,
  keepAliveTimeout: 60_000,
  keepAliveMaxTimeout: 600_000,
  connect: { timeout: 30_000 },
  pipelining: 0,
})

export class BackgroundCompactor {
  private pool: pg.Pool
  private endpoint: string
  private model: string
  private apiKey: string
  private intervalMs: number
  private minUnsummarized: number
  private batchSize: number
  private minLeafsForBranch: number
  private branchBatchSize: number
  private minBranchesForRoot: number
  private rootBatchSize: number
  private timer: ReturnType<typeof setInterval> | null = null
  private running: boolean = false
  private circuitBreaker: Map<string, { failures: number; lastFailAt: number }> = new Map()
  private static readonly CIRCUIT_BREAKER_THRESHOLD = 3
  private static readonly CIRCUIT_BREAKER_RESET_MS = 3_600_000 // 1 hour

  private metrics: CompactorMetrics = {
    cyclesCompleted: 0,
    leafsCreated: 0,
    branchesCreated: 0,
    rootsCreated: 0,
    llmCalls: 0,
    llmFailures: 0,
    lastCycleAt: null,
    lastCycleDurationMs: 0,
  }

  constructor(config: CompactorConfig) {
    if (!config.compactorEndpoint) {
      throw new Error(
        '[Compactor] compactor_endpoint is required — set it in config.yaml under memory.postgres.compactor_endpoint',
      )
    }
    this.endpoint = config.compactorEndpoint
    this.model = config.compactorModel ?? 'rivet-refined-v5'
    this.apiKey = config.compactorApiKey ?? ''
    this.intervalMs = config.intervalMs ?? 1_800_000
    this.minUnsummarized = config.minUnsummarized ?? 50
    this.batchSize = config.batchSize ?? 10
    this.minLeafsForBranch = config.minLeafsForBranch ?? 5
    this.branchBatchSize = config.branchBatchSize ?? 8
    this.minBranchesForRoot = config.minBranchesForRoot ?? 3
    this.rootBatchSize = config.rootBatchSize ?? 5
    this.pool = new pg.Pool({ connectionString: config.connectionString, max: 2 })
  }

  start(): void {
    if (this.timer) return
    console.log(
      `[Compactor] Starting v5 pipeline (every ${String(this.intervalMs / 60_000)}min, ` +
        `leaf threshold ${String(this.minUnsummarized)} msgs, ` +
        `branch threshold ${String(this.minLeafsForBranch)} leaves, ` +
        `root threshold ${String(this.minBranchesForRoot)} branches)`,
    )
    console.log(`[Compactor] Endpoint: ${this.endpoint} (model: ${this.model})`)

    setTimeout(() => void this.cycle(), 60_000)
    this.timer = setInterval(() => void this.cycle(), this.intervalMs)
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  async close(): Promise<void> {
    this.stop()
    await this.pool.end()
  }

  getMetrics(): CompactorMetrics {
    return { ...this.metrics }
  }

  // -----------------------------------------------------------------------
  // Main cycle: leaf → branch → root (bottom-up)
  // -----------------------------------------------------------------------

  private async cycle(): Promise<void> {
    if (this.running) return
    this.running = true

    const cycleStart = Date.now()

    try {
      await this.compactLeaves()
      await this.compactBranches()
      await this.compactRoots()

      this.metrics.cyclesCompleted++
      this.metrics.lastCycleAt = new Date()
      this.metrics.lastCycleDurationMs = Date.now() - cycleStart
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error)
      console.error(`[Compactor] Cycle failed: ${msg}`)
    } finally {
      this.running = false
    }
  }

  private async loadConversationMeta(
    client: pg.PoolClient | pg.Pool,
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

  // =======================================================================
  // Level 0: Leaf compaction (messages → leaf)
  // =======================================================================

  private async compactLeaves(): Promise<void> {
    const candidates = await this.pool.query<CandidateRow>(
      `SELECT m.conversation_id, COUNT(*) AS unsummarized
       FROM ros_messages m
       LEFT JOIN ros_summary_sources ss ON ss.message_id = m.id
       WHERE ss.summary_id IS NULL 
         AND (
           (m.content IS NOT NULL AND LENGTH(m.content) > 10)
        OR m.tool_name IS NOT NULL
         )
       GROUP BY m.conversation_id
       HAVING COUNT(*) >= $1
       ORDER BY COUNT(*) DESC LIMIT $2`,
      [this.minUnsummarized, MAX_CONVERSATIONS_PER_CYCLE],
    )

    if (candidates.rows.length === 0) return
    console.log(
      `[Compactor] Leaf: ${String(candidates.rows.length)} conversation(s) need compaction`,
    )

    for (const row of candidates.rows) {
      const cb = this.circuitBreaker.get(row.conversation_id)
      if (cb && cb.failures >= BackgroundCompactor.CIRCUIT_BREAKER_THRESHOLD) {
        if (Date.now() - cb.lastFailAt < BackgroundCompactor.CIRCUIT_BREAKER_RESET_MS) {
          console.log(
            `[Compactor] Circuit breaker: skipping ${row.conversation_id.slice(0, 8)}… ` +
              `(${String(cb.failures)} consecutive failures, will retry after reset)`,
          )
          continue
        }
        this.circuitBreaker.delete(row.conversation_id)
        console.log(`[Compactor] Circuit breaker reset for ${row.conversation_id.slice(0, 8)}…`)
      }

      try {
        await this.compactLeafConversation(row.conversation_id)
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error)
        console.error(`[Compactor] Leaf failed for ${row.conversation_id}: ${msg}`)
      }
    }
  }

  private async compactLeafConversation(conversationId: string): Promise<void> {
    const clientForMeta = await this.pool.connect()
    let convMeta: ConversationMeta
    try {
      convMeta = await this.loadConversationMeta(clientForMeta, conversationId)
    } finally {
      clientForMeta.release()
    }

    const messages = await this.pool.query<CompactMessageRow>(
      `SELECT m.id, m.role, m.content, m.agent, m.created_at, m.tool_name, m.tool_args
       FROM ros_messages m
       LEFT JOIN ros_summary_sources ss ON ss.message_id = m.id
       WHERE ss.summary_id IS NULL AND m.conversation_id = $1
         AND (
           (m.content IS NOT NULL AND LENGTH(m.content) > 10)
        OR m.tool_name IS NOT NULL
         )
       ORDER BY m.created_at ASC LIMIT $2`,
      [conversationId, this.batchSize],
    )

    if (messages.rows.length < MIN_BATCH_SIZE) return

    const formatted = formatLeafPrompt(convMeta, messages.rows)

    const summaryText = await this.callLlm(LEAF_SYSTEM_PROMPT, formatted, LEAF_MAX_TOKENS)
    if (!summaryText) {
      const entry = this.circuitBreaker.get(conversationId) ?? { failures: 0, lastFailAt: 0 }
      entry.failures++
      entry.lastFailAt = Date.now()
      this.circuitBreaker.set(conversationId, entry)
      console.error(
        `[Compactor] Empty leaf summary for ${conversationId.slice(0, 8)}… ` +
          `(failure ${String(entry.failures)}/${String(BackgroundCompactor.CIRCUIT_BREAKER_THRESHOLD)})`,
      )
      return
    }

    this.circuitBreaker.delete(conversationId)

    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')

      const sumResult = await client.query<IdRow>(
        `INSERT INTO ros_summaries
           (conversation_id, depth, content, kind, message_count, earliest_at, latest_at, model)
         VALUES ($1, 0, $2, 'leaf', $3, $4, $5, $6) RETURNING id`,
        [
          conversationId,
          summaryText,
          messages.rows.length,
          messages.rows[0].created_at,
          messages.rows[messages.rows.length - 1].created_at,
          this.model,
        ],
      )
      const summaryId = sumResult.rows[0].id

      if (messages.rows.length > 0) {
        const values: string[] = []
        const params: unknown[] = []
        let pi = 1
        for (let i = 0; i < messages.rows.length; i++) {
          values.push(`($${String(pi)}, $${String(pi + 1)}, $${String(pi + 2)})`)
          params.push(summaryId, messages.rows[i].id, i)
          pi += 3
        }
        await client.query(
          `INSERT INTO ros_summary_sources (summary_id, message_id, ordinal) VALUES ${values.join(', ')}`,
          params,
        )
      }

      await client.query('COMMIT')
      this.metrics.leafsCreated++
      console.log(
        `[Compactor] Leaf ${summaryId} (${String(messages.rows.length)} messages, conversation ${conversationId.slice(0, 8)}…)`,
      )
    } catch (err: unknown) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  }

  // =======================================================================
  // Level 1: Branch compaction (leaves → branch)
  // =======================================================================

  private async compactBranches(): Promise<void> {
    const candidates = await this.pool.query<BranchCandidateRow>(
      `SELECT s.conversation_id, COUNT(*) AS leaf_count
       FROM ros_summaries s
       WHERE s.kind = 'leaf' AND s.parent_id IS NULL
       GROUP BY s.conversation_id
       HAVING COUNT(*) >= $1
       ORDER BY COUNT(*) DESC LIMIT $2`,
      [this.minLeafsForBranch, MAX_CONVERSATIONS_PER_CYCLE],
    )

    if (candidates.rows.length === 0) return
    console.log(
      `[Compactor] Branch: ${String(candidates.rows.length)} conversation(s) have enough leaves`,
    )

    for (const row of candidates.rows) {
      try {
        await this.compactBranchConversation(row.conversation_id)
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error)
        console.error(`[Compactor] Branch failed for ${row.conversation_id}: ${msg}`)
      }
    }
  }

  private async compactBranchConversation(conversationId: string): Promise<void> {
    const clientForMeta = await this.pool.connect()
    let convMeta: ConversationMeta
    try {
      convMeta = await this.loadConversationMeta(clientForMeta, conversationId)
    } finally {
      clientForMeta.release()
    }

    const leaves = await this.pool.query<SummaryRow>(
      `SELECT id, content, kind, earliest_at, latest_at, message_count, created_at
       FROM ros_summaries
       WHERE conversation_id = $1 AND kind = 'leaf' AND parent_id IS NULL
       ORDER BY created_at ASC LIMIT $2`,
      [conversationId, this.branchBatchSize],
    )

    if (leaves.rows.length < this.minLeafsForBranch) return

    const formatted = formatBranchPrompt(convMeta, leaves.rows)

    const summaryText = await this.callLlm(BRANCH_SYSTEM_PROMPT, formatted, BRANCH_MAX_TOKENS)
    if (!summaryText) {
      console.error(`[Compactor] Empty branch summary for conversation ${conversationId}`)
      return
    }

    const totalMessages = leaves.rows.reduce((sum, r) => sum + r.message_count, 0)
    const earliestAt = leaves.rows[0].earliest_at ?? leaves.rows[0].created_at
    const lastLeaf = leaves.rows[leaves.rows.length - 1]
    const latestAt = lastLeaf.latest_at ?? lastLeaf.created_at

    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')

      const sumResult = await client.query<IdRow>(
        `INSERT INTO ros_summaries
           (conversation_id, depth, content, kind, message_count, earliest_at, latest_at, model)
         VALUES ($1, 1, $2, 'branch', $3, $4, $5, $6) RETURNING id`,
        [conversationId, summaryText, totalMessages, earliestAt, latestAt, this.model],
      )
      const branchId = sumResult.rows[0].id

      const leafIds = leaves.rows.map((r) => r.id)
      await client.query(`UPDATE ros_summaries SET parent_id = $1 WHERE id = ANY($2::uuid[])`, [
        branchId,
        leafIds,
      ])

      await client.query('COMMIT')
      this.metrics.branchesCreated++
      console.log(
        `[Compactor] Branch ${branchId} (${String(leaves.rows.length)} leaves, ${String(totalMessages)} msgs, conversation ${conversationId.slice(0, 8)}…)`,
      )
    } catch (err: unknown) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  }

  // =======================================================================
  // Level 2: Root compaction (branches → root)
  // =======================================================================

  private async compactRoots(): Promise<void> {
    const candidates = await this.pool.query<RootCandidateRow>(
      `SELECT s.conversation_id, COUNT(*) AS branch_count
       FROM ros_summaries s
       WHERE s.kind = 'branch' AND s.parent_id IS NULL
       GROUP BY s.conversation_id
       HAVING COUNT(*) >= $1
       ORDER BY COUNT(*) DESC LIMIT $2`,
      [this.minBranchesForRoot, MAX_CONVERSATIONS_PER_CYCLE],
    )

    if (candidates.rows.length === 0) return
    console.log(
      `[Compactor] Root: ${String(candidates.rows.length)} conversation(s) have enough branches`,
    )

    for (const row of candidates.rows) {
      try {
        await this.compactRootConversation(row.conversation_id)
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error)
        console.error(`[Compactor] Root failed for ${row.conversation_id}: ${msg}`)
      }
    }
  }

  private async compactRootConversation(conversationId: string): Promise<void> {
    const clientForMeta = await this.pool.connect()
    let convMeta: ConversationMeta
    try {
      convMeta = await this.loadConversationMeta(clientForMeta, conversationId)
    } finally {
      clientForMeta.release()
    }

    const branches = await this.pool.query<SummaryRow>(
      `SELECT id, content, kind, earliest_at, latest_at, message_count, created_at
       FROM ros_summaries
       WHERE conversation_id = $1 AND kind = 'branch' AND parent_id IS NULL
       ORDER BY created_at ASC LIMIT $2`,
      [conversationId, this.rootBatchSize],
    )

    if (branches.rows.length < this.minBranchesForRoot) return

    const formatted = formatRootPrompt(convMeta, branches.rows)

    const summaryText = await this.callLlm(ROOT_SYSTEM_PROMPT, formatted, ROOT_MAX_TOKENS)
    if (!summaryText) {
      console.error(`[Compactor] Empty root summary for conversation ${conversationId}`)
      return
    }

    const totalMessages = branches.rows.reduce((sum, r) => sum + r.message_count, 0)
    const earliestAt = branches.rows[0].earliest_at ?? branches.rows[0].created_at
    const lastBranch = branches.rows[branches.rows.length - 1]
    const latestAt = lastBranch.latest_at ?? lastBranch.created_at

    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')

      const sumResult = await client.query<IdRow>(
        `INSERT INTO ros_summaries
           (conversation_id, depth, content, kind, message_count, earliest_at, latest_at, model)
         VALUES ($1, 2, $2, 'root', $3, $4, $5, $6) RETURNING id`,
        [conversationId, summaryText, totalMessages, earliestAt, latestAt, this.model],
      )
      const rootId = sumResult.rows[0].id

      const branchIds = branches.rows.map((r) => r.id)
      await client.query(`UPDATE ros_summaries SET parent_id = $1 WHERE id = ANY($2::uuid[])`, [
        rootId,
        branchIds,
      ])

      await client.query('COMMIT')
      this.metrics.rootsCreated++
      console.log(
        `[Compactor] Root ${rootId} (${String(branches.rows.length)} branches, ${String(totalMessages)} msgs, conversation ${conversationId.slice(0, 8)}…)`,
      )
    } catch (err: unknown) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  }

  // -----------------------------------------------------------------------
  // Hardened LLM client (undici + retries + thinking mode)
  // -----------------------------------------------------------------------

  private async callLlm(
    systemPrompt: string,
    userContent: string,
    maxTokens: number,
  ): Promise<string | null> {
    this.metrics.llmCalls++

    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS)

    let lastError: Error | null = null

    for (let attempt = 0; attempt <= LLM_RETRIES; attempt++) {
      try {
        const headers: Record<string, string> = { 'Content-Type': 'application/json' }
        if (this.apiKey) {
          headers['Authorization'] = `Bearer ${this.apiKey}`
        }

        const response = await undiciFetch(`${this.endpoint}/chat/completions`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            model: this.model,
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: userContent },
            ],
            max_tokens: maxTokens,
            temperature: LLM_TEMPERATURE,
            // Thinking mode always on for v5 (no enable_thinking: false)
          }),
          dispatcher: httpDispatcher,
          signal: controller.signal,
        })

        clearTimeout(timeoutId)

        if (!response.ok) {
          this.metrics.llmFailures++
          const statusErr = new Error(`HTTP ${response.status}: ${response.statusText}`)
          if (response.status >= 500 || response.status === 0) {
            lastError = statusErr
            if (attempt < LLM_RETRIES) {
              const backoff = (attempt + 1) * LLM_RETRY_BACKOFF_MS
              console.error(
                `[Compactor] LLM ${response.status}, retry ${attempt + 1} in ${backoff}ms`,
              )
              await new Promise((r) => setTimeout(r, backoff))
              continue
            }
          }
          console.error(
            `[Compactor] LLM returned ${String(response.status)}: ${response.statusText}`,
          )
          return null
        }

        const data = (await response.json()) as LlmResponse
        const message = data.choices?.[0]?.message
        return message?.content ?? message?.reasoning_content ?? null
      } catch (error: unknown) {
        clearTimeout(timeoutId)
        lastError = error instanceof Error ? error : new Error(String(error))

        if (attempt < LLM_RETRIES) {
          const backoff = (attempt + 1) * LLM_RETRY_BACKOFF_MS
          console.error(
            `[Compactor] LLM error (attempt ${attempt + 1}): ${lastError.message}, retry in ${backoff}ms`,
          )
          await new Promise((r) => setTimeout(r, backoff))
          continue
        }
        break
      }
    }

    this.metrics.llmFailures++
    console.error(
      `[Compactor] LLM call failed after ${LLM_RETRIES + 1} attempts: ${lastError?.message}`,
    )
    return null
  }
}

// -----------------------------------------------------------------------
// Formatters — exact spec from pr-spec.md §1.2 (exported for worker reuse)
// -----------------------------------------------------------------------

export function formatLeafPrompt(conv: ConversationMeta, msgs: CompactMessageRow[]): string {
  const span = msgs.length
    ? `${fmtIsoMinute(msgs[0].created_at)} → ${fmtIsoMinute(msgs[msgs.length - 1].created_at)}`
    : ''
  const preamble = [
    `[conversation]`,
    `  id:        ${conv.id}`,
    `  agent:     ${conv.agent ?? 'unknown'}`,
    `  channel:   ${conv.channel ?? 'unknown'}${conv.channel_id ? ` (${conv.channel_id})` : ''}`,
    conv.title ? `  title:     ${conv.title}` : null,
    `  span:      ${span}`,
    `  messages:  ${msgs.length} in this batch`,
  ]
    .filter(Boolean)
    .join('\n')

  const body = msgs
    .map((m, i) => {
      const idx = String(i + 1).padStart(2, '0')
      const when = fmtIsoMinute(m.created_at)
      const role = m.role || 'unknown'
      const agent = m.agent ? `${m.agent}/` : ''

      let content = m.content ?? ''
      if (!content && m.tool_name) {
        // Bounded excerpt of tool_args — fallback only. Tool-call messages
        // should normally have natural-language `content` written by the
        // tool-synth pipeline; we only hit this branch when synthesis
        // hasn't run yet or failed. Cap at 2000 chars because raw JSON
        // blobs (shell stdout, diff payloads, large embeddings) have low
        // per-char information density and would otherwise dominate the
        // leaf-prompt budget.
        const args = m.tool_args ? JSON.stringify(m.tool_args).slice(0, 2000) : ''
        content = `(tool call) ${m.tool_name}${args ? ' ' + args : ''}`
      }

      const sep = i < msgs.length - 1 ? '\n\n---\n\n' : ''
      return `[#${idx} ${when} ${agent}${role}]\n${sanitizeForJson(content)}${sep}`
    })
    .join('')

  return `${preamble}\n\n---\n\n${body}`
}

export function formatBranchPrompt(conv: ConversationMeta, leaves: SummaryRow[]): string {
  const span = leaves.length
    ? `${fmtIsoMinute(leaves[0].earliest_at ?? leaves[0].created_at)} → ${fmtIsoMinute(
        leaves[leaves.length - 1].latest_at ?? leaves[leaves.length - 1].created_at,
      )}`
    : ''
  const preamble = [
    `[conversation]`,
    `  id:        ${conv.id}`,
    `  agent:     ${conv.agent ?? 'unknown'}`,
    `  channel:   ${conv.channel ?? 'unknown'}${conv.channel_id ? ` (${conv.channel_id})` : ''}`,
    conv.title ? `  title:     ${conv.title}` : null,
    `  leaves:    ${leaves.length} in this branch`,
    `  span:      ${span}`,
  ]
    .filter(Boolean)
    .join('\n')

  const body = leaves
    .map((s, i) => {
      const idx = String(i + 1).padStart(2, '0')
      const from = fmtIsoMinute(s.earliest_at ?? s.created_at)
      const to = fmtIsoMinute(s.latest_at ?? s.created_at)
      const msgs = s.message_count
      const sep = i < leaves.length - 1 ? '\n\n---\n\n' : ''
      return `[Leaf #${idx} ${from} → ${to} | ${msgs} msgs]\n${sanitizeForJson(s.content)}${sep}`
    })
    .join('')

  return `${preamble}\n\n---\n\n${body}`
}

export function formatRootPrompt(conv: ConversationMeta, branches: SummaryRow[]): string {
  const span = branches.length
    ? `${fmtIsoMinute(branches[0].earliest_at ?? branches[0].created_at)} → ${fmtIsoMinute(
        branches[branches.length - 1].latest_at ?? branches[branches.length - 1].created_at,
      )}`
    : ''
  const preamble = [
    `[conversation]`,
    `  id:        ${conv.id}`,
    `  agent:     ${conv.agent ?? 'unknown'}`,
    `  channel:   ${conv.channel ?? 'unknown'}${conv.channel_id ? ` (${conv.channel_id})` : ''}`,
    conv.title ? `  title:     ${conv.title}` : null,
    `  branches:  ${branches.length} in this root`,
    `  span:      ${span}`,
  ]
    .filter(Boolean)
    .join('\n')

  const body = branches
    .map((s, i) => {
      const idx = String(i + 1).padStart(2, '0')
      const from = fmtIsoMinute(s.earliest_at ?? s.created_at)
      const to = fmtIsoMinute(s.latest_at ?? s.created_at)
      const msgs = s.message_count
      const sep = i < branches.length - 1 ? '\n\n---\n\n' : ''
      return `[Branch #${idx} ${from} → ${to} | ${msgs} msgs]\n${sanitizeForJson(s.content)}${sep}`
    })
    .join('')

  return `${preamble}\n\n---\n\n${body}`
}
