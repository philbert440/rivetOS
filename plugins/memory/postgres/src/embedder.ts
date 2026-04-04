/**
 * BackgroundEmbedder — generates embeddings for messages and summaries.
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
// Config
// ---------------------------------------------------------------------------

export interface EmbedderConfig {
  /** PostgreSQL connection string */
  connectionString: string
  /** Nemotron embedding service URL (e.g., http://10.4.20.12:9401) */
  embedEndpoint: string
  /** Messages per cycle (default: 10) */
  batchSize?: number
  /** Embedding model name (default: "nemotron") */
  model?: string
  /** Milliseconds between cycles (default: 30000) */
  intervalMs?: number
}

// ---------------------------------------------------------------------------
// Embedder
// ---------------------------------------------------------------------------

export class BackgroundEmbedder {
  private pool: pg.Pool
  private config: EmbedderConfig
  private timer: ReturnType<typeof setInterval> | null = null
  private running = false
  private model: string

  constructor(config: EmbedderConfig) {
    this.config = config
    this.model = config.model ?? 'nemotron'
    this.pool = new pg.Pool({ connectionString: config.connectionString, max: 2 })
  }

  start(): void {
    if (this.timer) return
    const interval = this.config.intervalMs ?? 30_000
    const batch = this.config.batchSize ?? 10
    console.log(`[Embedder] Starting (every ${interval / 1000}s, batch ${batch})`)

    // Run immediately, then on interval
    this.cycle()
    this.timer = setInterval(() => this.cycle(), interval)
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
  // Main cycle: embed messages, then summaries
  // -----------------------------------------------------------------------

  private async cycle(): Promise<void> {
    if (this.running) return
    this.running = true

    try {
      const batch = this.config.batchSize ?? 10
      let total = 0

      total += await this.embedTable('ros_messages', batch)
      total += await this.embedTable('ros_summaries', batch)

      if (total > 0) {
        console.log(`[Embedder] Embedded ${total} items`)
      }
    } catch (err: any) {
      console.error(`[Embedder] Cycle failed: ${err.message}`)
    } finally {
      this.running = false
    }
  }

  /**
   * Find rows with NULL embedding in the given table and embed them.
   * Returns the number of successfully embedded rows.
   */
  private async embedTable(table: string, limit: number): Promise<number> {
    const result = await this.pool.query(
      `SELECT id, content FROM ${table}
       WHERE embedding IS NULL
         AND content IS NOT NULL
         AND LENGTH(content) > 20
       ORDER BY created_at DESC
       LIMIT $1`,
      [limit],
    )

    let embedded = 0
    for (const row of result.rows) {
      try {
        const vec = await this.embed(row.content)
        if (vec) {
          await this.pool.query(`UPDATE ${table} SET embedding = $1 WHERE id = $2`, [
            `[${vec.join(',')}]`,
            row.id,
          ])
          embedded++
        }
      } catch (err: any) {
        console.error(`[Embedder] Failed ${table} ${row.id}: ${err.message}`)
      }
    }

    return embedded
  }

  // -----------------------------------------------------------------------
  // Call the Nemotron embedding service
  // -----------------------------------------------------------------------

  private async embed(text: string): Promise<number[] | null> {
    const truncated = text.length > 8000 ? text.slice(0, 8000) : text

    const response = await fetch(`${this.config.embedEndpoint}/v1/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: truncated, model: this.model }),
      signal: AbortSignal.timeout(10_000),
    })

    if (!response.ok) return null

    const data = (await response.json()) as { data: Array<{ embedding: number[] }> }
    return data.data?.[0]?.embedding ?? null
  }
}
