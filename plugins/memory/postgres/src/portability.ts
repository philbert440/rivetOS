/**
 * Memory portability — gzip NDJSON v1 export/import (local ↔ cloud).
 *
 * Format: line 1 is the header; remaining lines are `{t, r}` rows in
 * EXPORT_TABLES order. Importers re-embed (no vector columns in the file).
 */

import { once } from 'node:events'
import { createInterface } from 'node:readline'
import type { Readable, Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createGunzip, createGzip } from 'node:zlib'
import { hostname as osHostname } from 'node:os'
import {
  EXPORT_COLUMNS,
  EXPORT_SINCE_COLUMN,
  EXPORT_TABLES,
  type ExportTable,
} from './portability-columns.js'

export { EXPORT_COLUMNS, EXPORT_TABLES, EXPORT_SINCE_COLUMN }
export type { ExportTable }

export const EXPORT_TYPE = 'rivet-memory-export'
export const EXPORT_VERSION = 1
export const IMPORT_BATCH_SIZE = 500
export const EXPORT_CURSOR_PAGE = 1000

export const EXPORT_TX_BEGIN_SQL = 'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY'
export const EXPORT_TX_COMMIT_SQL = 'COMMIT'
export const EXPORT_TX_ROLLBACK_SQL = 'ROLLBACK'

export const DEFER_EMBED_GUC_SQL = 'SET LOCAL rivet.defer_embed_enqueue = on'
export const GRAPHILE_NAMESPACE_SQL =
  "SELECT 1 FROM pg_namespace WHERE nspname = 'graphile_worker' LIMIT 1"
export const ENQUEUE_UNEMBEDDED_SQL =
  "SELECT graphile_worker.add_job('enqueue-unembedded', '{}'::json)"
export const GRAPHILE_MISSING_HINT =
  'graphile_worker schema not found — skipped enqueue-unembedded; start the worker services so embeddings backfill, or re-import after graphile-worker is installed'

/** Recursively selected summaries for `--since` (matching rows + parent chain). */
export const SELECTED_SUMMARIES_CTE = `WITH RECURSIVE selected_summaries AS (
  SELECT id, parent_id, conversation_id
  FROM ros_summaries
  WHERE created_at >= $1::timestamptz
  UNION
  SELECT p.id, p.parent_id, p.conversation_id
  FROM ros_summaries p
  INNER JOIN selected_summaries s ON p.id = s.parent_id
)`

const WIKI_CHANGED_PREDICATE = '(created_at >= $1::timestamptz OR updated_at >= $1::timestamptz)'

export const SUMMARY_PARENT_UPDATE_SQL = `UPDATE ros_summaries AS s
SET parent_id = v.parent_id
FROM json_populate_recordset(NULL::ros_summaries, $1::json) AS v
WHERE s.id = v.id
  AND v.parent_id IS NOT NULL
  AND EXISTS (SELECT 1 FROM ros_summaries AS p WHERE p.id = v.parent_id)`

export const SUMMARY_PARENT_UNRESOLVED_SQL = `SELECT count(*)::int AS n
FROM json_populate_recordset(NULL::ros_summaries, $1::json) AS v
WHERE v.parent_id IS NOT NULL
  AND EXISTS (SELECT 1 FROM ros_summaries AS c WHERE c.id = v.id)
  AND NOT EXISTS (SELECT 1 FROM ros_summaries AS p WHERE p.id = v.parent_id)`

export interface PortabilityQueryResult {
  rows: Record<string, unknown>[]
  rowCount: number | null
}

export interface PortabilityClient {
  query: (sql: string, values?: unknown[]) => Promise<PortabilityQueryResult>
  release?: () => void
}

export interface PortabilityPool {
  query: (sql: string, values?: unknown[]) => Promise<PortabilityQueryResult>
  connect?: () => Promise<PortabilityClient>
}

export type ExportSourceKind = 'cloud' | 'local' | 'datahub'

export interface ExportSource {
  kind: ExportSourceKind
  id: string
}

export interface ExportHeader {
  type: typeof EXPORT_TYPE
  version: typeof EXPORT_VERSION
  exported_at: string
  source: ExportSource
  tables: readonly ExportTable[]
}

export interface ExportOptions {
  since?: Date | string
  source?: ExportSource
  exportedAt?: string
}

export interface ImportOptions {
  dryRun?: boolean
  /** Override console output (tests). */
  log?: (message: string) => void
}

export interface ImportResult {
  inserted: Record<string, number>
  skipped: Record<string, number>
  enqueuedEmbeds: number
  unresolvedParentLinks: number
}

const TABLE_SET = new Set<string>(EXPORT_TABLES)

export function insertBatchSql(table: string, cols: readonly string[]): string {
  if (cols.length === 0) {
    return `INSERT INTO ${table} DEFAULT VALUES ON CONFLICT DO NOTHING`
  }
  const list = cols.join(', ')
  return (
    `INSERT INTO ${table} (${list}) ` +
    `SELECT ${list} FROM json_populate_recordset(NULL::${table}, $1::json) ` +
    `ON CONFLICT DO NOTHING`
  )
}

export function declareCursorSql(cursor: string, selectSql: string): string {
  return `DECLARE ${cursor} NO SCROLL CURSOR FOR ${selectSql}`
}

export function fetchCursorSql(cursor: string, page = EXPORT_CURSOR_PAGE): string {
  return `FETCH ${page} FROM ${cursor}`
}

export function closeCursorSql(cursor: string): string {
  return `CLOSE ${cursor}`
}

export function exportCursorName(table: ExportTable): string {
  return `export_${table}`
}

export function selectTableSql(
  table: ExportTable,
  cols: readonly string[],
  since?: Date | string,
): { sql: string; params: unknown[] } {
  const list = cols.join(', ')
  if (since === undefined) {
    return { sql: `SELECT ${list} FROM ${table}`, params: [] }
  }
  const iso = since instanceof Date ? since.toISOString() : since
  const params = [iso]
  switch (table) {
    case 'ros_messages':
      return {
        sql: `SELECT ${list} FROM ros_messages WHERE created_at >= $1::timestamptz ORDER BY created_at ASC`,
        params,
      }
    case 'ros_conversations':
      return {
        sql:
          `${SELECTED_SUMMARIES_CTE} SELECT ${list} FROM ros_conversations WHERE id IN (` +
          `SELECT conversation_id FROM ros_messages WHERE created_at >= $1::timestamptz ` +
          `UNION SELECT conversation_id FROM selected_summaries)`,
        params,
      }
    case 'ros_summaries':
      return {
        sql: `${SELECTED_SUMMARIES_CTE} SELECT ${list} FROM ros_summaries WHERE id IN (SELECT id FROM selected_summaries)`,
        params,
      }
    case 'ros_summary_sources':
      return {
        sql:
          `${SELECTED_SUMMARIES_CTE} SELECT ${list} FROM ros_summary_sources ` +
          `WHERE summary_id IN (SELECT id FROM selected_summaries) ` +
          `AND message_id IN (SELECT id FROM ros_messages WHERE created_at >= $1::timestamptz)`,
        params,
      }
    case 'ros_wiki_topics':
      return {
        sql: `SELECT ${list} FROM ros_wiki_topics WHERE ${WIKI_CHANGED_PREDICATE}`,
        params,
      }
    case 'ros_wiki_redirects':
      return {
        sql:
          `SELECT ${list} FROM ros_wiki_redirects WHERE to_slug IN (` +
          `SELECT slug FROM ros_wiki_topics WHERE ${WIKI_CHANGED_PREDICATE})`,
        params,
      }
    case 'ros_wiki_citations':
      return {
        sql:
          `SELECT ${list} FROM ros_wiki_citations WHERE topic_slug IN (` +
          `SELECT slug FROM ros_wiki_topics WHERE ${WIKI_CHANGED_PREDICATE})`,
        params,
      }
  }
}

export function isExportTable(value: string): value is ExportTable {
  return TABLE_SET.has(value)
}

export function pickKnownColumns(
  row: Record<string, unknown>,
  cols: readonly string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const col of cols) {
    if (Object.prototype.hasOwnProperty.call(row, col)) {
      out[col] = serializeValue(row[col])
    }
  }
  return out
}

/** Partition rows by the allowlisted keys they actually carry (explicit null counts). */
export function groupByPresentColumns(
  rows: Record<string, unknown>[],
  allowed: readonly string[],
): Array<{ cols: string[]; rows: Record<string, unknown>[] }> {
  const map = new Map<string, { cols: string[]; rows: Record<string, unknown>[] }>()
  for (const row of rows) {
    const cols = allowed.filter((c) => Object.prototype.hasOwnProperty.call(row, c))
    const key = cols.join('\0')
    let group = map.get(key)
    if (!group) {
      group = { cols, rows: [] }
      map.set(key, group)
    }
    group.rows.push(row)
  }
  return [...map.values()]
}

function serializeValue(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString()
  return value
}

function emptyCounts(): Record<string, number> {
  const out: Record<string, number> = {}
  for (const table of EXPORT_TABLES) out[table] = 0
  return out
}

async function withClient<T>(
  pool: PortabilityPool,
  fn: (client: PortabilityClient) => Promise<T>,
): Promise<T> {
  if (typeof pool.connect === 'function') {
    const client = await pool.connect()
    try {
      return await fn(client)
    } finally {
      client.release?.()
    }
  }
  return fn(pool)
}

function destroyQuiet(stream: Readable): void {
  try {
    stream.destroy()
  } catch {
    // already destroyed
  }
}

export async function exportMemory(
  pool: PortabilityPool,
  out: Writable,
  opts: ExportOptions = {},
): Promise<void> {
  const gzip = createGzip()
  const done = new Promise<void>((resolve, reject) => {
    gzip.on('error', reject)
    out.on('error', reject)
    gzip.on('end', () => resolve())
  })
  gzip.pipe(out, { end: false })

  await withClient(pool, async (client) => {
    await client.query(EXPORT_TX_BEGIN_SQL)
    let txOpen = true
    const openCursors: string[] = []
    try {
      const header: ExportHeader = {
        type: EXPORT_TYPE,
        version: EXPORT_VERSION,
        exported_at: opts.exportedAt ?? new Date().toISOString(),
        source: opts.source ?? { kind: 'local', id: osHostname() },
        tables: EXPORT_TABLES,
      }
      if (!gzip.write(`${JSON.stringify(header)}\n`)) await once(gzip, 'drain')

      for (const table of EXPORT_TABLES) {
        const cols = EXPORT_COLUMNS[table]
        const { sql, params } = selectTableSql(table, cols, opts.since)
        const cursor = exportCursorName(table)
        await client.query(declareCursorSql(cursor, sql), params)
        openCursors.push(cursor)
        try {
          for (;;) {
            const result = await client.query(fetchCursorSql(cursor))
            if (result.rows.length === 0) break
            for (const row of result.rows) {
              const payload = { t: table, r: pickKnownColumns(row, cols) }
              if (!gzip.write(`${JSON.stringify(payload)}\n`)) await once(gzip, 'drain')
            }
          }
        } finally {
          await client.query(closeCursorSql(cursor))
          const idx = openCursors.lastIndexOf(cursor)
          if (idx >= 0) openCursors.splice(idx, 1)
        }
      }
      gzip.end()
      await done
      await client.query(EXPORT_TX_COMMIT_SQL)
      txOpen = false
    } catch (err) {
      gzip.destroy()
      await done.catch(() => undefined)
      throw err
    } finally {
      for (const cursor of openCursors) {
        await client.query(closeCursorSql(cursor)).catch(() => undefined)
      }
      if (txOpen) {
        await client.query(EXPORT_TX_ROLLBACK_SQL).catch(() => undefined)
      }
    }
  })
}

export async function importMemory(
  pool: PortabilityPool,
  input: Readable,
  opts: ImportOptions = {},
): Promise<ImportResult> {
  const log = opts.log ?? console.log
  const dryRun = opts.dryRun ?? false
  const inserted = emptyCounts()
  const skipped = emptyCounts()
  let enqueuedEmbeds = 0
  let unresolvedParentLinks = 0

  const gunzip = createGunzip()
  const rl = createInterface({ input: gunzip, crlfDelay: Infinity })
  const piped = pipeline(input, gunzip)

  const run = async (): Promise<ImportResult> => {
    const result = await withClient(pool, async (client) => {
      let headerSeen = false
      let currentTable: ExportTable | null = null
      let batch: Record<string, unknown>[] = []
      let pendingParents: Array<{ id: unknown; parent_id: unknown }> = []

      const insertGroup = async (
        table: ExportTable,
        cols: readonly string[],
        groupRows: Record<string, unknown>[],
      ): Promise<void> => {
        const defer = table === 'ros_messages' || table === 'ros_summaries'
        await client.query('BEGIN')
        try {
          if (defer) await client.query(DEFER_EMBED_GUC_SQL)
          if (cols.length === 0) {
            for (let i = 0; i < groupRows.length; i++) {
              const res = await client.query(insertBatchSql(table, cols))
              const wrote = res.rowCount ?? 0
              inserted[table] += wrote
              skipped[table] += wrote > 0 ? 0 : 1
            }
          } else {
            const sql = insertBatchSql(table, cols)
            const res = await client.query(sql, [JSON.stringify(groupRows)])
            const wrote = res.rowCount ?? 0
            inserted[table] += wrote
            skipped[table] += Math.max(0, groupRows.length - wrote)
          }
          await client.query('COMMIT')
        } catch (err) {
          await client.query('ROLLBACK').catch(() => undefined)
          throw err
        }
      }

      const applySummaryParentLinks = async (): Promise<void> => {
        if (dryRun || pendingParents.length === 0) {
          pendingParents = []
          return
        }
        for (let i = 0; i < pendingParents.length; i += IMPORT_BATCH_SIZE) {
          const chunk = pendingParents.slice(i, i + IMPORT_BATCH_SIZE)
          const payload = JSON.stringify(chunk)
          await client.query(SUMMARY_PARENT_UPDATE_SQL, [payload])
          const unresolved = await client.query(SUMMARY_PARENT_UNRESOLVED_SQL, [payload])
          const n = unresolved.rows[0]?.n
          unresolvedParentLinks += typeof n === 'number' ? n : Number(n ?? 0)
        }
        pendingParents = []
      }

      const flush = async (): Promise<void> => {
        if (!currentTable || batch.length === 0) {
          batch = []
          return
        }
        const table = currentTable
        const allowed = EXPORT_COLUMNS[table]
        const rows = batch
        batch = []
        if (dryRun) return

        if (table === 'ros_summaries') {
          for (const row of rows) {
            if (row.parent_id != null && row.id != null) {
              pendingParents.push({ id: row.id, parent_id: row.parent_id })
            }
            delete row.parent_id
          }
        }

        for (let i = 0; i < rows.length; i += IMPORT_BATCH_SIZE) {
          const chunk = rows.slice(i, i + IMPORT_BATCH_SIZE)
          for (const group of groupByPresentColumns(chunk, allowed)) {
            await insertGroup(table, group.cols, group.rows)
          }
        }
      }

      const finishTable = async (): Promise<void> => {
        await flush()
        if (currentTable === 'ros_summaries') await applySummaryParentLinks()
      }

      for await (const raw of rl) {
        const line = raw.trim()
        if (!line) continue
        let parsed: unknown
        try {
          parsed = JSON.parse(line) as unknown
        } catch {
          throw new Error('invalid NDJSON: line is not JSON')
        }
        if (!headerSeen) {
          assertHeader(parsed)
          headerSeen = true
          continue
        }
        const row = parseRow(parsed)
        if (!row) continue
        if (row.t !== currentTable) {
          await finishTable()
          currentTable = row.t
        }
        batch.push(row.r)
        if (batch.length >= IMPORT_BATCH_SIZE) await flush()
      }
      await finishTable()

      if (!headerSeen) {
        throw new Error('invalid rivet-memory-export: missing header')
      }

      if (!dryRun) {
        const ns = await client.query(GRAPHILE_NAMESPACE_SQL)
        if ((ns.rowCount ?? ns.rows.length) > 0) {
          await client.query(ENQUEUE_UNEMBEDDED_SQL)
          enqueuedEmbeds = 1
        } else {
          log(GRAPHILE_MISSING_HINT)
        }
      }

      return { inserted, skipped, enqueuedEmbeds, unresolvedParentLinks }
    })
    rl.close()
    await piped
    return result
  }

  try {
    return await run()
  } catch (err) {
    rl.close()
    destroyQuiet(input)
    destroyQuiet(gunzip)
    await piped.catch(() => undefined)
    throw err
  }
}

function assertHeader(value: unknown): asserts value is ExportHeader {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('invalid rivet-memory-export: header is not an object')
  }
  const rec = value as Record<string, unknown>
  if (rec.type !== EXPORT_TYPE) {
    throw new Error(`invalid rivet-memory-export: type ${String(rec.type)}`)
  }
  if (rec.version !== EXPORT_VERSION) {
    throw new Error(`unsupported rivet-memory-export version: ${String(rec.version)}`)
  }
}

function parseRow(value: unknown): { t: ExportTable; r: Record<string, unknown> } | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('invalid rivet-memory-export: row is not an object')
  }
  const rec = value as Record<string, unknown>
  if (typeof rec.t !== 'string') {
    throw new Error('invalid rivet-memory-export: row missing t')
  }
  if (!isExportTable(rec.t)) return null
  if (!rec.r || typeof rec.r !== 'object' || Array.isArray(rec.r)) {
    throw new Error(`invalid rivet-memory-export: row.r for ${rec.t} is not an object`)
  }
  return { t: rec.t, r: pickKnownColumns(rec.r as Record<string, unknown>, EXPORT_COLUMNS[rec.t]) }
}
