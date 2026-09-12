#!/usr/bin/env node
/**
 * Codex Memory Capture — ingest Codex CLI rollout jsonl into the shared
 * RivetOS memory DB as `rivet-gpt` conversations.
 *
 * Trigger: Codex lifecycle hooks (`UserPromptSubmit`, `Stop`, `SessionEnd`)
 * invoke this worker with `--hook` and one JSON object on stdin. The payload's
 * `transcript_path` is the absolute rollout jsonl:
 *
 *   $CODEX_HOME/sessions/YYYY/MM/DD/rollout-<ISO>-<uuid>.jsonl
 *
 * `--hook` validates stdin, then hands off to a detached child
 * (`--ingest-file <transcript> --delay-ms 400`, plus `--close-session` on
 * SessionEnd) so the parent exits in milliseconds. Codex clamps SessionEnd
 * hooks to 3s; inline ingest would get killed on any non-trivial rollout.
 * The child tails the file from a persisted per-file cursor under the
 * cross-process state lock, folds with the same rules as den-server's
 * `codexTurnsFromLines` (drop developer / injection wrappers; keep user +
 * assistant + tool), and upserts ros_conversations / ros_messages.
 * `--backfill` is the one-shot walk of existing rollouts.
 *
 * Identity: agent='rivet-gpt', channel='codex', session_key='codex:<uuid>'.
 * Dedup: rollout item id (`rs_…` / `ctc_…` / `ctco_…`); messages without an
 * id use `codex:<uuid>:line:<index>`. Content-hash is not the primary key.
 *
 * Truncation: 16K cap only when the row carries an absolute rollout path +
 * line offset so memory_get_full can re-read from disk.
 *
 * `--hook` never throws (log + exit 0) so the CLI is never blocked. Log:
 * ~/.rivetos/logs/codex-capture.log. State:
 * ~/.rivetos/codex-capture-state.json.
 */

import { spawn } from 'node:child_process'
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

const LOG_FILE = path.join(os.homedir(), '.rivetos', 'logs', 'codex-capture.log')
export const MAX_CONTENT = 16000
const STATEMENT_TIMEOUT_MS = 15000
const DEFAULT_STATE_FILE = path.join(os.homedir(), '.rivetos', 'codex-capture-state.json')
export const HOOK_HANDOFF_DELAY_MS = 400

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

export function deriveSessionKey(
  sessionId: string,
  bindingsFile = path.join(
    process.env.RIVETOS_DEN_STATE_DIR ?? path.join(os.homedir(), '.rivetos', 'den'),
    'codex-threads.json',
  ),
): string {
  try {
    const data = JSON.parse(fs.readFileSync(bindingsFile, 'utf8')) as {
      version?: number
      bindings?: Array<{ id?: unknown; threadId?: unknown }>
    }
    if (data.version !== 1 || !Array.isArray(data.bindings))
      throw new Error('Invalid Codex bindings file')
    const binding = data.bindings.find((entry) => entry.threadId === sessionId)
    if (binding) {
      if (
        typeof binding.id !== 'string' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(binding.id)
      )
        throw new Error('Invalid Codex session binding')
      return `codex:${binding.id}`
    }
  } catch (error) {
    // A missing map is a standalone installation. Never silently split
    // identity when an existing map is unreadable or malformed.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
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
  sessionIdHint: string | null = null,
  transcriptPath: string | null = null,
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
      case 'function_call':
      case 'custom_tool_call': {
        const name = asString(payload.name) || asString(payload.tool) || 'unknown'
        const callId = asString(payload.call_id) || asString(payload.id)
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
            sourceEvent: `response_item:${payload.type}`,
            source: CAPTURE_SOURCE,
            callId: callId,
          },
        })
        break
      }
      case 'function_call_output':
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
            sourceEvent: `response_item:${payload.type}`,
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
    // tool_args is jsonb. Free-form code and truncated object previews must
    // be encoded as JSON strings instead of sent as invalid JSON.
    toolArgsStored =
      typeof m.toolArgs === 'string' || argCap.truncated ? JSON.stringify(argCap.stored) : raw
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
    /** Per-conversation in-memory dedup set. Primed from the DB once. */
    seen?: Set<string>
  } = {},
): Promise<{ inserted: number; skipped: number; conversationId: string; sessionKey: string }> {
  const sessionKey = deriveSessionKey(sessionId)
  // Publish dedup progress only after commit so rolled-back INSERTs replay.
  const seen = opts.seen ? new Set(opts.seen) : undefined
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

    if (opts.lock !== false) await client.query('COMMIT')
    if (opts.seen && seen) for (const id of seen) opts.seen.add(id)
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
// Persisted state (cursors + last ingest; doctor reads --status)
// ---------------------------------------------------------------------------

export interface PersistedCursor {
  offset: number
  pending: string
}

export interface ClosedSession {
  closedAt: string
  transcriptPath?: string | null
  reason?: string
}

export interface CaptureState {
  version: 1
  lastIngestAt?: string
  lastIngestSource?: string
  hookInstalledAt?: string
  files?: number
  inserted?: number
  skipped?: number
  cursors: Record<string, PersistedCursor>
  closedSessions?: Record<string, ClosedSession>
}

export function captureStatePath(): string {
  const env = process.env.RIVETOS_CODEX_STATE?.trim()
  return env && env.length > 0 ? env : DEFAULT_STATE_FILE
}

export function emptyCaptureState(): CaptureState {
  return { version: 1, cursors: {} }
}

export function loadCaptureState(file = captureStatePath()): CaptureState {
  try {
    const raw = fs.readFileSync(file, 'utf8')
    const parsed = JSON.parse(raw) as unknown
    if (!isRecord(parsed)) return emptyCaptureState()
    const cursors: Record<string, PersistedCursor> = {}
    if (isRecord(parsed.cursors)) {
      for (const [k, v] of Object.entries(parsed.cursors)) {
        if (!isRecord(v)) continue
        const offset = typeof v.offset === 'number' && Number.isFinite(v.offset) ? v.offset : 0
        const pending = typeof v.pending === 'string' ? v.pending : ''
        cursors[k] = { offset, pending }
      }
    }
    const closedSessions: Record<string, ClosedSession> = {}
    if (isRecord(parsed.closedSessions)) {
      for (const [k, v] of Object.entries(parsed.closedSessions)) {
        if (!isRecord(v) || typeof v.closedAt !== 'string') continue
        closedSessions[k] = {
          closedAt: v.closedAt,
          transcriptPath: typeof v.transcriptPath === 'string' ? v.transcriptPath : null,
          reason: typeof v.reason === 'string' ? v.reason : undefined,
        }
      }
    }
    return {
      version: 1,
      lastIngestAt: typeof parsed.lastIngestAt === 'string' ? parsed.lastIngestAt : undefined,
      lastIngestSource:
        typeof parsed.lastIngestSource === 'string' ? parsed.lastIngestSource : undefined,
      hookInstalledAt:
        typeof parsed.hookInstalledAt === 'string' ? parsed.hookInstalledAt : undefined,
      files: typeof parsed.files === 'number' ? parsed.files : undefined,
      inserted: typeof parsed.inserted === 'number' ? parsed.inserted : undefined,
      skipped: typeof parsed.skipped === 'number' ? parsed.skipped : undefined,
      cursors,
      closedSessions: Object.keys(closedSessions).length > 0 ? closedSessions : undefined,
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      log(`state load failed: ${err instanceof Error ? err.message : String(err)}`)
    }
    return emptyCaptureState()
  }
}

export const STATE_LOCK_STALE_MS = 120_000
export const STATE_LOCK_WAIT_MS = 30_000
export const STATE_LOCK_POLL_MS = 100

export interface StateLockOpts {
  staleMs?: number
  waitMs?: number
  pollMs?: number
}

export interface StateLockHandle {
  dir: string
  held: boolean
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

function lockDirFor(stateFile: string): string {
  return `${stateFile}.lock`
}

function writeLockOwner(dir: string): void {
  fs.writeFileSync(
    path.join(dir, 'owner.json'),
    `${JSON.stringify({ pid: process.pid, ts: Date.now() })}\n`,
  )
}

function readLockStamp(dir: string): number | null {
  try {
    const raw = fs.readFileSync(path.join(dir, 'owner.json'), 'utf8')
    const parsed = JSON.parse(raw) as { ts?: unknown }
    if (typeof parsed.ts === 'number' && Number.isFinite(parsed.ts)) return parsed.ts
  } catch {
    // fall through to directory mtime
  }
  try {
    return fs.statSync(dir).mtimeMs
  } catch {
    return null
  }
}

function lockIsStale(dir: string, staleMs: number): boolean {
  const ts = readLockStamp(dir)
  if (ts == null) return true
  return Date.now() - ts > staleMs
}

function tryAcquireLock(dir: string): 'acquired' | 'exists' | 'error' {
  try {
    fs.mkdirSync(dir)
    writeLockOwner(dir)
    return 'acquired'
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return 'exists'
    log(`state lock mkdir failed: ${err instanceof Error ? err.message : String(err)}`)
    return 'error'
  }
}

function removeLockDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true })
  } catch {
    // ignore
  }
}

export async function acquireStateLock(
  stateFile: string,
  opts: StateLockOpts = {},
): Promise<StateLockHandle> {
  const dir = lockDirFor(stateFile)
  const staleMs = opts.staleMs ?? STATE_LOCK_STALE_MS
  const waitMs = opts.waitMs ?? STATE_LOCK_WAIT_MS
  const pollMs = opts.pollMs ?? STATE_LOCK_POLL_MS
  const deadline = Date.now() + waitMs
  while (true) {
    const result = tryAcquireLock(dir)
    if (result === 'acquired') return { dir, held: true }
    if (result === 'error') {
      log(`state lock: cannot create ${dir}; treating as busy`)
      return { dir, held: false }
    }
    if (lockIsStale(dir, staleMs) && Date.now() < deadline) {
      log(`state lock stale (${dir}); removing`)
      removeLockDir(dir)
      await sleep(pollMs)
      continue
    }
    if (Date.now() >= deadline) {
      log(`state lock timeout for ${dir}`)
      return { dir, held: false }
    }
    await sleep(pollMs)
  }
}

export function releaseStateLock(handle: StateLockHandle): void {
  if (!handle.held) return
  removeLockDir(handle.dir)
}

/** Run `fn` under the state lock; when the bounded wait expires the work is
 *  SKIPPED (null) — the persistence critical section never runs unowned; the
 *  next hook retries. */
export async function withStateLock<T>(
  stateFile: string,
  fn: () => Promise<T>,
  opts: StateLockOpts = {},
): Promise<T | null> {
  const handle = await acquireStateLock(stateFile, opts)
  if (!handle.held) {
    log(`state lock busy (${handle.dir}); skipping — the next hook retries`)
    return null
  }
  try {
    return await fn()
  } finally {
    releaseStateLock(handle)
  }
}

/** `--stamp-installed`: record hookInstalledAt under the state lock (setup
 *  scripts must not race detached workers with an unlocked write). */
export async function runStampInstalled(stateFile = captureStatePath()): Promise<void> {
  await withStateLock(stateFile, () => {
    const st = loadCaptureState(stateFile)
    const now = new Date().toISOString()
    saveCaptureState({ ...st, hookInstalledAt: st.hookInstalledAt ?? now }, stateFile)
    console.log(`hookInstalledAt=${st.hookInstalledAt ?? now} ${stateFile}`)
    return Promise.resolve()
  })
}

/** Apply this run's cursor/session fields on top of `base`. Cursors never regress. */
export function mergeCaptureState(
  base: CaptureState,
  patch: {
    cursors?: Record<string, PersistedCursor>
    closedSessions?: Record<string, ClosedSession>
    lastIngestAt?: string
    lastIngestSource?: string
    hookInstalledAt?: string
    files?: number
    inserted?: number
    skipped?: number
  },
): CaptureState {
  const cursors: Record<string, PersistedCursor> = { ...base.cursors }
  if (patch.cursors) {
    for (const [key, next] of Object.entries(patch.cursors)) {
      const prev = cursors[key]
      if (!prev || next.offset > prev.offset) {
        cursors[key] = { offset: next.offset, pending: next.pending }
      } else if (next.offset === prev.offset && next.pending.length > prev.pending.length) {
        cursors[key] = { offset: next.offset, pending: next.pending }
      }
    }
  }
  const closed: Record<string, ClosedSession> = {
    ...(base.closedSessions ?? {}),
    ...(patch.closedSessions ?? {}),
  }
  const patchIsNewer =
    typeof patch.lastIngestAt === 'string' &&
    (!base.lastIngestAt || patch.lastIngestAt >= base.lastIngestAt)
  return {
    version: 1,
    lastIngestAt: patchIsNewer ? patch.lastIngestAt : base.lastIngestAt,
    lastIngestSource: patchIsNewer
      ? (patch.lastIngestSource ?? base.lastIngestSource)
      : base.lastIngestSource,
    hookInstalledAt: base.hookInstalledAt ?? patch.hookInstalledAt,
    files: patchIsNewer ? (patch.files ?? base.files) : base.files,
    inserted: patchIsNewer ? (patch.inserted ?? base.inserted) : base.inserted,
    skipped: patchIsNewer ? (patch.skipped ?? base.skipped) : base.skipped,
    cursors,
    closedSessions: Object.keys(closed).length > 0 ? closed : undefined,
  }
}

export function saveCaptureState(state: CaptureState, file = captureStatePath()): void {
  let tmp = ''
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const unique = `${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 10)}`
    tmp = `${file}.${unique}.tmp`
    fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`)
    fs.renameSync(tmp, file)
  } catch (err) {
    if (tmp) {
      try {
        fs.unlinkSync(tmp)
      } catch {
        // ignore
      }
    }
    log(`state save failed: ${err instanceof Error ? err.message : String(err)}`)
  }
}

function cursorFromState(state: CaptureState, file: string): FileCursor {
  const abs = path.resolve(file)
  const saved = state.cursors[abs] ?? state.cursors[file]
  if (saved) return { offset: saved.offset, pending: saved.pending }
  return { offset: 0, pending: '' }
}

function stateToWatcher(state: CaptureState): WatcherState {
  const w = createWatcherState()
  for (const [file, cur] of Object.entries(state.cursors)) {
    w.cursors.set(file, { offset: cur.offset, pending: cur.pending })
    w.known.add(file)
  }
  return w
}

function watcherToCursors(state: WatcherState): Record<string, PersistedCursor> {
  const cursors: Record<string, PersistedCursor> = {}
  for (const [file, cur] of state.cursors) {
    cursors[path.resolve(file)] = { offset: cur.offset, pending: cur.pending }
  }
  return cursors
}

function pickPayloadString(payload: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const v = payload[key]
    if (typeof v === 'string' && v.trim().length > 0) return v
  }
  return null
}

/** Newest `rollout-*.jsonl` whose filename UUID matches `sessionId`. */
export function newestRolloutForSession(sessionId: string, root?: string): string | null {
  if (!sessionId) return null
  const files = discoverRolloutFiles(root ?? codexSessionsDir()).filter(
    (f) => uuidFromRolloutName(path.basename(f)) === sessionId,
  )
  if (files.length === 0) return null
  const mtimeOf = (f: string): number => {
    try {
      return fs.statSync(f).mtimeMs
    } catch {
      return 0
    }
  }
  files.sort((a, b) => {
    const am = mtimeOf(a)
    const bm = mtimeOf(b)
    if (am !== bm) return bm - am
    return a < b ? 1 : -1
  })
  return files[0] ?? null
}

function rolloutWithinDays(file: string, days: number): boolean {
  const parts = file.split(path.sep)
  for (let i = 0; i + 2 < parts.length; i++) {
    if (!isDateDir(parts[i] ?? '', 4)) continue
    if (!isDateDir(parts[i + 1] ?? '', 2)) continue
    if (!isDateDir(parts[i + 2] ?? '', 2)) continue
    const ms = Date.parse(`${parts[i]}-${parts[i + 1]}-${parts[i + 2]}T00:00:00Z`)
    if (Number.isNaN(ms)) continue
    const cutoff = Date.now() - days * 86400000
    return ms >= cutoff - 86400000
  }
  try {
    return Date.now() - fs.statSync(file).mtimeMs <= days * 86400000
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Cursor ingest (shared by --hook and --backfill)
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
  triggerEvent = 'ingest',
  finalize = false,
): Promise<{ inserted: number; skipped: number } | null> {
  const newLines = consumeNewLines(file, cursor)
  if (newLines.length === 0 && !finalize) return null
  // Re-parse the whole file so tool call/output pairing still works when the
  // pair straddles two ingest ticks. The in-memory seen-set keeps re-ticks O(new).
  const parsed = parseRolloutFile(file)
  if (parsed.messages.length === 0 && !finalize) return { inserted: 0, skipped: 0 }
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
    finalize,
    seen,
  })
  log(
    `ingest ${result.sessionKey}: file=${abs} newLines=${newLines.length} msgs=${parsed.messages.length} inserted=${result.inserted} skipped=${result.skipped} event=${triggerEvent}`,
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
  let files = discoverRolloutFiles(root)
  if (typeof opts.days === 'number' && opts.days >= 0) {
    files = files.filter((f) => rolloutWithinDays(f, opts.days as number))
  }
  let inserted = 0
  let skipped = 0
  const triggerEvent = opts.triggerEvent ?? 'backfill'
  for (const file of files) {
    const abs = path.resolve(file)
    if (!state.cursors.has(abs)) {
      const prior = state.cursors.get(file)
      state.cursors.set(abs, prior ?? primeCursor(abs, fromStart || !state.known.has(abs)))
    }
    state.known.add(abs)
    const cursor = state.cursors.get(abs)!
    const before = { ...cursor }
    try {
      const r = await ingestNewLines(abs, cursor, client, state.seen, triggerEvent, false)
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

export async function runBackfill(
  sessionsDir?: string,
  days?: number,
  stateFile = captureStatePath(),
  delayMs = 0,
): Promise<void> {
  if (delayMs > 0) await sleep(delayMs)
  const root = sessionsDir ?? codexSessionsDir()
  const source = typeof days === 'number' ? `backfill:${String(days)}d` : 'backfill'
  await withStateLock(stateFile, async () => {
    const persisted = loadCaptureState(stateFile)
    const state = stateToWatcher(persisted)
    const summary = await withPool((client) =>
      scanOnce(root, client, state, true, { days, triggerEvent: source }),
    )
    const latest = loadCaptureState(stateFile)
    const next = mergeCaptureState(latest, {
      lastIngestAt: new Date().toISOString(),
      lastIngestSource: source,
      files: summary.files,
      inserted: summary.inserted,
      skipped: summary.skipped,
      cursors: watcherToCursors(state),
    })
    saveCaptureState(next, stateFile)
    log(
      `backfill ${root}: files=${summary.files} inserted=${summary.inserted} skipped=${summary.skipped}`,
    )
    console.log(
      `codex-memory-capture --backfill: files=${summary.files} inserted=${summary.inserted} skipped=${summary.skipped}`,
    )
  })
}

/** @deprecated alias of runBackfill */
export async function runOnce(sessionsDir?: string): Promise<void> {
  await runBackfill(sessionsDir)
}

export interface HookHandleOpts {
  client: Queryable
  stateFile?: string
  sessionsDir?: string
  delayMs?: number
  lock?: StateLockOpts
}

export interface IngestFileOpts {
  client: Queryable
  stateFile?: string
  delayMs?: number
  lock?: StateLockOpts
  closeSession?: boolean
  sessionId?: string | null
  triggerEvent?: string
  reason?: string
}

export interface HookHandleResult {
  inserted: number
  skipped: number
  file: string | null
  event: string
  finalized: boolean
  sessionId: string | null
}

function eventNameFromTrigger(triggerEvent: string): string {
  return triggerEvent.startsWith('hook:') ? triggerEvent.slice(5) : triggerEvent
}

/**
 * Cursor-tail one rollout under the round-1 state lock. Used by `--ingest-file`
 * (including the detached `--hook` child) and by `handleHookPayload`.
 * Never throws — failures are logged and return zeros.
 */
export async function ingestTranscriptFile(
  file: string,
  opts: IngestFileOpts,
): Promise<HookHandleResult> {
  const abs = path.resolve(file)
  const stateFile = opts.stateFile ?? captureStatePath()
  const triggerEvent = opts.triggerEvent ?? 'ingest-file'
  const event = eventNameFromTrigger(triggerEvent)
  const empty: HookHandleResult = {
    inserted: 0,
    skipped: 0,
    file: abs,
    event,
    finalized: false,
    sessionId: opts.sessionId ?? uuidFromRolloutName(path.basename(abs)) ?? null,
  }

  try {
    if (opts.delayMs && opts.delayMs > 0) await sleep(opts.delayMs)
    const finalize = Boolean(opts.closeSession)
    const locked = await withStateLock(
      stateFile,
      async () => {
        const cursor = cursorFromState(loadCaptureState(stateFile), abs)
        const before = { offset: cursor.offset, pending: cursor.pending }
        const seenByKey = new Map<string, Set<string>>()

        let inserted = 0
        let skipped = 0
        try {
          const r = await ingestNewLines(
            abs,
            cursor,
            opts.client,
            seenByKey,
            triggerEvent,
            finalize,
          )
          if (r) {
            inserted = r.inserted
            skipped = r.skipped
          }
        } catch (err) {
          Object.assign(cursor, before)
          log(`ingest ${triggerEvent} failed: ${err instanceof Error ? err.message : String(err)}`)
          return { ...empty, file: abs }
        }

        const latest = loadCaptureState(stateFile)
        const now = new Date().toISOString()
        const sid = opts.sessionId ?? uuidFromRolloutName(path.basename(abs)) ?? null
        const closedPatch: Record<string, ClosedSession> | undefined =
          finalize && sid
            ? {
                [sid]: {
                  closedAt: now,
                  transcriptPath: abs,
                  reason: opts.reason,
                },
              }
            : undefined
        const merged = mergeCaptureState(latest, {
          cursors: {
            [path.resolve(abs)]: { offset: cursor.offset, pending: cursor.pending },
          },
          closedSessions: closedPatch,
          lastIngestAt: now,
          lastIngestSource: triggerEvent,
          hookInstalledAt: latest.hookInstalledAt ?? now,
          inserted,
          skipped,
        })
        saveCaptureState(merged, stateFile)
        return {
          inserted,
          skipped,
          file: abs,
          event,
          finalized: finalize,
          sessionId: sid,
        }
      },
      opts.lock,
    )
    return locked ?? empty
  } catch (err) {
    log(`ingest ${triggerEvent} failed: ${err instanceof Error ? err.message : String(err)}`)
    return empty
  }
}

/**
 * Resolve transcript + ingest one Codex hook payload. Used by tests and as
 * the child's ingest implementation via `ingestTranscriptFile`. Never throws.
 */
export async function handleHookPayload(
  payload: Record<string, unknown>,
  opts: HookHandleOpts,
): Promise<HookHandleResult> {
  const event = pickPayloadString(payload, 'hook_event_name', 'hookEventName') ?? 'unknown'
  const source = `hook:${event}`
  const finalize = /^sessionend$/i.test(event)
  const sessionsDir = opts.sessionsDir ?? codexSessionsDir()
  const empty: HookHandleResult = {
    inserted: 0,
    skipped: 0,
    file: null,
    event,
    finalized: false,
    sessionId: pickPayloadString(payload, 'session_id', 'sessionId'),
  }

  try {
    const sessionId = empty.sessionId
    let transcript = pickPayloadString(payload, 'transcript_path', 'transcriptPath') ?? null
    if (!transcript && sessionId) {
      transcript = newestRolloutForSession(sessionId, sessionsDir)
      if (transcript) log(`hook ${event}: transcript_path missing, fallback ${transcript}`)
    }
    if (!transcript) {
      log(`hook ${event}: no transcript_path and no rollout for session ${sessionId ?? '?'}`)
      return empty
    }

    return await ingestTranscriptFile(transcript, {
      client: opts.client,
      stateFile: opts.stateFile,
      delayMs: opts.delayMs,
      lock: opts.lock,
      closeSession: finalize,
      sessionId,
      triggerEvent: source,
      reason: pickPayloadString(payload, 'reason') ?? undefined,
    })
  } catch (err) {
    log(`hook ${event} failed: ${err instanceof Error ? err.message : String(err)}`)
    return empty
  }
}

export interface SpawnHandle {
  unref: () => void
}

export interface SpawnOpts {
  detached?: boolean
  stdio?: 'ignore' | 'inherit' | 'pipe'
  env?: NodeJS.ProcessEnv
}

export type SpawnFn = (command: string, args: string[], options: SpawnOpts) => SpawnHandle

export interface HookHandoffOpts {
  spawn?: SpawnFn
  sessionsDir?: string
  argv?: string[]
  execPath?: string
  delayMs?: number
  env?: NodeJS.ProcessEnv
}

export interface HookHandoffResult {
  event: string
  sessionId: string | null
  file: string | null
  closeSession: boolean
  spawned: boolean
  command: string
  args: string[]
}

export function resolveHookTranscript(
  payload: Record<string, unknown>,
  sessionsDir?: string,
): { event: string; sessionId: string | null; file: string | null; closeSession: boolean } {
  const event = pickPayloadString(payload, 'hook_event_name', 'hookEventName') ?? 'unknown'
  const sessionId = pickPayloadString(payload, 'session_id', 'sessionId')
  let transcript = pickPayloadString(payload, 'transcript_path', 'transcriptPath') ?? null
  if (!transcript && sessionId) {
    transcript = newestRolloutForSession(sessionId, sessionsDir ?? codexSessionsDir())
    if (transcript) log(`hook ${event}: transcript_path missing, fallback ${transcript}`)
  }
  return {
    event,
    sessionId,
    file: transcript ? path.resolve(transcript) : null,
    closeSession: /^sessionend$/i.test(event),
  }
}

function captureEntryPath(
  argv = process.argv,
  execPath = process.execPath,
): { command: string; prefix: string[] } {
  const self = argv[1] ?? fileURLToPath(import.meta.url)
  if (self.endsWith('.ts')) {
    const builtJs = path.join(
      path.dirname(self),
      '..',
      'dist',
      path.basename(self).replace(/\.ts$/, '.js'),
    )
    if (fs.existsSync(builtJs)) {
      return { command: execPath, prefix: [builtJs] }
    }
    return { command: 'npx', prefix: ['--yes', 'tsx', self] }
  }
  return { command: execPath, prefix: [self] }
}

export function hookChildArgs(
  file: string,
  opts: {
    delayMs?: number
    closeSession?: boolean
    event?: string
    sessionId?: string | null
  } = {},
): string[] {
  const args = ['--ingest-file', file, '--delay-ms', String(opts.delayMs ?? HOOK_HANDOFF_DELAY_MS)]
  if (opts.closeSession) args.push('--close-session')
  if (opts.event) {
    args.push('--hook-event', opts.event)
  }
  if (opts.sessionId) {
    args.push('--session-id', opts.sessionId)
  }
  return args
}

function defaultSpawn(command: string, args: string[], options: SpawnOpts): SpawnHandle {
  const child = spawn(command, args, {
    detached: options.detached ?? true,
    stdio: 'ignore',
    env: options.env,
  })
  // never let an asynchronous spawn error surface as an unhandled 'error' event
  child.on('error', (err: unknown) => {
    log(`handoff spawn error: ${err instanceof Error ? err.message : String(err)}`)
  })
  return child
}

/**
 * `--hook` parent: validate stdin JSON, spawn a detached child that does the
 * ingest, log one line, return. The parent never waits on the child.
 */
export function handOffHook(
  payload: Record<string, unknown>,
  opts: HookHandoffOpts = {},
): HookHandoffResult {
  const resolved = resolveHookTranscript(payload, opts.sessionsDir)
  const empty: HookHandoffResult = {
    event: resolved.event,
    sessionId: resolved.sessionId,
    file: resolved.file,
    closeSession: resolved.closeSession,
    spawned: false,
    command: '',
    args: [],
  }
  if (!resolved.file) {
    log(
      `hook ${resolved.event}: no transcript_path and no rollout for session ${resolved.sessionId ?? '?'}`,
    )
    return empty
  }

  const entry = captureEntryPath(opts.argv, opts.execPath)
  const childArgs = [
    ...entry.prefix,
    ...hookChildArgs(resolved.file, {
      delayMs: opts.delayMs ?? HOOK_HANDOFF_DELAY_MS,
      closeSession: resolved.closeSession,
      event: resolved.event,
      sessionId: resolved.sessionId,
    }),
  ]
  const spawnFn = opts.spawn ?? defaultSpawn
  try {
    const child = spawnFn(entry.command, childArgs, {
      detached: true,
      stdio: 'ignore',
      env: opts.env ?? process.env,
    })
    child.unref()
    const delay = opts.delayMs ?? HOOK_HANDOFF_DELAY_MS
    const closeNote = resolved.closeSession ? ' close-session' : ''
    log(
      `hook ${resolved.event}: handed off file=${resolved.file} delayMs=${String(delay)}${closeNote}`,
    )
    return {
      event: resolved.event,
      sessionId: resolved.sessionId,
      file: resolved.file,
      closeSession: resolved.closeSession,
      spawned: true,
      command: entry.command,
      args: childArgs,
    }
  } catch (err) {
    log(`hook ${resolved.event} spawn failed: ${err instanceof Error ? err.message : String(err)}`)
    return { ...empty, file: resolved.file, command: entry.command, args: childArgs }
  }
}

export async function readStdinObject(): Promise<Record<string, unknown>> {
  if (process.stdin.isTTY) return {}
  const input = await new Promise<string>((resolve) => {
    let data = ''
    process.stdin.setEncoding('utf8')
    const onData = (chunk: string): void => {
      data += chunk
    }
    process.stdin.on('data', onData)
    process.stdin.on('end', () => resolve(data))
    process.stdin.on('error', () => resolve(data))
  })
  const trimmed = input.trim()
  if (!trimmed) return {}
  const parsed: unknown = JSON.parse(trimmed)
  return isRecord(parsed) ? parsed : {}
}

function flagValue(args: string[], name: string): string | undefined {
  const idx = args.indexOf(name)
  if (idx >= 0 && idx + 1 < args.length) return args[idx + 1]
  return undefined
}

function flagPresent(args: string[], name: string): boolean {
  return args.includes(name)
}

export function parseDelayMs(args: string[]): number {
  const raw = flagValue(args, '--delay-ms')
  if (raw === undefined) return 0
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : 0
}

async function runHook(): Promise<void> {
  try {
    const payload = await readStdinObject()
    handOffHook(payload)
  } catch (err) {
    log(`hook failed: ${err instanceof Error ? err.message : String(err)}`)
  }
}

export function statusPayload(
  state: CaptureState,
  file = captureStatePath(),
): Record<string, unknown> {
  const closed = state.closedSessions ? Object.keys(state.closedSessions).length : 0
  return {
    lastIngestAt: state.lastIngestAt ?? null,
    lastIngestSource: state.lastIngestSource ?? null,
    hookInstalledAt: state.hookInstalledAt ?? null,
    files: Object.keys(state.cursors).length,
    inserted: state.inserted ?? 0,
    skipped: state.skipped ?? 0,
    closed,
    stateFile: file,
  }
}

export function formatStatus(state: CaptureState, file = captureStatePath()): string {
  if (!state.lastIngestAt && Object.keys(state.cursors).length === 0) {
    return `codex-memory-capture --status: no ingest yet (${file})`
  }
  const payload = statusPayload(state, file)
  return (
    `codex-memory-capture --status: lastIngestAt=${state.lastIngestAt ?? 'n/a'} ` +
    `lastIngestSource=${state.lastIngestSource ?? 'n/a'} ` +
    `files=${String(payload.files)} ` +
    `inserted=${String(payload.inserted)} skipped=${String(payload.skipped)} ` +
    `closed=${String(payload.closed)}`
  )
}

export function runStatus(stateFile = captureStatePath()): void {
  const state = loadCaptureState(stateFile)
  console.log(JSON.stringify(statusPayload(state, stateFile)))
  console.log(formatStatus(state, stateFile))
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

  codex-rivet-memory-capture --hook
  codex-rivet-memory-capture --ingest-file <rollout.jsonl> [--delay-ms N] [--close-session]
  codex-rivet-memory-capture --backfill [--days N] [--sessions-dir DIR]
  codex-rivet-memory-capture --status

  --hook             read one Codex hook JSON object from stdin and hand off
  --ingest-file FILE ingest one rollout file then exit (used by --hook child)
  --close-session    with --ingest-file, mark the session closed in state
  --backfill         one-shot walk of existing rollout files
  --days N           with --backfill, only rollouts from the last N days
  --delay-ms N       sleep N ms before reading state (coalesce quick fires)
  --status           one JSON line + one human line from the state file
  --sessions-dir DIR override the sessions root
`

async function main(): Promise<void> {
  loadEnvFile()
  const args = process.argv.slice(2)
  if (args.length === 0 || args[0] === '-h' || args[0] === '--help') {
    console.log(USAGE)
    return
  }

  const sessionsDir = flagValue(args, '--sessions-dir')
  const mode = args[0]

  if (mode === '--hook') {
    await runHook()
    return
  }
  if (mode === '--status') {
    runStatus()
    return
  }
  if (mode === '--stamp-installed') {
    await runStampInstalled()
    return
  }
  if (mode === '--backfill' || mode === '--once') {
    const daysRaw = flagValue(args, '--days')
    let days: number | undefined
    if (daysRaw !== undefined) {
      const n = Number(daysRaw)
      if (!Number.isFinite(n) || n < 0) {
        console.error('Usage: codex-memory-capture --backfill [--days N]')
        return
      }
      days = n
    }
    await runBackfill(sessionsDir, days, captureStatePath(), parseDelayMs(args))
    return
  }
  if (mode === '--ingest-file' || mode === '--ingest') {
    const file = args[1]
    if (!file || file.startsWith('--')) {
      console.error('Usage: codex-memory-capture --ingest-file <rollout.jsonl>')
      return
    }
    const hookEvent = flagValue(args, '--hook-event')
    const sessionId = flagValue(args, '--session-id')
    const triggerEvent = hookEvent ? `hook:${hookEvent}` : 'ingest-file'
    await withPool(async (client) => {
      const result = await ingestTranscriptFile(file, {
        client,
        delayMs: parseDelayMs(args),
        closeSession: flagPresent(args, '--close-session'),
        sessionId: sessionId ?? null,
        triggerEvent,
      })
      console.log(
        `${file}: event=${result.event} inserted=${result.inserted} skipped=${result.skipped}${result.finalized ? ' finalized' : ''}`,
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
  const isHook = process.argv.slice(2)[0] === '--hook'
  main().catch((err: unknown) => {
    log(`fatal: ${err instanceof Error ? err.stack : String(err)}`)
    if (!isHook) process.exitCode = 1
  })
}
