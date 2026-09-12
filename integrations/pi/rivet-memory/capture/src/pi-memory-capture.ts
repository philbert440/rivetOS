#!/usr/bin/env node
/**
 * Pi Memory Capture — ingest pi CLI v3 session jsonl into the shared
 * RivetOS memory DB as `rivet-deepseek` conversations.
 *
 * Trigger is the pi extension (`~/.pi/agent/extensions/rivet-memory.ts`)
 * which spawns `--ingest-file` on turn_end / agent_end / session_shutdown.
 * `--backfill` walks existing session files once. There is no file watcher.
 *
 * Capture source is the append-only session file the CLI writes:
 *
 *   ~/.pi/agent/sessions/<encoded-cwd>/<ISO-ts>_<id>.jsonl
 *
 * encoded cwd: `/home/rivet` → `--home-rivet--`. A custom `--session-dir` is
 * flat (`<dir>/<ts>_<id>.jsonl`, no cwd bucket). `--session-id` may be any
 * non-empty token, not only a UUID.
 *
 * New lines are tailed from a persisted per-file cursor, folded with the
 * same rules as den-server's `piTurnsFromLines` (copy, not import), and
 * upserted into ros_conversations / ros_messages.
 *
 * Identity: agent='rivet-deepseek' (env `RIVETOS_CAPTURE_AGENT`),
 * channel='pi', session_key='pi:<id>'.
 * Dedup: `pi:<id>:<lineId>` (line `id` is 8-hex); messages without an id
 * use `pi:<id>:line:<index>`. Tool-call items on an assistant line append
 * `:tool:<callId>` so they do not collide with the assistant row.
 * Title: latest `session_info.name` (pi `-n`); else first user text.
 *
 * Truncation: 16K cap only when the row carries an absolute session path +
 * line offset so memory_get_full can re-read from disk.
 *
 * Best-effort: `--ingest-file` always exits 0 so the pi extension never
 * breaks the harness. Log: ~/.rivetos/logs/pi-capture.log. Doctor marker:
 * ~/.rivetos/pi-capture-state.json (cursors + lastIngestAt).
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import type { PoolClient } from 'pg'

const { Pool } = pg

export const CAPTURE_AGENT = 'rivet-deepseek'
export const CAPTURE_CHANNEL = 'pi'
export const CAPTURE_SOURCE = 'pi-session'

const LOG_FILE = path.join(os.homedir(), '.rivetos', 'logs', 'pi-capture.log')
export const STATE_FILE = path.join(os.homedir(), '.rivetos', 'pi-capture-state.json')
export const MAX_CONTENT = 16000
const STATEMENT_TIMEOUT_MS = 15000
const LOCK_TIMEOUT_MS = 5000
const LOCK_RETRY_ATTEMPTS = 8
const LOCK_RETRY_MS = 50
const MS_PER_DAY = 86_400_000
const STATE_LOCK_STALE_MS = 120_000
const STATE_LOCK_WAIT_MS = 30_000
const STATE_LOCK_POLL_MS = 100

/** Override with RIVETOS_PI_CAPTURE_STATE (tests). */
export function captureStatePath(): string {
  const env = process.env.RIVETOS_PI_CAPTURE_STATE?.trim()
  if (env && env.length > 0) return env
  return STATE_FILE
}

/** Native session id — UUID, any version (pi mints v7). `--session-id` may be any token. */
export const PI_NATIVE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** `<timestamp>_<id>.jsonl` inside a cwd bucket or flat dir. Id is any non-empty token. */
export const PI_SESSION_FILE_RE = /^([^_]+)_(.+)\.jsonl$/i

/** Paths already logged as skipped (non-matching *.jsonl). */
const skippedSessionFiles = new Set<string>()

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
  eventTs?: string | null
  createdAt?: string | null
  lineIndex?: number
  reasoning?: string | null
  extra?: Record<string, unknown>
}

export interface ParseResult {
  sessionId: string
  cwd: string | null
  title: string
  name: string | null
  model: string | null
  provider: string | null
  thinkingLevel: string | null
  messages: PendingMessage[]
  malformed: number
  skipped: Record<string, number>
}

export interface FileCursor {
  offset: number
  pending: string
}

export interface PersistedCaptureState {
  version: number
  updatedAt: string
  lastIngestAt?: string | null
  lastIngestSource?: string | null
  hookInstalledAt?: string | null
  sessionsDir?: string | null
  files: number
  lastInserted?: number
  lastSkipped?: number
  cursors: Record<string, FileCursor>
}

export interface Queryable {
  query: (
    sql: string,
    params?: unknown[],
  ) => Promise<{ rows: Array<Record<string, unknown>>; rowCount: number | null }>
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
  return env && env.length > 0 ? env : CAPTURE_AGENT
}

/** `~/.pi/agent` — pi does not document `$PI_HOME`. */
export function piAgentHome(): string {
  return path.join(os.homedir(), '.pi', 'agent')
}

export function piSessionsDir(home = piAgentHome()): string {
  const env = process.env.PI_SESSIONS_DIR?.trim()
  if (env && env.length > 0) return env
  return path.join(home, 'sessions')
}

export function deriveSessionKey(sessionId: string): string {
  return `pi:${sessionId}`
}

export function uuidFromSessionName(name: string): string | undefined {
  const m = name.match(PI_SESSION_FILE_RE)
  return m?.[2]
}

export function isNativeSessionId(id: string): boolean {
  if (PI_NATIVE_RE.test(id)) return true
  return id.length > 0 && !id.includes('/') && !id.includes('\\') && !id.includes('..')
}

/**
 * Cwd bucket name: replace every `/` with `-` and wrap in dashes.
 * `/home/rivet` → `--home-rivet--`. Copied from harness-pi (do not import).
 */
export function encodePiCwd(cwd: string): string {
  const trimmed = cwd.replace(/\/+$/, '') || '/'
  const slashed = trimmed === '/' ? '/' : `${trimmed}/`
  return `-${slashed.replaceAll('/', '-')}-`
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function asString(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null
}

function pickStr(obj: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const v = asString(obj[key])
    if (v) return v
  }
  return null
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v)
  } catch {
    return String(v)
  }
}

function contentItems(message: Record<string, unknown>): Record<string, unknown>[] {
  const content = message.content
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : []
  if (!Array.isArray(content)) return []
  return content.filter(isRecord)
}

/**
 * Cap stored text only when a disk pointer exists so memory_get_full can
 * recover the tail. Without a pointer, keep the full string.
 */
export function capForStorage(
  full: string,
  pointer: { sessionJsonlPath?: string | null; lineIndex?: number | null },
): { stored: string; truncated: boolean; uncapped?: boolean } {
  if (full.length <= MAX_CONTENT) return { stored: full, truncated: false }
  const hasPointer = Boolean(pointer.sessionJsonlPath) && typeof pointer.lineIndex === 'number'
  if (!hasPointer) {
    return { stored: full, truncated: false, uncapped: true }
  }
  return { stored: full.slice(0, MAX_CONTENT) + '\n…[truncated]', truncated: true }
}

function bump(skipped: Record<string, number>, reason: string): void {
  skipped[reason] = (skipped[reason] ?? 0) + 1
}

function isoFromObj(obj: Record<string, unknown>): string | null {
  const t = obj.timestamp ?? obj.time
  if (typeof t === 'string' && t) {
    const ms = Date.parse(t)
    return Number.isNaN(ms) ? t : new Date(ms).toISOString()
  }
  if (typeof t === 'number' && Number.isFinite(t)) {
    const ms = t > 1e12 ? t : t * 1000
    return new Date(ms).toISOString()
  }
  return null
}

/**
 * Dedup key for one jsonl line. Prefer the line's 8-hex `id` scoped by
 * session; fall back to session + 0-based line index.
 */
export function eventIdFromLine(
  sessionId: string,
  lineId: string | null,
  lineIndex: number,
): string {
  if (lineId) return `pi:${sessionId}:${lineId}`
  return `pi:${sessionId}:line:${String(lineIndex)}`
}

function parseToolInput(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw
  try {
    return JSON.parse(raw) as unknown
  } catch {
    return raw
  }
}

function textFromItems(items: Record<string, unknown>[]): string {
  return items
    .map((item) => {
      if (item.type === 'text' && typeof item.text === 'string') return item.text
      if (typeof item.text === 'string' && !item.type) return item.text
      return ''
    })
    .filter((t) => t.trim().length > 0)
    .join('\n')
    .trim()
}

function thinkingFromItems(items: Record<string, unknown>[]): string {
  return items
    .map((item) => {
      if (item.type === 'thinking' && typeof item.thinking === 'string') return item.thinking
      return ''
    })
    .filter(Boolean)
    .join('')
}

function toolCallItems(items: Record<string, unknown>[]): Record<string, unknown>[] {
  return items.filter((item) => {
    const t = item.type
    return t === 'toolCall' || t === 'tool_call' || t === 'toolUse' || t === 'tool_use'
  })
}

function usageFromMessage(message: Record<string, unknown>): Record<string, number> | null {
  const u = message.usage
  if (!isRecord(u)) return null
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
  const input = num(u.input) || num(u.input_tokens) || num(u.inputTokens) || num(u.promptTokens)
  const output =
    num(u.output) || num(u.output_tokens) || num(u.outputTokens) || num(u.completionTokens)
  const cacheRead = num(u.cacheRead) || num(u.cache_read_tokens)
  const cacheWrite = num(u.cacheWrite) || num(u.cache_write_tokens)
  const reasoning = num(u.reasoning) || num(u.reasoning_tokens)
  const totalTokens = num(u.totalTokens) || num(u.total_tokens)
  if (input <= 0 && output <= 0 && cacheRead <= 0 && cacheWrite <= 0 && reasoning <= 0) {
    return null
  }
  return { input, output, cacheRead, cacheWrite, reasoning, totalTokens }
}

/**
 * Line-oriented ingest parser. Folding *rules* match `piTurnsFromLines`
 * (user / assistant text+thinking+toolCall; toolResult is a separate
 * message joined by toolCallId). Rows stay per-line (plus one tool row per
 * toolCall item) so we can dedup on line ids and point memory_get_full at a
 * single jsonl line.
 *
 * Runtime print-mode events (`message_start`, `agent_start`, …) are skipped
 * — they are not the on-disk v3 shape.
 */
export function parseSessionText(
  text: string,
  sessionIdHint: string | null,
  transcriptPath: string | null,
): ParseResult {
  const lines = text.split('\n')
  const skipped: Record<string, number> = {}
  let malformed = 0
  let sessionId = sessionIdHint
  let cwd: string | null = null
  let sessionName: string | null = null
  let firstUser: string | null = null
  let provider: string | null = null
  let model: string | null = null
  let thinkingLevel: string | null = null
  const messages: PendingMessage[] = []
  const toolNameById = new Map<string, string>()

  const push = (m: PendingMessage): void => {
    if (transcriptPath) {
      m.extra = {
        ...(m.extra ?? {}),
        session_jsonl_path: transcriptPath,
        sessionJsonlPath: transcriptPath,
      }
    }
    if (typeof m.lineIndex === 'number') {
      m.extra = {
        ...(m.extra ?? {}),
        session_jsonl_line: m.lineIndex,
        sessionJsonlLine: m.lineIndex,
      }
    }
    if (model) {
      m.extra = { ...(m.extra ?? {}), model, provider }
    }
    messages.push(m)
  }

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? ''
    const line = raw.trim()
    if (!line) continue
    let obj: unknown
    try {
      obj = JSON.parse(line)
    } catch {
      malformed++
      continue
    }
    if (!isRecord(obj)) {
      malformed++
      continue
    }

    const type = obj.type
    const eventTs = isoFromObj(obj)

    if (type === 'session') {
      const id = asString(obj.id)
      if (id && isNativeSessionId(id)) sessionId = id
      const cwdVal = asString(obj.cwd)
      if (cwdVal) cwd = cwdVal
      continue
    }

    if (type === 'session_info') {
      // Real pi 0.85.1 `-n` writes session_info.name (latest wins). The
      // session line has no name; name_change / session_name are not on-disk.
      const named = asString(obj.name)
      if (named) sessionName = named
      continue
    }

    if (type === 'model_change') {
      const p = asString(obj.provider)
      const m = asString(obj.modelId) || asString(obj.model)
      if (p) provider = p
      if (m) model = m
      continue
    }

    if (type === 'thinking_level_change') {
      const level = asString(obj.thinkingLevel) || asString(obj.thinking_level)
      if (level) thinkingLevel = level
      continue
    }

    if (type !== 'message') {
      // Runtime stdout events (agent_start, message_start, …) and other
      // bookkeeping are not on-disk v3 message lines.
      bump(skipped, `type:${String(type)}`)
      continue
    }

    const sid = sessionId ?? sessionIdHint ?? 'unknown'
    const lineId = asString(obj.id)
    const eventId = eventIdFromLine(sid, lineId, i)
    const message = isRecord(obj.message) ? obj.message : obj
    const rawRole = typeof message.role === 'string' ? message.role : ''
    const items = contentItems(message)
    const msgTs = isoFromObj(message) ?? eventTs

    if (rawRole === 'toolResult' || rawRole === 'tool_result') {
      const callId = pickStr(message, 'toolCallId', 'id') || pickStr(obj, 'toolCallId')
      const name =
        pickStr(message, 'toolName', 'name') ||
        (callId ? toolNameById.get(callId) : undefined) ||
        'unknown'
      const nested = items.filter((it) => it.type === 'toolResult' || it.type === 'tool_result')
      const bodyItems = nested.length > 0 ? nested : items
      let toolResult: string | null = textFromItems(bodyItems)
      if (!toolResult) {
        const rawResult = message.result ?? message.content
        if (typeof rawResult === 'string') toolResult = rawResult
        else if (rawResult != null && !Array.isArray(rawResult)) toolResult = safeJson(rawResult)
      }
      push({
        role: 'tool',
        content: `[tool-result] ${name}`,
        toolName: name,
        toolResult,
        eventId,
        eventTs: msgTs,
        lineIndex: i,
        extra: {
          sourceEvent: 'message:toolResult',
          source: CAPTURE_SOURCE,
          callId,
        },
      })
      continue
    }

    if (rawRole === 'user') {
      const textBody = textFromItems(items)
      if (!textBody) {
        bump(skipped, 'user:empty')
        continue
      }
      if (firstUser === null) firstUser = textBody
      push({
        role: 'user',
        content: textBody,
        eventId,
        eventTs: msgTs,
        lineIndex: i,
        extra: { sourceEvent: 'message:user', source: CAPTURE_SOURCE },
      })
      continue
    }

    if (rawRole !== 'assistant') {
      bump(skipped, `message:${rawRole || 'unknown'}`)
      continue
    }

    const textBody = textFromItems(items)
    const thinking = thinkingFromItems(items)
    const calls = toolCallItems(items)
    const usage = usageFromMessage(message)
    const stopReason = asString(message.stopReason)

    if (!textBody && !thinking && calls.length === 0) {
      bump(skipped, 'assistant:empty')
      continue
    }

    if (textBody || thinking) {
      const extra: Record<string, unknown> = {
        sourceEvent: 'message:assistant',
        source: CAPTURE_SOURCE,
      }
      if (usage) extra.usage = usage
      if (stopReason) extra.stopReason = stopReason
      if (thinking) extra.partType = 'think'
      push({
        role: 'assistant',
        content: textBody,
        eventId,
        eventTs: msgTs,
        lineIndex: i,
        reasoning: thinking || null,
        extra,
      })
    }

    // Tool-only assistant turns have no text row; keep one copy of usage
    // on the first tool-call so accounting matches the den adapter.
    let accountingAttached = Boolean(textBody || thinking)
    for (const item of calls) {
      const name = pickStr(item, 'name', 'toolName') || 'unknown'
      const callId = pickStr(item, 'id', 'toolCallId')
      if (callId) toolNameById.set(callId, name)
      const args = parseToolInput(item.arguments ?? item.input)
      const toolEventId = callId ? `${eventId}:tool:${callId}` : `${eventId}:tool`
      const extra: Record<string, unknown> = {
        sourceEvent: 'message:toolCall',
        source: CAPTURE_SOURCE,
        callId,
      }
      if (!accountingAttached) {
        if (usage) extra.usage = usage
        if (stopReason) extra.stopReason = stopReason
        accountingAttached = true
      }
      push({
        role: 'tool',
        content: `[tool] ${name}`,
        toolName: name,
        toolArgs: args,
        eventId: toolEventId,
        eventTs: msgTs,
        lineIndex: i,
        extra,
      })
    }
  }

  if (!sessionId) {
    if (transcriptPath) {
      sessionId = uuidFromSessionName(path.basename(transcriptPath)) ?? 'unknown'
    } else {
      sessionId = 'unknown'
    }
  }

  const titleSource = sessionName || firstUser
  const title = titleSource ? titleSource.replace(/\s+/g, ' ').slice(0, 120) : 'Pi session'

  return {
    sessionId,
    cwd,
    title,
    name: sessionName,
    model,
    provider,
    thinkingLevel,
    messages,
    malformed,
    skipped,
  }
}

export function parseSessionFile(file: string, sessionIdHint?: string | null): ParseResult {
  const text = fs.readFileSync(file, 'utf8')
  const fromName = uuidFromSessionName(path.basename(file)) ?? null
  return parseSessionText(text, sessionIdHint ?? fromName, path.resolve(file))
}

function pushSessionFile(out: string[], full: string, name: string): void {
  if (!PI_SESSION_FILE_RE.test(name)) {
    if (name.endsWith('.jsonl') && !skippedSessionFiles.has(full)) {
      skippedSessionFiles.add(full)
      log(`skip session file (name does not match <ts>_<id>.jsonl): ${full}`)
    }
    return
  }
  try {
    if (fs.statSync(full).isFile()) out.push(full)
  } catch {
    // vanished
  }
}

/**
 * Every `<ts>_<id>.jsonl` under the sessions root. Accepts both the default
 * cwd-bucket layout and a flat `--session-dir`. Id is any non-empty token.
 */
export function discoverSessionFiles(root: string): string[] {
  const out: string[] = []
  let entries: string[]
  try {
    entries = fs.readdirSync(root)
  } catch {
    return out
  }
  for (const entry of entries) {
    if (entry.startsWith('.')) continue
    const full = path.join(root, entry)
    let st
    try {
      st = fs.statSync(full)
    } catch {
      continue
    }
    if (st.isFile()) {
      pushSessionFile(out, full, entry)
      continue
    }
    if (!st.isDirectory()) continue
    let names: string[]
    try {
      names = fs.readdirSync(full)
    } catch {
      continue
    }
    for (const name of names) {
      pushSessionFile(out, path.join(full, name), name)
    }
  }
  return out
}

/**
 * Read newly-appended complete jsonl lines from `cursor.offset`. Incomplete
 * trailing lines stay in `cursor.pending` until a newline arrives. A shrink
 * (rewrite) resets the cursor.
 */
export function consumeNewLines(file: string, cursor: FileCursor): string[] {
  let fd: number
  try {
    fd = fs.openSync(file, 'r')
  } catch {
    return []
  }
  try {
    const st = fs.fstatSync(fd)
    if (st.size < cursor.offset) {
      cursor.offset = 0
      cursor.pending = ''
    }
    if (st.size === cursor.offset) return []
    const buf = Buffer.alloc(st.size - cursor.offset)
    fs.readSync(fd, buf, 0, buf.length, cursor.offset)
    cursor.offset = st.size
    const text = cursor.pending + buf.toString('utf8')
    const parts = text.split('\n')
    cursor.pending = parts.pop() ?? ''
    return parts.filter((l) => l.trim().length > 0)
  } finally {
    fs.closeSync(fd)
  }
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

function isPgTrue(v: unknown): boolean {
  return v === true || v === 't' || v === 'true'
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

/**
 * Take the per-session xact lock without a blocking wait that can hit
 * statement_timeout and abort the transaction. BEGIN must already be open.
 */
async function acquireSessionLock(client: Queryable, sessionKey: string): Promise<void> {
  await client.query(`SET LOCAL lock_timeout = ${LOCK_TIMEOUT_MS}`)
  for (let attempt = 1; attempt <= LOCK_RETRY_ATTEMPTS; attempt++) {
    const r = await client.query('SELECT pg_try_advisory_xact_lock(hashtext($1)) AS locked', [
      sessionKey,
    ])
    if (isPgTrue(r.rows[0]?.locked)) return
    if (attempt === LOCK_RETRY_ATTEMPTS) {
      throw new Error(`session lock not acquired for ${sessionKey}`)
    }
    await delay(LOCK_RETRY_MS)
  }
}

async function findOrCreateConversation(
  client: Queryable,
  sessionKey: string,
  init: { title: string; settings: Record<string, unknown>; active: boolean },
): Promise<{ id: string; created: boolean }> {
  // Upsert on the (session_key, agent) unique index (migration 0009): concurrency-safe,
  // no SELECT-then-INSERT race. xmax = 0 on the returned row means this INSERT created it.
  // Codex only bumps updated_at; pi refreshes title + settings so a later
  // session_info rename or model_change is not stuck on the first scan.
  const conv = await client.query(
    `INSERT INTO ros_conversations (session_key, agent, channel, title, settings, active, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, now(), now())
     ON CONFLICT (session_key, agent) DO UPDATE SET
       title = EXCLUDED.title,
       settings = EXCLUDED.settings,
       updated_at = now()
     RETURNING id, (xmax = 0) AS created`,
    [
      sessionKey,
      captureAgent(),
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
  transcriptPath: string | null,
  /** In-memory dedup set (primed once per conversation). When present it is the
   *  authority and the per-message existence SELECT is skipped — steady-state
   *  ticks touch the DB only for genuinely new items (fleet slice-by-count parity). */
  seen?: Set<string>,
): Promise<'inserted' | 'skipped'> {
  if (seen) {
    if (seen.has(m.eventId)) return 'skipped'
  } else if (await eventIdExists(client, conversationId, m.eventId)) {
    return 'skipped'
  }

  const pointer = {
    sessionJsonlPath:
      transcriptPath ||
      (typeof m.extra?.session_jsonl_path === 'string' ? m.extra.session_jsonl_path : null),
    lineIndex:
      typeof m.lineIndex === 'number'
        ? m.lineIndex
        : typeof m.extra?.session_jsonl_line === 'number'
          ? m.extra.session_jsonl_line
          : null,
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
    // tool_args is jsonb. Free-form code and truncated object previews must
    // be encoded as JSON strings instead of sent as invalid JSON.
    toolArgsStored =
      typeof m.toolArgs === 'string' || argCap.truncated ? JSON.stringify(argCap.stored) : raw
    toolArgsTruncated = argCap.truncated
    toolArgsFullLength = raw.length
  }

  let reasoningStored: string | null = null
  let reasoningTruncated = false
  if (typeof m.reasoning === 'string' && m.reasoning) {
    const rCap = capForStorage(m.reasoning, pointer)
    reasoningStored = rCap.stored
    reasoningTruncated = rCap.truncated
  }

  const meta: Record<string, unknown> = {
    source: CAPTURE_SOURCE,
    event_id: m.eventId,
    ...(m.extra ?? {}),
  }
  if (m.eventTs) meta.event_ts = m.eventTs
  if (pointer.sessionJsonlPath) {
    meta.session_jsonl_path = pointer.sessionJsonlPath
    meta.sessionJsonlPath = pointer.sessionJsonlPath
  }
  if (typeof pointer.lineIndex === 'number') {
    meta.session_jsonl_line = pointer.lineIndex
    meta.sessionJsonlLine = pointer.lineIndex
  }
  if (reasoningStored) meta.reasoning = reasoningStored
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
  if (reasoningTruncated && m.reasoning) {
    meta.full_reasoning_length = m.reasoning.length
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
      captureAgent(),
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
    transcriptPath?: string | null
    finalize?: boolean
    triggerEvent?: string
    lock?: boolean
    model?: string | null
    provider?: string | null
    thinkingLevel?: string | null
    /** Per-conversation in-memory dedup set. Primed from the DB once. */
    seen?: Set<string>
  } = {},
): Promise<{ inserted: number; skipped: number; conversationId: string; sessionKey: string }> {
  const sessionKey = deriveSessionKey(sessionId)
  // Publish dedup progress only after commit so rolled-back INSERTs replay.
  const seen = opts.seen ? new Set(opts.seen) : undefined
  // BEGIN/lock live inside try so a lock timeout ROLLBACKs before the
  // pooled client is reused. `began` avoids ROLLBACK when BEGIN itself fails.
  let began = false
  try {
    if (opts.lock !== false) {
      await client.query('BEGIN')
      began = true
      await acquireSessionLock(client, sessionKey)
    }
    const conv = await findOrCreateConversation(client, sessionKey, {
      title: (opts.title || 'Pi session').slice(0, 120),
      settings: {
        source: CAPTURE_SOURCE,
        sessionId,
        cwd: opts.cwd ?? null,
        model: opts.model ?? null,
        provider: opts.provider ?? null,
        thinkingLevel: opts.thinkingLevel ?? null,
        triggerEvent: opts.triggerEvent ?? 'ingest',
        session_jsonl_path: opts.transcriptPath ?? null,
      },
      active: !opts.finalize,
    })

    // Prime the in-memory dedup set once for an existing conversation, then let it
    // be the authority — no per-message SELECT on subsequent ticks.
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
      const result = await insertMessage(client, conv.id, m, opts.transcriptPath ?? null, seen)
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

    if (opts.lock !== false) {
      await client.query('COMMIT')
      began = false
    }
    if (opts.seen && seen) for (const id of seen) opts.seen.add(id)
    return { inserted, skipped, conversationId: conv.id, sessionKey }
  } catch (err) {
    if (began) await client.query('ROLLBACK').catch(() => undefined)
    throw err
  }
}

export async function ingestSessionFile(
  file: string,
  client: Queryable,
  opts: { finalize?: boolean; triggerEvent?: string } = {},
): Promise<{ parsed: ParseResult; result: Awaited<ReturnType<typeof ingestMessages>> }> {
  const parsed = parseSessionFile(file)
  const result = await ingestMessages(client, parsed.sessionId, parsed.messages, {
    title: parsed.title,
    cwd: parsed.cwd,
    transcriptPath: path.resolve(file),
    finalize: opts.finalize,
    triggerEvent: opts.triggerEvent ?? 'ingest',
    model: parsed.model,
    provider: parsed.provider,
    thinkingLevel: parsed.thinkingLevel,
  })
  return { parsed, result }
}

// ---------------------------------------------------------------------------
// Cursors / backfill scan
// ---------------------------------------------------------------------------

export interface WatcherState {
  cursors: Map<string, FileCursor>
  known: Set<string>
  /** sessionKey → primed in-memory event-id dedup set. */
  seen: Map<string, Set<string>>
}

export function createWatcherState(): WatcherState {
  return { cursors: new Map(), known: new Set(), seen: new Map() }
}

export function primeCursor(file: string, fromStart: boolean): FileCursor {
  if (fromStart) return { offset: 0, pending: '' }
  try {
    const st = fs.statSync(file)
    return { offset: st.size, pending: '' }
  } catch {
    return { offset: 0, pending: '' }
  }
}

function emptyCaptureState(): PersistedCaptureState {
  return {
    version: 2,
    updatedAt: new Date().toISOString(),
    files: 0,
    cursors: {},
  }
}

export function loadCaptureState(): PersistedCaptureState {
  try {
    const raw = fs.readFileSync(captureStatePath(), 'utf8')
    const parsed = JSON.parse(raw) as unknown
    if (!isRecord(parsed)) return emptyCaptureState()
    const cursors: Record<string, FileCursor> = {}
    if (isRecord(parsed.cursors)) {
      for (const [key, value] of Object.entries(parsed.cursors)) {
        if (isRecord(value) && typeof value.offset === 'number') {
          cursors[key] = {
            offset: value.offset,
            pending: typeof value.pending === 'string' ? value.pending : '',
          }
        }
      }
    }
    return {
      version: typeof parsed.version === 'number' ? parsed.version : 2,
      updatedAt: asString(parsed.updatedAt) ?? new Date().toISOString(),
      lastIngestAt: asString(parsed.lastIngestAt),
      lastIngestSource: asString(parsed.lastIngestSource),
      hookInstalledAt: asString(parsed.hookInstalledAt),
      sessionsDir: asString(parsed.sessionsDir),
      files: typeof parsed.files === 'number' ? parsed.files : Object.keys(cursors).length,
      lastInserted: typeof parsed.lastInserted === 'number' ? parsed.lastInserted : undefined,
      lastSkipped: typeof parsed.lastSkipped === 'number' ? parsed.lastSkipped : undefined,
      cursors,
    }
  } catch {
    return emptyCaptureState()
  }
}

function sleepSync(ms: number): void {
  const buf = new Int32Array(new SharedArrayBuffer(4))
  Atomics.wait(buf, 0, 0, ms)
}

function errCode(err: unknown): string | undefined {
  if (isRecord(err) && typeof err.code === 'string') return err.code
  return undefined
}

function stateLockDir(stateFile = captureStatePath()): string {
  return `${stateFile}.lock`
}

/** Lock age source: the owner stamp when present, else the lock dir's mtime
 *  (a fresh mkdir whose owner has not written its stamp yet must NOT look stale). */
function readLockStamp(lockDir: string): number | null {
  try {
    const raw = fs.readFileSync(path.join(lockDir, 'owner'), 'utf8')
    const ts = Number(raw.split('\n')[1])
    if (Number.isFinite(ts)) return ts
  } catch {
    // fall through to the directory mtime
  }
  try {
    return fs.statSync(lockDir).mtimeMs
  } catch {
    return null
  }
}

function removeLockDir(lockDir: string): void {
  try {
    fs.unlinkSync(path.join(lockDir, 'owner'))
  } catch {
    // ignore
  }
  try {
    fs.rmdirSync(lockDir)
  } catch {
    // ignore
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return errCode(err) === 'EPERM'
  }
}

/** Stale = older than the threshold AND the recorded owner is not a live
 *  process (a slow live backfill keeps its lock however long it runs). */
function lockIsStale(lockDir: string): boolean {
  const at = readLockStamp(lockDir)
  if (at !== null && Date.now() - at <= STATE_LOCK_STALE_MS) return false
  const owner = lockOwnerPid(lockDir)
  if (owner !== null && pidAlive(owner)) return false
  return true
}

function tryAcquireStateLock(lockDir: string): boolean {
  try {
    fs.mkdirSync(lockDir)
    fs.writeFileSync(path.join(lockDir, 'owner'), `${process.pid}\n${Date.now()}\n`)
    return true
  } catch (err) {
    if (errCode(err) !== 'EEXIST') return false
    if (lockIsStale(lockDir)) {
      removeLockDir(lockDir)
      try {
        fs.mkdirSync(lockDir)
        fs.writeFileSync(path.join(lockDir, 'owner'), `${process.pid}\n${Date.now()}\n`)
        return true
      } catch {
        return false
      }
    }
    return false
  }
}

type StateLockHold = { dir: string; owned: boolean }

function acquireStateLock(): StateLockHold {
  const dest = captureStatePath()
  try {
    fs.mkdirSync(path.dirname(dest), { recursive: true })
  } catch {
    // ignore
  }
  const dir = stateLockDir(dest)
  const start = Date.now()
  while (Date.now() - start < STATE_LOCK_WAIT_MS) {
    if (tryAcquireStateLock(dir)) return { dir, owned: true }
    sleepSync(STATE_LOCK_POLL_MS)
  }
  log(`state lock timeout after ${STATE_LOCK_WAIT_MS}ms (${dir})`)
  return { dir, owned: false }
}

function lockOwnerPid(lockDir: string): number | null {
  try {
    const raw = fs.readFileSync(path.join(lockDir, 'owner'), 'utf8')
    const pid = Number(raw.split('\n')[0])
    return Number.isFinite(pid) ? pid : null
  } catch {
    return null
  }
}

/** Release only a lock we own (never remove another process's reclaimed lock). */
/** Release only when the recorded owner is us; a missing stamp is NOT permission. */
function releaseStateLock(hold: StateLockHold): void {
  if (!hold.owned) return
  if (lockOwnerPid(hold.dir) === process.pid) removeLockDir(hold.dir)
}

/** Run `fn` under the state lock; when the bounded wait expires the work is
 *  SKIPPED (null) — the persistence critical section never runs unowned; the
 *  next native event retries. */
function withStateLock<T>(fn: () => T): T | null {
  const hold = acquireStateLock()
  if (!hold.owned) {
    log(`state lock busy (${hold.dir}); skipping — the next event retries`)
    return null
  }
  try {
    return fn()
  } finally {
    releaseStateLock(hold)
  }
}

async function withStateLockAsync<T>(fn: () => Promise<T>): Promise<T | null> {
  const hold = acquireStateLock()
  if (!hold.owned) {
    log(`state lock busy (${hold.dir}); skipping — the next event retries`)
    return null
  }
  try {
    return await fn()
  } finally {
    releaseStateLock(hold)
  }
}

/** Never let a persisted cursor offset move backwards. */
export function mergeCursor(prev: FileCursor | undefined, next: FileCursor): FileCursor {
  if (!prev) return { offset: next.offset, pending: next.pending }
  if (next.offset < prev.offset) return prev
  if (next.offset > prev.offset) return { offset: next.offset, pending: next.pending }
  return { offset: prev.offset, pending: next.pending }
}

function writeStateAtomic(dest: string, next: PersistedCaptureState): void {
  const tmp = `${dest}.${process.pid}.${Date.now()}.${process.hrtime.bigint()}.tmp`
  fs.writeFileSync(tmp, `${JSON.stringify(next)}\n`)
  try {
    fs.renameSync(tmp, dest)
  } catch (err) {
    try {
      fs.unlinkSync(tmp)
    } catch {
      // ignore
    }
    throw err
  }
}

export function saveCaptureState(
  patch: Partial<PersistedCaptureState>,
  opts: { alreadyLocked?: boolean } = {},
): PersistedCaptureState {
  const run = (): PersistedCaptureState => {
    const prev = loadCaptureState()
    const cursors: Record<string, FileCursor> = { ...prev.cursors }
    if (patch.cursors) {
      for (const [key, cursor] of Object.entries(patch.cursors)) {
        cursors[key] = mergeCursor(cursors[key], cursor)
      }
    }
    const next: PersistedCaptureState = {
      ...prev,
      ...patch,
      cursors,
      version: 2,
      updatedAt: new Date().toISOString(),
      files: Object.keys(cursors).length,
      hookInstalledAt:
        patch.hookInstalledAt !== undefined ? patch.hookInstalledAt : prev.hookInstalledAt,
    }
    try {
      const dest = captureStatePath()
      fs.mkdirSync(path.dirname(dest), { recursive: true })
      writeStateAtomic(dest, next)
    } catch {
      // ignore
    }
    return next
  }
  if (opts.alreadyLocked) return run()
  return withStateLock(run) ?? loadCaptureState()
}

export function persistWatcherCursors(
  root: string,
  state: WatcherState,
  summary: { inserted: number; skipped: number },
  source: string,
): void {
  const cursors: Record<string, FileCursor> = {}
  for (const [file, cursor] of state.cursors) {
    cursors[file] = { offset: cursor.offset, pending: cursor.pending }
  }
  saveCaptureState({
    sessionsDir: root,
    cursors,
    files: state.known.size,
    lastIngestAt: new Date().toISOString(),
    lastIngestSource: source,
    lastInserted: summary.inserted,
    lastSkipped: summary.skipped,
  })
}

export function formatStatus(state: PersistedCaptureState = loadCaptureState()): string {
  return [
    `lastIngestAt: ${state.lastIngestAt ?? 'never'}`,
    `lastIngestSource: ${state.lastIngestSource ?? 'unknown'}`,
    `files: ${String(state.files)}`,
    `lastInserted: ${String(state.lastInserted ?? 0)}`,
    `lastSkipped: ${String(state.lastSkipped ?? 0)}`,
    `hookInstalledAt: ${state.hookInstalledAt ?? 'unknown'}`,
  ].join('\n')
}

export function isNewerThanDays(file: string, days: number): boolean {
  try {
    const st = fs.statSync(file)
    return st.mtimeMs >= Date.now() - days * MS_PER_DAY
  } catch {
    return false
  }
}

async function ingestNewLines(
  file: string,
  cursor: FileCursor,
  client: Queryable,
  seenByKey?: Map<string, Set<string>>,
  triggerEvent = 'ingest',
): Promise<{ inserted: number; skipped: number } | null> {
  const newLines = consumeNewLines(file, cursor)
  if (newLines.length === 0) return null
  // Re-parse the whole file so tool call/result pairing still works when the
  // pair straddles two ingest ticks. The in-memory seen-set keeps re-ticks O(new).
  const parsed = parseSessionFile(file)
  if (parsed.messages.length === 0) return { inserted: 0, skipped: 0 }
  const abs = path.resolve(file)
  let seen: Set<string> | undefined
  if (seenByKey) {
    const key = deriveSessionKey(parsed.sessionId)
    seen = seenByKey.get(key)
    if (!seen) {
      seen = new Set()
      seenByKey.set(key, seen)
    }
  }
  const result = await ingestMessages(client, parsed.sessionId, parsed.messages, {
    title: parsed.title,
    cwd: parsed.cwd,
    transcriptPath: abs,
    triggerEvent,
    model: parsed.model,
    provider: parsed.provider,
    thinkingLevel: parsed.thinkingLevel,
    seen,
  })
  log(
    `ingest ${result.sessionKey}: file=${abs} newLines=${newLines.length} msgs=${parsed.messages.length} inserted=${result.inserted} skipped=${result.skipped}`,
  )
  return { inserted: result.inserted, skipped: result.skipped }
}

export async function scanOnce(
  root: string,
  client: Queryable,
  state: WatcherState,
  fromStart: boolean,
  opts: { days?: number; triggerEvent?: string } = {},
): Promise<{ files: number; inserted: number; skipped: number }> {
  let files = discoverSessionFiles(root)
  if (typeof opts.days === 'number') {
    files = files.filter((file) => isNewerThanDays(file, opts.days as number))
  }
  let inserted = 0
  let skipped = 0
  const triggerEvent = opts.triggerEvent ?? 'backfill'
  for (const file of files) {
    if (!state.cursors.has(file)) {
      state.cursors.set(file, primeCursor(file, fromStart || !state.known.has(file)))
    }
    state.known.add(file)
    const cursor = state.cursors.get(file)!
    const before = { ...cursor }
    try {
      const r = await ingestNewLines(file, cursor, client, state.seen, triggerEvent)
      if (r) {
        inserted += r.inserted
        skipped += r.skipped
      }
    } catch (err) {
      // Retry even if the file stops growing after a database failure.
      Object.assign(cursor, before)
      log(`scan ${file} failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  return { files: files.length, inserted, skipped }
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

export async function runOnce(sessionsDir?: string, days?: number): Promise<void> {
  const root = sessionsDir ?? piSessionsDir()
  const state = createWatcherState()
  const summary = await withPool((client) =>
    scanOnce(root, client, state, true, { days, triggerEvent: 'backfill' }),
  )
  persistWatcherCursors(root, state, summary, 'backfill')
  log(
    `once ${root}: files=${summary.files} inserted=${summary.inserted} skipped=${summary.skipped}`,
  )
  console.log(
    `pi-memory-capture --backfill: files=${summary.files} inserted=${summary.inserted} skipped=${summary.skipped}`,
  )
}

/**
 * Tail one session file from the persisted per-file cursor, then upsert.
 * Dedup keys are unchanged (line id). Always updates lastIngestAt / source.
 */
export async function ingestFileFromCursor(
  file: string,
  client: Queryable,
): Promise<{ inserted: number; skipped: number }> {
  const abs = path.resolve(file)
  const locked = await withStateLockAsync(async () => {
    const persisted = loadCaptureState()
    const stored = persisted.cursors[abs]
    const cursor: FileCursor = stored
      ? { offset: stored.offset, pending: stored.pending }
      : { offset: 0, pending: '' }
    const before = { offset: cursor.offset, pending: cursor.pending }
    try {
      const r = await ingestNewLines(file, cursor, client, new Map(), 'extension')
      saveCaptureState(
        {
          lastIngestAt: new Date().toISOString(),
          lastIngestSource: 'extension',
          cursors: { [abs]: { offset: cursor.offset, pending: cursor.pending } },
          lastInserted: r?.inserted ?? 0,
          lastSkipped: r?.skipped ?? 0,
        },
        { alreadyLocked: true },
      )
      return { inserted: r?.inserted ?? 0, skipped: r?.skipped ?? 0 }
    } catch (err) {
      Object.assign(cursor, before)
      throw err
    }
  })
  return locked ?? { inserted: 0, skipped: 0 }
}

/** `--ingest-file` CLI: never throws out of this function; caller exits 0. */
export async function runIngestFile(file: string, delayMs = 0): Promise<void> {
  try {
    if (delayMs > 0) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, delayMs)
      })
    }
    await withPool(async (client) => {
      const result = await ingestFileFromCursor(file, client)
      console.log(`${file}: inserted=${result.inserted} skipped=${result.skipped}`)
    })
  } catch (err) {
    log(`ingest-file ${file} failed: ${err instanceof Error ? err.message : String(err)}`)
  }
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

export const USAGE = `pi-memory-capture — ingest pi v3 session jsonl into RivetOS memory

  pi-rivet-memory-capture --ingest-file <session.jsonl> [--delay-ms N]
  pi-rivet-memory-capture --backfill [--days N] [--sessions-dir DIR]
  pi-rivet-memory-capture --status

  --ingest-file FILE tail one session from the persisted cursor then exit (always 0)
  --delay-ms N       sleep N ms before reading (coalesce overlapping children)
  --backfill         ingest existing session files then exit
  --days N           with --backfill, only files whose mtime is within N days
  --once             alias of --backfill
  --status           print last ingest time + counts from the state file
  --sessions-dir DIR override the sessions root
`

export interface CliArgs {
  mode: 'help' | 'backfill' | 'ingest-file' | 'status' | 'stamp-installed' | 'unknown'
  file?: string
  sessionsDir?: string
  days?: number
  delayMs?: number
}

export function parseCli(argv: string[]): CliArgs {
  const out: CliArgs = { mode: 'unknown' }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '-h' || arg === '--help') {
      out.mode = 'help'
    } else if (arg === '--backfill' || arg === '--once') {
      out.mode = 'backfill'
    } else if (arg === '--ingest-file' || arg === '--ingest') {
      out.mode = 'ingest-file'
      out.file = argv[i + 1]
      i++
    } else if (arg === '--stamp-installed') {
      out.mode = 'stamp-installed'
    } else if (arg === '--status') {
      out.mode = 'status'
    } else if (arg === '--sessions-dir') {
      out.sessionsDir = argv[i + 1]
      i++
    } else if (arg === '--days') {
      const n = Number(argv[i + 1])
      i++
      if (Number.isFinite(n) && n >= 0) out.days = n
    } else if (arg === '--delay-ms') {
      const n = Number(argv[i + 1])
      i++
      if (Number.isFinite(n) && n >= 0) out.delayMs = n
    } else if (arg === '--watch') {
      out.mode = 'unknown'
    }
  }
  return out
}

async function main(): Promise<void> {
  loadEnvFile()
  const args = process.argv.slice(2)
  const cli = parseCli(args)
  if (args.length === 0 || cli.mode === 'help') {
    console.log(USAGE)
    return
  }

  if (args.includes('--watch')) {
    console.error(
      'pi-memory-capture: --watch has been removed; capture is triggered by the pi extension (~/.pi/agent/extensions/rivet-memory.ts). Use --backfill for a one-shot walk or --ingest-file for a single session.',
    )
    return
  }

  if (cli.mode === 'status') {
    console.log(formatStatus())
    return
  }

  if (cli.mode === 'stamp-installed') {
    const now = new Date().toISOString()
    const st = saveCaptureState({ hookInstalledAt: now })
    console.log(`hookInstalledAt=${st.hookInstalledAt ?? now} ${captureStatePath()}`)
    return
  }

  if (cli.mode === 'backfill') {
    await runOnce(cli.sessionsDir, cli.days)
    return
  }

  if (cli.mode === 'ingest-file') {
    if (!cli.file || cli.file.startsWith('--')) {
      console.error('Usage: pi-memory-capture --ingest-file <session.jsonl>')
      return
    }
    await runIngestFile(cli.file, cli.delayMs ?? 0)
    return
  }

  console.log(USAGE)
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  (path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) ||
    /pi-memory-capture\.(ts|js)$/.test(process.argv[1]))

if (invokedDirectly) {
  main().catch((err: unknown) => {
    log(`fatal: ${err instanceof Error ? err.stack : String(err)}`)
    process.exitCode = 1
  })
}
