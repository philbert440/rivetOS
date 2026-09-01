/**
 * Environment-driven configuration for the embedding worker.
 */

function requireEnv(name: string, detail?: string): string {
  const value = process.env[name]
  if (!value) {
    console.error(`[EmbedWorker] ${name} is required${detail ? `. ${detail}` : ''}`)
    process.exit(1)
  }
  return value
}

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const parsed = parseInt(raw, 10)
  return Number.isFinite(parsed) ? parsed : fallback
}

function boolEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  const n = raw.trim().toLowerCase()
  if (['1', 'true', 'yes', 'on'].includes(n)) return true
  if (['0', 'false', 'no', 'off'].includes(n)) return false
  return fallback
}

export const config = {
  pgUrl: requireEnv('RIVETOS_PG_URL'),
  embedUrl: requireEnv('RIVETOS_EMBED_URL'),
  embedModel: requireEnv(
    'RIVETOS_EMBED_MODEL',
    'OpenAI-compatible embedding model id (example: text-embedding-3-small)',
  ),

  concurrency: intEnv('EMBED_CONCURRENCY', 4),

  // Schema is hard halfvec(1024); doctor checkEmbeddingWidth expects 1024.
  truncateDims: intEnv('EMBED_TRUNCATE_DIMS', 1024),
  // Single-shot content (<= this) is embedded in one call; larger content is
  // split into <=charsPerChunk pieces and mean-pooled. This MUST stay at or
  // below the embed endpoint's per-request capacity — if it exceeds it, an
  // oversized row 500s/times-out instead of chunking and the job dies. The old
  // default (20000) sat above nemotron-embed-8b's effective ceiling, so rows in
  // the ~8k–20k range never chunked and became permanent failures.
  charsPerChunk: intEnv('EMBED_CHARS_PER_CHUNK', 6000),
  apiTimeoutMs: intEnv('EMBED_API_TIMEOUT_MS', 30000),
  maxRetries: intEnv('EMBED_MAX_RETRIES', 3),
  maxFailures: intEnv('EMBED_MAX_FAILURES', 3),

  // enqueue-unembedded backstop sweep: how many never-embedded rows (per table)
  // to re-enqueue each pass, and the max_attempts those jobs get. The sweep is
  // the safety net for rows whose trigger-driven embed job was dropped or died
  // before embed_status was marked terminal — without it such a row is orphaned
  // forever (no periodic re-enqueue, unlike compaction's enqueue-idle).
  sweepLimit: intEnv('EMBED_SWEEP_LIMIT', 200),
  sweepMaxAttempts: intEnv('EMBED_SWEEP_MAX_ATTEMPTS', 5),

  // Per-chunk rows for long messages (ros_message_chunks). Default on; the
  // parent mean-pooled vector is still written. Backfill sweep is bounded.
  embedChunksEnabled: boolEnv('EMBED_CHUNKS_ENABLED', true),
  chunkBackfillLimit: intEnv('CHUNK_BACKFILL_LIMIT', 200),
} as const
