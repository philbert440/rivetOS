#!/usr/bin/env node
/**
 * T3 Code Memory Capture — poll ~/.t3/userdata/state.sqlite (read-only,
 * WAL-aware) and upsert completed turns into RivetOS memory as rivet-t3
 * conversations. Same PG path as the OpenCode capture kit
 * (ros_conversations / ros_messages, dedup on metadata.event_id).
 *
 * T3 has no capture hook. This process runs beside `t3 service`.
 */

import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { PoolClient } from 'pg'

const require_ = createRequire(import.meta.url)

export const DEFAULT_CAPTURE_AGENT = 'rivet-t3'
export const CAPTURE_CHANNEL = 't3code'
export const CAPTURE_SOURCE = 't3code-sqlite'
export const DEFAULT_BACKFILL_DAYS = 14
export const DEFAULT_POLL_MS = 2500
export const BUSY_TIMEOUT_MS = 5000
export const MAX_CONTENT = 16000
export const STATE_VERSION = 1 as const
export const STATEMENT_TIMEOUT_MS = 15000
export const STATE_LOCK_WAIT_MS = 120_000
export const CURSOR_OVERLAP_MS = 2000

const REQUIRED_TABLES = ['projection_turns', 'projection_thread_messages', 'projection_threads']

const LOG_FILE = path.join(os.homedir(), '.rivetos', 'logs', 't3code-capture.log')

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

export interface ThreadCursor {
  lastMessageUpdatedAt: string
  lastMessageId: string
  lastActivityCreatedAt: string
  lastActivityId: string
  lastTurnCompletedAt: string
}

export interface CaptureState {
  version: typeof STATE_VERSION
  threads: Record<string, ThreadCursor>
  lastIngestAt?: string | null
  lastIngestSource?: string | null
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
  exec(sql: string): void
  close(): void
}

export interface SchemaProbe {
  ok: boolean
  missing: string[]
  columns: Record<string, string[]>
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function asString(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null
}

function isoOrEmpty(v: unknown): string {
  return typeof v === 'string' && v.length > 0 ? v : ''
}

export function log(msg: string): void {
  const line = `${new Date().toISOString()} ${msg}\n`
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true })
    fs.appendFileSync(LOG_FILE, line)
  } catch {
    // ignore
  }
}

export function captureAgent(): string {
  const env = process.env.RIVETOS_CAPTURE_AGENT?.trim()
  return env && env.length > 0 ? env : DEFAULT_CAPTURE_AGENT
}

export function t3UserdataDir(): string {
  const env = process.env.T3_USERDATA?.trim()
  if (env) return env
  return path.join(os.homedir(), '.t3', 'userdata')
}

export function t3StateSqlitePath(): string {
  const env = process.env.T3_STATE_SQLITE?.trim()
  if (env) return env
  return path.join(t3UserdataDir(), 'state.sqlite')
}

export function captureStatePath(): string {
  const env = process.env.RIVETOS_T3CODE_STATE?.trim()
  if (env) return env
  return path.join(os.homedir(), '.rivetos', 't3code-capture-state.json')
}

export function deriveSessionKey(threadId: string): string {
  return `t3code:${threadId}`
}

export function capForStorage(
  full: string,
  pointer: { dbPath?: string | null; rowId?: string | null },
): { stored: string; truncated: boolean; uncapped?: boolean } {
  if (full.length <= MAX_CONTENT) return { stored: full, truncated: false }
  const hasPointer = Boolean(pointer.dbPath) && Boolean(pointer.rowId)
  if (!hasPointer) return { stored: full, truncated: false, uncapped: true }
  return { stored: `${full.slice(0, MAX_CONTENT)}\n…[truncated]`, truncated: true }
}

export function emptyCursor(): ThreadCursor {
  return {
    lastMessageUpdatedAt: '',
    lastMessageId: '',
    lastActivityCreatedAt: '',
    lastActivityId: '',
    lastTurnCompletedAt: '',
  }
}

export function emptyState(): CaptureState {
  return { version: STATE_VERSION, threads: {}, lastIngestAt: null, lastIngestSource: null }
}

export function loadState(file = captureStatePath()): CaptureState {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<CaptureState>
    if (raw.version !== STATE_VERSION) return emptyState()
    const threads: Record<string, ThreadCursor> = {}
    if (isRecord(raw.threads)) {
      for (const [id, cur] of Object.entries(raw.threads)) {
        if (!id || !isRecord(cur)) continue
        threads[id] = {
          lastMessageUpdatedAt: isoOrEmpty(cur.lastMessageUpdatedAt),
          lastMessageId: isoOrEmpty(cur.lastMessageId),
          lastActivityCreatedAt: isoOrEmpty(cur.lastActivityCreatedAt),
          lastActivityId: isoOrEmpty(cur.lastActivityId),
          lastTurnCompletedAt: isoOrEmpty(cur.lastTurnCompletedAt),
        }
      }
    }
    return {
      version: STATE_VERSION,
      threads,
      lastIngestAt: asString(raw.lastIngestAt),
      lastIngestSource: asString(raw.lastIngestSource),
    }
  } catch {
    return emptyState()
  }
}

export function mergeState(onDisk: CaptureState | null, next: CaptureState): CaptureState {
  if (!onDisk) return next
  const threads: Record<string, ThreadCursor> = { ...onDisk.threads }
  for (const [id, cur] of Object.entries(next.threads)) {
    const prev = threads[id]
    threads[id] = prev
      ? {
          lastMessageUpdatedAt: maxIso(prev.lastMessageUpdatedAt, cur.lastMessageUpdatedAt),
          lastMessageId:
            maxIso(prev.lastMessageUpdatedAt, cur.lastMessageUpdatedAt) === cur.lastMessageUpdatedAt
              ? cur.lastMessageId || prev.lastMessageId
              : prev.lastMessageId || cur.lastMessageId,
          lastActivityCreatedAt: maxIso(prev.lastActivityCreatedAt, cur.lastActivityCreatedAt),
          lastActivityId:
            maxIso(prev.lastActivityCreatedAt, cur.lastActivityCreatedAt) ===
            cur.lastActivityCreatedAt
              ? cur.lastActivityId || prev.lastActivityId
              : prev.lastActivityId || cur.lastActivityId,
          lastTurnCompletedAt: maxIso(prev.lastTurnCompletedAt, cur.lastTurnCompletedAt),
        }
      : cur
  }
  return { ...onDisk, ...next, threads }
}

function maxIso(a: string, b: string): string {
  if (!a) return b
  if (!b) return a
  return a >= b ? a : b
}

export function saveState(state: CaptureState, file = captureStatePath()): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  let onDisk: CaptureState | null = null
  if (fs.existsSync(file)) {
    try {
      onDisk = loadState(file)
    } catch {
      onDisk = null
    }
  }
  const merged = mergeState(onDisk, state)
  const tmp = `${file}.${String(process.pid)}.${String(Date.now())}.tmp`
  fs.writeFileSync(tmp, `${JSON.stringify(merged, null, 2)}\n`)
  try {
    fs.renameSync(tmp, file)
  } catch (err) {
    try {
      fs.unlinkSync(tmp)
    } catch {
      // ignore
    }
    throw err
  }
  state.threads = merged.threads
}

export function openT3Db(dbPath = t3StateSqlitePath()): SqliteDb | null {
  if (!fs.existsSync(dbPath)) return null
  try {
    const { DatabaseSync } = require_('node:sqlite') as {
      DatabaseSync: new (p: string, o?: { readOnly?: boolean }) => SqliteDb
    }
    const db = new DatabaseSync(dbPath, { readOnly: true })
    db.exec(`PRAGMA busy_timeout = ${String(BUSY_TIMEOUT_MS)}`)
    return db
  } catch (err) {
    log(`open sqlite failed: ${err instanceof Error ? err.message : String(err)}`)
    return null
  }
}

export function tableColumns(db: SqliteDb, table: string): string[] {
  try {
    const rows = db.prepare(`PRAGMA table_info(${table})`).all()
    return rows
      .map((r) => asString(r.name))
      .filter((n): n is string => Boolean(n))
  } catch {
    return []
  }
}

export function probeSchema(db: SqliteDb): SchemaProbe {
  const columns: Record<string, string[]> = {}
  const missing: string[] = []
  for (const table of [
    ...REQUIRED_TABLES,
    'projection_thread_activities',
    'projection_thread_sessions',
    'projection_projects',
  ]) {
    const cols = tableColumns(db, table)
    columns[table] = cols
    if (REQUIRED_TABLES.includes(table) && cols.length === 0) missing.push(table)
  }
  return { ok: missing.length === 0, missing, columns }
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

function afterCursor(updatedAt: string, id: string, lastUpdatedAt: string, lastId: string): boolean {
  if (!lastUpdatedAt) return true
  if (updatedAt > lastUpdatedAt) return true
  if (updatedAt === lastUpdatedAt && id > lastId) return true
  return false
}

function overlapFloor(iso: string): string {
  if (!iso) return ''
  const ms = Date.parse(iso)
  if (!Number.isFinite(ms)) return iso
  return new Date(Math.max(0, ms - CURSOR_OVERLAP_MS)).toISOString()
}

export function isIdleSessionStatus(status: string | null): boolean {
  if (!status) return false
  return !['running', 'starting'].includes(status)
}

export function isToolActivity(tone: string, kind: string): boolean {
  if (tone === 'tool') return true
  return kind.startsWith('tool') || kind.includes('.tool')
}

export function extractToolFromActivity(payload: Record<string, unknown>, kind: string, summary: string): {
  toolName: string
  toolArgs: unknown
  toolResult: string | null
} {
  const data = isRecord(payload.data) ? payload.data : {}
  const item = isRecord(data.item) ? data.item : {}
  const toolName =
    asString(item.tool) ||
    asString(data.toolName) ||
    asString(payload.itemType) ||
    asString(payload.title) ||
    kind ||
    'tool'
  const toolArgs = item.arguments ?? data.input ?? item.command ?? data.command ?? item
  const result = item.result ?? data.result ?? item.rawOutput ?? payload.detail ?? summary
  const toolResult =
    typeof result === 'string'
      ? result
      : result == null
        ? summary || null
        : JSON.stringify(result)
  return { toolName, toolArgs, toolResult }
}

export interface FoldedTurn {
  threadId: string
  title: string
  cwd: string | null
  provider: string | null
  messages: PendingMessage[]
}

export function foldCompletedThread(
  db: SqliteDb,
  schema: SchemaProbe,
  threadId: string,
  cursor: ThreadCursor,
  dbPath: string,
  opts: { ignoreCursor?: boolean } = {},
): FoldedTurn {
  const skip: Record<string, number> = {}
  const messages: PendingMessage[] = []
  const msgCols = new Set(schema.columns.projection_thread_messages ?? [])
  const actCols = new Set(schema.columns.projection_thread_activities ?? [])
  const threadCols = new Set(schema.columns.projection_threads ?? [])
  const sessionCols = new Set(schema.columns.projection_thread_sessions ?? [])
  const projectCols = new Set(schema.columns.projection_projects ?? [])

  const titleSel = threadCols.has('title') ? 'th.title' : `''`
  const cwdSel = threadCols.has('worktree_path') ? 'th.worktree_path' : `''`
  const projectJoin =
    projectCols.has('project_id') && threadCols.has('project_id')
      ? 'LEFT JOIN projection_projects p ON p.project_id = th.project_id'
      : ''
  const rootSel = projectCols.has('workspace_root') ? 'p.workspace_root' : `''`
  const providerSel = sessionCols.has('provider_name') ? 's.provider_name' : `''`
  const sessionJoin = sessionCols.size
    ? 'LEFT JOIN projection_thread_sessions s ON s.thread_id = th.thread_id'
    : ''

  const meta = db
    .prepare(
      `SELECT ${titleSel} AS title, ${cwdSel} AS cwd, ${rootSel} AS workspace_root,
              ${providerSel} AS provider_name
         FROM projection_threads th
         ${projectJoin}
         ${sessionJoin}
        WHERE th.thread_id = ?`,
    )
    .get(threadId)

  const title = asString(meta?.title) || `T3 thread ${threadId.slice(0, 8)}`
  const cwd = asString(meta?.cwd) || asString(meta?.workspace_root)
  const provider = asString(meta?.provider_name)

  const msgUpdated = msgCols.has('updated_at') ? 'm.updated_at' : 'm.created_at'
  const msgFloor = opts.ignoreCursor ? '' : overlapFloor(cursor.lastMessageUpdatedAt)
  const streamingPred = msgCols.has('is_streaming') ? 'AND COALESCE(m.is_streaming, 0) = 0' : ''

  const msgRows = db
    .prepare(
      `SELECT m.message_id, m.thread_id, m.turn_id, m.role, m.text,
              ${msgUpdated} AS updated_at, m.created_at
         FROM projection_thread_messages m
         JOIN projection_turns t
           ON t.thread_id = m.thread_id
          AND (t.turn_id = m.turn_id OR (m.turn_id IS NULL AND t.completed_at IS NOT NULL))
        WHERE m.thread_id = ?
          AND t.completed_at IS NOT NULL
          ${streamingPred}
        ORDER BY ${msgUpdated} ASC, m.message_id ASC`,
    )
    .all(threadId)

  const seenMsg = new Set<string>()
  for (const r of msgRows) {
    const id = asString(r.message_id)
    const role = asString(r.role) || 'assistant'
    if (!id || seenMsg.has(id)) continue
    seenMsg.add(id)
    const updatedAt = isoOrEmpty(r.updated_at) || isoOrEmpty(r.created_at)
    if (!opts.ignoreCursor && !afterCursor(updatedAt, id, msgFloor, cursor.lastMessageId)) {
      skip.cursor = (skip.cursor ?? 0) + 1
      continue
    }
    const text = typeof r.text === 'string' ? r.text : ''
    if (!text.trim()) {
      skip.empty = (skip.empty ?? 0) + 1
      continue
    }
    messages.push({
      role,
      content: text,
      eventId: id,
      sessionId: threadId,
      eventTs: updatedAt || null,
      createdAt: isoOrEmpty(r.created_at) || updatedAt || null,
      extra: {
        session_sqlite_path: dbPath,
        session_sqlite_message_id: id,
        turn_id: asString(r.turn_id),
        provider_name: provider,
      },
    })
  }

  if (actCols.size > 0) {
    const actFloor = opts.ignoreCursor ? '' : overlapFloor(cursor.lastActivityCreatedAt)
    const payloadSel = actCols.has('payload_json') ? 'a.payload_json' : `'{}'`
    const actRows = db
      .prepare(
        `SELECT a.activity_id, a.thread_id, a.turn_id, a.tone, a.kind, a.summary,
                ${payloadSel} AS payload_json, a.created_at
           FROM projection_thread_activities a
           JOIN projection_turns t
             ON t.thread_id = a.thread_id AND t.turn_id = a.turn_id
          WHERE a.thread_id = ?
            AND t.completed_at IS NOT NULL
          ORDER BY a.created_at ASC, a.activity_id ASC`,
      )
      .all(threadId)
    for (const r of actRows) {
      const id = asString(r.activity_id)
      const tone = asString(r.tone) || ''
      const kind = asString(r.kind) || ''
      if (!id || !isToolActivity(tone, kind)) continue
      const createdAt = isoOrEmpty(r.created_at)
      if (!opts.ignoreCursor && !afterCursor(createdAt, id, actFloor, cursor.lastActivityId)) continue
      const payload = parseJson(r.payload_json)
      const tool = extractToolFromActivity(payload, kind, asString(r.summary) || '')
      messages.push({
        role: 'tool',
        content: asString(r.summary) || `[tool] ${tool.toolName}`,
        toolName: tool.toolName,
        toolArgs: tool.toolArgs,
        toolResult: tool.toolResult,
        eventId: id,
        sessionId: threadId,
        eventTs: createdAt || null,
        createdAt: createdAt || null,
        extra: {
          session_sqlite_path: dbPath,
          session_sqlite_activity_id: id,
          turn_id: asString(r.turn_id),
          provider_name: provider,
          activity_kind: kind,
        },
      })
    }
  }

  void skip
  return { threadId, title, cwd, provider, messages }
}

export function listEligibleThreadIds(
  db: SqliteDb,
  schema: SchemaProbe,
  state: CaptureState,
  opts: { ignoreCursor?: boolean; sinceIso?: string } = {},
): string[] {
  const turnCols = new Set(schema.columns.projection_turns ?? [])
  if (!turnCols.has('completed_at')) return []
  const sessionCols = new Set(schema.columns.projection_thread_sessions ?? [])
  const threadCols = new Set(schema.columns.projection_threads ?? [])
  const deletedPred = threadCols.has('deleted_at') ? 'AND th.deleted_at IS NULL' : ''

  const since = opts.sinceIso ?? ''
  const ids = new Set<string>()

  const turnRows = db
    .prepare(
      `SELECT t.thread_id, t.completed_at
         FROM projection_turns t
         JOIN projection_threads th ON th.thread_id = t.thread_id
        WHERE t.completed_at IS NOT NULL
          ${deletedPred}
        ORDER BY t.completed_at ASC`,
    )
    .all()
  for (const r of turnRows) {
    const id = asString(r.thread_id)
    const completed = isoOrEmpty(r.completed_at)
    if (!id || !completed) continue
    if (since && completed < since) continue
    const cur = state.threads[id]
    if (!opts.ignoreCursor && cur?.lastTurnCompletedAt && completed <= cur.lastTurnCompletedAt) {
      // already ingested this completed_at; idle-session path below
      // re-lists the thread if the session moved after the turn stamp
      continue
    }
    ids.add(id)
  }

  if (sessionCols.has('status')) {
    const sess = db
      .prepare(
        `SELECT s.thread_id, s.status, s.updated_at
           FROM projection_thread_sessions s
           JOIN projection_threads th ON th.thread_id = s.thread_id
          WHERE s.status IS NOT NULL
            ${deletedPred}`,
      )
      .all()
    for (const r of sess) {
      const id = asString(r.thread_id)
      if (!id || !isIdleSessionStatus(asString(r.status))) continue
      const updated = isoOrEmpty(r.updated_at)
      const cur = state.threads[id]
      if (!opts.ignoreCursor && cur && updated && updated <= cur.lastTurnCompletedAt) continue
      ids.add(id)
    }
  }

  return [...ids]
}

export function advanceThreadCursor(
  cursor: ThreadCursor,
  folded: FoldedTurn,
  completedAt?: string | null,
): ThreadCursor {
  let next = { ...cursor }
  for (const m of folded.messages) {
    const ts = m.eventTs || m.createdAt || ''
    if (m.extra?.session_sqlite_activity_id) {
      if (ts > next.lastActivityCreatedAt || (ts === next.lastActivityCreatedAt && m.eventId > next.lastActivityId)) {
        next.lastActivityCreatedAt = ts
        next.lastActivityId = m.eventId
      }
    } else if (ts > next.lastMessageUpdatedAt || (ts === next.lastMessageUpdatedAt && m.eventId > next.lastMessageId)) {
      next.lastMessageUpdatedAt = ts
      next.lastMessageId = m.eventId
    }
  }
  if (completedAt && completedAt > next.lastTurnCompletedAt) next.lastTurnCompletedAt = completedAt
  return next
}

export function latestCompletedAt(db: SqliteDb, threadId: string): string {
  const row = db
    .prepare(
      `SELECT MAX(completed_at) AS completed_at FROM projection_turns
        WHERE thread_id = ? AND completed_at IS NOT NULL`,
    )
    .get(threadId)
  return isoOrEmpty(row?.completed_at)
}

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

export function stateLockKey(stateFile = captureStatePath()): string {
  return `rivetos-capture-state:${os.hostname()}:${path.resolve(stateFile)}`
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
    [sessionKey, agent, CAPTURE_CHANNEL, init.title.slice(0, 120), JSON.stringify(init.settings), init.active],
  )
  return { id: String(conv.rows[0].id), created: conv.rows[0].created === true }
}

async function eventIdExists(client: Queryable, conversationId: string, eventId: string): Promise<boolean> {
  const r = await client.query(
    `SELECT 1 FROM ros_messages
      WHERE conversation_id = $1 AND metadata->>'event_id' = $2 LIMIT 1`,
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
  if (seen?.has(m.eventId)) return 'skipped'
  if (await eventIdExists(client, conversationId, m.eventId)) {
    seen?.add(m.eventId)
    return 'skipped'
  }

  const rowId =
    (typeof m.extra?.session_sqlite_message_id === 'string' && m.extra.session_sqlite_message_id) ||
    (typeof m.extra?.session_sqlite_activity_id === 'string' && m.extra.session_sqlite_activity_id) ||
    m.eventId
  const pointer = { dbPath, rowId }
  const contentCap = capForStorage(m.content ?? '', pointer)
  let toolResultStored: string | null = null
  if (typeof m.toolResult === 'string') toolResultStored = capForStorage(m.toolResult, pointer).stored
  let toolArgsStored: string | null = null
  if (m.toolArgs != null) {
    const raw = typeof m.toolArgs === 'string' ? m.toolArgs : JSON.stringify(m.toolArgs)
    toolArgsStored = capForStorage(raw, pointer).stored
  }

  const meta: Record<string, unknown> = {
    source: CAPTURE_SOURCE,
    event_id: m.eventId,
    ...(m.extra ?? {}),
  }
  if (m.eventTs) meta.event_ts = m.eventTs
  if (dbPath) {
    meta.session_sqlite_path = dbPath
    meta.sessionSqlitePath = dbPath
  }
  if (contentCap.truncated) {
    meta.full_content_length = (m.content ?? '').length
    meta.truncated = true
  }

  await client.query(
    `INSERT INTO ros_messages
       (conversation_id, agent, channel, role, content, tool_name, tool_args, tool_result, metadata, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, COALESCE($10, now()))`,
    [
      conversationId,
      captureAgent(),
      CAPTURE_CHANNEL,
      m.role,
      contentCap.stored,
      m.toolName ?? null,
      toolArgsStored,
      toolResultStored,
      JSON.stringify(meta),
      m.createdAt ?? null,
    ],
  )
  seen?.add(m.eventId)
  return 'inserted'
}

export async function ingestMessages(
  client: Queryable,
  threadId: string,
  messages: PendingMessage[],
  opts: {
    title?: string
    cwd?: string | null
    dbPath?: string | null
    provider?: string | null
    triggerEvent?: string
    lock?: boolean
    seen?: Set<string>
  } = {},
): Promise<{ inserted: number; skipped: number; conversationId: string; sessionKey: string }> {
  const sessionKey = deriveSessionKey(threadId)
  const seen = opts.seen ? new Set(opts.seen) : undefined
  if (opts.lock !== false) {
    await client.query('BEGIN')
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [sessionKey])
  }
  try {
    const conv = await findOrCreateConversation(client, sessionKey, {
      title: (opts.title || 'T3 thread').slice(0, 120),
      settings: {
        source: CAPTURE_SOURCE,
        threadId,
        cwd: opts.cwd ?? null,
        provider: opts.provider ?? null,
        triggerEvent: opts.triggerEvent ?? 'ingest',
        session_sqlite_path: opts.dbPath ?? null,
      },
      active: true,
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
    if (inserted > 0) {
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

export interface WatcherState {
  seen: Map<string, Set<string>>
  capture: CaptureState
}

export function createWatcherState(capture: CaptureState = emptyState()): WatcherState {
  return { seen: new Map(), capture }
}

export async function scanOnce(
  dbPath: string,
  client: Queryable,
  state: WatcherState,
  opts: { backfillDays?: number; stateFile?: string; source?: string; ignoreCursor?: boolean } = {},
): Promise<{ threads: number; inserted: number; skipped: number; schemaChurn?: string[] }> {
  const db = openT3Db(dbPath)
  if (!db) return { threads: 0, inserted: 0, skipped: 0 }
  const source = opts.source ?? 'poll'
  const stateFile = opts.stateFile ?? captureStatePath()
  try {
    const schema = probeSchema(db)
    if (!schema.ok) {
      log(`schema-churn missing tables: ${schema.missing.join(',')}`)
      return { threads: 0, inserted: 0, skipped: 0, schemaChurn: schema.missing }
    }
    const days = opts.backfillDays
    const sinceIso =
      days === undefined || days <= 0
        ? ''
        : new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()
    const ignoreCursor = opts.ignoreCursor === true || (days !== undefined && days > 0)
    const threadIds = listEligibleThreadIds(db, schema, state.capture, { ignoreCursor, sinceIso })
    const abs = path.resolve(dbPath)
    let inserted = 0
    let skipped = 0
    for (const threadId of threadIds) {
      const cursor = state.capture.threads[threadId] ?? emptyCursor()
      const folded = foldCompletedThread(db, schema, threadId, cursor, abs, { ignoreCursor })
      if (folded.messages.length === 0) {
        state.capture.threads[threadId] = advanceThreadCursor(
          cursor,
          folded,
          latestCompletedAt(db, threadId),
        )
        continue
      }
      let seen = state.seen.get(deriveSessionKey(threadId))
      if (!seen) {
        seen = new Set()
        state.seen.set(deriveSessionKey(threadId), seen)
      }
      const result = await ingestMessages(client, threadId, folded.messages, {
        title: folded.title,
        cwd: folded.cwd,
        dbPath: abs,
        provider: folded.provider,
        triggerEvent: source,
        seen,
      })
      inserted += result.inserted
      skipped += result.skipped
      state.capture.threads[threadId] = advanceThreadCursor(
        cursor,
        folded,
        latestCompletedAt(db, threadId),
      )
      log(
        `ingest ${result.sessionKey}: msgs=${String(folded.messages.length)} inserted=${String(result.inserted)} skipped=${String(result.skipped)}`,
      )
    }
    state.capture.lastIngestAt = new Date().toISOString()
    state.capture.lastIngestSource = source
    saveState(state.capture, stateFile)
    return { threads: threadIds.length, inserted, skipped }
  } finally {
    try {
      db.close()
    } catch {
      // ignore
    }
  }
}

async function withPool<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const pg = (await import('pg')).default
  const pool = new pg.Pool({ connectionString: resolvePgUrl(), max: 1 })
  const client = await pool.connect()
  try {
    await client.query(`SET statement_timeout = ${String(STATEMENT_TIMEOUT_MS)}`)
    return await fn(client)
  } finally {
    client.release()
    await pool.end()
  }
}

export async function withStateLock<T>(
  client: Queryable,
  fn: () => Promise<T>,
  stateFile = captureStatePath(),
  waitMs = STATE_LOCK_WAIT_MS,
): Promise<T | null> {
  const key = stateLockKey(stateFile)
  try {
    await client.query('SET statement_timeout = 0')
    await client.query(`SET lock_timeout = ${String(Math.max(1, Math.floor(waitMs)))}`)
    await client.query('SELECT pg_advisory_lock(hashtext($1))', [key])
    await client.query(`SET statement_timeout = ${String(STATEMENT_TIMEOUT_MS)}`)
  } catch (err) {
    log(`state lock unavailable (${err instanceof Error ? err.message : String(err)}); skipping`)
    return null
  }
  try {
    return await fn()
  } finally {
    try {
      await client.query('SELECT pg_advisory_unlock(hashtext($1))', [key])
    } catch {
      // ignore
    }
  }
}

export async function runOnce(opts: { dbPath?: string; backfillDays?: number; source?: string } = {}): Promise<void> {
  const dbPath = opts.dbPath ?? t3StateSqlitePath()
  const stateFile = captureStatePath()
  try {
    const summary = await withPool((client) =>
      withStateLock(
        client,
        async () => {
          const state = createWatcherState(loadState(stateFile))
          return scanOnce(dbPath, client, state, {
            backfillDays: opts.backfillDays,
            stateFile,
            source: opts.source ?? 'backfill',
            ignoreCursor: (opts.backfillDays ?? 0) > 0,
          })
        },
        stateFile,
      ),
    )
    if (!summary) return
    const line = `t3code-memory-capture: threads=${String(summary.threads)} inserted=${String(summary.inserted)} skipped=${String(summary.skipped)}`
    log(line)
    console.log(line)
  } catch (err) {
    log(`run failed: ${err instanceof Error ? err.message : String(err)}`)
  }
}

export async function runWatch(opts: { dbPath?: string; pollMs?: number } = {}): Promise<void> {
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS
  log(`watch start poll=${String(pollMs)} db=${opts.dbPath ?? t3StateSqlitePath()}`)
  let stopping = false
  const stop = () => {
    stopping = true
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
  while (!stopping) {
    await runOnce({ dbPath: opts.dbPath, source: 'watch' })
    await new Promise((r) => setTimeout(r, pollMs))
  }
  log('watch stop')
}

export function formatStatus(state: CaptureState, file = captureStatePath()): string {
  return [
    't3code-memory-capture --status',
    `  stateFile: ${file}`,
    `  lastIngestAt: ${state.lastIngestAt ?? 'never'}`,
    `  lastIngestSource: ${state.lastIngestSource ?? 'none'}`,
    `  threads: ${String(Object.keys(state.threads).length)}`,
  ].join('\n')
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
  const daysIdx = args.indexOf('--days')
  if (daysIdx >= 0) {
    const n = Number(args[daysIdx + 1])
    return Number.isFinite(n) && n >= 0 ? n : DEFAULT_BACKFILL_DAYS
  }
  return DEFAULT_BACKFILL_DAYS
}

export function parsePollMs(args: string[]): number {
  const idx = args.indexOf('--poll-ms')
  if (idx < 0) return DEFAULT_POLL_MS
  const n = Number(args[idx + 1])
  return Number.isFinite(n) && n >= 250 ? Math.min(n, 60_000) : DEFAULT_POLL_MS
}

function parseDb(args: string[]): string | undefined {
  const idx = args.indexOf('--db')
  return idx >= 0 ? args[idx + 1] : undefined
}

export const USAGE = `t3code-memory-capture — ingest T3 state.sqlite projections into RivetOS memory

  t3code-memory-capture --watch [--poll-ms N] [--db FILE]
  t3code-memory-capture --backfill [--days N] [--db FILE]
  t3code-memory-capture --once [--db FILE]
  t3code-memory-capture --status

  --watch          poll completed turns / idle sessions (run beside t3 service)
  --poll-ms N      watch interval (default ${String(DEFAULT_POLL_MS)})
  --backfill       one-shot catch-up (default ${String(DEFAULT_BACKFILL_DAYS)} days)
  --once           one poll using the saved cursor
  --status         print last ingest time + thread cursor count
  --db FILE        override ~/.t3/userdata/state.sqlite
`

export async function main(argv = process.argv.slice(2)): Promise<void> {
  loadEnvFile()
  if (argv.length === 0 || argv[0] === '-h' || argv[0] === '--help') {
    console.log(USAGE)
    return
  }
  const dbPath = parseDb(argv)
  if (argv[0] === '--status') {
    const file = captureStatePath()
    console.log(formatStatus(loadState(file), file))
    return
  }
  if (argv[0] === '--watch') {
    await runWatch({ dbPath, pollMs: parsePollMs(argv) })
    return
  }
  if (argv[0] === '--backfill') {
    await runOnce({ dbPath, backfillDays: parseBackfill(argv), source: 'backfill' })
    return
  }
  if (argv[0] === '--once') {
    await runOnce({ dbPath, source: 'once' })
    return
  }
  console.log(USAGE)
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  (path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) ||
    /t3code-memory-capture\.(ts|js)$/.test(process.argv[1]))

if (invokedDirectly) {
  main().catch((err: unknown) => {
    log(`fatal: ${err instanceof Error ? err.stack : String(err)}`)
  })
}
