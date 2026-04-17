/**
 * BackgroundEmbedder — generates embeddings for messages and summaries.
 *
 * M4.1 Phase A: Hardened with batch API calls, retry with exponential backoff,
 * poison row handling, in-memory metrics, and parallel table processing.
 *
 * Runs on a timer (default: every 30 seconds).
 * Picks up rows with NULL embedding from ros_messages and ros_summaries.
 * Calls the Nemotron 8B service on GERTY for embedding generation.
 *
 * Non-blocking: never stalls the message pipeline. Errors are logged
 * and the batch continues. Skips cycles if the previous one is still running.
 */

import pg from 'pg'

// ---------------------------------------------------------------------------
// Row interfaces
// ---------------------------------------------------------------------------

interface EmbeddableRow {
  id: string
  content: string
}

interface EmbeddingResponseItem {
  embedding?: number[]
  index?: number
}

interface EmbeddingResponse {
  data?: EmbeddingResponseItem[]
}

interface QueueDepthRow {
  msg_queue: string
  sum_queue: string
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

export interface EmbedderMetrics {
  cyclesCompleted: number
  totalEmbedded: number
  totalFailed: number
  totalSkipped: number
  totalApiCalls: number
  avgLatencyMs: number
  lastCycleAt: Date | null
  lastCycleDurationMs: number
  queueDepth: { messages: number; summaries: number } | null
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface EmbedderConfig {
  /** PostgreSQL connection string */
  connectionString: string
  /** Nemotron embedding service URL (e.g., http://192.168.1.50:9401) */
  embedEndpoint: string
  /** Rows per table per cycle (default: 50) */
  batchSize?: number
  /** Texts per API call (default: 8) */
  apiBatchSize?: number
  /** Embedding model name (default: "nemotron") */
  model?: string
  /** Milliseconds between cycles (default: 30000) */
  intervalMs?: number
  /** Max retries per API call on transient failures (default: 3) */
  maxRetries?: number
  /** Mark row as poison after this many cumulative failures (default: 3) */
  maxFailures?: number
}

// ---------------------------------------------------------------------------
// Schema migration
// ---------------------------------------------------------------------------

/**
 * Add embed_failures and embed_error columns if they don't exist.
 * Safe to call multiple times (IF NOT EXISTS).
 */
export async function ensureEmbedderSchema(pool: pg.Pool): Promise<void> {
  await pool.query(`
    ALTER TABLE ros_messages ADD COLUMN IF NOT EXISTS embed_failures INTEGER DEFAULT 0;
    ALTER TABLE ros_messages ADD COLUMN IF NOT EXISTS embed_error TEXT;
    ALTER TABLE ros_summaries ADD COLUMN IF NOT EXISTS embed_failures INTEGER DEFAULT 0;
    ALTER TABLE ros_summaries ADD COLUMN IF NOT EXISTS embed_error TEXT;
  `)
}

// ---------------------------------------------------------------------------
// Transient error detection
// ---------------------------------------------------------------------------

function isTransientError(error: unknown, status?: number): boolean {
  if (status !== undefined && status >= 500) return true
  if (error instanceof TypeError) return true // network errors
  if (error instanceof DOMException && error.name === 'AbortError') return true
  if (error instanceof Error && error.name === 'AbortError') return true
  return false
}

// ---------------------------------------------------------------------------
// Embedder
// ---------------------------------------------------------------------------

export class BackgroundEmbedder {
  private pool: pg.Pool
  private config: EmbedderConfig
  private timer: ReturnType<typeof setInterval> | null = null
  private running: boolean = false
  private model: string
  private batchSize: number
  private apiBatchSize: number
  private maxRetries: number
  private maxFailures: number

  // Metrics state
  private metrics: EmbedderMetrics = {
    cyclesCompleted: 0,
    totalEmbedded: 0,
    totalFailed: 0,
    totalSkipped: 0,
    totalApiCalls: 0,
    avgLatencyMs: 0,
    lastCycleAt: null,
    lastCycleDurationMs: 0,
    queueDepth: null,
  }
  private latencySum: number = 0
  private latencyCount: number = 0

  constructor(config: EmbedderConfig) {
    this.config = config
    this.model = config.model ?? 'nemotron'
    this.batchSize = config.batchSize ?? 50
    this.apiBatchSize = config.apiBatchSize ?? 8
    this.maxRetries = config.maxRetries ?? 3
    this.maxFailures = config.maxFailures ?? 3
    this.pool = new pg.Pool({ connectionString: config.connectionString, max: 4 })
  }

  start(): void {
    if (this.timer) return
    const interval = this.config.intervalMs ?? 30_000
    console.log(
      `[Embedder] Starting (every ${String(interval / 1000)}s, batch ${String(this.batchSize)}, ` +
        `api batch ${String(this.apiBatchSize)}, retries ${String(this.maxRetries)})`,
    )

    // Run immediately, then on interval
    void this.cycle()
    this.timer = setInterval(() => void this.cycle(), interval)
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

  /** Get current metrics snapshot */
  getMetrics(): EmbedderMetrics {
    return { ...this.metrics }
  }

  // -----------------------------------------------------------------------
  // Main cycle: embed messages and summaries in parallel
  // -----------------------------------------------------------------------

  private async cycle(): Promise<void> {
    if (this.running) return
    this.running = true

    const cycleStart = Date.now()

    try {
      // Process messages and summaries in parallel
      const [msgCount, sumCount] = await Promise.all([
        this.embedTable('ros_messages'),
        this.embedTable('ros_summaries'),
      ])

      const total = msgCount + sumCount

      if (total > 0) {
        console.log(
          `[Embedder] Embedded ${String(total)} items ` +
            `(${String(msgCount)} messages, ${String(sumCount)} summaries)`,
        )
      }

      // Update queue depth (non-blocking)
      void this.updateQueueDepth()

      // Update cycle metrics
      this.metrics.cyclesCompleted++
      this.metrics.lastCycleAt = new Date()
      this.metrics.lastCycleDurationMs = Date.now() - cycleStart
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error)
      console.error(`[Embedder] Cycle failed: ${msg}`)
    } finally {
      this.running = false
    }
  }

  /**
   * Find rows with NULL embedding in the given table and embed them in batches.
   * Returns the number of successfully embedded rows.
   */
  private async embedTable(table: string): Promise<number> {
    // Fetch rows that need embedding, excluding poison rows
    const result = await this.pool.query<EmbeddableRow>(
      `SELECT id, content FROM ${table}
       WHERE embedding IS NULL
         AND content IS NOT NULL
         AND LENGTH(content) > 0
         AND COALESCE(embed_failures, 0) < $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [this.maxFailures, this.batchSize],
    )

    if (result.rows.length === 0) return 0

    let embedded = 0

    // Process in API-sized batches
    for (let i = 0; i < result.rows.length; i += this.apiBatchSize) {
      const chunk = result.rows.slice(i, i + this.apiBatchSize)
      const texts = chunk.map((row) =>
        row.content.length > 8000 ? row.content.slice(0, 8000) : row.content,
      )

      const apiStart = Date.now()
      const vectors = await this.embedBatch(texts)
      const apiDuration = Date.now() - apiStart

      // Track latency
      this.latencySum += apiDuration
      this.latencyCount++
      this.metrics.avgLatencyMs = Math.round(this.latencySum / this.latencyCount)
      this.metrics.totalApiCalls++

      // Process results
      for (let j = 0; j < chunk.length; j++) {
        const row = chunk[j]
        const vec = vectors[j]

        if (vec) {
          try {
            await this.pool.query(`UPDATE ${table} SET embedding = $1 WHERE id = $2`, [
              `[${vec.join(',')}]`,
              row.id,
            ])
            embedded++
            this.metrics.totalEmbedded++
          } catch (error: unknown) {
            const msg = error instanceof Error ? error.message : String(error)
            console.error(`[Embedder] Failed to store ${table} ${row.id}: ${msg}`)
            this.metrics.totalFailed++
          }
        } else {
          // Embedding failed for this row — increment failure count
          await this.markFailure(table, row.id, 'Embedding returned null after retries')
          this.metrics.totalFailed++
        }
      }
    }

    return embedded
  }

  // -----------------------------------------------------------------------
  // Batch embed with retry
  // -----------------------------------------------------------------------

  /**
   * Call the Nemotron embedding service with a batch of texts.
   * Returns one vector per input (null for any that failed).
   * Retries the entire batch on transient failures.
   */
  private async embedBatch(texts: string[]): Promise<(number[] | null)[]> {
    let lastError: unknown = null

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const response = await fetch(`${this.config.embedEndpoint}/v1/embeddings`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ input: texts, model: this.model }),
          signal: AbortSignal.timeout(30_000),
        })

        // Non-transient error (4xx) — don't retry
        if (!response.ok && response.status < 500) {
          console.error(
            `[Embedder] API returned ${String(response.status)}: ${response.statusText} (not retrying)`,
          )
          return texts.map(() => null)
        }

        // Transient error (5xx) — retry
        if (!response.ok) {
          lastError = new Error(`HTTP ${String(response.status)}: ${response.statusText}`)
          if (attempt < this.maxRetries) {
            const delay = Math.pow(2, attempt) * 1000
            console.error(
              `[Embedder] API ${String(response.status)}, retry ${String(attempt + 1)}/${String(this.maxRetries)} in ${String(delay)}ms`,
            )
            await this.sleep(delay)
            continue
          }
          break
        }

        const data = (await response.json()) as EmbeddingResponse
        if (!data.data) return texts.map(() => null)

        // Map response items back by index
        const results: (number[] | null)[] = texts.map(() => null)
        for (const item of data.data) {
          const idx = item.index ?? 0
          if (idx >= 0 && idx < results.length && item.embedding) {
            results[idx] = item.embedding
          }
        }

        return results
      } catch (error: unknown) {
        lastError = error

        if (isTransientError(error) && attempt < this.maxRetries) {
          const delay = Math.pow(2, attempt) * 1000
          const msg = error instanceof Error ? error.message : String(error)
          console.error(
            `[Embedder] Transient error: ${msg}, retry ${String(attempt + 1)}/${String(this.maxRetries)} in ${String(delay)}ms`,
          )
          await this.sleep(delay)
          continue
        }

        // Non-transient or out of retries
        break
      }
    }

    const errMsg = lastError instanceof Error ? lastError.message : String(lastError)
    console.error(
      `[Embedder] Batch embed failed after ${String(this.maxRetries)} retries: ${errMsg}`,
    )
    return texts.map(() => null)
  }

  // -----------------------------------------------------------------------
  // Poison row management
  // -----------------------------------------------------------------------

  /**
   * Increment embed_failures and store the error message.
   * When failures reach maxFailures, the row is effectively poisoned
   * and will be excluded from future cycles.
   */
  private async markFailure(table: string, id: string, errorMsg: string): Promise<void> {
    try {
      await this.pool.query(
        `UPDATE ${table}
         SET embed_failures = COALESCE(embed_failures, 0) + 1,
             embed_error = $1
         WHERE id = $2`,
        [errorMsg, id],
      )
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error)
      console.error(`[Embedder] Failed to mark failure for ${table} ${id}: ${msg}`)
    }
  }

  // -----------------------------------------------------------------------
  // Queue depth tracking
  // -----------------------------------------------------------------------

  private async updateQueueDepth(): Promise<void> {
    try {
      const result = await this.pool.query<QueueDepthRow>(`
        SELECT
          (SELECT COUNT(*) FROM ros_messages
           WHERE embedding IS NULL AND content IS NOT NULL
             AND LENGTH(content) > 0 AND COALESCE(embed_failures, 0) < ${String(this.maxFailures)}) AS msg_queue,
          (SELECT COUNT(*) FROM ros_summaries
           WHERE embedding IS NULL AND content IS NOT NULL
             AND COALESCE(embed_failures, 0) < ${String(this.maxFailures)}) AS sum_queue
      `)
      this.metrics.queueDepth = {
        messages: Number(result.rows[0].msg_queue),
        summaries: Number(result.rows[0].sum_queue),
      }
    } catch {
      // Non-critical — don't fail the cycle
    }
  }

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }
}
