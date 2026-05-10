/**
 * Environment-driven configuration for the embedding worker.
 */

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) {
    console.error(`[EmbedWorker] ${name} is required`)
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

export const config = {
  pgUrl: requireEnv('RIVETOS_PG_URL'),
  embedUrl: requireEnv('RIVETOS_EMBED_URL'),
  embedModel: process.env.RIVETOS_EMBED_MODEL ?? 'nemotron',

  concurrency: intEnv('EMBED_CONCURRENCY', 4),

  truncateDims: intEnv('EMBED_TRUNCATE_DIMS', 4000),
  charsPerChunk: intEnv('EMBED_CHARS_PER_CHUNK', 20000),
  apiTimeoutMs: intEnv('EMBED_API_TIMEOUT_MS', 30000),
  maxRetries: intEnv('EMBED_MAX_RETRIES', 3),
  maxFailures: intEnv('EMBED_MAX_FAILURES', 3),
} as const
