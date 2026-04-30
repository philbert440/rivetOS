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
 * Add embed_failures, embed_error, and embed_status columns if they don't exist.
 * Safe to call multiple times (IF NOT EXISTS).
 *
 * embed_status:
 *   - NULL (default): row is eligible for embedding
 *   - 'unembeddable': row was classified as never-embeddable (base64 blobs,
 *     media markers, etc.) — permanently skipped
 *   - 'failed': row hit maxFailures transient errors and is poisoned
 */
export async function ensureEmbedderSchema(pool: pg.Pool): Promise<void> {
  await pool.query(`
    ALTER TABLE ros_messages ADD COLUMN IF NOT EXISTS embed_failures INTEGER DEFAULT 0;
    ALTER TABLE ros_messages ADD COLUMN IF NOT EXISTS embed_error TEXT;
    ALTER TABLE ros_messages ADD COLUMN IF NOT EXISTS embed_status TEXT;
    ALTER TABLE ros_summaries ADD COLUMN IF NOT EXISTS embed_failures INTEGER DEFAULT 0;
    ALTER TABLE ros_summaries ADD COLUMN IF NOT EXISTS embed_error TEXT;
    ALTER TABLE ros_summaries ADD COLUMN IF NOT EXISTS embed_status TEXT;
  `)
}

// ---------------------------------------------------------------------------
// Unembeddable content detection
// ---------------------------------------------------------------------------

/**
 * Classify content that should never be sent to the embedding API.
 *
 * Returns a short reason string if the content is unembeddable, or null
 * if it should be embedded normally.
 *
 * Rationale: media payloads (base64 PNG dumps, "[media attached: ...]"
 * markers from chat bridges) produce no semantically useful embedding and
 * frequently cause the chunker to return all-null vectors, burning retry
 * budget forever. Pre-filter them so they exit the queue cleanly rather
 * than poisoning via repeated failure.
 */
export function classifyUnembeddable(content: string): string | null {
  if (!content) return null

  const trimmed = content.trimStart()

  // Chat-bridge media markers
  if (/^\[media attached:/i.test(trimmed)) return 'media-marker'
  if (/^MEDIA:/i.test(trimmed)) return 'media-prefix'

  // Base64 PNG/JPEG payloads — detect the magic-bytes header in base64 form.
  // PNG: "iVBORw0KGgo" — JPEG: "/9j/" — generic data URLs: "data:image/"
  if (/data:image\/[a-z]+;base64,/i.test(content)) return 'base64-data-url'
  if (/iVBORw0KGgo[A-Za-z0-9+/=]{200,}/.test(content)) return 'base64-png'
  if (/\/9j\/[A-Za-z0-9+/=]{500,}/.test(content)) return 'base64-jpeg'

  // Long unbroken base64-ish runs with no whitespace are almost certainly
  // a binary blob the embedder can't make sense of. 1500 chars of pure
  // base64 alphabet with no spaces is a strong signal.
  const longBase64Run = /[A-Za-z0-9+/]{1500,}={0,2}/
  if (longBase64Run.test(content)) {
    // Sanity check: ratio of base64-alphabet chars to total length
    const sample = content.slice(0, 4000)
    const b64Chars = (sample.match(/[A-Za-z0-9+/=]/g) ?? []).length
    if (b64Chars / sample.length > 0.95) return 'base64-blob'
  }

  return null
}

// ---------------------------------------------------------------------------
// Transient error detection
// ---------------------------------------------------------------------------

/**
 * Split text into approximately equal-sized chunks no larger than maxChars.
 * Prefers paragraph/line boundaries near the target size to keep chunks
 * semantically coherent. Falls back to a hard character split when no
 * boundary is close enough.
 */
function splitIntoChunks(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) return [text]

  const chunks: string[] = []
  let cursor = 0

  while (cursor < text.length) {
    const remaining = text.length - cursor
    if (remaining <= maxChars) {
      chunks.push(text.slice(cursor))
      break
    }

    // Search window: last 15% of the chunk. Look for a good break point
    // (paragraph break > line break > sentence end) working backward.
    const windowStart = cursor + Math.floor(maxChars * 0.85)
    const hardEnd = cursor + maxChars

    const candidates = [
      text.lastIndexOf('\n\n', hardEnd),
      text.lastIndexOf('\n', hardEnd),
      text.lastIndexOf('. ', hardEnd),
    ]

    let breakAt = -1
    for (const c of candidates) {
      if (c >= windowStart && c < hardEnd) {
        breakAt = c
        break
      }
    }

    const end = breakAt === -1 ? hardEnd : breakAt
    chunks.push(text.slice(cursor, end))
    cursor = end
  }

  return chunks
}

/**
 * Mean-pool a batch of embedding vectors into a single vector.
 * Returns null if no vectors succeeded. Nulls in the input are skipped,
 * so a partial batch failure still produces a usable pooled vector.
 */
function meanPool(vectors: (number[] | null)[]): number[] | null {
  const valid = vectors.filter((v): v is number[] => v !== null)
  if (valid.length === 0) return null

  const dim = valid[0].length
  const sum = new Array<number>(dim).fill(0)

  for (const vec of valid) {
    if (vec.length !== dim) continue // defensive: skip mis-sized
    for (let i = 0; i < dim; i++) sum[i] += vec[i]
  }

  const n = valid.length
  for (let i = 0; i < dim; i++) sum[i] /= n
  return sum
}

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

/**
 * Maximum characters per embedding API call.
 *
 * Nemotron has an 8K token context window. 20000 chars is ~5-6K tokens for
 * typical text — a conservative ceiling that leaves headroom for tokenizer
 * variance (code, non-latin scripts, long-word content).
 *
 * Content longer than this is split into chunks, embedded separately, and
 * mean-pooled into a single vector before storage.
 */
const CHARS_PER_CHUNK = 20_000

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
    // Fetch rows that need embedding, excluding poisoned and unembeddable rows
    const result = await this.pool.query<EmbeddableRow>(
      `SELECT id, content FROM ${table}
       WHERE embedding IS NULL
         AND content IS NOT NULL
         AND LENGTH(content) > 0
         AND COALESCE(embed_failures, 0) < $1
         AND embed_status IS DISTINCT FROM 'unembeddable'
         AND embed_status IS DISTINCT FROM 'failed'
       ORDER BY created_at DESC
       LIMIT $2`,
      [this.maxFailures, this.batchSize],
    )

    if (result.rows.length === 0) return 0

    // Pre-filter: classify any content that should never be embedded
    // (base64 blobs, media markers). Mark as unembeddable so they exit
    // the queue immediately instead of burning retry budget.
    const eligible: EmbeddableRow[] = []
    let preFiltered = 0
    for (const row of result.rows) {
      const reason = classifyUnembeddable(row.content)
      if (reason) {
        await this.markUnembeddable(table, row.id, reason)
        preFiltered++
      } else {
        eligible.push(row)
      }
    }
    if (preFiltered > 0) {
      console.log(
        `[Embedder] Pre-filtered ${String(preFiltered)} unembeddable row(s) from ${table}`,
      )
    }
    if (eligible.length === 0) return 0

    // Partition by size: rows that fit in a single API call vs rows that need
    // chunk + mean-pool. Keeps the fast path fast for the common case.
    const normalRows: EmbeddableRow[] = []
    const oversizedRows: EmbeddableRow[] = []
    for (const row of eligible) {
      if (row.content.length <= CHARS_PER_CHUNK) {
        normalRows.push(row)
      } else {
        oversizedRows.push(row)
      }
    }

    let embedded = 0

    // Normal path: batch API calls, one vector per row.
    for (let i = 0; i < normalRows.length; i += this.apiBatchSize) {
      const chunk = normalRows.slice(i, i + this.apiBatchSize)
      const texts = chunk.map((row) => row.content)

      const vectors = await this.timedEmbed(texts)

      for (let j = 0; j < chunk.length; j++) {
        const row = chunk[j]
        const vec = vectors[j]
        if (await this.storeVector(table, row.id, vec)) embedded++
      }
    }

    // Oversized path: split each row into chunks, embed them, mean-pool,
    // and store one vector per row. Each oversized row is handled in its
    // own API call (kept simple; oversized rows are rare).
    for (const row of oversizedRows) {
      const chunks = splitIntoChunks(row.content, CHARS_PER_CHUNK)
      const vectors = await this.timedEmbed(chunks)

      const pooled = meanPool(vectors)
      if (await this.storeVector(table, row.id, pooled)) {
        embedded++
        console.log(
          `[Embedder] Mean-pooled ${String(chunks.length)} chunks for ${table} ${row.id} ` +
            `(${String(row.content.length)} chars)`,
        )
      }
    }

    return embedded
  }

  /**
   * Call embedBatch and update latency metrics. Thin wrapper.
   */
  private async timedEmbed(texts: string[]): Promise<(number[] | null)[]> {
    const start = Date.now()
    const vectors = await this.embedBatch(texts)
    const duration = Date.now() - start

    this.latencySum += duration
    this.latencyCount++
    this.metrics.avgLatencyMs = Math.round(this.latencySum / this.latencyCount)
    this.metrics.totalApiCalls++

    return vectors
  }

  /**
   * Persist a vector (or mark the row as failed if vec is null).
   * Returns true on successful store, false on any failure path.
   */
  private async storeVector(table: string, id: string, vec: number[] | null): Promise<boolean> {
    if (!vec) {
      await this.markFailure(table, id, 'Embedding returned null after retries')
      this.metrics.totalFailed++
      return false
    }
    try {
      await this.pool.query(`UPDATE ${table} SET embedding = $1 WHERE id = $2`, [
        `[${vec.join(',')}]`,
        id,
      ])
      this.metrics.totalEmbedded++
      return true
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error)
      console.error(`[Embedder] Failed to store ${table} ${id}: ${msg}`)
      this.metrics.totalFailed++
      return false
    }
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
   * When failures reach maxFailures, embed_status is flipped to 'failed'
   * so the row drops out of the eligible queue cleanly.
   */
  private async markFailure(table: string, id: string, errorMsg: string): Promise<void> {
    try {
      await this.pool.query(
        `UPDATE ${table}
         SET embed_failures = COALESCE(embed_failures, 0) + 1,
             embed_error = $1,
             embed_status = CASE
               WHEN COALESCE(embed_failures, 0) + 1 >= $2 THEN 'failed'
               ELSE embed_status
             END
         WHERE id = $3`,
        [errorMsg, this.maxFailures, id],
      )
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error)
      console.error(`[Embedder] Failed to mark failure for ${table} ${id}: ${msg}`)
    }
  }

  /**
   * Permanently exclude a row from the embedding queue. Used by the
   * pre-filter for content that we know cannot produce a useful vector
   * (base64 blobs, media markers).
   */
  private async markUnembeddable(table: string, id: string, reason: string): Promise<void> {
    try {
      await this.pool.query(
        `UPDATE ${table}
         SET embed_status = 'unembeddable',
             embed_error = $1
         WHERE id = $2`,
        [`unembeddable: ${reason}`, id],
      )
      this.metrics.totalSkipped++
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error)
      console.error(`[Embedder] Failed to mark unembeddable for ${table} ${id}: ${msg}`)
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
             AND LENGTH(content) > 0
             AND COALESCE(embed_failures, 0) < ${String(this.maxFailures)}
             AND embed_status IS DISTINCT FROM 'unembeddable'
             AND embed_status IS DISTINCT FROM 'failed') AS msg_queue,
          (SELECT COUNT(*) FROM ros_summaries
           WHERE embedding IS NULL AND content IS NOT NULL
             AND COALESCE(embed_failures, 0) < ${String(this.maxFailures)}
             AND embed_status IS DISTINCT FROM 'unembeddable'
             AND embed_status IS DISTINCT FROM 'failed') AS sum_queue
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
