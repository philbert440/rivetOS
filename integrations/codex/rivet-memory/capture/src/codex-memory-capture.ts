#!/usr/bin/env node
/**
 * Codex Memory Capture — ingest Codex CLI rollout jsonl into the shared
 * RivetOS memory DB as `rivet-gpt` conversations.
 *
 * Codex has no Claude/kimi-style lifecycle hooks. The capture source is the
 * append-only rollout the CLI writes:
 *
 *   $CODEX_HOME/sessions/YYYY/MM/DD/rollout-<ISO>-<uuid>.jsonl
 *
 * A file watcher over that tree tails new lines, folds with the same rules as
 * den-server's `codexTurnsFromLines` (drop developer / injection wrappers;
 * keep user + assistant + tool), and upserts ros_conversations / ros_messages.
 *
 * Identity: agent='rivet-gpt', channel='codex', session_key='codex:<uuid>'.
 * Dedup: rollout item id (`rs_…` / `ctc_…` / `ctco_…`); messages without an
 * id use `codex:<uuid>:line:<index>`. Content-hash is not the primary key.
 *
 * Truncation: 16K cap only when the row carries an absolute rollout path +
 * line offset so memory_get_full can re-read from disk.
 *
 * Best-effort: never throw to the caller. Failures go to
 * ~/.rivetos/codex-memory-capture.log.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import type { PoolClient } from 'pg'

const { Pool } = pg

export const CAPTURE_AGENT = 'rivet-gpt'
export const CAPTURE_CHANNEL = 'codex'
export const CAPTURE_SOURCE = 'codex-rollout'

const LOG_FILE = path.join(os.homedir(), '.rivetos', 'codex-memory-capture.log')
export const MAX_CONTENT = 16000
const STATEMENT_TIMEOUT_MS = 15000
const WATCH_POLL_MS = 2000

const CODEX_NATIVE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const ROLLOUT_NAME_RE =
  /^rollout-.+-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i

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
  extra?: Record<string, unknown>
}

export interface ParseResult {
  sessionId: string
  cwd: string | null
  title: string
  messages: PendingMessage[]
  malformed: number
  skipped: Record<string, number>
}

export interface FileCursor {
  offset: number
  pending: string
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

export function codexHome(): string {
  const env = process.env.CODEX_HOME?.trim()
  return env && env.length > 0 ? env : path.join(os.homedir(), '.codex')
}

export function codexSessionsDir(home = codexHome()): string {
  return path.join(home, 'sessions')
}

export function deriveSessionKey(sessionId: string): string {
  return `codex:${sessionId}`
}

export function uuidFromRolloutName(name: string): string | undefined {
  const m = name.match(ROLLOUT_NAME_RE)
  return m?.[1]
}

export function isNativeSessionId(id: string): boolean {
  return CODEX_NATIVE_RE.test(id) && !id.includes('/') && !id.includes('..')
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function asString(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v)
  } catch {
    return String(v)
  }
}

/**
 * Same wrapper filter as den-server `codexTurnsFromLines` / `isCodexWrapper`.
 * Developer / injection lines are not human turns.
 */
export function isCodexWrapper(text: string): boolean {
  return (
    text.startsWith('<environment_context>') ||
    text.startsWith('<skills_instructions>') ||
    text.startsWith('<multi_agent_')
  )
}

/**
 * Text out of a Codex message-content value. Mirrors the den adapter's
 * `contentText` (input_text / output_text / bare text), then drops wrappers.
 */
export function contentText(content: unknown, want: 'input_text' | 'output_text'): string | null {
  let text = ''
  if (typeof content === 'string') {
    text = content
  } else if (Array.isArray(content)) {
    text = content
      .map((b) => {
        if (!isRecord(b) || typeof b.text !== 'string') return ''
        if (b.type !== want && b.type !== 'text') return ''
        return b.text
      })
      .filter(Boolean)
      .join('\n')
  }
  text = text.trim()
  if (!text || isCodexWrapper(text)) return null
  return text
}

export function reasoningText(payload: Record<string, unknown>): string {
  if (typeof payload.text === 'string' && payload.text) return payload.text
  const parts: string[] = []
  const collect = (raw: unknown): void => {
    if (!Array.isArray(raw)) return
    for (const item of raw) {
      if (!isRecord(item) || typeof item.text !== 'string' || !item.text) continue
      parts.push(item.text)
    }
  }
  collect(payload.summary)
  collect(payload.content)
  return parts.join('')
}

function parseToolInput(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw
  try {
    return JSON.parse(raw) as unknown
  } catch {
    return raw
  }
}

/**
 * Dedup key for one rollout item.
 *
 * Prefer the harness item id so two legitimate identical "ok" turns do not
 * collapse. Fall back to session + 0-based line index (stable within a file).
 */
export function eventIdFromItem(
  sessionId: string,
  payload: Record<string, unknown> | undefined,
  lineIndex: number,
): string {
  const id = (payload ? asString(payload.id) : null) || (payload ? asString(payload.call_id) : null)
  if (id) return id
  return `codex:${sessionId}:line:${String(lineIndex)}`
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

function payloadOf(obj: Record<string, unknown>): Record<string, unknown> | undefined {
  return isRecord(obj.payload) ? obj.payload : undefined
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
 * Line-oriented ingest parser. Folding *rules* match `codexTurnsFromLines`
 * (drop developer / wrappers; keep user input_text, assistant output_text,
 * reasoning, custom_tool_call + output). Rows stay per-item so we can dedup
 * on rollout ids and point memory_get_full at a single jsonl line — the
 * den HarnessTurn fold drops tool output text and per-line ids, so it is
 * the wrong grain for ros_messages.
 */
export function parseRolloutText(
  text: string,
  sessionIdHint: string | null,
  transcriptPath: string | null,
): ParseResult {
  const lines = text.split('\n')
  const skipped: Record<string, number> = {}
  let malformed = 0
  let sessionId = sessionIdHint
  let cwd: string | null = null
  let firstUser: string | null = null
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
    const payload = payloadOf(obj)
    const eventTs = isoFromObj(obj) ?? (payload ? isoFromObj(payload) : null)

    if (type === 'session_meta' && payload) {
      const id = asString(payload.id)
      if (id && isNativeSessionId(id)) sessionId = id
      const cwdVal =
        asString(payload.cwd) || (isRecord(payload.cwd) ? asString(payload.cwd.path) : null)
      if (cwdVal) cwd = cwdVal
      continue
    }

    if (type !== 'response_item' || !payload) {
      continue
    }

    const sid = sessionId ?? sessionIdHint ?? 'unknown'
    const eventId = eventIdFromItem(sid, payload, i)

    switch (payload.type) {
      case 'message': {
        const role = payload.role
        if (role === 'developer') {
          bump(skipped, 'developer')
          break
        }
        if (role === 'user') {
          const textBody = contentText(payload.content, 'input_text')
          if (!textBody) {
            bump(skipped, 'user:wrapper-or-empty')
            break
          }
          if (firstUser === null) firstUser = textBody
          push({
            role: 'user',
            content: textBody,
            eventId,
            eventTs,
            lineIndex: i,
            extra: { sourceEvent: 'response_item:message', source: CAPTURE_SOURCE },
          })
          break
        }
        if (role !== 'assistant') {
          bump(skipped, `message:${String(role)}`)
          break
        }
        const textBody = contentText(payload.content, 'output_text')
        if (!textBody) {
          bump(skipped, 'assistant:empty')
          break
        }
        push({
          role: 'assistant',
          content: textBody,
          eventId,
          eventTs,
          lineIndex: i,
          extra: { sourceEvent: 'response_item:message', source: CAPTURE_SOURCE },
        })
        break
      }
      case 'reasoning': {
        const chunk = reasoningText(payload)
        if (!chunk) {
          bump(skipped, 'reasoning:empty')
          break
        }
        push({
          role: 'assistant',
          content: `[thinking] ${chunk}`,
          eventId,
          eventTs,
          lineIndex: i,
          extra: {
            sourceEvent: 'response_item:reasoning',
            source: CAPTURE_SOURCE,
            partType: 'think',
          },
        })
        break
      }
      case 'custom_tool_call': {
        const name = asString(payload.name) || asString(payload.tool) || 'unknown'
        const callId = asString(payload.id)
        if (callId) toolNameById.set(callId, name)
        const args = parseToolInput(payload.input ?? payload.arguments)
        push({
          role: 'tool',
          content: `[tool] ${name}`,
          toolName: name,
          toolArgs: args,
          eventId,
          eventTs,
          lineIndex: i,
          extra: {
            sourceEvent: 'response_item:custom_tool_call',
            source: CAPTURE_SOURCE,
            callId: callId,
          },
        })
        break
      }
      case 'custom_tool_call_output': {
        const callId = asString(payload.call_id) || asString(payload.id)
        const name = (callId && toolNameById.get(callId)) || 'unknown'
        const err = payload.error
        const isFailure = err != null && err !== false && err !== ''
        const out = payload.output ?? payload.content
        const toolResult = typeof out === 'string' ? out : out != null ? safeJson(out) : null
        push({
          role: 'tool',
          content: isFailure ? `[tool-failure] ${name}` : `[tool-result] ${name}`,
          toolName: name,
          toolResult,
          eventId,
          eventTs,
          lineIndex: i,
          extra: {
            sourceEvent: 'response_item:custom_tool_call_output',
            source: CAPTURE_SOURCE,
            callId,
            failure: isFailure,
          },
        })
        break
      }
      default:
        bump(skipped, `payload:${String(payload.type)}`)
        break
    }
  }

  if (!sessionId) {
    if (transcriptPath) {
      sessionId = uuidFromRolloutName(path.basename(transcriptPath)) ?? 'unknown'
    } else {
      sessionId = 'unknown'
    }
  }

  const title = firstUser ? firstUser.replace(/\s+/g, ' ').slice(0, 120) : 'Codex session'

  return { sessionId, cwd, title, messages, malformed, skipped }
}

export function parseRolloutFile(file: string, sessionIdHint?: string | null): ParseResult {
  const text = fs.readFileSync(file, 'utf8')
  const fromName = uuidFromRolloutName(path.basename(file)) ?? null
  return parseRolloutText(text, sessionIdHint ?? fromName, path.resolve(file))
}

function isDateDir(name: string, width: number): boolean {
  return name.length === width && /^\d+$/.test(name)
}

/** Every `rollout-*.jsonl` under `$CODEX_HOME/sessions/YYYY/MM/DD/`. */
export function discoverRolloutFiles(root: string): string[] {
  const out: string[] = []
  let years: string[]
  try {
    years = fs.readdirSync(root).sort()
  } catch {
    return out
  }
  for (const year of years) {
    if (!isDateDir(year, 4)) continue
    let months: string[]
    try {
      months = fs.readdirSync(path.join(root, year)).sort()
    } catch {
      continue
    }
    for (const month of months) {
      if (!isDateDir(month, 2)) continue
      let days: string[]
      try {
        days = fs.readdirSync(path.join(root, year, month)).sort()
      } catch {
        continue
      }
      for (const day of days) {
        if (!isDateDir(day, 2)) continue
        const dir = path.join(root, year, month, day)
        let files: string[]
        try {
          files = fs.readdirSync(dir)
        } catch {
          continue
        }
        for (const f of files) {
          if (!ROLLOUT_NAME_RE.test(f)) continue
          const p = path.join(dir, f)
          try {
            if (fs.statSync(p).isFile()) out.push(p)
          } catch {
            // vanished
          }
        }
      }
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

async function findOrCreateConversation(
  client: Queryable,
  sessionKey: string,
  init: { title: string; settings: Record<string, unknown>; active: boolean },
): Promise<{ id: string; created: boolean }> {
  // Upsert on the (session_key, agent) unique index (migration 0009): concurrency-safe,
  // no SELECT-then-INSERT race. xmax = 0 on the returned row means this INSERT created it.
  const conv = await client.query(
    `INSERT INTO ros_conversations (session_key, agent, channel, title, settings, active, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, now(), now())
     ON CONFLICT (session_key, agent) DO UPDATE SET updated_at = now()
     RETURNING id, (xmax = 0) AS created`,
    [
      sessionKey,
      CAPTURE_AGENT,
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
    toolArgsStored = argCap.stored
    toolArgsTruncated = argCap.truncated
    toolArgsFullLength = raw.length
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
      CAPTURE_AGENT,
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
    /** Per-conversation in-memory dedup set (watcher). Primed from the DB once. */
    seen?: Set<string>
  } = {},
): Promise<{ inserted: number; skipped: number; conversationId: string; sessionKey: string }> {
  const sessionKey = deriveSessionKey(sessionId)
  if (opts.lock !== false) {
    await client.query('BEGIN')
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [sessionKey])
  }
  try {
    const conv = await findOrCreateConversation(client, sessionKey, {
      title: (opts.title || 'Codex session').slice(0, 120),
      settings: {
        source: CAPTURE_SOURCE,
        sessionId,
        cwd: opts.cwd ?? null,
        triggerEvent: opts.triggerEvent ?? 'ingest',
        session_jsonl_path: opts.transcriptPath ?? null,
      },
      active: !opts.finalize,
    })

    // Prime the in-memory dedup set once for an existing conversation, then let it
    // be the authority — no per-message SELECT on subsequent ticks.
    if (opts.seen && !conv.created && opts.seen.size === 0) {
      const prior = await client.query(
        `SELECT metadata->>'event_id' AS e FROM ros_messages
          WHERE conversation_id = $1 AND metadata->>'event_id' IS NOT NULL`,
        [conv.id],
      )
      for (const row of prior.rows as Array<{ e?: string | null }>) {
        if (typeof row.e === 'string' && row.e) opts.seen.add(row.e)
      }
    }

    let inserted = 0
    let skipped = 0
    for (const m of messages) {
      const result = await insertMessage(client, conv.id, m, opts.transcriptPath ?? null, opts.seen)
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
    return { inserted, skipped, conversationId: conv.id, sessionKey }
  } catch (err) {
    if (opts.lock !== false) await client.query('ROLLBACK').catch(() => undefined)
    throw err
  }
}

export async function ingestRolloutFile(
  file: string,
  client: Queryable,
  opts: { finalize?: boolean; triggerEvent?: string } = {},
): Promise<{ parsed: ParseResult; result: Awaited<ReturnType<typeof ingestMessages>> }> {
  const parsed = parseRolloutFile(file)
  const result = await ingestMessages(client, parsed.sessionId, parsed.messages, {
    title: parsed.title,
    cwd: parsed.cwd,
    transcriptPath: path.resolve(file),
    finalize: opts.finalize,
    triggerEvent: opts.triggerEvent ?? 'ingest',
  })
  return { parsed, result }
}

// ---------------------------------------------------------------------------
// Watcher
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

async function ingestNewLines(
  file: string,
  cursor: FileCursor,
  client: Queryable,
  seenByKey?: Map<string, Set<string>>,
): Promise<{ inserted: number; skipped: number } | null> {
  const newLines = consumeNewLines(file, cursor)
  if (newLines.length === 0) return null
  // Re-parse the whole file so tool call/output pairing still works when the
  // pair straddles two watch ticks. The in-memory seen-set keeps re-ticks O(new).
  const parsed = parseRolloutFile(file)
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
    triggerEvent: 'watch',
    seen,
  })
  log(
    `watch ${result.sessionKey}: file=${abs} newLines=${newLines.length} msgs=${parsed.messages.length} inserted=${result.inserted} skipped=${result.skipped}`,
  )
  return { inserted: result.inserted, skipped: result.skipped }
}

export async function scanOnce(
  root: string,
  client: Queryable,
  state: WatcherState,
  fromStart: boolean,
): Promise<{ files: number; inserted: number; skipped: number }> {
  const files = discoverRolloutFiles(root)
  let inserted = 0
  let skipped = 0
  for (const file of files) {
    if (!state.cursors.has(file)) {
      state.cursors.set(file, primeCursor(file, fromStart || !state.known.has(file)))
    }
    state.known.add(file)
    const cursor = state.cursors.get(file)!
    try {
      const r = await ingestNewLines(file, cursor, client, state.seen)
      if (r) {
        inserted += r.inserted
        skipped += r.skipped
      }
    } catch (err) {
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

export async function runOnce(sessionsDir?: string): Promise<void> {
  const root = sessionsDir ?? codexSessionsDir()
  const state = createWatcherState()
  const summary = await withPool((client) => scanOnce(root, client, state, true))
  log(
    `once ${root}: files=${summary.files} inserted=${summary.inserted} skipped=${summary.skipped}`,
  )
  console.log(
    `codex-memory-capture --once: files=${summary.files} inserted=${summary.inserted} skipped=${summary.skipped}`,
  )
}

export async function runWatch(sessionsDir?: string): Promise<void> {
  const root = sessionsDir ?? codexSessionsDir()
  try {
    fs.mkdirSync(root, { recursive: true })
  } catch (err) {
    log(`watch: cannot create ${root}: ${err instanceof Error ? err.message : String(err)}`)
  }

  const pool = new Pool({ connectionString: resolvePgUrl(), max: 1 })
  const state = createWatcherState()
  log(`watch starting on ${root}`)

  const tick = async (fromStart: boolean): Promise<void> => {
    const client = await pool.connect()
    try {
      await client.query(`SET statement_timeout = ${STATEMENT_TIMEOUT_MS}`)
      await scanOnce(root, client, state, fromStart)
    } catch (err) {
      log(`watch tick failed: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      client.release()
    }
  }

  await tick(true)

  let watching = false
  const startWatch = (): void => {
    if (watching) return
    try {
      const watcher = fs.watch(root, { recursive: true }, () => {
        void tick(false)
      })
      watcher.on('error', (err) => {
        log(`fs.watch error: ${err.message}`)
        watching = false
      })
      watching = true
      log(`fs.watch attached to ${root}`)
    } catch (err) {
      log(`fs.watch unavailable: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  startWatch()

  setInterval(() => {
    if (!watching) startWatch()
    void tick(false)
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

export const USAGE = `codex-memory-capture — ingest Codex rollout jsonl into RivetOS memory

  codex-rivet-memory-capture --watch [--sessions-dir DIR]
  codex-rivet-memory-capture --once [--sessions-dir DIR]
  codex-rivet-memory-capture --ingest <rollout.jsonl>

  --watch            tail $CODEX_HOME/sessions (default ~/.codex/sessions)
  --once             ingest existing rollout files then exit
  --ingest FILE      ingest one rollout file then exit
  --sessions-dir DIR override the sessions root
`

async function main(): Promise<void> {
  loadEnvFile()
  const args = process.argv.slice(2)
  if (args.length === 0 || args[0] === '-h' || args[0] === '--help') {
    console.log(USAGE)
    return
  }

  const sessionsIdx = args.indexOf('--sessions-dir')
  const sessionsDir = sessionsIdx >= 0 ? args[sessionsIdx + 1] : undefined

  if (args[0] === '--watch') {
    await runWatch(sessionsDir)
    return
  }
  if (args[0] === '--once') {
    await runOnce(sessionsDir)
    return
  }
  if (args[0] === '--ingest') {
    const file = args[1]
    if (!file) {
      console.error('Usage: codex-memory-capture --ingest <rollout.jsonl>')
      process.exitCode = 1
      return
    }
    await withPool(async (client) => {
      const { parsed, result } = await ingestRolloutFile(file, client, {
        triggerEvent: 'ingest',
      })
      console.log(
        `${file}: session=${parsed.sessionId} msgs=${parsed.messages.length} inserted=${result.inserted} skipped=${result.skipped}`,
      )
    })
    return
  }

  console.log(USAGE)
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  (path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) ||
    /codex-memory-capture\.(ts|js)$/.test(process.argv[1]))

if (invokedDirectly) {
  main().catch((err: unknown) => {
    log(`fatal: ${err instanceof Error ? err.stack : String(err)}`)
    process.exitCode = 0
  })
}
