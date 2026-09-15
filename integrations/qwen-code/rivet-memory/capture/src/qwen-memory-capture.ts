#!/usr/bin/env node
/**
 * Qwen Code Memory Capture — ingest Qwen Code session jsonl into the shared
 * RivetOS memory DB as `rivet-qwen` conversations.
 *
 * Trigger: Qwen lifecycle hooks (`UserPromptSubmit`, `Stop`, `SessionEnd`)
 * invoke this worker with `--hook` and one JSON object on stdin. The payload's
 * `transcript_path` is the absolute session jsonl:
 *
 *   ~/.qwen/projects/<sanitized-cwd>/chats/<uuid>.jsonl
 *
 * `--hook` validates stdin, then hands off to a detached child
 * (`--ingest-file <transcript> --delay-ms 400`, plus `--close-session` on
 * SessionEnd) so the parent exits in milliseconds. The child tails the file
 * from a persisted per-file cursor under the Postgres session-level advisory
 * lock, folds gemini-style `parts` records, and upserts ros_conversations /
 * ros_messages. `--backfill` is the one-shot walk of existing chats.
 *
 * Identity: agent='rivet-qwen' (env `RIVETOS_CAPTURE_AGENT`),
 * channel='qwen-code', session_key='qwen-code:<uuid>'.
 * Dedup: `qwen-code:<sessionId>:<line uuid>`.
 *
 * Truncation: 16K cap only when the row carries an absolute jsonl path +
 * line offset so memory_get_full can re-read from disk.
 *
 * `--hook` never throws (log + exit 0) so the CLI is never blocked. Log:
 * ~/.rivetos/logs/qwen-code-capture.log. State:
 * ~/.rivetos/qwen-code-capture-state.json.
 */

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import type { PoolClient } from 'pg'

const { Pool } = pg

export const CAPTURE_AGENT = 'rivet-qwen'
export const CAPTURE_CHANNEL = 'qwen-code'
export const CAPTURE_SOURCE = 'qwen-session'

const LOG_FILE = path.join(os.homedir(), '.rivetos', 'logs', 'qwen-code-capture.log')
export const MAX_CONTENT = 16000
const STATEMENT_TIMEOUT_MS = 15000
const DEFAULT_STATE_FILE = path.join(os.homedir(), '.rivetos', 'qwen-code-capture-state.json')
export const HOOK_HANDOFF_DELAY_MS = 400

const NATIVE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function resolveCaptureAgent(): string {
  const env = process.env.RIVETOS_CAPTURE_AGENT?.trim()
  return env && env.length > 0 ? env : CAPTURE_AGENT
}

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
  model: string | null
  qwenVersion: string | null
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

export function log(msg: string): void {
  const line = `${new Date().toISOString()} ${msg}\n`
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true })
    fs.appendFileSync(LOG_FILE, line)
  } catch {
    // ignore
  }
}

export function qwenHome(): string {
  const env = process.env.QWEN_HOME?.trim()
  return env && env.length > 0 ? env : path.join(os.homedir(), '.qwen')
}

export function qwenProjectsDir(home = qwenHome()): string {
  return path.join(home, 'projects')
}

export function deriveSessionKey(sessionId: string): string {
  return `qwen-code:${sessionId}`
}

export function isNativeSessionId(id: string): boolean {
  return NATIVE_ID_RE.test(id) && !id.includes('/') && !id.includes('..')
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

export function eventIdFromLine(sessionId: string, uuid: string | null, lineIndex: number): string {
  if (uuid) return `qwen-code:${sessionId}:${uuid}`
  return `qwen-code:${sessionId}:line:${String(lineIndex)}`
}

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
  return null
}

function partsOf(message: Record<string, unknown> | undefined): Record<string, unknown>[] {
  if (!message || !Array.isArray(message.parts)) return []
  return message.parts.filter((p): p is Record<string, unknown> => isRecord(p))
}

function joinTextParts(parts: Record<string, unknown>[], thought?: boolean): string {
  return parts
    .map((p) => {
      if (typeof p.text !== 'string' || !p.text) return ''
      if (thought === true) return p.thought === true ? p.text : ''
      if (thought === false) return p.thought === true ? '' : p.text
      return p.text
    })
    .filter(Boolean)
    .join('')
}

/**
 * Gemini-style Qwen Code session jsonl. One row per record.
 * `type:user` + `provenance:'real_user'` → user; assistant parts (thought /
 * text / functionCall); `type:tool_result` → tool result; `type:system` skipped
 * (ui_telemetry token counts may stamp usage on the following assistant).
 */
export function parseTranscriptText(
  text: string,
  sessionIdHint: string | null = null,
  transcriptPath: string | null = null,
  triggerEvent = 'ingest',
): ParseResult {
  const lines = text.split('\n')
  const skipped: Record<string, number> = {}
  let malformed = 0
  let sessionId = sessionIdHint
  let cwd: string | null = null
  let firstUser: string | null = null
  let model: string | null = null
  let qwenVersion: string | null = null
  let pendingUsage: Record<string, unknown> | null = null
  const messages: PendingMessage[] = []

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
    const eventTs = isoFromObj(obj)
    const lineUuid = asString(obj.uuid)
    const lineSession = asString(obj.sessionId)
    if (lineSession && isNativeSessionId(lineSession)) sessionId = lineSession
    const cwdVal = asString(obj.cwd)
    if (cwdVal) cwd = cwdVal
    const ver = asString(obj.version)
    if (ver) qwenVersion = ver
    const sid = sessionId ?? sessionIdHint ?? 'unknown'
    const eventId = eventIdFromLine(sid, lineUuid, i)
    const extraBase: Record<string, unknown> = {
      source: CAPTURE_SOURCE,
      sourceEvent: triggerEvent,
    }

    if (type === 'system') {
      const payload = isRecord(obj.systemPayload) ? obj.systemPayload : undefined
      const uiEvent = payload && isRecord(payload.uiEvent) ? payload.uiEvent : undefined
      const name = uiEvent ? asString(uiEvent['event.name']) : null
      if (name === 'qwen-code.api_response' && uiEvent) {
        pendingUsage = {
          input_tokens: uiEvent.input_token_count,
          output_tokens: uiEvent.output_token_count,
          cache_read_input_tokens: uiEvent.cached_content_token_count,
          thoughts_tokens: uiEvent.thoughts_token_count,
          total_tokens: uiEvent.total_token_count,
          model: uiEvent.model,
        }
        const m = asString(uiEvent.model)
        if (m) model = m
      }
      bump(skipped, 'system')
      continue
    }

    if (type === 'user') {
      if (obj.provenance !== 'real_user') {
        bump(skipped, 'user:not-real')
        continue
      }
      const message = isRecord(obj.message) ? obj.message : undefined
      const body = joinTextParts(partsOf(message)).trim()
      if (!body) {
        bump(skipped, 'user:empty')
        continue
      }
      if (firstUser === null) firstUser = body
      push({
        role: 'user',
        content: body,
        eventId,
        eventTs,
        lineIndex: i,
        extra: extraBase,
      })
      continue
    }

    if (type === 'assistant') {
      const message = isRecord(obj.message) ? obj.message : undefined
      const parts = partsOf(message)
      const thinking = joinTextParts(parts, true)
      const contentText = joinTextParts(parts, false).trim()
      const calls = parts
        .map((p) => (isRecord(p.functionCall) ? p.functionCall : null))
        .filter((c): c is Record<string, unknown> => c != null)
      const lineModel = asString(obj.model)
      if (lineModel) model = lineModel
      const usageMeta = isRecord(obj.usageMetadata) ? obj.usageMetadata : pendingUsage
      pendingUsage = null
      extraBase.cwd = cwd
      extraBase.model = model
      extraBase.qwenVersion = qwenVersion
      if (usageMeta) extraBase.usage = usageMeta

      const firstCall = calls[0]
      const callName = firstCall ? asString(firstCall.name) || 'unknown' : null
      const callArgs = firstCall ? (firstCall.args ?? firstCall.arguments) : undefined

      if (!contentText && thinking && !firstCall) {
        push({
          role: 'assistant',
          content: `[thinking] ${thinking}`,
          eventId,
          eventTs,
          lineIndex: i,
          extra: { ...extraBase, partType: 'think' },
        })
        continue
      }
      if (!contentText && firstCall && callName) {
        push({
          role: 'tool',
          content: `[tool] ${callName}`,
          toolName: callName,
          toolArgs: callArgs,
          eventId,
          eventTs,
          lineIndex: i,
          extra: { ...extraBase, callId: asString(firstCall.id) },
        })
        continue
      }
      if (!contentText && !thinking && !firstCall) {
        bump(skipped, 'assistant:empty')
        continue
      }
      push({
        role: 'assistant',
        content: contentText || (thinking ? `[thinking] ${thinking}` : ''),
        toolName: callName,
        toolArgs: callArgs,
        eventId,
        eventTs,
        lineIndex: i,
        extra: {
          ...extraBase,
          ...(thinking ? { reasoning: thinking } : {}),
          callId: firstCall ? asString(firstCall.id) : undefined,
        },
      })
      continue
    }

    if (type === 'tool_result') {
      const message = isRecord(obj.message) ? obj.message : undefined
      const parts = partsOf(message)
      let name = 'unknown'
      let output: string | null = null
      let callId: string | null = null
      for (const p of parts) {
        const fr = isRecord(p.functionResponse) ? p.functionResponse : null
        if (!fr) continue
        name = asString(fr.name) || name
        callId = asString(fr.id)
        const resp = isRecord(fr.response) ? fr.response : null
        const out = resp ? resp.output : null
        output = typeof out === 'string' ? out : out != null ? safeJson(out) : null
      }
      push({
        role: 'tool',
        content: `[tool-result] ${name}`,
        toolName: name,
        toolResult: output,
        eventId,
        eventTs,
        lineIndex: i,
        extra: { ...extraBase, callId, cwd, model, qwenVersion },
      })
      continue
    }

    bump(skipped, `type:${String(type)}`)
  }

  if (!sessionId) {
    if (transcriptPath) {
      const base = path.basename(transcriptPath, '.jsonl')
      sessionId = isNativeSessionId(base) ? base : 'unknown'
    } else {
      sessionId = 'unknown'
    }
  }

  const title = firstUser ? firstUser.replace(/\s+/g, ' ').slice(0, 120) : 'Qwen Code session'

  return { sessionId, cwd, title, model, qwenVersion, messages, malformed, skipped }
}

export function parseTranscriptFile(
  file: string,
  sessionIdHint?: string | null,
  triggerEvent = 'ingest',
): ParseResult {
  const text = fs.readFileSync(file, 'utf8')
  const fromName = path.basename(file, '.jsonl')
  const hint = sessionIdHint ?? (isNativeSessionId(fromName) ? fromName : null)
  return parseTranscriptText(text, hint, path.resolve(file), triggerEvent)
}

export function discoverTranscriptFiles(root: string): string[] {
  const out: string[] = []
  let projects: string[]
  try {
    projects = fs.readdirSync(root)
  } catch {
    return out
  }
  for (const project of projects) {
    const chats = path.join(root, project, 'chats')
    let files: string[]
    try {
      files = fs.readdirSync(chats)
    } catch {
      continue
    }
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue
      if (f.endsWith('.runtime.json') || f.includes('.runtime.')) continue
      const p = path.join(chats, f)
      try {
        if (fs.statSync(p).isFile()) out.push(p)
      } catch {
        // vanished
      }
    }
  }
  return out
}

export function newestTranscriptForSession(sessionId: string, root?: string): string | null {
  if (!sessionId) return null
  const files = discoverTranscriptFiles(root ?? qwenProjectsDir()).filter(
    (f) => path.basename(f, '.jsonl') === sessionId,
  )
  if (files.length === 0) return null
  const mtimeOf = (f: string): number => {
    try {
      return fs.statSync(f).mtimeMs
    } catch {
      return 0
    }
  }
  files.sort((a, b) => mtimeOf(b) - mtimeOf(a))
  return files[0] ?? null
}

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
  const agent = resolveCaptureAgent()
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
  transcriptPath: string | null,
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

  const agent = resolveCaptureAgent()
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
    model?: string | null
    qwenVersion?: string | null
    transcriptPath?: string | null
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
      title: (opts.title || 'Qwen Code session').slice(0, 120),
      settings: {
        source: CAPTURE_SOURCE,
        sessionId,
        cwd: opts.cwd ?? null,
        model: opts.model ?? null,
        qwenVersion: opts.qwenVersion ?? null,
        triggerEvent: opts.triggerEvent ?? 'ingest',
        session_jsonl_path: opts.transcriptPath ?? null,
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
  const env = process.env.RIVETOS_QWEN_CODE_STATE?.trim()
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

export const RETRY_HOP_DELAY_MS = 15_000
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

export const STATE_LOCK_WAIT_MS = 120_000

export function stateLockKey(stateFile = captureStatePath()): string {
  return `rivetos-capture-state:${os.hostname()}:${path.resolve(stateFile)}`
}

function isLockTimeout(err: unknown): boolean {
  const code = (err as { code?: unknown }).code
  const msg = err instanceof Error ? err.message : String(err)
  return code === '55P03' || /lock timeout|lock_not_available/i.test(msg)
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
    try {
      await client.query(`SET statement_timeout = ${String(STATEMENT_TIMEOUT_MS)}`)
    } catch {
      // ignore
    }
    if (isLockTimeout(err)) {
      log(`state lock busy (${key}); skipping this run — the next hook retries`)
    } else {
      log(`state lock unavailable (${err instanceof Error ? err.message : String(err)}); skipping`)
    }
    return null
  }
  try {
    return await fn()
  } finally {
    try {
      await client.query('SELECT pg_advisory_unlock(hashtext($1))', [key])
    } catch {
      // connection gone → the server already released it
    }
    try {
      await client.query('RESET lock_timeout')
    } catch {
      // ignore
    }
  }
}

export async function runStampInstalled(stateFile = captureStatePath()): Promise<void> {
  try {
    const r = await withPool((client) =>
      withStateLock(
        client,
        () => {
          const st = loadCaptureState(stateFile)
          const now = new Date().toISOString()
          saveCaptureState({ ...st, hookInstalledAt: st.hookInstalledAt ?? now }, stateFile)
          console.log(`hookInstalledAt=${st.hookInstalledAt ?? now} ${stateFile}`)
          return Promise.resolve(true)
        },
        stateFile,
      ),
    )
    if (r === null) {
      log('stamp-installed deferred: state lock busy — the next ingest records hookInstalledAt')
    }
  } catch (err) {
    log(`stamp-installed deferred (${err instanceof Error ? err.message : String(err)})`)
  }
}

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

export interface WatcherState {
  cursors: Map<string, FileCursor>
  known: Set<string>
  seen: Map<string, Set<string>>
}

export function createWatcherState(): WatcherState {
  return { cursors: new Map(), known: new Set(), seen: new Map() }
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

export function primeCursor(file: string, fromStart: boolean): FileCursor {
  if (fromStart) return { offset: 0, pending: '' }
  try {
    const st = fs.statSync(file)
    return { offset: st.size, pending: '' }
  } catch {
    return { offset: 0, pending: '' }
  }
}

function fileWithinDays(file: string, days: number): boolean {
  try {
    return Date.now() - fs.statSync(file).mtimeMs <= days * 86400000
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
  finalize = false,
): Promise<{ inserted: number; skipped: number } | null> {
  const newLines = consumeNewLines(file, cursor)
  if (newLines.length === 0 && !finalize) return null
  const parsed = parseTranscriptFile(file, null, triggerEvent)
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
    model: parsed.model,
    qwenVersion: parsed.qwenVersion,
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
  let files = discoverTranscriptFiles(root)
  if (typeof opts.days === 'number' && opts.days >= 0) {
    files = files.filter((f) => fileWithinDays(f, opts.days as number))
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
  projectsDir?: string,
  days?: number,
  stateFile = captureStatePath(),
  delayMs = 0,
): Promise<void> {
  if (delayMs > 0) await sleep(delayMs)
  const root = projectsDir ?? qwenProjectsDir()
  const source = typeof days === 'number' ? `backfill:${String(days)}d` : 'backfill'
  const done = await withPool((client) =>
    withStateLock(
      client,
      async () => {
        const persisted = loadCaptureState(stateFile)
        const state = stateToWatcher(persisted)
        const summary = await scanOnce(root, client, state, true, { days, triggerEvent: source })
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
          `qwen-memory-capture --backfill: files=${summary.files} inserted=${summary.inserted} skipped=${summary.skipped}`,
        )
        return true
      },
      stateFile,
    ),
  )
  if (done === null) log('backfill skipped: state lock busy')
}

export interface HookHandleOpts {
  client: Queryable
  stateFile?: string
  projectsDir?: string
  delayMs?: number
  lockWaitMs?: number
}

export interface IngestFileOpts {
  alreadyLocked?: boolean
  client: Queryable
  stateFile?: string
  delayMs?: number
  lockWaitMs?: number
  closeSession?: boolean
  sessionId?: string | null
  triggerEvent?: string
  reason?: string
}

export interface HookHandleResult {
  lockBusy?: boolean
  failed?: boolean
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
    sessionId:
      opts.sessionId ??
      (NATIVE_ID_RE.test(path.basename(abs, '.jsonl')) ? path.basename(abs, '.jsonl') : null),
  }

  try {
    if (opts.delayMs && opts.delayMs > 0) await sleep(opts.delayMs)
    const finalize = Boolean(opts.closeSession)
    const body = async (): Promise<HookHandleResult> => {
      const cursor = cursorFromState(loadCaptureState(stateFile), abs)
      const before = { offset: cursor.offset, pending: cursor.pending }
      const seenByKey = new Map<string, Set<string>>()

      let inserted = 0
      let skipped = 0
      try {
        const r = await ingestNewLines(abs, cursor, opts.client, seenByKey, triggerEvent, finalize)
        if (r) {
          inserted = r.inserted
          skipped = r.skipped
        }
      } catch (err) {
        Object.assign(cursor, before)
        log(`ingest ${triggerEvent} failed: ${err instanceof Error ? err.message : String(err)}`)
        return { ...empty, file: abs, failed: true }
      }

      const latest = loadCaptureState(stateFile)
      const now = new Date().toISOString()
      const sid =
        opts.sessionId ??
        (NATIVE_ID_RE.test(path.basename(abs, '.jsonl')) ? path.basename(abs, '.jsonl') : null)
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
    }
    if (opts.alreadyLocked) return await body()
    const locked = await withStateLock(opts.client, body, stateFile, opts.lockWaitMs)
    return locked ?? { ...empty, lockBusy: true }
  } catch (err) {
    log(`ingest ${triggerEvent} failed: ${err instanceof Error ? err.message : String(err)}`)
    return empty
  }
}

function pickPayloadString(payload: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const v = payload[key]
    if (typeof v === 'string' && v.trim().length > 0) return v
  }
  return null
}

export async function handleHookPayload(
  payload: Record<string, unknown>,
  opts: HookHandleOpts,
): Promise<HookHandleResult> {
  const event = pickPayloadString(payload, 'hook_event_name', 'hookEventName') ?? 'unknown'
  const source = `hook:${event}`
  const finalize = /^sessionend$/i.test(event)
  const projectsDir = opts.projectsDir ?? qwenProjectsDir()
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
      transcript = newestTranscriptForSession(sessionId, projectsDir)
      if (transcript) log(`hook ${event}: transcript_path missing, fallback ${transcript}`)
    }
    if (!transcript) {
      log(`hook ${event}: no transcript_path and no chat for session ${sessionId ?? '?'}`)
      return empty
    }

    return await ingestTranscriptFile(transcript, {
      client: opts.client,
      stateFile: opts.stateFile,
      delayMs: opts.delayMs,
      lockWaitMs: opts.lockWaitMs,
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
  projectsDir?: string
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
  projectsDir?: string,
): { event: string; sessionId: string | null; file: string | null; closeSession: boolean } {
  const event = pickPayloadString(payload, 'hook_event_name', 'hookEventName') ?? 'unknown'
  const sessionId = pickPayloadString(payload, 'session_id', 'sessionId')
  let transcript = pickPayloadString(payload, 'transcript_path', 'transcriptPath') ?? null
  if (!transcript && sessionId) {
    transcript = newestTranscriptForSession(sessionId, projectsDir ?? qwenProjectsDir())
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
  child.on('error', (err: unknown) => {
    log(`handoff spawn error: ${err instanceof Error ? err.message : String(err)}`)
  })
  return child
}

export function handOffHook(
  payload: Record<string, unknown>,
  opts: HookHandoffOpts = {},
): HookHandoffResult {
  const resolved = resolveHookTranscript(payload, opts.projectsDir)
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
      `hook ${resolved.event}: no transcript_path and no chat for session ${resolved.sessionId ?? '?'}`,
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
    return `qwen-memory-capture --status: no ingest yet (${file})`
  }
  const payload = statusPayload(state, file)
  return (
    `qwen-memory-capture --status: lastIngestAt=${state.lastIngestAt ?? 'n/a'} ` +
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

export const USAGE = `qwen-memory-capture — ingest Qwen Code session jsonl into RivetOS memory

  qwen-code-rivet-memory-capture --hook
  qwen-code-rivet-memory-capture --ingest-file <session.jsonl> [--delay-ms N] [--close-session]
  qwen-code-rivet-memory-capture --backfill [--days N] [--projects-dir DIR]
  qwen-code-rivet-memory-capture --status

  --hook             read one Qwen hook JSON object from stdin and hand off
  --ingest-file FILE ingest one transcript then exit (used by --hook child)
  --close-session    with --ingest-file, mark the session closed in state
  --backfill         one-shot walk of ~/.qwen/projects/<enc-cwd>/chats/*.jsonl
  --days N           with --backfill, only files from the last N days
  --projects-dir DIR override the projects root
  --delay-ms N       sleep N ms before reading state (coalesce quick fires)
  --status           one JSON line + one human line from the state file
`

async function main(): Promise<void> {
  loadEnvFile()
  const args = process.argv.slice(2)
  if (args.length === 0 || args[0] === '-h' || args[0] === '--help') {
    console.log(USAGE)
    return
  }

  const projectsDir = flagValue(args, '--projects-dir')
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
        console.error('Usage: qwen-memory-capture --backfill [--days N]')
        return
      }
      days = n
    }
    await runBackfill(projectsDir, days, captureStatePath(), parseDelayMs(args))
    return
  }
  if (mode === '--ingest-file' || mode === '--ingest') {
    const file = args[1]
    if (!file || file.startsWith('--')) {
      console.error('Usage: qwen-memory-capture --ingest-file <session.jsonl>')
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
      if (result.lockBusy && flagPresent(args, '--retry-once')) {
        log(`${file} skipped twice on a busy state lock; run --backfill to catch up`)
      } else if (result.lockBusy && !flagPresent(args, '--retry-once')) {
        const entry = captureEntryPath()
        const hop = [...entry.prefix, ...args.filter((a) => a !== '--delay-ms' && !/^\d+$/.test(a))]
        hop.push('--retry-once', '--delay-ms', String(RETRY_HOP_DELAY_MS))
        defaultSpawn(entry.command, hop, { env: process.env })
        log(`lock busy for ${file}; re-queued once with --delay-ms ${String(RETRY_HOP_DELAY_MS)}`)
      }
    })
    return
  }

  console.log(USAGE)
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  (path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) ||
    /qwen-memory-capture\.(ts|js)$/.test(process.argv[1]))

if (invokedDirectly) {
  const isHook = process.argv.slice(2)[0] === '--hook'
  main().catch((err: unknown) => {
    log(`fatal: ${err instanceof Error ? err.stack : String(err)}`)
    if (!isHook) process.exitCode = 1
  })
}
