/**
 * Embedder schema migration.
 *
 * The actual embedding worker lives at `services/embedding-worker/` (graphile-worker
 * service). This file only retains the schema-migration helper that agent CTs call
 * at startup to ensure the columns the worker expects exist.
 *
 * Startup DDL on hot tables (ros_messages / ros_summaries) must not queue the
 * fleet: check pg catalogs first, and when ALTER is unavoidable run it on a
 * dedicated client with lock_timeout so a blocked ACCESS EXCLUSIVE fails fast
 * instead of lining up every other session behind it.
 */

import pg from 'pg'

/** Session-local; a blocked ALTER fails in 3s instead of waiting forever. */
export const EMBEDDER_LOCK_TIMEOUT = '3s'

/** Five attempts, sleeps of 0+5+10+20+25s ≈ 1 min of backoff. */
export const EMBEDDER_LOCK_BACKOFF_MS: readonly number[] = [0, 5_000, 10_000, 20_000, 25_000]

export interface EnsureEmbedderSchemaOptions {
  /** Override lock_timeout GUC (tests). */
  lockTimeout?: string
  /** Per-attempt sleep before the attempt; index 0 should be 0. */
  backoffMs?: readonly number[]
  /** Injected sleep so tests do not wait out the real backoff. */
  sleep?: (ms: number) => Promise<void>
  log?: (msg: string) => void
}

interface RequiredColumn {
  table: string
  column: string
  sql: string
}

const REQUIRED_COLUMNS: readonly RequiredColumn[] = [
  {
    table: 'ros_messages',
    column: 'embed_failures',
    sql: 'ALTER TABLE ros_messages ADD COLUMN IF NOT EXISTS embed_failures INTEGER DEFAULT 0',
  },
  {
    table: 'ros_messages',
    column: 'embed_error',
    sql: 'ALTER TABLE ros_messages ADD COLUMN IF NOT EXISTS embed_error TEXT',
  },
  {
    table: 'ros_messages',
    column: 'embed_status',
    sql: 'ALTER TABLE ros_messages ADD COLUMN IF NOT EXISTS embed_status TEXT',
  },
  {
    table: 'ros_summaries',
    column: 'embed_failures',
    sql: 'ALTER TABLE ros_summaries ADD COLUMN IF NOT EXISTS embed_failures INTEGER DEFAULT 0',
  },
  {
    table: 'ros_summaries',
    column: 'embed_error',
    sql: 'ALTER TABLE ros_summaries ADD COLUMN IF NOT EXISTS embed_error TEXT',
  },
  {
    table: 'ros_summaries',
    column: 'embed_status',
    sql: 'ALTER TABLE ros_summaries ADD COLUMN IF NOT EXISTS embed_status TEXT',
  },
]

const COLUMNS_EXIST_SQL = `
SELECT table_name, column_name
  FROM information_schema.columns
 WHERE table_schema = current_schema()
   AND table_name IN ('ros_messages', 'ros_summaries')
   AND column_name IN ('embed_failures', 'embed_error', 'embed_status')
`

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

/** Postgres interval literal only — `lockTimeout` is interpolated into SET. */
export function assertLockTimeout(value: string): string {
  if (!/^\d+(\.\d+)?(us|ms|s|min|h|d)$/i.test(value)) {
    throw new Error(`invalid lock_timeout: ${value}`)
  }
  return value
}

export function isLockNotAvailable(err: unknown): boolean {
  if (typeof err !== 'object' || err === null || !('code' in err)) return false
  return err.code === '55P03'
}

function columnKey(table: string, column: string): string {
  return `${table}.${column}`
}

async function listExistingColumns(pool: pg.Pool): Promise<Set<string>> {
  const res = await pool.query<{ table_name: string; column_name: string }>(COLUMNS_EXIST_SQL)
  const found = new Set<string>()
  for (const row of res.rows) {
    found.add(columnKey(row.table_name, row.column_name))
  }
  return found
}

/**
 * Add embed_failures, embed_error, and embed_status columns if they don't exist.
 * Safe to call multiple times. The common case (columns already present) issues
 * zero DDL — no ACCESS EXCLUSIVE on a hot table at every process start.
 *
 * When DDL is needed it runs on a dedicated client with lock_timeout. On
 * 55P03 (lock_not_available) we warn, skip the rest of that table for the
 * attempt, back off, and retry a bounded number of times, then give up
 * WITHOUT throwing: the process must stay up. Search, append, and compaction
 * do not read these columns. Until a later start that gets the lock:
 * embedding-worker enqueue (`embed_status IS NULL`) and embed-target jobs
 * fail closed, and health.sql `EMBEDDING_HEALTH_SQL` raises 42703
 * (undefined_column) — not just terminal bookkeeping counters.
 *
 * embed_status:
 *   - NULL (default): row is eligible for embedding
 *   - 'unembeddable': row was classified as never-embeddable (base64 blobs,
 *     media markers, etc.) — permanently skipped
 *   - 'failed': row hit maxFailures consecutive null embeddings and is
 *     poisoned. embed_error is then 'Embedding returned null (permanent)'
 *     so the enqueue-unembedded heal (which only matches the legacy
 *     'Embedding returned null' string) will not reopen it. Transient
 *     nulls stay non-terminal until that cap.
 */
export async function ensureEmbedderSchema(
  pool: pg.Pool,
  options: EnsureEmbedderSchemaOptions = {},
): Promise<void> {
  const existing = await listExistingColumns(pool)
  let remaining = REQUIRED_COLUMNS.filter((col) => !existing.has(columnKey(col.table, col.column)))
  if (remaining.length === 0) return

  const lockTimeout = assertLockTimeout(options.lockTimeout ?? EMBEDDER_LOCK_TIMEOUT)
  const backoffMs = options.backoffMs ?? EMBEDDER_LOCK_BACKOFF_MS
  const sleep = options.sleep ?? defaultSleep
  const log = options.log ?? ((msg: string) => console.warn(msg))

  const client = await pool.connect()
  try {
    await client.query(`SET lock_timeout = '${lockTimeout}'`)
    for (let attempt = 0; attempt < backoffMs.length; attempt++) {
      const delay = backoffMs[attempt] ?? 0
      if (delay > 0) await sleep(delay)

      const stillMissing: RequiredColumn[] = []
      const skipTables = new Set<string>()
      for (const col of remaining) {
        if (skipTables.has(col.table)) {
          stillMissing.push(col)
          continue
        }
        try {
          await client.query(col.sql)
        } catch (err) {
          if (isLockNotAvailable(err)) {
            log(
              `[memory-postgres] ensureEmbedderSchema: lock_timeout on ${col.sql} ` +
                `(attempt ${attempt + 1}/${backoffMs.length}); skipping remaining ALTERs ` +
                `on ${col.table} this attempt`,
            )
            stillMissing.push(col)
            skipTables.add(col.table)
            continue
          }
          throw err
        }
      }
      remaining = stillMissing
      if (remaining.length === 0) return
    }

    log(
      `[memory-postgres] ensureEmbedderSchema: giving up after ${String(backoffMs.length)} ` +
        `attempts; ${remaining.map((c) => `${c.table}.${c.column}`).join(', ')} still missing. ` +
        `Embedding-worker enqueue/embed-target and health.sql counters that read ` +
        `embed_status are degraded until a later start; search/append/compaction do ` +
        `not require these columns.`,
    )
  } finally {
    let resetErr: Error | undefined
    try {
      await client.query('RESET lock_timeout')
    } catch (err) {
      resetErr = err instanceof Error ? err : new Error(String(err))
    }
    client.release(resetErr)
  }
}
