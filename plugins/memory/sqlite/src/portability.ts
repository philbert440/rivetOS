/**
 * Memory portability on SQLite: the gzip NDJSON v1 dump the Postgres backend
 * writes and reads (`rivetos memory export` / `import`), so memory moves
 * between a SQLite node and a Postgres one in either direction.
 *
 * Format: line 1 is the header; every other line is `{t, r}`, one row of
 * table `t`, tables in `EXPORT_TABLES` order. No vectors: the importer
 * re-embeds. Postgres keeps arrays and JSON as values; this file keeps them
 * as JSON text, so rows are converted on the way in and out.
 */

import { hostname as osHostname } from 'node:os'
import { createInterface } from 'node:readline'
import type { Readable, Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createGunzip, createGzip } from 'node:zlib'
import type { DatabaseSync, SQLInputValue } from 'node:sqlite'
import { EXPORT_COLUMNS, EXPORT_TABLES, type ExportTable } from '@rivetos/memory-core'

export const EXPORT_TYPE = 'rivet-memory-export'
export const EXPORT_VERSION = 1

/** Columns stored as JSON text here and as JSON values in the dump. */
const JSON_COLUMNS: Partial<Record<ExportTable, readonly string[]>> = {
  ros_conversations: ['settings'],
  ros_messages: ['tool_args', 'metadata'],
  ros_wiki_topics: ['aliases', 'tags', 'entities', 'related'],
}
/** Columns stored as 0/1 here and as booleans in the dump. */
const BOOLEAN_COLUMNS: Partial<Record<ExportTable, readonly string[]>> = {
  ros_conversations: ['active'],
}
/** Row timestamp for `--since`. */
const SINCE_COLUMN: Partial<Record<ExportTable, string>> = {
  ros_conversations: 'updated_at',
  ros_messages: 'created_at',
  ros_summaries: 'created_at',
  ros_wiki_topics: 'updated_at',
  ros_wiki_redirects: 'created_at',
  ros_wiki_citations: 'cited_at',
}

export interface SqliteExportOptions {
  /** Only rows written at or after this time (and what they depend on). */
  since?: Date | string
  /** Recorded in the header. */
  source?: { kind: 'cloud' | 'local' | 'datahub'; id: string }
  exportedAt?: string
}

export interface SqliteImportOptions {
  dryRun?: boolean
  log?: (message: string) => void
}

export interface SqliteImportResult {
  inserted: Record<string, number>
  skipped: Record<string, number>
  /** Conversations matched to an existing one by (session_key, agent). */
  merged: Record<string, number>
}

function tableColumns(db: DatabaseSync, table: ExportTable): string[] {
  const present = new Set(
    (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name),
  )
  return EXPORT_COLUMNS[table].filter((c) => present.has(c))
}

function toDump(table: ExportTable, row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...row }
  for (const col of JSON_COLUMNS[table] ?? []) {
    const v = out[col]
    if (typeof v !== 'string') continue
    try {
      out[col] = JSON.parse(v) as unknown
    } catch {
      // text that is not JSON travels as it is
    }
  }
  for (const col of BOOLEAN_COLUMNS[table] ?? []) {
    if (typeof out[col] === 'number') out[col] = out[col] !== 0
  }
  return out
}

function fromDump(table: ExportTable, col: string, value: unknown): SQLInputValue {
  if (value === undefined || value === null) return null
  if (BOOLEAN_COLUMNS[table]?.includes(col)) return value === true || value === 1 ? 1 : 0
  if (JSON_COLUMNS[table]?.includes(col)) {
    return typeof value === 'string' ? value : JSON.stringify(value)
  }
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint') {
    return value
  }
  if (typeof value === 'boolean') return value ? 1 : 0
  return JSON.stringify(value)
}

/** Write a dump of this store. One read transaction, so the dump is consistent. */
export async function exportSqliteMemory(
  db: DatabaseSync,
  out: Writable,
  opts: SqliteExportOptions = {},
): Promise<void> {
  const since =
    opts.since === undefined
      ? undefined
      : opts.since instanceof Date
        ? opts.since.toISOString()
        : new Date(opts.since).toISOString()

  function* lines(): Generator<string> {
    yield `${JSON.stringify({
      type: EXPORT_TYPE,
      version: EXPORT_VERSION,
      exported_at: opts.exportedAt ?? new Date().toISOString(),
      source: opts.source ?? { kind: 'local', id: osHostname() },
      tables: EXPORT_TABLES,
    })}\n`
    db.exec('BEGIN')
    try {
      for (const table of EXPORT_TABLES) {
        const cols = tableColumns(db, table)
        if (cols.length === 0) continue
        const select = `SELECT ${cols.map((c) => `t.${c}`).join(', ')} FROM ${table} t`
        let where = ''
        const params: SQLInputValue[] = []
        if (since !== undefined) {
          const col = SINCE_COLUMN[table]
          if (table === 'ros_summary_sources') {
            // A link travels with its summary.
            where = ` WHERE t.summary_id IN (SELECT id FROM ros_summaries WHERE created_at >= ?)`
            params.push(since)
          } else if (table === 'ros_conversations') {
            // A conversation travels when it changed, or when a row that needs it does.
            where = ` WHERE t.updated_at >= ?
                         OR t.id IN (SELECT conversation_id FROM ros_messages WHERE created_at >= ?)
                         OR t.id IN (SELECT conversation_id FROM ros_summaries WHERE created_at >= ?)`
            params.push(since, since, since)
          } else if (col) {
            where = ` WHERE t.${col} >= ?`
            params.push(since)
          }
        }
        for (const row of db.prepare(select + where).iterate(...params)) {
          yield `${JSON.stringify({ t: table, r: toDump(table, row) })}\n`
        }
      }
    } finally {
      // Read-only work: ending the transaction either way. An abandoned
      // export may still have a cursor open, which must not mask the cause.
      try {
        db.exec('COMMIT')
      } catch {
        // nothing was written
      }
    }
  }
  // The destination is the caller's to end (it may be stdout).
  await pipeline(lines, createGzip(), out, { end: false })
}

/**
 * Read a dump into this store. Rows that already exist (same primary key)
 * are skipped. A conversation whose (session_key, agent) already exists under
 * another id is merged into the existing one: its messages and summaries are
 * attached there. Rows whose parent is missing are skipped, not half-linked.
 * One write transaction: a failed import leaves the store as it was.
 */
export async function importSqliteMemory(
  db: DatabaseSync,
  input: Readable,
  opts: SqliteImportOptions = {},
): Promise<SqliteImportResult> {
  const log = opts.log ?? (() => {})
  const count = (): Record<string, number> => Object.fromEntries(EXPORT_TABLES.map((t) => [t, 0]))
  const inserted = count()
  const skipped = count()
  const merged = count()
  const conversationIds = new Map<string, string>()
  const columns = new Map<ExportTable, string[]>()
  for (const table of EXPORT_TABLES) columns.set(table, tableColumns(db, table))

  const exists = {
    conversation: db.prepare(`SELECT 1 AS ok FROM ros_conversations WHERE id = ?`),
    conversationByKey: db.prepare(
      `SELECT id FROM ros_conversations WHERE session_key = ? AND agent = ?`,
    ),
    message: db.prepare(`SELECT 1 AS ok FROM ros_messages WHERE id = ?`),
    summary: db.prepare(`SELECT 1 AS ok FROM ros_summaries WHERE id = ?`),
    topic: db.prepare(`SELECT 1 AS ok FROM ros_wiki_topics WHERE slug = ?`),
  }
  const insertRow = (table: ExportTable, row: Record<string, unknown>): boolean => {
    // A null in the dump is left out, so a column with a default here gets
    // its default instead of failing a NOT NULL constraint.
    const cols = (columns.get(table) ?? []).filter((c) => row[c] !== undefined && row[c] !== null)
    if (cols.length === 0) return false
    const r = db
      .prepare(
        `INSERT OR IGNORE INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
      )
      .run(...cols.map((c) => fromDump(table, c, row[c])))
    return Number(r.changes) > 0
  }
  const str = (v: unknown): string | undefined =>
    typeof v === 'string' && v !== '' ? v : undefined

  const apply = (table: ExportTable, row: Record<string, unknown>): void => {
    const skip = (): void => {
      skipped[table] += 1
    }
    if (table === 'ros_conversations') {
      const id = str(row.id)
      const sessionKey = str(row.session_key)
      const agent = str(row.agent)
      if (!id || !sessionKey || !agent) return skip()
      const same = exists.conversationByKey.get(sessionKey, agent) as { id: string } | undefined
      if (same) {
        conversationIds.set(id, same.id)
        if (same.id !== id) merged[table] += 1
        return skip()
      }
      conversationIds.set(id, id)
      if (insertRow(table, row)) inserted[table] += 1
      else skip()
      return
    }
    if (table === 'ros_messages' || table === 'ros_summaries') {
      const incoming = str(row.conversation_id)
      // A conversation that was not in the dump may already be here.
      const target =
        incoming === undefined
          ? undefined
          : (conversationIds.get(incoming) ??
            (exists.conversation.get(incoming) ? incoming : undefined))
      if (table === 'ros_messages' && target === undefined) return skip()
      // A parent summary arrives later in the file or not at all: linked below.
      const next = {
        ...row,
        conversation_id: target ?? null,
        ...(table === 'ros_summaries' ? { parent_id: null } : {}),
      }
      if (insertRow(table, next)) {
        inserted[table] += 1
        if (table === 'ros_summaries' && str(row.parent_id)) parents.push([row.id, row.parent_id])
      } else skip()
      return
    }
    if (table === 'ros_summary_sources') {
      const summaryId = str(row.summary_id)
      const messageId = str(row.message_id)
      if (!summaryId || !messageId) return skip()
      if (!exists.summary.get(summaryId) || !exists.message.get(messageId)) return skip()
      if (insertRow(table, row)) inserted[table] += 1
      else skip()
      return
    }
    if (table === 'ros_wiki_redirects') {
      if (!exists.topic.get(str(row.to_slug) ?? '')) return skip()
    }
    if (table === 'ros_wiki_citations') {
      if (!exists.topic.get(str(row.topic_slug) ?? '')) return skip()
    }
    if (insertRow(table, row)) inserted[table] += 1
    else skip()
  }
  const parents: Array<[unknown, unknown]> = []

  const rl = createInterface({ input: input.pipe(createGunzip()), crlfDelay: Infinity })
  let headerSeen = false
  let tableIndex = -1
  const unknownTables = new Set<string>()
  db.exec('BEGIN IMMEDIATE')
  try {
    for await (const line of rl) {
      if (line.trim() === '') continue
      const parsed = JSON.parse(line) as Record<string, unknown>
      if (!headerSeen) {
        if (parsed.type !== EXPORT_TYPE) throw new Error('not a rivet memory export')
        if (parsed.version !== EXPORT_VERSION) {
          throw new Error(`unsupported export version ${String(parsed.version)}`)
        }
        headerSeen = true
        continue
      }
      const table = parsed.t
      const row = parsed.r
      if (typeof table !== 'string' || typeof row !== 'object' || row === null) {
        throw new Error('malformed row in export')
      }
      const index = (EXPORT_TABLES as readonly string[]).indexOf(table)
      // A table this version does not know (a newer dump): skipped, as the
      // Postgres importer does.
      if (index === -1) {
        unknownTables.add(table)
        continue
      }
      if (index < tableIndex) throw new Error(`table ${table} is out of order in export`)
      tableIndex = index
      apply(table as ExportTable, row as Record<string, unknown>)
    }
    if (!headerSeen) throw new Error('empty export')
    // Parent links, once every summary of the file is in.
    const link = db.prepare(
      `UPDATE ros_summaries SET parent_id = ? WHERE id = ? AND parent_id IS NULL
          AND EXISTS (SELECT 1 FROM ros_summaries p WHERE p.id = ?)`,
    )
    for (const [id, parent] of parents) {
      if (typeof id === 'string' && typeof parent === 'string') link.run(parent, id, parent)
    }
    if (opts.dryRun) db.exec('ROLLBACK')
    else db.exec('COMMIT')
  } catch (err) {
    try {
      db.exec('ROLLBACK')
    } catch {
      // already rolled back
    }
    // Stop reading: the source must not be left flowing into nothing.
    rl.close()
    input.destroy()
    throw err
  }
  if (unknownTables.size > 0) log(`skipped unknown tables: ${[...unknownTables].join(', ')}`)
  log(
    `${opts.dryRun ? 'dry run: would insert' : 'inserted'} ${EXPORT_TABLES.map((t) => `${t}=${String(inserted[t])}`).join(' ')}`,
  )
  return { inserted, skipped, merged }
}
