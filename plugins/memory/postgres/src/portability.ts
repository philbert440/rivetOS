/**
 * Memory portability — gzip NDJSON v1 export/import (local ↔ cloud).
 *
 * Format: line 1 is the header; remaining lines are `{t, r}` rows in
 * EXPORT_TABLES order. Importers re-embed (no vector columns in the file).
 */

import { once } from 'node:events'
import { createInterface } from 'node:readline'
import type { Readable, Writable } from 'node:stream'
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

export const DEFER_EMBED_GUC_SQL = 'SET rivet.defer_embed_enqueue = on'
export const GRAPHILE_NAMESPACE_SQL =
  "SELECT 1 FROM pg_namespace WHERE nspname = 'graphile_worker' LIMIT 1"
export const ENQUEUE_UNEMBEDDED_SQL =
  "SELECT graphile_worker.add_job('enqueue-unembedded', '{}'::json)"
export const GRAPHILE_MISSING_HINT =
  'graphile_worker schema not found — skipped enqueue-unembedded; start the worker services so embeddings backfill, or re-import after graphile-worker is installed'

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
}

const TABLE_SET = new Set<string>(EXPORT_TABLES)

export function insertBatchSql(table: string, cols: readonly string[]): string {
  const list = cols.join(', ')
  return (
    `INSERT INTO ${table} (${list}) ` +
    `SELECT ${list} FROM json_populate_recordset(NULL::${table}, $1::json) ` +
    `ON CONFLICT DO NOTHING`
  )
}

export function selectTableSql(
  table: ExportTable,
  cols: readonly string[],
  since?: Date | string,
): { sql: string; params: unknown[] } {
  const list = cols.join(', ')
  const sinceCol = EXPORT_SINCE_COLUMN[table]
  if (since !== undefined && sinceCol) {
    const iso = since instanceof Date ? since.toISOString() : since
    return {
      sql: `SELECT ${list} FROM ${table} WHERE ${sinceCol} >= $1::timestamptz ORDER BY ${sinceCol} ASC`,
      params: [iso],
    }
  }
  return { sql: `SELECT ${list} FROM ${table}`, params: [] }
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
      const result = await pool.query(sql, params)
      for (const row of result.rows) {
        const payload = { t: table, r: pickKnownColumns(row, cols) }
        if (!gzip.write(`${JSON.stringify(payload)}\n`)) await once(gzip, 'drain')
      }
    }
    gzip.end()
    await done
  } catch (err) {
    gzip.destroy()
    throw err
  }
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
  let deferSet = false

  const gunzip = createGunzip()
  input.pipe(gunzip)
  const rl = createInterface({ input: gunzip, crlfDelay: Infinity })

  let headerSeen = false
  let currentTable: ExportTable | null = null
  let batch: Record<string, unknown>[] = []

  const result = await withClient(pool, async (client) => {
    const flush = async (): Promise<void> => {
      if (!currentTable || batch.length === 0) {
        batch = []
        return
      }
      const table = currentTable
      const cols = EXPORT_COLUMNS[table]
      const rows = batch
      batch = []
      if (dryRun) return

      if (table === 'ros_messages' && !deferSet) {
        await client.query(DEFER_EMBED_GUC_SQL)
        deferSet = true
      }

      for (let i = 0; i < rows.length; i += IMPORT_BATCH_SIZE) {
        const chunk = rows.slice(i, i + IMPORT_BATCH_SIZE)
        const sql = insertBatchSql(table, cols)
        const res = await client.query(sql, [JSON.stringify(chunk)])
        const wrote = res.rowCount ?? 0
        inserted[table] += wrote
        skipped[table] += Math.max(0, chunk.length - wrote)
      }
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
        await flush()
        currentTable = row.t
      }
      batch.push(row.r)
      if (batch.length >= IMPORT_BATCH_SIZE) await flush()
    }
    await flush()

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

    return { inserted, skipped, enqueuedEmbeds }
  })

  return result
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
