/**
 * Background Embedding Job
 *
 * Periodically picks up messages with NULL embeddings and calls
 * the Nemotron embed service. Runs on a timer, never blocks
 * the message pipeline.
 */

import pg from 'pg';

export interface EmbedderConfig {
  /** PostgreSQL connection string */
  connectionString: string;
  /** Embedding service URL (e.g., http://10.4.20.12:9401) */
  embedEndpoint: string;
  /** Batch size per cycle (default: 10) */
  batchSize?: number;
  /** Interval in ms between cycles (default: 30000) */
  intervalMs?: number;
}

export class BackgroundEmbedder {
  private pool: pg.Pool;
  private config: EmbedderConfig;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(config: EmbedderConfig) {
    this.config = config;
    this.pool = new pg.Pool({ connectionString: config.connectionString, max: 2 });
  }

  start(): void {
    if (this.timer) return;
    const interval = this.config.intervalMs ?? 30000;
    console.log(`[Embedder] Starting background embedder (every ${interval / 1000}s, batch ${this.config.batchSize ?? 10})`);

    // Run immediately, then on interval
    this.processUnembedded();
    this.timer = setInterval(() => this.processUnembedded(), interval);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async processUnembedded(): Promise<void> {
    if (this.running) return; // Skip if previous cycle still running
    this.running = true;

    try {
      const batchSize = this.config.batchSize ?? 10;

      // Get messages without embeddings
      const result = await this.pool.query(
        `SELECT message_id, content FROM messages
         WHERE embedding IS NULL AND content IS NOT NULL AND LENGTH(content) > 20
         ORDER BY created_at DESC
         LIMIT $1`,
        [batchSize],
      );

      if (result.rows.length === 0) {
        this.running = false;
        return;
      }

      for (const row of result.rows) {
        try {
          const embedding = await this.embed(row.content);
          if (embedding) {
            await this.pool.query(
              `UPDATE messages SET embedding = $1 WHERE message_id = $2`,
              [`[${embedding.join(',')}]`, row.message_id],
            );
          }
        } catch (err: any) {
          // Log but don't stop — continue with next message
          console.error(`[Embedder] Failed to embed message ${row.message_id}: ${err.message}`);
        }
      }

      console.log(`[Embedder] Embedded ${result.rows.length} messages`);
    } catch (err: any) {
      console.error(`[Embedder] Cycle failed: ${err.message}`);
    } finally {
      this.running = false;
    }
  }

  private async embed(text: string): Promise<number[] | null> {
    // Truncate long texts
    const truncated = text.length > 8000 ? text.slice(0, 8000) : text;

    const response = await fetch(`${this.config.embedEndpoint}/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: truncated }),
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) return null;

    const data = (await response.json()) as { embedding: number[] };
    return data.embedding;
  }

  async close(): Promise<void> {
    this.stop();
    await this.pool.end();
  }
}
