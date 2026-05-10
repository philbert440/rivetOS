/**
 * Embedder schema migration.
 *
 * The actual embedding worker lives at `workers/embedding/index.js` and runs
 * on the datahub. This file only retains the schema-migration helper that
 * agent CTs call at startup to ensure the columns the worker expects exist.
 */

import pg from 'pg'

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
