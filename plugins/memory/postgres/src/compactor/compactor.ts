/**
 * BackgroundCompactor — summarizes old messages into the summary DAG.
 *
 * M4.1 Phase B: Hierarchical compaction with branch/root levels,
 * level-specific prompts, batch source linking, and metrics.
 *
 * Runs on a timer (default: every 30 minutes):
 *
 * Leaf compaction (Level 0):
 *   1. Finds conversations with ≥ minUnsummarized messages without summaries
 *   2. Takes the oldest batchSize unsummarized messages from each
 *   3. Sends them to the LLM for summarization
 *   4. Stores as ros_summaries (kind='leaf', depth=0)
 *   5. Links source messages via ros_summary_sources
 *
 * Branch compaction (Level 1):
 *   1. Finds conversations with ≥ minLeafsForBranch unparented leaf summaries
 *   2. Takes up to branchBatchSize oldest unparented leaves
 *   3. Summarizes them into a branch summary (kind='branch', depth=1)
 *   4. Sets parent_id on each leaf to point to the new branch
 *
 * Root compaction (Level 2):
 *   1. Finds conversations with ≥ minBranchesForRoot unparented branch summaries
 *   2. Takes up to rootBatchSize oldest unparented branches
 *   3. Summarizes them into a root summary (kind='root', depth=2)
 *   4. Sets parent_id on each branch to point to the new root
 *
 * Embeddings are NULL on creation — BackgroundEmbedder picks them up.
 */

import pg from 'pg'
import {
  fmtDate,
  sanitizeForJson,
  MIN_BATCH_SIZE,
  MAX_CONVERSATIONS_PER_CYCLE,
  LLM_TIMEOUT_MS,
  MAX_MSG_CONTENT_FOR_PROMPT,
  MAX_SUMMARY_CONTENT_FOR_PROMPT,
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
} from './types.js'

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
    this.model = config.compactorModel ?? 'rivet-v0.1'
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
      `[Compactor] Starting (every ${String(this.intervalMs / 60_000)}min, ` +
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

  // =======================================================================
  // Level 0: Leaf compaction (messages → leaf)
  // =======================================================================

  private async compactLeaves(): Promise<void> {
    const candidates = await this.pool.query<CandidateRow>(
      `SELECT m.conversation_id, COUNT(*) AS unsummarized
       FROM ros_messages m
       LEFT JOIN ros_summary_sources ss ON ss.message_id = m.id
       WHERE ss.summary_id IS NULL AND m.content IS NOT NULL AND LENGTH(m.content) > 10
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
      // Circuit breaker: skip conversations that repeatedly fail
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
    const messages = await this.pool.query<CompactMessageRow>(
      `SELECT m.id, m.role, m.content, m.agent, m.created_at
       FROM ros_messages m
       LEFT JOIN ros_summary_sources ss ON ss.message_id = m.id
       WHERE ss.summary_id IS NULL AND m.conversation_id = $1
         AND m.content IS NOT NULL AND LENGTH(m.content) > 10
       ORDER BY m.created_at ASC LIMIT $2`,
      [conversationId, this.batchSize],
    )

    if (messages.rows.length < MIN_BATCH_SIZE) return

    const formatted = messages.rows
      .map((m) => `[${m.role}] ${sanitizeForJson(m.content.slice(0, MAX_MSG_CONTENT_FOR_PROMPT))}`)
      .join('\n')

    const summaryText = await this.callLlm(LEAF_SYSTEM_PROMPT, formatted, 1000)
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

    // Success — clear circuit breaker
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
    const leaves = await this.pool.query<SummaryRow>(
      `SELECT id, content, kind, earliest_at, latest_at, message_count, created_at
       FROM ros_summaries
       WHERE conversation_id = $1 AND kind = 'leaf' AND parent_id IS NULL
       ORDER BY created_at ASC LIMIT $2`,
      [conversationId, this.branchBatchSize],
    )

    if (leaves.rows.length < this.minLeafsForBranch) return

    const formatted = leaves.rows
      .map((s, i) => {
        const period =
          s.earliest_at && s.latest_at
            ? `${fmtDate(s.earliest_at)} → ${fmtDate(s.latest_at)}`
            : fmtDate(s.created_at)
        return `[Leaf ${String(i + 1)}, ${period}, ${String(s.message_count)} msgs]\n${sanitizeForJson(s.content.slice(0, MAX_SUMMARY_CONTENT_FOR_PROMPT))}`
      })
      .join('\n\n')

    const summaryText = await this.callLlm(BRANCH_SYSTEM_PROMPT, formatted, 1500)
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
    const branches = await this.pool.query<SummaryRow>(
      `SELECT id, content, kind, earliest_at, latest_at, message_count, created_at
       FROM ros_summaries
       WHERE conversation_id = $1 AND kind = 'branch' AND parent_id IS NULL
       ORDER BY created_at ASC LIMIT $2`,
      [conversationId, this.rootBatchSize],
    )

    if (branches.rows.length < this.minBranchesForRoot) return

    const formatted = branches.rows
      .map((s, i) => {
        const period =
          s.earliest_at && s.latest_at
            ? `${fmtDate(s.earliest_at)} → ${fmtDate(s.latest_at)}`
            : fmtDate(s.created_at)
        return `[Branch ${String(i + 1)}, ${period}, ${String(s.message_count)} msgs]\n${sanitizeForJson(s.content.slice(0, MAX_SUMMARY_CONTENT_FOR_PROMPT))}`
      })
      .join('\n\n')

    const summaryText = await this.callLlm(ROOT_SYSTEM_PROMPT, formatted, 2000)
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
  // LLM call (shared across all levels)
  // -----------------------------------------------------------------------

  private async callLlm(
    systemPrompt: string,
    userContent: string,
    maxTokens: number,
  ): Promise<string | null> {
    this.metrics.llmCalls++

    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      if (this.apiKey) {
        headers['Authorization'] = `Bearer ${this.apiKey}`
      }

      const response = await fetch(`${this.endpoint}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: this.model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userContent },
          ],
          max_tokens: maxTokens,
          temperature: 0.3,
        }),
        signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
      })

      if (!response.ok) {
        this.metrics.llmFailures++
        console.error(`[Compactor] LLM returned ${String(response.status)}: ${response.statusText}`)
        return null
      }

      const data = (await response.json()) as LlmResponse
      const message = data.choices?.[0]?.message
      return message?.content ?? message?.reasoning_content ?? null
    } catch (error: unknown) {
      this.metrics.llmFailures++
      const msg = error instanceof Error ? error.message : String(error)
      console.error(`[Compactor] LLM call failed: ${msg}`)
      return null
    }
  }
}
