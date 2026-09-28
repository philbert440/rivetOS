/**
 * Read-only reader over a Grok Bot per-agent `agents/<id>/store.db`.
 *
 * Real schema (13 live stores, verified read-only):
 *   transcript_entries(seq INTEGER PRIMARY KEY, id TEXT, entry TEXT)
 * plus unused sibling tables kv / blobs / automation_completion_inbox.
 * `seq` runs 1..N. `entry` is JSON with a `kind` field. Observed kinds:
 *   send-message, message, spend-initiation, event, user-attachment, feedback.
 * There are no tool-call entries. Timestamps are integer `timestampMs`.
 *
 * Positions are `seq`, which is not the on-disk jsonl line index, so ingest
 * uses SESSION_SUFFIX_V3_STORE.
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
import { systemMarker } from './hidden.js'
import { SESSION_SUFFIX_V3_STORE } from './types.js'

export { SESSION_SUFFIX_V3_STORE }

const AGENT_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface TranscriptEntry {
  seq: number
  id: string
  entry: unknown
  kind: string | null
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
  skipped: number
  unknownKinds: Record<string, number>
}

const ENTRY_COLS = 'seq, id, entry'

interface EntryRow {
  seq: unknown
  id: unknown
  entry: unknown
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

export function v3StoreSession(session: string, suffix = SESSION_SUFFIX_V3_STORE): string {
  return session.endsWith(suffix) ? session : `${session}${suffix}`
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
  const records: unknown[] = []
  const positions: number[] = []
  const unknownKinds: Record<string, number> = {}
  let skipped = 0
  for (const entry of entries) {
    const mapped = entryToRecord(entry)
    if (mapped == null) {
      skipped += 1
      const kind = entry.kind ?? 'unknown'
      unknownKinds[kind] = (unknownKinds[kind] ?? 0) + 1
      console.warn(`store: skip unknown kind ${kind} seq=${String(entry.seq)}`)
      continue
    }
    records.push(mapped)
    positions.push(entry.seq)
  }
  const seqs = entries.map((e) => e.seq)
  return {
    entries,
    records,
    positions,
    maxSeq: seqs.length ? Math.max(...seqs) : (opts?.afterSeq ?? -1),
    minSeq: seqs.length ? Math.min(...seqs) : (opts?.afterSeq ?? -1),
    skipped,
    unknownKinds,
  }
}

/**
 * Map a real store entry onto an on-disk-shaped record for the normalizer.
 * Returns null for unknown kinds (caller skips and warns). Compact markers
 * never include the raw entry JSON.
 */
export function entryToRecord(entry: TranscriptEntry): Record<string, unknown> | null {
  const raw = isRecord(entry.entry) ? entry.entry : {}
  const kind = entry.kind ?? (typeof raw.kind === 'string' ? raw.kind : null)
  const created_at = entry.created_at ?? timestampMsToIso(raw.timestampMs)
  if (kind === 'message') return mapMessageKind(raw, created_at)
  if (kind === 'send-message') return mapSendMessageKind(raw, created_at)
  if (kind === 'event') return mapEventKind(raw, created_at)
  if (kind === 'spend-initiation') return compactSystem('spend-initiation', created_at)
  if (kind === 'feedback') return compactSystem('feedback', created_at)
  if (kind === 'user-attachment') return mapAttachmentKind(raw, created_at)
  return null
}

function mapMessageKind(
  raw: Record<string, unknown>,
  created_at: string | null,
): Record<string, unknown> {
  const text = extractText(raw)
  const from = agentRef(raw.fromAgent ?? raw.from_agent)
  const to = agentRef(raw.toAgent ?? raw.to_agent)
  if (from || to) return mapAgentToAgent(text, from, created_at)
  const role = typeof raw.role === 'string' && raw.role ? raw.role : 'user'
  return onDiskRecord(role, text, created_at)
}

function mapSendMessageKind(
  raw: Record<string, unknown>,
  created_at: string | null,
): Record<string, unknown> {
  const msg = isRecord(raw.message) ? raw.message : raw
  const text = extractText(msg) || extractText(raw)
  return onDiskRecord('assistant', text, created_at)
}

function mapEventKind(
  raw: Record<string, unknown>,
  created_at: string | null,
): Record<string, unknown> {
  const text = extractText(raw)
  const body = text.includes('[SAND_HIDDEN_PROMPT]')
    ? text
    : `[SAND_HIDDEN_PROMPT]\n${/(?:^|\n)\s*\[event\]/.test(text) ? text : `[event]\n${text}`}`
  return onDiskRecord('user', body, created_at)
}

function mapAttachmentKind(
  raw: Record<string, unknown>,
  created_at: string | null,
): Record<string, unknown> {
  const name =
    firstString(raw, ['name', 'filename', 'fileName', 'file_name', 'title']) ||
    (isRecord(raw.file) ? firstString(raw.file, ['name', 'filename', 'fileName']) : undefined)
  const extra = name ? ` ${name}` : ''
  return compactSystem('attachment', created_at, extra.trim())
}

function mapAgentToAgent(
  text: string,
  from: { name?: string; id?: string } | undefined,
  created_at: string | null,
): Record<string, unknown> {
  const name = from?.name
  const id = from?.id
  if (name && id && AGENT_UUID_RE.test(id)) {
    const wrapped = [
      '[SAND_HIDDEN_PROMPT]',
      `A message just arrived from another of your user's agents: ${name} (id: ${id})`,
      'your user can already see it in this chat.',
      `${name}: ${text}`,
    ].join('\n')
    return onDiskRecord('user', wrapped, created_at)
  }
  const tagged = name
    ? `${systemMarker('agent_message')} ${name}: ${text}`
    : `${systemMarker('agent_message')} ${text}`
  return onDiskRecord('system', tagged.trim(), created_at)
}

function compactSystem(
  kind: string,
  created_at: string | null,
  extra?: string,
): Record<string, unknown> {
  const tail = extra ? ` ${extra}` : ''
  return onDiskRecord('system', `[grokbot.${kind}]${tail}`.trim(), created_at)
}

function onDiskRecord(
  role: string,
  text: string,
  created_at: string | null,
): Record<string, unknown> {
  return {
    role,
    message: { role, content: [{ type: 'text', text }] },
    created_at,
  }
}

function extractText(raw: Record<string, unknown>): string {
  if (typeof raw.text === 'string' && raw.text) return raw.text
  if (typeof raw.content === 'string' && raw.content) return raw.content
  if (typeof raw.body === 'string' && raw.body) return raw.body
  if (Array.isArray(raw.content)) return partsToText(raw.content)
  if (isRecord(raw.message)) {
    const msg = raw.message
    if (typeof msg.content === 'string' && msg.content) return msg.content
    if (Array.isArray(msg.content)) return partsToText(msg.content)
    if (typeof msg.text === 'string' && msg.text) return msg.text
  }
  if (isRecord(raw.payload)) return extractText(raw.payload)
  return ''
}

function partsToText(parts: unknown[]): string {
  return parts
    .map((p) => {
      if (typeof p === 'string') return p
      if (isRecord(p) && typeof p.text === 'string') return p.text
      return ''
    })
    .filter(Boolean)
    .join('\n')
}

function agentRef(v: unknown): { name?: string; id?: string } | undefined {
  if (v == null) return undefined
  if (typeof v === 'string' && v.trim()) {
    return AGENT_UUID_RE.test(v) ? { id: v } : { name: v }
  }
  if (!isRecord(v)) return undefined
  const name = firstString(v, ['name', 'agent', 'persona', 'label'])
  const id = firstString(v, ['id', 'agentId', 'agent_id'])
  if (!name && !id) return undefined
  return { name, id }
}

function firstString(obj: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = obj[k]
    if (typeof v === 'string' && v.trim()) return v
  }
  return undefined
}

function mapEntryRow(row: EntryRow): TranscriptEntry {
  const parsed = parseEntry(row.entry)
  const kind = isRecord(parsed) && typeof parsed.kind === 'string' ? parsed.kind : null
  const created_at = isRecord(parsed) ? timestampMsToIso(parsed.timestampMs) : null
  return {
    seq: Number(row.seq),
    id: asText(row.id),
    entry: parsed,
    kind,
    created_at,
  }
}

function parseEntry(raw: unknown): unknown {
  if (raw == null) return null
  if (typeof raw !== 'string') return raw
  try {
    return JSON.parse(raw) as unknown
  } catch {
    return raw
  }
}

export function timestampMsToIso(raw: unknown): string | null {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return null
  const ms = raw < 1e12 ? raw * 1000 : raw
  const d = new Date(ms)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

function asText(v: unknown): string {
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') return String(v)
  return ''
}

/** Build a redacted sqlite fixture from the real schema (synthetic content only). */
export function writeRedactedStoreFixture(
  dbPath: string,
  rows: Array<{ seq: number; id: string; entry: unknown }>,
): void {
  const db = new DatabaseSync(dbPath)
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS transcript_entries (
        seq INTEGER PRIMARY KEY,
        id TEXT,
        entry TEXT
      );
      CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE IF NOT EXISTS blobs (id TEXT PRIMARY KEY, bytes BLOB);
      CREATE TABLE IF NOT EXISTS automation_completion_inbox (
        id TEXT PRIMARY KEY,
        payload TEXT
      );
    `)
    const ins = db.prepare(`INSERT INTO transcript_entries (${ENTRY_COLS}) VALUES (?, ?, ?)`)
    for (const row of rows) {
      ins.run(
        row.seq,
        row.id,
        typeof row.entry === 'string' ? row.entry : JSON.stringify(row.entry),
      )
    }
  } finally {
    db.close()
  }
}
