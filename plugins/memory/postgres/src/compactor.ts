/**
 * BackgroundCompactor — summarizes old messages into the summary DAG.
 *
 * Runs on a timer (default: every 30 minutes):
 *   1. Finds conversations with >50 unsummarized messages
 *   2. Takes the oldest 25 unsummarized messages from each
 *   3. Sends them to Rivet Local (GERTY llama-server) for summarization
 *   4. Stores the summary in ros_summaries (kind='leaf', depth=0)
 *   5. Links source messages via ros_summary_sources
 *   6. Summary embedding is NULL → BackgroundEmbedder picks it up next cycle
 *
 * Compaction levels (from MEMORY-DESIGN.md):
 *   Level 0 (leaf):   25 messages → 1 summary (~200-400 tokens)
 *   Level 1 (branch): 5-8 leaves → 1 branch  (~300-500 tokens)
 *   Level 2 (root):   3-5 branches → 1 root   (~400-600 tokens)
 *
 * Currently implements leaf compaction. Branch/root compaction will be
 * added when we have enough leaves to warrant it.
 */

import pg from 'pg'

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface CompactorConfig {
  /** PostgreSQL connection string */
  connectionString: string
  /** LLM endpoint for summarization (default: http://10.4.20.12:8000/v1) */
  compactorEndpoint?: string
  /** Model name (default: rivet-v0.1) */
  compactorModel?: string
  /** Milliseconds between cycles (default: 1800000 = 30 min) */
  intervalMs?: number
  /** Minimum unsummarized messages to trigger compaction (default: 50) */
  minUnsummarized?: number
  /** Messages per compaction batch (default: 25) */
  batchSize?: number
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SUMMARIZE_SYSTEM_PROMPT =
  'Summarize these conversation messages concisely. Preserve: key decisions, ' +
  'technical details, configurations, action items, state changes, problems solved. ' +
  'Format as bullet points.'

/** Minimum messages in a batch to be worth summarizing */
const MIN_BATCH_SIZE = 5

/** Maximum conversations to compact per cycle */
const MAX_CONVERSATIONS_PER_CYCLE = 5

/** LLM request timeout */
const LLM_TIMEOUT_MS = 60_000

/** Max content per message in the LLM prompt (avoid blowing context) */
const MAX_MSG_CONTENT_FOR_PROMPT = 1000

// ---------------------------------------------------------------------------
// Compactor
// ---------------------------------------------------------------------------

export class BackgroundCompactor {
  private pool: pg.Pool
  private endpoint: string
  private model: string
  private intervalMs: number
  private minUnsummarized: number
  private batchSize: number
  private timer: ReturnType<typeof setInterval> | null = null
  private running = false

  constructor(config: CompactorConfig) {
    this.endpoint = config.compactorEndpoint ?? 'http://10.4.20.12:8000/v1'
    this.model = config.compactorModel ?? 'rivet-v0.1'
    this.intervalMs = config.intervalMs ?? 1_800_000
    this.minUnsummarized = config.minUnsummarized ?? 50
    this.batchSize = config.batchSize ?? 25
    this.pool = new pg.Pool({ connectionString: config.connectionString, max: 2 })
  }

  start(): void {
    if (this.timer) return
    console.log(
      `[Compactor] Starting (every ${this.intervalMs / 60_000}min, ` +
        `threshold ${this.minUnsummarized} msgs, batch ${this.batchSize})`,
    )
    console.log(`[Compactor] Endpoint: ${this.endpoint} (model: ${this.model})`)

    // Delay first run by 60s to let the system settle on boot
    setTimeout(() => this.cycle(), 60_000)
    this.timer = setInterval(() => this.cycle(), this.intervalMs)
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

  // -----------------------------------------------------------------------
  // Main cycle
  // -----------------------------------------------------------------------

  private async cycle(): Promise<void> {
    if (this.running) return
    this.running = true

    try {
      // Find conversations with enough unsummarized messages.
      // "Unsummarized" = messages not referenced by any ros_summary_sources row.
      const candidates = await this.pool.query(
        `SELECT m.conversation_id, COUNT(*) AS unsummarized
         FROM ros_messages m
         LEFT JOIN ros_summary_sources ss ON ss.message_id = m.id
         WHERE ss.summary_id IS NULL
           AND m.content IS NOT NULL
           AND LENGTH(m.content) > 10
         GROUP BY m.conversation_id
         HAVING COUNT(*) >= $1
         ORDER BY COUNT(*) DESC
         LIMIT $2`,
        [this.minUnsummarized, MAX_CONVERSATIONS_PER_CYCLE],
      )

      if (candidates.rows.length === 0) {
        this.running = false
        return
      }

      console.log(`[Compactor] ${candidates.rows.length} conversation(s) need compaction`)

      for (const row of candidates.rows) {
        try {
          await this.compactConversation(row.conversation_id)
        } catch (err: any) {
          console.error(`[Compactor] Failed conversation ${row.conversation_id}: ${err.message}`)
        }
      }
    } catch (err: any) {
      console.error(`[Compactor] Cycle failed: ${err.message}`)
    } finally {
      this.running = false
    }
  }

  // -----------------------------------------------------------------------
  // Compact one conversation
  // -----------------------------------------------------------------------

  private async compactConversation(conversationId: string): Promise<void> {
    // Get the oldest N unsummarized messages
    const messages = await this.pool.query(
      `SELECT m.id, m.role, m.content, m.agent, m.created_at
       FROM ros_messages m
       LEFT JOIN ros_summary_sources ss ON ss.message_id = m.id
       WHERE ss.summary_id IS NULL
         AND m.conversation_id = $1
         AND m.content IS NOT NULL
         AND LENGTH(m.content) > 10
       ORDER BY m.created_at ASC
       LIMIT $2`,
      [conversationId, this.batchSize],
    )

    if (messages.rows.length < MIN_BATCH_SIZE) return

    // Format for the LLM
    const formatted = messages.rows
      .map((m: any) => `[${m.role}] ${m.content.slice(0, MAX_MSG_CONTENT_FOR_PROMPT)}`)
      .join('\n')

    // Call Rivet Local for summarization
    const summaryText = await this.summarize(formatted)
    if (!summaryText) {
      console.error(`[Compactor] Empty summary for conversation ${conversationId}`)
      return
    }

    // Find the conversation's latest leaf summary to chain as parent
    const latestLeaf = await this.pool.query(
      `SELECT id FROM ros_summaries
       WHERE conversation_id = $1 AND kind = 'leaf'
       ORDER BY created_at DESC LIMIT 1`,
      [conversationId],
    )
    const parentId = latestLeaf.rows.length > 0 ? latestLeaf.rows[0].id : null

    // Write summary + links in one transaction
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')

      const sumResult = await client.query(
        `INSERT INTO ros_summaries
           (conversation_id, parent_id, depth, content, kind,
            message_count, earliest_at, latest_at, model)
         VALUES ($1, $2, 0, $3, 'leaf', $4, $5, $6, $7)
         RETURNING id`,
        [
          conversationId,
          parentId,
          summaryText,
          messages.rows.length,
          messages.rows[0].created_at,
          messages.rows[messages.rows.length - 1].created_at,
          this.model,
        ],
      )
      const summaryId = sumResult.rows[0].id

      // Link each source message with ordinal
      for (let i = 0; i < messages.rows.length; i++) {
        await client.query(
          `INSERT INTO ros_summary_sources (summary_id, message_id, ordinal)
           VALUES ($1, $2, $3)`,
          [summaryId, messages.rows[i].id, i],
        )
      }

      await client.query('COMMIT')

      console.log(
        `[Compactor] Created summary ${summaryId} ` +
          `(${messages.rows.length} messages, conversation ${conversationId})`,
      )
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  }

  // -----------------------------------------------------------------------
  // LLM call
  // -----------------------------------------------------------------------

  private async summarize(formattedMessages: string): Promise<string | null> {
    try {
      const response = await fetch(`${this.endpoint}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.model,
          messages: [
            { role: 'system', content: SUMMARIZE_SYSTEM_PROMPT },
            { role: 'user', content: formattedMessages },
          ],
          max_tokens: 1000,
          temperature: 0.3,
        }),
        signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
      })

      if (!response.ok) {
        console.error(`[Compactor] LLM returned ${response.status}: ${response.statusText}`)
        return null
      }

      const data = (await response.json()) as Record<string, unknown>
      const message = (data as any).choices?.[0]?.message
      // Prefer content, fall back to reasoning_content (QwQ/reasoning models)
      return message?.content || message?.reasoning_content || null
    } catch (err: any) {
      console.error(`[Compactor] LLM call failed: ${err.message}`)
      return null
    }
  }
}
