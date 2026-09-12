#!/usr/bin/env node
/**
 * OpenCode Memory Capture — ingest OpenCode SQLite sessions into the shared
 * RivetOS memory DB as `rivet-glm` conversations.
 *
 * OpenCode has no Claude/kimi-style lifecycle hooks and no jsonl transcript.
 * Sessions live in `$XDG_DATA_HOME/opencode/opencode.db` (else
 * `~/.local/share/opencode/opencode.db`), WAL mode.
 *
 * A read-only poller + fs.watch on `opencode.db` / `opencode.db-wal` folds
 * with the same rules as den-server `opencodeTurnsFromMessages` (skip system
 * / step-start / step-finish; keep user + assistant + reasoning + tool) and
 * upserts ros_conversations / ros_messages.
 *
 * Identity: agent='rivet-glm' (RIVETOS_CAPTURE_AGENT), channel='opencode',
 * session_key='opencode:<ses_id>'. Dedup: part.id (`prt_…`). Content-hash
 * is not the primary key.
 *
 * Truncation: 16K cap only when the row carries an absolute db path + part
 * id so memory_get_full can re-read from SQLite.
 *
 * Incremental cursor: part.time_updated high-water (30s overlap) plus
 * message.time_updated so skipped in-flight parts re-queue on completion.
 * Persisted in ~/.rivetos/opencode-capture-state.json. On start, the first
 * pass backfills sessions updated in the last N days (`--backfill`, default
 * 14; 0 = no backfill). Later ticks are cursor-only.
 *
 * Best-effort ticks: ingest/connect failures are logged and retried. Uncaught
 * fatals exit 1 so systemd/launchd can restart the watcher. Log:
 * ~/.rivetos/opencode-memory-capture.log.
 */

import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import type { PoolClient } from 'pg'

const { Pool } = pg
const require_ = createRequire(import.meta.url)

export const DEFAULT_CAPTURE_AGENT = 'rivet-glm'
export const CAPTURE_AGENT = DEFAULT_CAPTURE_AGENT
export const CAPTURE_CHANNEL = 'opencode'
export const CAPTURE_SOURCE = 'opencode-sqlite'
export const DEFAULT_BACKFILL_DAYS = 14

const LOG_FILE = path.join(os.homedir(), '.rivetos', 'opencode-memory-capture.log')
export const MAX_CONTENT = 16000
const STATEMENT_TIMEOUT_MS = 15000
const WATCH_POLL_MS = 3000
/** Re-read parts this close to the high-water so a late commit with an
 *  earlier stamp is not skipped. Part-id dedup absorbs the overlap. */
export const CURSOR_OVERLAP_MS = 30_000
export const STATE_VERSION = 1 as const

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PendingMessage {
  role: string
  content: string
  toolName?: string | null
  toolArgs?: unknown
  toolResult?: string | null
  eventId: string
  sessionId?: string
  eventTs?: string | null
  createdAt?: string | null
  extra?: Record<string, unknown>
}

export interface SessionMeta {
  id: string
  title: string
  directory: string | null
}

export interface ParseResult {
  sessions: Map<string, SessionMeta>
  messages: PendingMessage[]
  skipped: Record<string, number>
}

export interface CaptureState {
  version: typeof STATE_VERSION
  /** High-water of `part.time_updated` (legacy files used `partTimeCreated`). */
  partTimeUpdated: number
  messageTimeUpdated: number
}

export interface Queryable {
  query: (
    sql: string,
    params?: unknown[],
  ) => Promise<{ rows: Array<Record<string, unknown>>; rowCount: number | null }>
}

export interface SqliteRow {
  [k: string]: unknown
}
export interface SqliteStmt {
  all(...params: unknown[]): SqliteRow[]
  get(...params: unknown[]): SqliteRow | undefined
}
export interface SqliteDb {
  prepare(sql: string): SqliteStmt
  close(): void
}

export interface PartRow {
  id: string
  message_id: string
  session_id: string
  time_created: number
  time_updated: number
  data: Record<string, unknown>
  message_data: Record<string, unknown>
  message_time_updated: number
  session_title: string
  session_directory: string | null
}

// ---------------------------------------------------------------------------
// Logging (never throws)
// ---------------------------------------------------------------------------

export function log(msg: string): void {
  const line = `${new Date().toISOString()} ${msg}\n`
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true })
    fs.appendFileSync(LOG_FILE, line)
  } catch {
    // ignore
  }
}

// ---------------------------------------------------------------------------
// Paths / identity
// ---------------------------------------------------------------------------

export function captureAgent(): string {
  const env = process.env.RIVETOS_CAPTURE_AGENT?.trim()
  return env && env.length > 0 ? env : DEFAULT_CAPTURE_AGENT
}

export function opencodeDataDir(): string {
  const xdg = process.env.XDG_DATA_HOME?.trim()
  return path.join(xdg || path.join(os.homedir(), '.local', 'share'), 'opencode')
}

export function opencodeDbPath(): string {
  const env = process.env.OPENCODE_DB?.trim()
  if (env) return env
  return path.join(opencodeDataDir(), 'opencode.db')
}

export function captureStatePath(): string {
  const env = process.env.RIVETOS_OPENCODE_STATE?.trim()
  if (env) return env
  return path.join(os.homedir(), '.rivetos', 'opencode-capture-state.json')
}

export function deriveSessionKey(sessionId: string): string {
  return `opencode:${sessionId}`
}

export function dbWatchPaths(dbPath: string): string[] {
  return [dbPath, `${dbPath}-wal`]
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function asString(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null
}

function asNumber(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v)
  } catch {
    return String(v)
  }
}

function parseJson(value: unknown): Record<string, unknown> {
  if (isRecord(value)) return value
  if (typeof value !== 'string' || value.trim() === '') return {}
  try {
    const parsed: unknown = JSON.parse(value)
    return isRecord(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function isoFromMs(ms: number): string | null {
  if (!Number.isFinite(ms) || ms <= 0) return null
  return new Date(ms).toISOString()
}

function partText(part: Record<string, unknown>): string {
  if (typeof part.text === 'string') return part.text
  if (isRecord(part.text) && typeof part.text.value === 'string') return part.text.value
  if (typeof part.content === 'string') return part.content
  return ''
}

/** OpenCode writes streaming deltas until `data.time.end` is set. */
export function partHasTimeEnd(data: Record<string, unknown>): boolean {
  const time = isRecord(data.time) ? data.time : null
  if (!time) return false
  const end = time.end
  if (typeof end === 'number') return Number.isFinite(end) && end > 0
  if (typeof end === 'string') return end.length > 0
  return false
}

/**
 * Cap stored text only when a disk pointer exists so memory_get_full can
 * recover the tail. Without a pointer, keep the full string.
 */
export function capForStorage(
  full: string,
  pointer: { dbPath?: string | null; partId?: string | null },
): { stored: string; truncated: boolean; uncapped?: boolean } {
  if (full.length <= MAX_CONTENT) return { stored: full, truncated: false }
  const hasPointer = Boolean(pointer.dbPath) && Boolean(pointer.partId)
  if (!hasPointer) {
    return { stored: full, truncated: false, uncapped: true }
  }
  return { stored: full.slice(0, MAX_CONTENT) + '\n…[truncated]', truncated: true }
}

function bump(skipped: Record<string, number>, reason: string): void {
  skipped[reason] = (skipped[reason] ?? 0) + 1
}

// ---------------------------------------------------------------------------
// SQLite (read-only, same module + flags as den-server opencode-db.ts)
// ---------------------------------------------------------------------------

export function openOpencodeDb(dbPath = opencodeDbPath()): SqliteDb | null {
  if (!fs.existsSync(dbPath)) return null
  try {
    const { DatabaseSync } = require_('node:sqlite') as {
      DatabaseSync: new (p: string, o?: { readOnly?: boolean }) => SqliteDb
    }
    return new DatabaseSync(dbPath, { readOnly: true })
  } catch (err) {
    log(`open sqlite failed: ${err instanceof Error ? err.message : String(err)}`)
    return null
  }
}

export function emptyState(): CaptureState {
  return { version: STATE_VERSION, partTimeUpdated: 0, messageTimeUpdated: 0 }
}

export function loadState(file = captureStatePath()): CaptureState {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<CaptureState> & {
      partTimeCreated?: unknown
    }
    if (raw.version !== STATE_VERSION) return emptyState()
    return {
      version: STATE_VERSION,
      partTimeUpdated: asNumber(raw.partTimeUpdated) || asNumber(raw.partTimeCreated),
      messageTimeUpdated: asNumber(raw.messageTimeUpdated),
    }
  } catch {
    return emptyState()
  }
}

export function saveState(state: CaptureState, file = captureStatePath()): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`)
}

export function backfillCutoffMs(days = DEFAULT_BACKFILL_DAYS, now = Date.now()): number {
  if (days === 0) return now
  const n = Number.isFinite(days) && days > 0 ? days : DEFAULT_BACKFILL_DAYS
  return now - n * 24 * 60 * 60 * 1000
}

function partCursorFloor(state: CaptureState): number {
  const hw = Math.max(state.partTimeUpdated, 0)
  if (hw <= 0) return 0
  return Math.max(hw - CURSOR_OVERLAP_MS, 0)
}

/**
 * Parts newer than the high-water mark (with overlap), or whose parent
 * message was updated after it (in-flight text/tool parts complete in place).
 * `cutoffMs === 0` drops the session-age filter (incremental ticks).
 */
export function loadNewParts(
  db: SqliteDb,
  state: CaptureState,
  cutoffMs: number,
): PartRow[] {
  const partFloor = partCursorFloor(state)
  const msgHw = Math.max(state.messageTimeUpdated, 0)
  const rows = db
    .prepare(
      `SELECT p.id AS id, p.message_id AS message_id, p.session_id AS session_id,
              p.time_created AS time_created, p.time_updated AS time_updated,
              p.data AS data,
              m.data AS message_data, m.time_updated AS message_time_updated,
              s.title AS session_title, s.directory AS session_directory,
              s.time_updated AS session_time_updated
         FROM part p
         JOIN message m ON m.id = p.message_id
         JOIN session s ON s.id = p.session_id
        WHERE (? = 0 OR s.time_updated >= ?)
          AND (p.time_updated > ? OR m.time_updated > ?)
        ORDER BY p.time_updated ASC, p.id ASC`,
    )
    .all(cutoffMs, cutoffMs, partFloor, msgHw)

  const out: PartRow[] = []
  for (const r of rows) {
    const id = asString(r.id)
    const messageId = asString(r.message_id)
    const sessionId = asString(r.session_id)
    if (!id || !messageId || !sessionId) continue
    out.push({
      id,
      message_id: messageId,
      session_id: sessionId,
      time_created: asNumber(r.time_created),
      time_updated: asNumber(r.time_updated) || asNumber(r.time_created),
      data: parseJson(r.data),
      message_data: parseJson(r.message_data),
      message_time_updated: asNumber(r.message_time_updated),
      session_title: asString(r.session_title) || 'OpenCode session',
      session_directory: asString(r.session_directory),
    })
  }
  return out
}

/**
 * Fold one OpenCode part into a pending ros_messages row. Rules match
 * den-server `opencodeTurnsFromMessages` (skip system / step-start /
 * step-finish; keep user text, assistant text, reasoning, tools) but stay
 * per-part so dedup is `prt_…` and memory_get_full can re-read one row.
 *
 * Running/pending tool parts and assistant text/reasoning that still lack
 * `data.time.end` are skipped — the parent message.time_updated bump
 * re-queues them when they complete.
 */
export function foldPart(
  part: PartRow,
  dbPath: string,
  skipped: Record<string, number>,
): PendingMessage | null {
  const msg = part.message_data
  const roleRaw = typeof msg.role === 'string' ? msg.role : ''
  if (roleRaw === 'system') {
    bump(skipped, 'system')
    return null
  }
  const type = typeof part.data.type === 'string' ? part.data.type : ''
  if (
    type === 'step-start' ||
    type === 'step_start' ||
    type === 'step-finish' ||
    type === 'step_finish'
  ) {
    bump(skipped, 'step-marker')
    return null
  }

  const eventTs = isoFromMs(part.time_created)
  const createdAt = eventTs
  const extraBase: Record<string, unknown> = {
    source: CAPTURE_SOURCE,
    sourceEvent: `part:${type || 'unknown'}`,
    session_sqlite_path: dbPath,
    sessionSqlitePath: dbPath,
    session_sqlite_part_id: part.id,
    sessionSqlitePartId: part.id,
  }

  const modelID = asString(msg.modelID) || (isRecord(msg.model) ? asString(msg.model.id) : null)
  const providerID =
    asString(msg.providerID) || (isRecord(msg.model) ? asString(msg.model.providerID) : null)
  if (modelID) extraBase.modelID = modelID
  if (providerID) extraBase.providerID = providerID
  if (isRecord(msg.tokens)) extraBase.tokens = msg.tokens
  if (msg.cost != null) extraBase.cost = msg.cost

  if (type === 'reasoning' || type === 'thinking' || type === 'think') {
    if (!partHasTimeEnd(part.data)) {
      bump(skipped, 'reasoning:streaming')
      return null
    }
    const chunk = partText(part.data).trim()
    if (!chunk) {
      bump(skipped, 'reasoning:empty')
      return null
    }
    return {
      role: 'assistant',
      content: `[thinking] ${chunk}`,
      eventId: part.id,
      sessionId: part.session_id,
      eventTs,
      createdAt,
      extra: { ...extraBase, partType: 'think' },
    }
  }

  if (type === 'tool' || type === 'tool_use' || type === 'tool-call') {
    const name =
      asString(part.data.tool) ||
      asString(part.data.name) ||
      (isRecord(part.data.tool) ? asString(part.data.tool.name) : null) ||
      'tool'
    const state = isRecord(part.data.state) ? part.data.state : undefined
    const statusRaw = state && typeof state.status === 'string' ? state.status : ''
    const isError = part.data.isError === true || statusRaw === 'error'
    const isRunning = statusRaw === 'running' || statusRaw === 'pending'
    const args =
      (state && 'input' in state ? state.input : undefined) ??
      (isRecord(part.data.tool) ? (part.data.tool.input ?? part.data.tool.args) : undefined) ??
      part.data.input ??
      part.data.args
    const out = isError
      ? (state?.error ?? state?.output ?? state?.title ?? part.data.output ?? part.data.result)
      : state && 'output' in state
        ? state.output
        : (part.data.output ?? part.data.result)
    const toolResult =
      typeof out === 'string' ? out : out != null ? safeJson(out) : null
    if (isRunning && !toolResult) {
      bump(skipped, 'tool:running')
      return null
    }
    const content = isError ? `[tool-failure] ${name}` : `[tool-result] ${name}`
    return {
      role: 'tool',
      content,
      toolName: name,
      toolArgs: args,
      toolResult,
      eventId: part.id,
      sessionId: part.session_id,
      eventTs,
      createdAt,
      extra: { ...extraBase, toolStatus: isError ? 'error' : 'done', failure: isError },
    }
  }

  if (type === 'text' || type === '' || type === 'content') {
    const role = roleRaw === 'assistant' ? 'assistant' : 'user'
    if (role === 'assistant' && !partHasTimeEnd(part.data)) {
      bump(skipped, 'text:streaming')
      return null
    }
    const text = partText(part.data).trim()
    if (!text) {
      bump(skipped, 'text:empty')
      return null
    }
    return {
      role,
      content: text,
      eventId: part.id,
      sessionId: part.session_id,
      eventTs,
      createdAt,
      extra: extraBase,
    }
  }

  bump(skipped, `part:${type || 'unknown'}`)
  return null
}

export function foldParts(parts: PartRow[], dbPath: string): ParseResult {
  const skipped: Record<string, number> = {}
  const sessions = new Map<string, SessionMeta>()
  const messages: PendingMessage[] = []
  for (const part of parts) {
    if (!sessions.has(part.session_id)) {
      sessions.set(part.session_id, {
        id: part.session_id,
        title: part.session_title,
        directory: part.session_directory,
      })
    }
    const row = foldPart(part, dbPath, skipped)
    if (row) messages.push(row)
  }
  return { sessions, messages, skipped }
}

export function advanceState(state: CaptureState, parts: PartRow[]): CaptureState {
  let partTimeUpdated = state.partTimeUpdated
  let messageTimeUpdated = state.messageTimeUpdated
  for (const p of parts) {
    const stamp = p.time_updated || p.time_created
    if (stamp > partTimeUpdated) partTimeUpdated = stamp
    if (p.message_time_updated > messageTimeUpdated) messageTimeUpdated = p.message_time_updated
  }
  return { version: STATE_VERSION, partTimeUpdated, messageTimeUpdated }
}

// ---------------------------------------------------------------------------
// Env / DB
// ---------------------------------------------------------------------------

export function resolvePgUrl(explicit?: string): string {
  if (explicit) return explicit
  if (process.env.RIVETOS_PG_URL) return process.env.RIVETOS_PG_URL
  const envFile = process.env.RIVETOS_ENV_FILE ?? path.join(os.homedir(), '.rivetos', '.env')
  try {
    const raw = fs.readFileSync(envFile, 'utf8')
    for (const line of raw.split('\n')) {
      const m = /^\s*RIVETOS_PG_URL\s*=\s*(.+?)\s*$/.exec(line)
      if (m) return m[1].replace(/^["']|["']$/g, '')
    }
  } catch {
    // fall through
  }
  throw new Error('RIVETOS_PG_URL not set and not found in ~/.rivetos/.env')
}

async function findOrCreateConversation(
  client: Queryable,
  sessionKey: string,
  init: { title: string; settings: Record<string, unknown>; active: boolean },
): Promise<{ id: string; created: boolean }> {
  const agent = captureAgent()
  const conv = await client.query(
    `INSERT INTO ros_conversations (session_key, agent, channel, title, settings, active, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, now(), now())
     ON CONFLICT (session_key, agent) DO UPDATE SET updated_at = now()
     RETURNING id, (xmax = 0) AS created`,
    [
      sessionKey,
      agent,
      CAPTURE_CHANNEL,
      init.title.slice(0, 120),
      JSON.stringify(init.settings),
      init.active,
    ],
  )
  return { id: String(conv.rows[0].id), created: conv.rows[0].created === true }
}

async function eventIdExists(
  client: Queryable,
  conversationId: string,
  eventId: string,
): Promise<boolean> {
  const r = await client.query(
    `SELECT 1 FROM ros_messages
      WHERE conversation_id = $1
        AND metadata->>'event_id' = $2
      LIMIT 1`,
    [conversationId, eventId],
  )
  return (r.rowCount ?? 0) > 0
}

export async function insertMessage(
  client: Queryable,
  conversationId: string,
  m: PendingMessage,
  dbPath: string | null,
  seen?: Set<string>,
): Promise<'inserted' | 'skipped'> {
  if (seen) {
    if (seen.has(m.eventId)) return 'skipped'
  } else if (await eventIdExists(client, conversationId, m.eventId)) {
    return 'skipped'
  }

  const pointer = {
    dbPath:
      dbPath ||
      (typeof m.extra?.session_sqlite_path === 'string' ? m.extra.session_sqlite_path : null),
    partId:
      typeof m.extra?.session_sqlite_part_id === 'string' ? m.extra.session_sqlite_part_id : m.eventId,
  }

  const contentCap = capForStorage(m.content ?? '', pointer)
  let toolResultStored: string | null = null
  let toolResultTruncated = false
  if (typeof m.toolResult === 'string') {
    const toolCap = capForStorage(m.toolResult, pointer)
    toolResultStored = toolCap.stored
    toolResultTruncated = toolCap.truncated
  }

  let toolArgsStored: string | null = null
  let toolArgsTruncated = false
  let toolArgsFullLength = 0
  if (m.toolArgs != null) {
    const raw = typeof m.toolArgs === 'string' ? m.toolArgs : JSON.stringify(m.toolArgs)
    const argCap = capForStorage(raw, pointer)
    toolArgsStored =
      typeof m.toolArgs === 'string' || argCap.truncated ? JSON.stringify(argCap.stored) : raw
    toolArgsTruncated = argCap.truncated
    toolArgsFullLength = raw.length
  }

  const agent = captureAgent()
  const meta: Record<string, unknown> = {
    source: CAPTURE_SOURCE,
    event_id: m.eventId,
    ...(m.extra ?? {}),
  }
  if (m.eventTs) meta.event_ts = m.eventTs
  if (pointer.dbPath) {
    meta.session_sqlite_path = pointer.dbPath
    meta.sessionSqlitePath = pointer.dbPath
  }
  if (pointer.partId) {
    meta.session_sqlite_part_id = pointer.partId
    meta.sessionSqlitePartId = pointer.partId
  }
  if (contentCap.truncated) {
    meta.full_content_length = (m.content ?? '').length
    meta.truncated = true
  }
  if (toolResultTruncated && m.toolResult) {
    meta.full_tool_result_length = m.toolResult.length
    meta.truncated = true
  }
  if (toolArgsTruncated) {
    meta.full_tool_args_length = toolArgsFullLength
    meta.truncated = true
  }

  let createdAt: string | null = m.createdAt ?? null
  if (!createdAt && m.eventTs) {
    const parsedMs = Date.parse(m.eventTs)
    if (!Number.isNaN(parsedMs)) createdAt = m.eventTs
  }

  await client.query(
    `INSERT INTO ros_messages
       (conversation_id, agent, channel, role, content, tool_name, tool_args, tool_result, metadata, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, COALESCE($10, now()))`,
    [
      conversationId,
      agent,
      CAPTURE_CHANNEL,
      m.role,
      contentCap.stored,
      m.toolName ?? null,
      toolArgsStored,
      toolResultStored,
      JSON.stringify(meta),
      createdAt,
    ],
  )
  if (seen) seen.add(m.eventId)
  return 'inserted'
}

export async function ingestMessages(
  client: Queryable,
  sessionId: string,
  messages: PendingMessage[],
  opts: {
    title?: string
    cwd?: string | null
    dbPath?: string | null
    finalize?: boolean
    triggerEvent?: string
    lock?: boolean
    seen?: Set<string>
  } = {},
): Promise<{ inserted: number; skipped: number; conversationId: string; sessionKey: string }> {
  const sessionKey = deriveSessionKey(sessionId)
  const seen = opts.seen ? new Set(opts.seen) : undefined
  if (opts.lock !== false) {
    await client.query('BEGIN')
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [sessionKey])
  }
  try {
    const conv = await findOrCreateConversation(client, sessionKey, {
      title: (opts.title || 'OpenCode session').slice(0, 120),
      settings: {
        source: CAPTURE_SOURCE,
        sessionId,
        cwd: opts.cwd ?? null,
        triggerEvent: opts.triggerEvent ?? 'ingest',
        session_sqlite_path: opts.dbPath ?? null,
      },
      active: !opts.finalize,
    })

    if (seen && !conv.created && seen.size === 0) {
      const prior = await client.query(
        `SELECT metadata->>'event_id' AS e FROM ros_messages
          WHERE conversation_id = $1 AND metadata->>'event_id' IS NOT NULL`,
        [conv.id],
      )
      for (const row of prior.rows as Array<{ e?: string | null }>) {
        if (typeof row.e === 'string' && row.e) seen.add(row.e)
      }
    }

    let inserted = 0
    let skipped = 0
    for (const m of messages) {
      const result = await insertMessage(client, conv.id, m, opts.dbPath ?? null, seen)
      if (result === 'inserted') inserted++
      else skipped++
    }

    if (opts.finalize) {
      await client.query(
        `UPDATE ros_conversations
            SET active = false, updated_at = now()
          WHERE id = $1 AND active = true`,
        [conv.id],
      )
    } else if (inserted > 0) {
      await client.query(`UPDATE ros_conversations SET updated_at = now() WHERE id = $1`, [conv.id])
    }

    if (opts.lock !== false) await client.query('COMMIT')
    if (opts.seen && seen) for (const id of seen) opts.seen.add(id)
    return { inserted, skipped, conversationId: conv.id, sessionKey }
  } catch (err) {
    if (opts.lock !== false) await client.query('ROLLBACK').catch(() => undefined)
    throw err
  }
}

// ---------------------------------------------------------------------------
// Watcher
// ---------------------------------------------------------------------------

export interface WatcherState {
  seen: Map<string, Set<string>>
  capture: CaptureState
  /** Session-age cutoff is first pass after process start only. */
  initialPassDone: boolean
}

export function createWatcherState(capture: CaptureState = emptyState()): WatcherState {
  return { seen: new Map(), capture, initialPassDone: false }
}

function seedCursorIfEmpty(state: WatcherState, now = Date.now()): void {
  if (state.capture.partTimeUpdated > 0) return
  state.capture = {
    version: STATE_VERSION,
    partTimeUpdated: now,
    messageTimeUpdated: Math.max(state.capture.messageTimeUpdated, now),
  }
}

export async function scanOnce(
  dbPath: string,
  client: Queryable,
  state: WatcherState,
  opts: { backfillDays?: number; stateFile?: string } = {},
): Promise<{ parts: number; inserted: number; skipped: number }> {
  const db = openOpencodeDb(dbPath)
  if (!db) return { parts: 0, inserted: 0, skipped: 0 }
  try {
    const days = opts.backfillDays ?? DEFAULT_BACKFILL_DAYS
    const applyCutoff = !state.initialPassDone
    const cutoff = applyCutoff ? backfillCutoffMs(days) : 0
    const parts = loadNewParts(db, state.capture, cutoff)
    const stateFile = opts.stateFile ?? captureStatePath()
    if (parts.length === 0) {
      // Empty first pass must still advance the cursor so a later uncut
      // tick cannot dump pre-start history (especially `--backfill 0`).
      state.initialPassDone = true
      if (applyCutoff) {
        seedCursorIfEmpty(state)
        saveState(state.capture, stateFile)
      }
      return { parts: 0, inserted: 0, skipped: 0 }
    }
    const abs = path.resolve(dbPath)
    const parsed = foldParts(parts, abs)
    let inserted = 0
    let skipped = 0
    const bySession = new Map<string, PendingMessage[]>()
    for (const m of parsed.messages) {
      const sid = m.sessionId
      if (!sid) continue
      const arr = bySession.get(sid) ?? []
      arr.push(m)
      bySession.set(sid, arr)
    }
    for (const [sid, msgs] of bySession) {
      const meta = parsed.sessions.get(sid)
      let seen = state.seen.get(deriveSessionKey(sid))
      if (!seen) {
        seen = new Set()
        state.seen.set(deriveSessionKey(sid), seen)
      }
      const result = await ingestMessages(client, sid, msgs, {
        title: meta?.title,
        cwd: meta?.directory ?? null,
        dbPath: abs,
        triggerEvent: 'watch',
        seen,
      })
      inserted += result.inserted
      skipped += result.skipped
      log(
        `watch ${result.sessionKey}: db=${abs} msgs=${msgs.length} inserted=${result.inserted} skipped=${result.skipped}`,
      )
    }
    // Advance the cursor past every loaded part (including skipped running
    // tools / streaming text). Completions re-queue via message.time_updated.
    state.capture = advanceState(state.capture, parts)
    if (applyCutoff && days === 0) seedCursorIfEmpty(state)
    saveState(state.capture, stateFile)
    state.initialPassDone = true
    const foldSkipped = Object.values(parsed.skipped).reduce((a, b) => a + b, 0)
    return { parts: parts.length, inserted, skipped: skipped + foldSkipped }
  } finally {
    try {
      db.close()
    } catch {
      // ignore
    }
  }
}

export type WatchClient = Queryable & { release: () => void }
export type WatchPool = { connect: () => Promise<WatchClient> }

/** One watch poll. Connect failures (PGlite not up yet) are logged, not thrown. */
export async function watchTick(
  pool: WatchPool,
  dbPath: string,
  state: WatcherState,
  opts: { backfillDays?: number; stateFile?: string } = {},
): Promise<void> {
  let client: WatchClient | undefined
  try {
    client = await pool.connect()
    await client.query(`SET statement_timeout = ${STATEMENT_TIMEOUT_MS}`)
    await scanOnce(dbPath, client, state, opts)
  } catch (err) {
    log(`watch tick failed: ${err instanceof Error ? err.message : String(err)}`)
  } finally {
    client?.release()
  }
}

export type WatchFn = (
  filename: fs.PathLike,
  options: fs.WatchOptions,
  listener: (event: string, fname: string | Buffer | null) => void,
) => fs.FSWatcher

/**
 * WAL bursts call onWake many times. One in-flight scan + a dirty bit
 * collapses the rest into a single queued rescan.
 */
export function createCoalescedRunner(run: () => Promise<void>): () => void {
  let inFlight = false
  let dirty = false
  const kick = (): void => {
    if (inFlight) {
      dirty = true
      return
    }
    inFlight = true
    void run()
      .catch(() => undefined)
      .finally(() => {
        inFlight = false
        if (dirty) {
          dirty = false
          kick()
        }
      })
  }
  return kick
}

/**
 * Watch the SQLite file and its WAL sibling. Missing WAL is fine — we also
 * watch the parent directory so a later -wal create still wakes us.
 */
export function attachDbWatchers(
  dbPath: string,
  onWake: () => void,
  watchFn: WatchFn = fs.watch,
): { close: () => void; watching: string[] } {
  const watchers: fs.FSWatcher[] = []
  const watching: string[] = []
  const start = (target: string, recursive = false): void => {
    try {
      const w = watchFn(target, { persistent: true, recursive }, () => {
        onWake()
      })
      w.on('error', (err) => {
        log(`fs.watch error on ${target}: ${err.message}`)
      })
      watchers.push(w)
      watching.push(target)
    } catch (err) {
      log(`fs.watch unavailable for ${target}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  for (const p of dbWatchPaths(dbPath)) {
    if (fs.existsSync(p)) start(p)
  }
  const dir = path.dirname(dbPath)
  if (fs.existsSync(dir)) start(dir)
  return {
    watching,
    close: () => {
      for (const w of watchers) {
        try {
          w.close()
        } catch {
          // ignore
        }
      }
    },
  }
}

async function withPool<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const pool = new Pool({ connectionString: resolvePgUrl(), max: 1 })
  const client = await pool.connect()
  try {
    await client.query(`SET statement_timeout = ${STATEMENT_TIMEOUT_MS}`)
    return await fn(client)
  } finally {
    client.release()
    await pool.end()
  }
}

export async function runOnce(
  opts: { dbPath?: string; backfillDays?: number } = {},
): Promise<void> {
  const dbPath = opts.dbPath ?? opencodeDbPath()
  const stateFile = captureStatePath()
  const state = createWatcherState(loadState(stateFile))
  const summary = await withPool((client) =>
    scanOnce(dbPath, client, state, { backfillDays: opts.backfillDays, stateFile }),
  )
  log(
    `once ${dbPath}: parts=${summary.parts} inserted=${summary.inserted} skipped=${summary.skipped}`,
  )
  console.log(
    `opencode-memory-capture --once: parts=${summary.parts} inserted=${summary.inserted} skipped=${summary.skipped}`,
  )
}

export async function runWatch(
  opts: { dbPath?: string; backfillDays?: number } = {},
): Promise<void> {
  const dbPath = opts.dbPath ?? opencodeDbPath()
  const stateFile = captureStatePath()
  try {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true })
  } catch (err) {
    log(
      `watch: cannot create ${path.dirname(dbPath)}: ${err instanceof Error ? err.message : String(err)}`,
    )
  }

  const pool = new Pool({ connectionString: resolvePgUrl(), max: 1 })
  const state = createWatcherState(loadState(stateFile))
  log(`watch starting on ${dbPath}`)

  const tick = (): Promise<void> =>
    watchTick(pool, dbPath, state, { backfillDays: opts.backfillDays, stateFile })

  await tick()

  const kick = createCoalescedRunner(tick)
  let handle: { close: () => void } | null = null
  const startWatch = (): void => {
    if (handle) return
    handle = attachDbWatchers(dbPath, kick)
    log(`fs.watch attached to ${handle ? dbWatchPaths(dbPath).join(', ') : dbPath}`)
  }
  startWatch()

  setInterval(() => {
    if (!handle) startWatch()
    kick()
  }, WATCH_POLL_MS)
}

function loadEnvFile(): void {
  const envFile = process.env.RIVETOS_ENV_FILE ?? path.join(os.homedir(), '.rivetos', '.env')
  if (!fs.existsSync(envFile)) return
  try {
    const raw = fs.readFileSync(envFile, 'utf8')
    for (const line of raw.split('\n')) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line)
      if (!m || process.env[m[1]]) continue
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
    }
  } catch {
    // ignore
  }
}

export function parseBackfill(args: string[]): number {
  const idx = args.indexOf('--backfill')
  if (idx < 0) return DEFAULT_BACKFILL_DAYS
  const n = Number(args[idx + 1])
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_BACKFILL_DAYS
}

function parseDb(args: string[]): string | undefined {
  const idx = args.indexOf('--db')
  return idx >= 0 ? args[idx + 1] : undefined
}

export const USAGE = `opencode-memory-capture — ingest OpenCode SQLite sessions into RivetOS memory

  opencode-rivet-memory-capture --watch [--db FILE] [--backfill DAYS]
  opencode-rivet-memory-capture --once  [--db FILE] [--backfill DAYS]

  --watch            poll + fs.watch $XDG_DATA_HOME/opencode/opencode.db
  --once             ingest then exit
  --db FILE          override the SQLite path
  --backfill DAYS    first-pass session window (default ${String(DEFAULT_BACKFILL_DAYS)}; 0 = no backfill)
`

async function main(): Promise<void> {
  loadEnvFile()
  const args = process.argv.slice(2)
  if (args.length === 0 || args[0] === '-h' || args[0] === '--help') {
    console.log(USAGE)
    return
  }

  const dbPath = parseDb(args)
  const backfillDays = parseBackfill(args)

  if (args[0] === '--watch') {
    await runWatch({ dbPath, backfillDays })
    return
  }
  if (args[0] === '--once') {
    await runOnce({ dbPath, backfillDays })
    return
  }

  console.log(USAGE)
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  (path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) ||
    /opencode-memory-capture\.(ts|js)$/.test(process.argv[1]))

if (invokedDirectly) {
  main().catch((err: unknown) => {
    log(`fatal: ${err instanceof Error ? err.stack : String(err)}`)
    process.exitCode = 1
  })
}
