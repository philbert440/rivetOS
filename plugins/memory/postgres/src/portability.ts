/**
 * Memory portability — gzip NDJSON v1 export/import (local ↔ cloud).
 *
 * Format: line 1 is the header; remaining lines are `{t, r}` rows in
 * EXPORT_TABLES order. Importers re-embed (no vector columns in the file).
 */

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
/** Max uuids per `= ANY($1::uuid[])` bind when filtering junction rows. */
export const EXPORT_ID_CHUNK = 5000

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

/** Destination id for every incoming conversation, including natural-key merges. */
export const RESOLVE_CONVERSATIONS_SQL = `SELECT id, session_key, agent FROM ros_conversations
WHERE (session_key, agent) IN (
  SELECT session_key, agent FROM json_to_recordset($1::json) AS v(session_key text, agent text)
)`

/** Presence check for message conversation_ids that were not in the dump map. */
export const EXISTING_CONVERSATION_IDS_SQL =
  'SELECT id FROM ros_conversations WHERE id = ANY($1::uuid[])'

function asText(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value)
  }
  return undefined
}

function conversationPairKey(sessionKey: string, agent: string): string {
  return `${sessionKey}\0${agent}`
}

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
  /** Natural-key merges; `ros_conversations` counts (session_key, agent) remaps. */
  merged: Record<string, number>
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

export function chunkIds(ids: readonly string[], size = EXPORT_ID_CHUNK): string[][] {
  const out: string[][] = []
  for (let i = 0; i < ids.length; i += size) {
    out.push(ids.slice(i, i + size))
  }
  return out
}

/** Junction rows whose both ends are in the exported id sets. */
export function summarySourcesByExportedIdsSql(cols: readonly string[]): string {
  const list = cols.join(', ')
  return (
    `SELECT ${list} FROM ros_summary_sources ` +
    `WHERE summary_id = ANY($1::uuid[]) AND message_id = ANY($2::uuid[])`
  )
}

/** Conversations whose ids were collected from the --since closure. */
export function conversationsByExportedIdsSql(cols: readonly string[]): string {
  const list = cols.join(', ')
  return `SELECT ${list} FROM ros_conversations WHERE id = ANY($1::uuid[])`
}

/** Lightweight --since id pass: every in-window message (all pages). */
export const COLLECT_MESSAGE_IDS_SQL =
  'SELECT id, conversation_id FROM ros_messages WHERE created_at >= $1::timestamptz ORDER BY created_at ASC'

/** Lightweight --since id pass: selected summaries + parent chain. */
export const COLLECT_SUMMARY_IDS_SQL = `${SELECTED_SUMMARIES_CTE} SELECT id, conversation_id FROM selected_summaries`

/** Lightweight --since id pass: conversations changed in the window. */
export const COLLECT_CONVERSATION_IDS_SQL =
  'SELECT id FROM ros_conversations WHERE created_at >= $1::timestamptz OR updated_at >= $1::timestamptz'

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
      // Live --since export does not use this SQL: exportMemory collects
      // conversation_ids from every message page (plus the time window) and
      // binds `conversationsByExportedIdsSql`. Subquery form is the standalone
      // equivalent.
      return {
        sql:
          `${SELECTED_SUMMARIES_CTE} SELECT ${list} FROM ros_conversations WHERE ` +
          `(created_at >= $1::timestamptz OR updated_at >= $1::timestamptz) ` +
          `OR id IN (` +
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
      // Live --since export does not use this SQL: exportMemory binds the
      // ids that were actually emitted (`summarySourcesByExportedIdsSql`).
      // Subquery form is the standalone equivalent (both ends in-window).
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

function asError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err))
}

async function collectCursorRows(
  client: PortabilityClient,
  cursor: string,
  sql: string,
  params: unknown[],
  openCursors: string[],
  visit: (row: Record<string, unknown>) => void,
): Promise<void> {
  await client.query(declareCursorSql(cursor, sql), params)
  openCursors.push(cursor)
  try {
    for (;;) {
      const result = await client.query(fetchCursorSql(cursor))
      if (result.rows.length === 0) break
      for (const row of result.rows) visit(row)
    }
  } finally {
    await client.query(closeCursorSql(cursor))
    const idx = openCursors.lastIndexOf(cursor)
    if (idx >= 0) openCursors.splice(idx, 1)
  }
}

async function* emitCursorRows(
  client: PortabilityClient,
  table: ExportTable,
  cols: readonly string[],
  sql: string,
  params: unknown[],
  openCursors: string[],
): AsyncGenerator<string> {
  const cursor = exportCursorName(table)
  await client.query(declareCursorSql(cursor, sql), params)
  openCursors.push(cursor)
  try {
    for (;;) {
      const result = await client.query(fetchCursorSql(cursor))
      if (result.rows.length === 0) break
      for (const row of result.rows) {
        const payload = { t: table, r: pickKnownColumns(row, cols) }
        yield `${JSON.stringify(payload)}\n`
      }
    }
  } finally {
    await client.query(closeCursorSql(cursor))
    const idx = openCursors.lastIndexOf(cursor)
    if (idx >= 0) openCursors.splice(idx, 1)
  }
}

async function* emitRowsByIdChunks(
  client: PortabilityClient,
  table: ExportTable,
  cols: readonly string[],
  ids: readonly string[],
  openCursors: string[],
  sqlForCols: (cols: readonly string[]) => string,
): AsyncGenerator<string> {
  if (ids.length === 0) return
  const selectSql = sqlForCols(cols)
  for (const chunk of chunkIds(ids)) {
    yield* emitCursorRows(client, table, cols, selectSql, [chunk], openCursors)
  }
}

async function* emitSummarySourcesByExportedIds(
  client: PortabilityClient,
  cols: readonly string[],
  summaryIds: readonly string[],
  messageIds: readonly string[],
  openCursors: string[],
): AsyncGenerator<string> {
  if (summaryIds.length === 0 || messageIds.length === 0) return
  const selectSql = summarySourcesByExportedIdsSql(cols)
  for (const sumChunk of chunkIds(summaryIds)) {
    for (const msgChunk of chunkIds(messageIds)) {
      yield* emitCursorRows(
        client,
        'ros_summary_sources',
        cols,
        selectSql,
        [sumChunk, msgChunk],
        openCursors,
      )
    }
  }
}

export async function exportMemory(
  pool: PortabilityPool,
  out: Writable,
  opts: ExportOptions = {},
): Promise<void> {
  await withClient(pool, async (client) => {
    await client.query(EXPORT_TX_BEGIN_SQL)
    let txOpen = true
    const openCursors: string[] = []
    const gzip = createGzip()
    try {
      async function* ndjson(): AsyncGenerator<string> {
        const header: ExportHeader = {
          type: EXPORT_TYPE,
          version: EXPORT_VERSION,
          exported_at: opts.exportedAt ?? new Date().toISOString(),
          source: opts.source ?? { kind: 'local', id: osHostname() },
          tables: EXPORT_TABLES,
        }
        yield `${JSON.stringify(header)}\n`

        // Id sets are only needed for --since closure. Full exports page
        // through cursors and must not retain every message/summary id.
        let messageIds: readonly string[] = []
        let summaryIds: readonly string[] = []
        let conversationIds: readonly string[] = []
        const since = opts.since
        if (since !== undefined) {
          const iso = since instanceof Date ? since.toISOString() : since
          const collectedMessages: string[] = []
          const collectedSummaries: string[] = []
          const conversationIdSet = new Set<string>()

          await collectCursorRows(
            client,
            exportCursorName('ros_messages'),
            COLLECT_MESSAGE_IDS_SQL,
            [iso],
            openCursors,
            (row) => {
              const id = asText(row.id)
              if (id != null) collectedMessages.push(id)
              const cid = asText(row.conversation_id)
              if (cid != null) conversationIdSet.add(cid)
            },
          )
          await collectCursorRows(
            client,
            exportCursorName('ros_summaries'),
            COLLECT_SUMMARY_IDS_SQL,
            [iso],
            openCursors,
            (row) => {
              const id = asText(row.id)
              if (id != null) collectedSummaries.push(id)
              const cid = asText(row.conversation_id)
              if (cid != null) conversationIdSet.add(cid)
            },
          )
          await collectCursorRows(
            client,
            exportCursorName('ros_conversations'),
            COLLECT_CONVERSATION_IDS_SQL,
            [iso],
            openCursors,
            (row) => {
              const id = asText(row.id)
              if (id != null) conversationIdSet.add(id)
            },
          )

          messageIds = collectedMessages
          summaryIds = collectedSummaries
          conversationIds = [...conversationIdSet]
        }

        for (const table of EXPORT_TABLES) {
          const cols = EXPORT_COLUMNS[table]
          if (since !== undefined && table === 'ros_conversations') {
            yield* emitRowsByIdChunks(
              client,
              table,
              cols,
              conversationIds,
              openCursors,
              conversationsByExportedIdsSql,
            )
            continue
          }
          if (since !== undefined && table === 'ros_summary_sources') {
            yield* emitSummarySourcesByExportedIds(
              client,
              cols,
              summaryIds,
              messageIds,
              openCursors,
            )
            continue
          }
          const { sql, params } = selectTableSql(table, cols, since)
          yield* emitCursorRows(client, table, cols, sql, params, openCursors)
        }
      }

      // end: false — do not close stdout; --out files are ended by the CLI.
      await pipeline(ndjson(), gzip, out, { end: false })
      await client.query(EXPORT_TX_COMMIT_SQL)
      txOpen = false
    } catch (err) {
      gzip.destroy(asError(err))
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
  skipped.orphan_messages = 0
  const merged = emptyCounts()
  let enqueuedEmbeds = 0
  let unresolvedParentLinks = 0
  /** incoming conversation id → destination id (equal when inserted, different when merged). */
  const conversationIdMap = new Map<string, string>()

  try {
    return await withClient(pool, async (client) => {
      // Client first, then attach the iterator, then start the source.
      // Piping before connect drops the header when connect is slow (X4).
      const gunzip = createGunzip()
      const rl = createInterface({ input: gunzip, crlfDelay: Infinity })

      let headerSeen = false
      let currentTable: ExportTable | null = null
      let batch: Record<string, unknown>[] = []
      let pendingParents: Array<{ id: unknown; parent_id: unknown }> = []

      const insertGroup = async (
        table: ExportTable,
        cols: readonly string[],
        groupRows: Record<string, unknown>[],
      ): Promise<unknown[]> => {
        const defer = table === 'ros_messages' || table === 'ros_summaries'
        const returning = table === 'ros_summaries'
        const sql = returning
          ? `${insertBatchSql(table, cols)} RETURNING id`
          : insertBatchSql(table, cols)
        const ids: unknown[] = []
        await client.query('BEGIN')
        try {
          if (defer) await client.query(DEFER_EMBED_GUC_SQL)
          if (cols.length === 0) {
            for (let i = 0; i < groupRows.length; i++) {
              const res = await client.query(sql)
              const wrote = res.rowCount ?? 0
              inserted[table] += wrote
              skipped[table] += wrote > 0 ? 0 : 1
              if (returning) {
                for (const row of res.rows) {
                  if (row.id != null) ids.push(row.id)
                }
              }
            }
          } else {
            const res = await client.query(sql, [JSON.stringify(groupRows)])
            const wrote = res.rowCount ?? 0
            inserted[table] += wrote
            skipped[table] += Math.max(0, groupRows.length - wrote)
            if (returning) {
              for (const row of res.rows) {
                if (row.id != null) ids.push(row.id)
              }
            }
          }
          await client.query('COMMIT')
          return ids
        } catch (err) {
          await client.query('ROLLBACK').catch(() => undefined)
          throw err
        }
      }

      const resolveConversationIds = async (incoming: Record<string, unknown>[]): Promise<void> => {
        const pairs: Array<{ session_key: string; agent: string }> = []
        for (const row of incoming) {
          const sessionKey = asText(row.session_key)
          const agent = asText(row.agent)
          if (sessionKey == null || agent == null) continue
          pairs.push({ session_key: sessionKey, agent })
        }
        if (pairs.length === 0) return
        const res = await client.query(RESOLVE_CONVERSATIONS_SQL, [JSON.stringify(pairs)])
        const destByPair = new Map<string, string>()
        for (const row of res.rows) {
          const id = asText(row.id)
          const sessionKey = asText(row.session_key)
          const agent = asText(row.agent)
          if (id == null || sessionKey == null || agent == null) continue
          destByPair.set(conversationPairKey(sessionKey, agent), id)
        }
        for (const row of incoming) {
          const srcId = asText(row.id)
          const sessionKey = asText(row.session_key)
          const agent = asText(row.agent)
          if (srcId == null || sessionKey == null || agent == null) continue
          const destId = destByPair.get(conversationPairKey(sessionKey, agent))
          if (destId == null) continue
          conversationIdMap.set(srcId, destId)
          if (srcId !== destId) merged.ros_conversations += 1
        }
      }

      const ensureMappedConversationIds = async (ids: string[]): Promise<void> => {
        const unknown: string[] = []
        const seen = new Set<string>()
        for (const id of ids) {
          if (conversationIdMap.has(id) || seen.has(id)) continue
          seen.add(id)
          unknown.push(id)
        }
        if (unknown.length === 0) return
        const found = await client.query(EXISTING_CONVERSATION_IDS_SQL, [unknown])
        for (const row of found.rows) {
          const id = asText(row.id)
          if (id == null) continue
          conversationIdMap.set(id, id)
        }
      }

      const filterAndRewriteMessages = async (
        rows: Record<string, unknown>[],
      ): Promise<Record<string, unknown>[]> => {
        const pending: string[] = []
        for (const row of rows) {
          const cid = asText(row.conversation_id)
          if (cid == null) continue
          pending.push(cid)
        }
        await ensureMappedConversationIds(pending)
        const keep: Record<string, unknown>[] = []
        for (const row of rows) {
          if (row.conversation_id == null) {
            keep.push(row)
            continue
          }
          const src = asText(row.conversation_id)
          const dest = src == null ? undefined : conversationIdMap.get(src)
          if (dest == null) {
            skipped.orphan_messages += 1
            continue
          }
          row.conversation_id = dest
          keep.push(row)
        }
        return keep
      }

      const rewriteSummaryConversationIds = async (
        rows: Record<string, unknown>[],
      ): Promise<void> => {
        const pending: string[] = []
        for (const row of rows) {
          const cid = asText(row.conversation_id)
          if (cid == null) continue
          pending.push(cid)
        }
        await ensureMappedConversationIds(pending)
        for (const row of rows) {
          if (row.conversation_id == null) continue
          const src = asText(row.conversation_id)
          const dest = src == null ? undefined : conversationIdMap.get(src)
          if (dest == null) {
            // Nullable FK — drop the dangling id rather than 500.
            delete row.conversation_id
          } else {
            row.conversation_id = dest
          }
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

        const parentById = new Map<string, unknown>()
        if (table === 'ros_summaries') {
          for (const row of rows) {
            const id = asText(row.id)
            if (row.parent_id != null && id != null) {
              parentById.set(id, row.parent_id)
            }
            delete row.parent_id
          }
        }

        const insertedIds: unknown[] = []
        for (let i = 0; i < rows.length; i += IMPORT_BATCH_SIZE) {
          let chunk = rows.slice(i, i + IMPORT_BATCH_SIZE)
          if (table === 'ros_messages') {
            chunk = await filterAndRewriteMessages(chunk)
          } else if (table === 'ros_summaries') {
            await rewriteSummaryConversationIds(chunk)
          }
          if (chunk.length === 0) continue
          for (const group of groupByPresentColumns(chunk, allowed)) {
            insertedIds.push(...(await insertGroup(table, group.cols, group.rows)))
          }
          if (table === 'ros_conversations') {
            await resolveConversationIds(chunk)
          }
        }

        if (table === 'ros_summaries') {
          for (const id of insertedIds) {
            const key = asText(id)
            const parentId = key == null ? undefined : parentById.get(key)
            if (parentId != null) pendingParents.push({ id, parent_id: parentId })
          }
        }
      }

      const finishTable = async (): Promise<void> => {
        await flush()
        if (currentTable === 'ros_summaries') await applySummaryParentLinks()
      }

      let piped: Promise<void> | undefined
      try {
        const consume = (async (): Promise<ImportResult> => {
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

          return { inserted, skipped, merged, enqueuedEmbeds, unresolvedParentLinks }
        })()

        piped = pipeline(input, gunzip)
        const result = await consume
        await piped
        return result
      } catch (err) {
        destroyQuiet(input)
        destroyQuiet(gunzip)
        if (piped !== undefined) await piped.catch(() => undefined)
        throw err
      } finally {
        rl.close()
      }
    })
  } catch (err) {
    destroyQuiet(input)
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
