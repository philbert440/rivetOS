/**
 * `owner_user_id` on `ros_conversations` and `ros_messages` (migration 0013):
 * which registry user a row belongs to. Each user has a database of their
 * own here, so the column separates nothing; it is written so a row says
 * whose it is wherever it ends up (an export, an import into a file store).
 *
 * Code ships to the nodes before `rivetos db migrate` runs, so every writer
 * asks first and writes the column only where it exists. Only a positive
 * answer is remembered: a database that gains the column is noticed without
 * a restart.
 */

interface Queryable {
  query: (sql: string) => Promise<{ rows: unknown[] }>
}

const present = new WeakSet<object>()

/** SQL of the probe. `to_regclass` is NULL for a missing table, so this never raises inside a transaction. */
export const OWNER_COLUMN_PROBE_SQL = `SELECT count(*)::int AS n FROM pg_attribute
  WHERE attname = 'owner_user_id' AND NOT attisdropped
    AND attrelid IN (to_regclass('ros_conversations'), to_regclass('ros_messages'))`

/**
 * True when both tables have the column. `key` is what the answer is cached
 * on (the pool); `source` runs the probe (the pool, or the client of an open
 * transaction).
 */
export async function hasOwnerUserIdColumn(key: object, source: Queryable): Promise<boolean> {
  if (present.has(key)) return true
  const res = await source.query(OWNER_COLUMN_PROBE_SQL)
  const n = (res.rows[0] as { n?: number } | undefined)?.n ?? 0
  if (n !== 2) return false
  present.add(key)
  return true
}
