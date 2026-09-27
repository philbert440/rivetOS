/**
 * Read-only reader over a Grok Bot per-agent `agents/<id>/store.db`.
 *
 * Schema is taken from published grok-bot-mcp / xopc sources only — this
 * environment has no live store.db dump. Documented columns:
 *   transcript_entries(entry_id, session_id, seq, entry_kind, role, payload_json, created_at)
 * plus unused sibling tables kv / blobs. Positions are `seq`, which is not
 * the on-disk jsonl line index, so ingest uses SESSION_SUFFIX_V3_STORE.
 *
 * Open is SQLITE_OPEN_READONLY (`readOnly: true`) plus `PRAGMA query_only=ON`.
 * node:sqlite rejects `file:?mode=ro` / `immutable` URIs (SQLITE_CANTOPEN),
 * so those query params are not used. This process never writes the DB or
 * its WAL.
 */
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { isRecord } from '@rivetos/capture-core'
import { SESSION_SUFFIX_V3_STORE } from './types.js'

export { SESSION_SUFFIX_V3_STORE }

export interface TranscriptEntry {
  entry_id: string
  session_id: string | null
  seq: number
  entry_kind: string | null
  role: string | null
  payload: unknown
  created_at: string | null
}

export interface StoreReadOptions {
  /** Exclusive lower bound. Persist this as the live cursor. */
  afterSeq?: number
}

export interface StoreReadResult {
  entries: TranscriptEntry[]
  records: unknown[]
  positions: number[]
  maxSeq: number
  minSeq: number
}

const ENTRY_COLS = 'entry_id, session_id, seq, entry_kind, role, payload_json, created_at'

interface EntryRow {
  entry_id: unknown
  session_id: unknown
  seq: unknown
  entry_kind: unknown
  role: unknown
  payload_json: unknown
  created_at: unknown
}

/** SQLITE_OPEN_READONLY. Does not write WAL. */
export function openStoreReadonly(dbPath: string): DatabaseSync {
  const abs = resolve(dbPath)
  if (!existsSync(abs)) {
    throw new Error(`store.db not found: ${abs}`)
  }
  const db = new DatabaseSync(abs, { readOnly: true })
  db.exec('PRAGMA query_only = ON')
  return db
}

export function storeDbPath(agentsDir: string, agentId: string): string {
  return resolve(agentsDir, agentId, 'store.db')
}

export function v3StoreSession(session: string): string {
  return session.endsWith(SESSION_SUFFIX_V3_STORE)
    ? session
    : `${session}${SESSION_SUFFIX_V3_STORE}`
}

export function listTranscriptEntries(dbPath: string, opts?: StoreReadOptions): TranscriptEntry[] {
  const db = openStoreReadonly(dbPath)
  try {
    const table = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'transcript_entries'`,
      )
      .get() as { name?: string } | undefined
    if (!table?.name) return []
    const after = opts?.afterSeq ?? -1
    const rows = db
      .prepare(`SELECT ${ENTRY_COLS} FROM transcript_entries WHERE seq > ? ORDER BY seq ASC`)
      .all(after) as unknown as EntryRow[]
    return rows.map(mapEntryRow)
  } finally {
    db.close()
  }
}

export function readStoreSince(dbPath: string, opts?: StoreReadOptions): StoreReadResult {
  const entries = listTranscriptEntries(dbPath, opts)
  const records = entries.map(entryToRecord)
  const positions = entries.map((e) => e.seq)
  const seqs = positions
  return {
    entries,
    records,
    positions,
    maxSeq: seqs.length ? Math.max(...seqs) : (opts?.afterSeq ?? -1),
    minSeq: seqs.length ? Math.min(...seqs) : (opts?.afterSeq ?? -1),
  }
}

export function entryToRecord(entry: TranscriptEntry): unknown {
  const payload = entry.payload
  if (isOnDiskRecord(payload)) {
    if (entry.created_at && !('created_at' in payload) && !('createdAt' in payload)) {
      return { ...payload, created_at: entry.created_at }
    }
    return payload
  }
  const role =
    entry.role ||
    (isRecord(payload) && typeof payload.role === 'string' ? payload.role : 'assistant')
  return {
    role,
    message: { role, content: [{ type: 'text', text: payloadText(payload) }] },
    created_at: entry.created_at,
    entry_kind: entry.entry_kind,
  }
}

function isOnDiskRecord(payload: unknown): payload is Record<string, unknown> {
  if (!isRecord(payload)) return false
  return (
    Boolean(payload.message) || Array.isArray(payload.content) || typeof payload.role === 'string'
  )
}

function asText(v: unknown): string {
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') return String(v)
  return ''
}

function payloadText(payload: unknown): string {
  if (payload == null) return ''
  if (typeof payload === 'string') return payload
  if (!isRecord(payload)) return asText(payload)
  for (const key of ['text', 'content', 'result', 'output']) {
    const v = payload[key]
    if (typeof v === 'string' && v) return v
  }
  try {
    return JSON.stringify(payload)
  } catch {
    return ''
  }
}

function mapEntryRow(row: EntryRow): TranscriptEntry {
  return {
    entry_id: asText(row.entry_id),
    session_id: row.session_id == null ? null : asText(row.session_id),
    seq: Number(row.seq),
    entry_kind: row.entry_kind == null ? null : asText(row.entry_kind),
    role: row.role == null ? null : asText(row.role),
    payload: parsePayload(row.payload_json),
    created_at: createdAtString(row.created_at),
  }
}

function parsePayload(raw: unknown): unknown {
  if (raw == null) return null
  if (typeof raw !== 'string') return raw
  try {
    return JSON.parse(raw) as unknown
  } catch {
    return raw
  }
}

function createdAtString(raw: unknown): string | null {
  if (raw == null) return null
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    const ms = raw < 1e12 ? raw * 1000 : raw
    const d = new Date(ms)
    return Number.isNaN(d.getTime()) ? null : d.toISOString()
  }
  if (typeof raw === 'string' && raw.trim()) return raw
  return null
}

/** Build a redacted sqlite fixture from the published schema (not a live dump). */
export function writeRedactedStoreFixture(dbPath: string, rows: TranscriptEntry[]): void {
  const db = new DatabaseSync(dbPath)
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS transcript_entries (
        entry_id TEXT PRIMARY KEY,
        session_id TEXT,
        seq INTEGER NOT NULL,
        entry_kind TEXT,
        role TEXT,
        payload_json TEXT,
        created_at TEXT
      );
      CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE IF NOT EXISTS blobs (id TEXT PRIMARY KEY, bytes BLOB);
    `)
    const ins = db.prepare(
      `INSERT INTO transcript_entries (${ENTRY_COLS}) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    for (const row of rows) {
      ins.run(
        row.entry_id,
        row.session_id,
        row.seq,
        row.entry_kind,
        row.role,
        typeof row.payload === 'string' ? row.payload : JSON.stringify(row.payload),
        row.created_at,
      )
    }
  } finally {
    db.close()
  }
}
