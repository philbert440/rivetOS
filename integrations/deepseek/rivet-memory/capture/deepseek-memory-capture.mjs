#!/usr/bin/env node
/**
 * DeepSeek Harness (dsh) memory capture.
 *
 * dsh has no Claude/kimi-style lifecycle hooks. Capture is:
 *   1. Live: a Cordis plugin on ctx.on('session/event') spools one event
 *      and detaches this worker (--worker).
 *   2. Backstop: --backfill of $DSH_HOME/sessions/<workspace>/session-<id>/session.jsonl.zstd
 *
 * Identity: agent=rivet-deepseek, channel=dsh.
 * Dedup: dsh event uuid (message id / callId), falling back to session+seq
 * so legitimate repeated text is not collapsed (#525). Content-hash is NOT
 * the primary key.
 * Truncation: 16K cap only when the row carries an absolute session.jsonl.zstd
 * path + line offset so memory_get_full can re-read from disk. Never silent
 * truncate without a pointer (grokbot-bridge lesson).
 * Best-effort: never throw to the caller. Errors go to
 * ~/.rivetos/deepseek-memory-capture.log.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export const CAPTURE_AGENT = 'rivet-deepseek'
export const CAPTURE_CHANNEL = 'dsh'

const LOG_FILE = path.join(os.homedir(), '.rivetos', 'deepseek-memory-capture.log')
const SPOOL_DIR = path.join(os.tmpdir(), 'rivetos-deepseek-capture')
const MAX_CONTENT = 16000
const STATEMENT_TIMEOUT_MS = 15000
const NO_WORKER_ENV = 'DEEPSEEK_CAPTURE_NO_WORKER'
const SELF = fileURLToPath(import.meta.url)

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------
export function log(msg) {
  const line = `${new Date().toISOString()} ${msg}\n`
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true })
    fs.appendFileSync(LOG_FILE, line)
  } catch {
    // ignore
  }
}

// ---------------------------------------------------------------------------
// Content helpers
// ---------------------------------------------------------------------------
export function contentText(value) {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed.length > 0 ? trimmed : undefined
  }
  if (!Array.isArray(value)) return undefined
  const parts = []
  for (const part of value) {
    if (!part || typeof part !== 'object') continue
    const type = part.type
    if (type === 'text' && typeof part.text === 'string' && part.text.trim()) {
      parts.push(part.text.trim())
    } else if (
      (type === 'think' || type === 'reasoning' || type === 'thinking') &&
      typeof (part.text ?? part.think ?? part.reasoning) === 'string'
    ) {
      const body = String(part.text ?? part.think ?? part.reasoning).trim()
      if (body) parts.push(`[thinking] ${body}`)
    }
  }
  const joined = parts.join('\n').trim()
  return joined.length > 0 ? joined : undefined
}

export function contentHashEventId(parts) {
  const material = [
    parts.sessionId,
    parts.role,
    parts.content,
    parts.toolName ?? '',
    parts.toolResult ?? '',
    parts.sourceEvent ?? '',
  ].join('\0')
  return crypto.createHash('sha256').update(material, 'utf8').digest('hex')
}

/**
 * Dedup key for one dsh SessionEvent.
 *
 * Prefer the harness uuid (user/assistant message id, or tool callId) so two
 * legitimate "ok" turns do not collapse. Fall back to session+seq (stable
 * ordinal). Content-hash is last-resort only and is namespaced so it cannot
 * collide with a uuid.
 */
export function eventIdFromEvent(sessionId, event) {
  const data = isRecord(event?.data) ? event.data : {}
  const message = isRecord(data.message) ? data.message : {}
  const uuid =
    asString(event?.id) ||
    pickString(data, 'id', 'callId', 'call_id') ||
    pickString(message, 'id', 'callId', 'call_id')
  if (uuid) return `dsh:${sessionId}:${uuid}`
  const type = asString(event?.type) || 'event'
  const seq = typeof event?.seq === 'number' ? event.seq : null
  if (seq != null) return `dsh:${sessionId}:seq:${seq}`
  const fallback = contentHashEventId({
    sessionId,
    role: type,
    content: safeJson(data).slice(0, 200),
    sourceEvent: type,
  }).slice(0, 16)
  return `dsh:${sessionId}:fallback:${type}:${fallback}`
}

export function deriveSessionKey(sessionId) {
  return `dsh:${sessionId}`
}

export function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
}

export function resolveSessionJsonlPath(sessionId) {
  if (!sessionId) return null
  const root = path.join(dshHome(), 'sessions')
  const files = findSessionFiles(root)
  const needle = String(sessionId)
  for (const f of files) {
    if (f.includes(`/${needle}/`) || f.includes(`/${path.basename(needle)}/`)) return f
  }
  return null
}

export function findEventLineIndex(text, event) {
  if (!text || !isRecord(event)) return null
  const lines = text.split('\n')
  const wantType = asString(event.type)
  const wantSeq = typeof event.seq === 'number' ? event.seq : null
  const wantUuid =
    asString(event.id) ||
    (isRecord(event.data) ? pickString(event.data, 'id', 'callId', 'call_id') : null)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line) continue
    let obj
    try {
      obj = JSON.parse(line)
    } catch {
      continue
    }
    if (!isRecord(obj)) continue
    if (wantType && obj.type !== wantType) continue
    if (wantSeq != null && obj.seq === wantSeq) return i
    if (wantUuid) {
      const data = isRecord(obj.data) ? obj.data : {}
      const message = isRecord(data.message) ? data.message : {}
      const got =
        asString(obj.id) ||
        pickString(data, 'id', 'callId', 'call_id') ||
        pickString(message, 'id', 'callId', 'call_id')
      if (got === wantUuid) return i
    }
  }
  return null
}

/**
 * Cap stored text only when a disk pointer exists so memory_get_full can
 * recover the tail. Without a pointer, keep the full string (never a silent
 * 16K chop that reports success).
 */
export function capForStorage(full, pointer) {
  if (typeof full !== 'string') return { stored: full, truncated: false }
  if (full.length <= MAX_CONTENT) return { stored: full, truncated: false }
  const hasPointer = Boolean(pointer?.sessionJsonlPath) && typeof pointer.lineIndex === 'number'
  if (!hasPointer) {
    return { stored: full, truncated: false, uncapped: true }
  }
  return { stored: full.slice(0, MAX_CONTENT) + '\n…[truncated]', truncated: true }
}

function isRecord(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function asString(v) {
  return typeof v === 'string' && v.length > 0 ? v : null
}

function safeJson(v) {
  try {
    return JSON.stringify(v)
  } catch {
    return String(v)
  }
}

function pickString(obj, ...keys) {
  if (!isRecord(obj)) return undefined
  for (const k of keys) {
    const v = obj[k]
    if (typeof v === 'string' && v.length > 0) return v
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Session event → PendingMessage[]
// ---------------------------------------------------------------------------
/**
 * Extract zero or more memory rows from one dsh SessionEvent (or the
 * session-header first line of session.jsonl).
 *
 * Captured:
 *   - user/message with source.kind === 'user'  (skip plugin snapshots)
 *   - assistant/message assembled text + thinking
 *   - tool/call + tool/result
 *   - turn/end, compaction/start as system markers
 *
 * Skipped: assistant/chunk, text-chunks, request/*, inbox splices, etc.
 */
function pointerExtra(ctx, extra) {
  const out = { ...extra }
  if (ctx?.sessionJsonlPath) {
    out.session_jsonl_path = ctx.sessionJsonlPath
    out.sessionJsonlPath = ctx.sessionJsonlPath
  }
  if (typeof ctx?.lineIndex === 'number') {
    out.session_jsonl_line = ctx.lineIndex
    out.sessionJsonlLine = ctx.lineIndex
    out.event_offset = ctx.lineIndex
  }
  return out
}

function toolResultText(message, data) {
  const content = message?.content ?? message?.Content ?? data?.content ?? data?.Content
  if (Array.isArray(content)) {
    const parts = []
    for (const part of content) {
      if (!part || typeof part !== 'object') continue
      if (part.type === 'tool-result' || part.type === 'tool_result') {
        const inner = contentText(part.content) ?? (part.content != null ? String(part.content) : '')
        if (inner) parts.push(inner)
      } else if (part.type === 'text' && typeof part.text === 'string' && part.text.trim()) {
        parts.push(part.text.trim())
      }
    }
    if (parts.length > 0) return parts.join('\n')
  }
  return contentText(content) ?? (content != null ? safeJson(content) : null)
}

function toolNameFromResult(message, data) {
  const fromSource = isRecord(message?.source) ? pickString(message.source, 'name') : null
  return (
    pickString(message, 'name', 'Name') ||
    pickString(data, 'name', 'Name') ||
    fromSource ||
    'unknown'
  )
}

export function messagesFromSessionEvent(sessionId, event, ctx = {}) {
  if (!isRecord(event)) return []
  const type = asString(event.type) || pickString(event, 'type', 'Type')
  if (!type) return []

  const seq = typeof event.seq === 'number' ? event.seq : null
  const eventTs =
    typeof event.time === 'number' && Number.isFinite(event.time)
      ? new Date(event.time).toISOString()
      : new Date().toISOString()
  const data = isRecord(event.data) ? event.data : isRecord(event.Data) ? event.Data : {}
  const sourceEvent = seq != null ? `${type}:${seq}` : type
  const eventId = eventIdFromEvent(sessionId, event)
  const dshUuid =
    asString(event.id) ||
    pickString(data, 'id', 'callId', 'call_id') ||
    (isRecord(data.message) ? pickString(data.message, 'id', 'callId', 'call_id') : null)
  const out = []

  if (type === 'user/message') {
    const source = isRecord(data.source) ? data.source : isRecord(data.Source) ? data.Source : {}
    const sourceKind = source.kind || source.Kind
    if (sourceKind && sourceKind !== 'user') return []
    const content = contentText(data.content ?? data.Content)
    if (!content) return []
    out.push({
      role: 'user',
      content,
      eventId,
      eventTs,
      lineIndex: ctx.lineIndex,
      extra: pointerExtra(ctx, {
        sourceEvent: type,
        seq,
        source: 'dsh-session',
        messageId: pickString(data, 'id') ?? null,
        dsh_event_uuid: dshUuid,
      }),
    })
    return out
  }

  if (type === 'assistant/message') {
    const message = isRecord(data.message) ? data.message : isRecord(data.Message) ? data.Message : data
    const content = contentText(message.content ?? message.Content)
    if (!content) return []
    const src = isRecord(message.source) ? message.source : {}
    out.push({
      role: 'assistant',
      content,
      eventId,
      eventTs,
      lineIndex: ctx.lineIndex,
      extra: pointerExtra(ctx, {
        sourceEvent: type,
        seq,
        source: 'dsh-session',
        turn: data.turn ?? data.Turn ?? null,
        step: data.step ?? data.Step ?? null,
        model: src.model ?? null,
        provider: src.provider ?? null,
        usage: data.usage ?? data.Usage ?? null,
        dsh_event_uuid: dshUuid,
      }),
    })
    return out
  }

  if (type === 'tool/call') {
    const toolName = pickString(data, 'name', 'Name') ?? 'unknown'
    const rawArgs = data.arguments ?? data.Arguments ?? data.args ?? data.Args
    const args = typeof rawArgs === 'string' ? rawArgs : rawArgs != null ? safeJson(rawArgs) : null
    const content = `[tool] ${toolName}`
    out.push({
      role: 'tool',
      content,
      toolName,
      toolArgs: args,
      eventId,
      eventTs,
      lineIndex: ctx.lineIndex,
      extra: pointerExtra(ctx, {
        sourceEvent: type,
        seq,
        source: 'dsh-session',
        callId: pickString(data, 'callId', 'call_id') ?? null,
        turn: data.turn ?? null,
        step: data.step ?? null,
        dsh_event_uuid: dshUuid,
      }),
    })
    return out
  }

  if (type === 'tool/result') {
    const message = isRecord(data.message) ? data.message : isRecord(data.Message) ? data.Message : data
    const toolName = toolNameFromResult(message, data)
    const result = toolResultText(message, data)
    const nestedError =
      Array.isArray(message.content) &&
      message.content.some(p => p && typeof p === 'object' && p.isError)
    const isFailure = Boolean(data.error || data.Error || nestedError)
    const content = isFailure ? `[tool-failure] ${toolName}` : `[tool-result] ${toolName}`
    const callId =
      pickString(message, 'callId', 'call_id') ||
      (isRecord(message.source) ? pickString(message.source, 'callId', 'call_id') : null) ||
      pickString(data, 'callId', 'call_id') ||
      null
    out.push({
      role: 'tool',
      content,
      toolName,
      toolResult: result,
      eventId,
      eventTs,
      lineIndex: ctx.lineIndex,
      extra: pointerExtra(ctx, {
        sourceEvent: type,
        seq,
        source: 'dsh-session',
        callId,
        failure: isFailure,
        error: data.error ?? data.Error ?? null,
        turn: data.turn ?? null,
        step: data.step ?? null,
        dsh_event_uuid: dshUuid,
      }),
    })
    return out
  }

  if (type === 'turn/end' || type === 'compaction/start' || type === 'session/title') {
    const reason =
      (isRecord(data.reason) ? data.reason.kind : null) ||
      pickString(data, 'title', 'Title', 'preset', 'Preset') ||
      ''
    const content = `[dsh.${type}]${reason ? ' ' + reason : ''}`
    out.push({
      role: 'system',
      content,
      eventId,
      eventTs,
      lineIndex: ctx.lineIndex,
      extra: pointerExtra(ctx, { sourceEvent: type, seq, source: 'dsh-session', dsh_event_uuid: dshUuid }),
    })
    return out
  }

  return out
}

/** Pair tool/result rows with the tool/call name via callId (result events omit name). */
export function applyToolNamePairing(messages) {
  const names = new Map()
  for (const m of messages) {
    const callId = m.extra?.callId
    if (m.extra?.sourceEvent === 'tool/call' && callId && m.toolName && m.toolName !== 'unknown') {
      names.set(callId, m.toolName)
    }
  }
  for (const m of messages) {
    const callId = m.extra?.callId
    if (m.extra?.sourceEvent === 'tool/result' && callId && names.has(callId)) {
      const name = names.get(callId)
      if (m.toolName === 'unknown' || !m.toolName) {
        m.toolName = name
        if (typeof m.content === 'string') {
          m.content = m.content.replace(/\[tool-(result|failure)\] unknown/, `[tool-$1] ${name}`)
        }
      }
    }
  }
  return messages
}

// ---------------------------------------------------------------------------
// Transcript decode
// ---------------------------------------------------------------------------
async function decompressZstd(buf) {
  const candidates = [
    path.join(path.dirname(SELF), 'node_modules', 'fzstd', 'index.js'),
    path.join(path.dirname(SELF), '..', 'node_modules', 'fzstd', 'index.js'),
    'fzstd',
  ]
  let lastErr
  for (const spec of candidates) {
    try {
      const mod = await import(spec)
      const decompress = mod.decompress ?? mod.default?.decompress
      if (typeof decompress !== 'function') continue
      const out = decompress(buf instanceof Uint8Array ? buf : new Uint8Array(buf))
      return Buffer.from(out).toString('utf8')
    } catch (err) {
      lastErr = err
    }
  }
  throw new Error(`fzstd not available (${lastErr instanceof Error ? lastErr.message : lastErr})`)
}

export async function readTranscriptText(filePath) {
  const buf = fs.readFileSync(filePath)
  if (filePath.endsWith('.zstd') || filePath.endsWith('.zst')) {
    return decompressZstd(buf)
  }
  return buf.toString('utf8')
}

export function parseSessionJsonl(text, sessionIdHint, transcriptPath) {
  const lines = text.split('\n')
  let sessionId = sessionIdHint || null
  let cwd = null
  let title = null
  const events = []

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line) continue
    let obj
    try {
      obj = JSON.parse(line)
    } catch {
      continue
    }
    if (!isRecord(obj)) continue

    if (obj.type === 'session' && obj.id) {
      sessionId = asString(obj.id) ?? sessionId
      cwd = asString(obj.cwd) ?? cwd
      continue
    }
    if (obj.type === 'text-chunks') continue
    if (typeof obj.type === 'string') events.push({ event: obj, lineIndex: i })
  }

  if (!sessionId) sessionId = 'unknown-' + Date.now()
  const messages = []
  for (const { event: ev, lineIndex } of events) {
    if (ev.type === 'session/title' && isRecord(ev.data) && typeof ev.data.title === 'string') {
      title = ev.data.title
    }
    messages.push(
      ...messagesFromSessionEvent(sessionId, ev, {
        lineIndex,
        sessionJsonlPath: transcriptPath ?? null,
      }),
    )
  }
  applyToolNamePairing(messages)
  return { sessionId, cwd, title, messages, transcriptPath: transcriptPath ?? null }
}

export function findSessionFiles(root) {
  const out = []
  const walk = dir => {
    let ents
    try {
      ents = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const ent of ents) {
      const p = path.join(dir, ent.name)
      if (ent.isDirectory()) walk(p)
      else if (/^session\.jsonl(\.zstd|\.zst)?$/.test(ent.name)) out.push(p)
    }
  }
  walk(root)
  return out
}

// ---------------------------------------------------------------------------
// DB
// ---------------------------------------------------------------------------
function resolvePgUrl() {
  if (process.env.RIVETOS_PG_URL) return process.env.RIVETOS_PG_URL
  const envFile = process.env.RIVETOS_ENV_FILE ?? path.join(os.homedir(), '.rivetos', '.env')
  try {
    const raw = fs.readFileSync(envFile, 'utf8')
    for (const line of raw.split('\n')) {
      const m = /^\s*RIVETOS_PG_URL\s*=\s*(.+?)\s*$/.exec(line)
      if (m) return m[1].replace(/^["']|["']$/g, '')
    }
  } catch {
    // ignore
  }
  throw new Error('RIVETOS_PG_URL not set and not found in ~/.rivetos/.env')
}

async function loadPg() {
  const candidates = [
    path.join(path.dirname(SELF), 'node_modules', 'pg', 'lib', 'index.js'),
    'pg',
  ]
  let lastErr
  for (const spec of candidates) {
    try {
      const mod = await import(spec)
      return mod.default ?? mod
    } catch (err) {
      lastErr = err
    }
  }
  throw new Error(`pg module not available (${lastErr instanceof Error ? lastErr.message : lastErr})`)
}

async function findOrCreateConversation(client, sessionKey, init) {
  const existing = await client.query(
    `SELECT id FROM ros_conversations WHERE session_key = $1 AND agent = $2`,
    [sessionKey, CAPTURE_AGENT],
  )
  if (existing.rows.length > 0) {
    return { id: existing.rows[0].id, created: false }
  }
  const conv = await client.query(
    `INSERT INTO ros_conversations (session_key, agent, channel, title, settings, active, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, now(), now())
     RETURNING id`,
    [
      sessionKey,
      CAPTURE_AGENT,
      CAPTURE_CHANNEL,
      init.title.slice(0, 120),
      JSON.stringify(init.settings),
      init.active,
    ],
  )
  return { id: conv.rows[0].id, created: true }
}

async function eventIdExists(client, conversationId, eventId) {
  const r = await client.query(
    `SELECT 1 FROM ros_messages
      WHERE conversation_id = $1
        AND metadata->>'event_id' = $2
      LIMIT 1`,
    [conversationId, eventId],
  )
  return (r.rowCount ?? 0) > 0
}

async function insertMessage(client, conversationId, m, transcriptPath) {
  if (await eventIdExists(client, conversationId, m.eventId)) return 'skipped'

  const pointer = {
    sessionJsonlPath:
      transcriptPath ||
      m.extra?.session_jsonl_path ||
      m.extra?.sessionJsonlPath ||
      null,
    lineIndex:
      typeof m.lineIndex === 'number'
        ? m.lineIndex
        : typeof m.extra?.session_jsonl_line === 'number'
          ? m.extra.session_jsonl_line
          : typeof m.extra?.sessionJsonlLine === 'number'
            ? m.extra.sessionJsonlLine
            : null,
  }

  const contentFull = m.content ?? ''
  const contentCap = capForStorage(contentFull, pointer)
  const contentStored = contentCap.stored
  const contentTruncated = Boolean(contentCap.truncated)

  const toolResultFull = m.toolResult ?? null
  let toolResultStored = null
  let toolResultTruncated = false
  if (typeof toolResultFull === 'string') {
    const toolCap = capForStorage(toolResultFull, pointer)
    toolResultStored = toolCap.stored
    toolResultTruncated = Boolean(toolCap.truncated)
    if (toolCap.uncapped) {
      log(
        `insert ${conversationId}: tool_result ${toolResultFull.length} chars left uncapped (no disk pointer)`,
      )
    }
  }
  if (contentCap.uncapped) {
    log(
      `insert ${conversationId}: content ${contentFull.length} chars left uncapped (no disk pointer)`,
    )
  }

  const meta = {
    source: 'dsh-session',
    event_id: m.eventId,
    ...(m.extra ?? {}),
  }
  if (m.eventTs) meta.event_ts = m.eventTs
  if (typeof m.extra?.seq === 'number') meta.ordinal = m.extra.seq
  if (pointer.sessionJsonlPath) {
    meta.session_jsonl_path = pointer.sessionJsonlPath
    meta.sessionJsonlPath = pointer.sessionJsonlPath
  }
  if (typeof pointer.lineIndex === 'number') {
    meta.session_jsonl_line = pointer.lineIndex
    meta.sessionJsonlLine = pointer.lineIndex
    meta.event_offset = pointer.lineIndex
  }
  if (contentTruncated) meta.full_content_length = contentFull.length
  if (toolResultTruncated && toolResultFull) meta.full_tool_result_length = toolResultFull.length
  if (contentTruncated || toolResultTruncated) meta.truncated = true

  await client.query(
    `INSERT INTO ros_messages
       (conversation_id, agent, channel, role, content, tool_name, tool_args, tool_result, metadata, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, COALESCE($10, now()))`,
    [
      conversationId,
      CAPTURE_AGENT,
      CAPTURE_CHANNEL,
      m.role,
      contentStored,
      m.toolName ?? null,
      m.toolArgs != null ? (typeof m.toolArgs === 'string' ? m.toolArgs : JSON.stringify(m.toolArgs)) : null,
      toolResultStored,
      JSON.stringify(meta),
      m.createdAt ?? m.eventTs ?? null,
    ],
  )
  return 'inserted'
}

export async function ingestMessages(sessionId, messages, opts = {}) {
  if (messages.length === 0 && !opts.finalize) {
    return { inserted: 0, skipped: 0, conversationId: null }
  }
  const pgUrl = resolvePgUrl()
  const pg = await loadPg()
  const pool = new pg.Pool({ connectionString: pgUrl, max: 1 })
  const client = await pool.connect()
  const sessionKey = deriveSessionKey(sessionId)
  try {
    await client.query(`SET statement_timeout = ${STATEMENT_TIMEOUT_MS}`)
    await client.query('BEGIN')
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [sessionKey])
    const conv = await findOrCreateConversation(client, sessionKey, {
      title: (opts.title || 'dsh session').slice(0, 120),
      settings: {
        source: 'dsh-session',
        sessionId,
        cwd: opts.cwd ?? null,
        triggerEvent: opts.triggerEvent ?? 'ingest',
        session_jsonl_path: opts.transcriptPath ?? null,
      },
      active: !opts.finalize,
    })
    let inserted = 0
    let skipped = 0
    for (const m of messages) {
      const result = await insertMessage(client, conv.id, m, opts.transcriptPath ?? null)
      if (result === 'inserted') inserted++
      else skipped++
    }
    if (opts.finalize) {
      await client.query(
        `UPDATE ros_conversations SET active = false, updated_at = now() WHERE id = $1 AND active = true`,
        [conv.id],
      )
    } else if (inserted > 0) {
      await client.query(`UPDATE ros_conversations SET updated_at = now() WHERE id = $1`, [conv.id])
    }
    await client.query('COMMIT')
    log(
      `process ${sessionKey}: trigger=${opts.triggerEvent ?? 'ingest'} msgs=${messages.length} inserted=${inserted} skipped=${skipped}${opts.finalize ? ' finalized' : ''}`,
    )
    return { inserted, skipped, conversationId: conv.id, sessionKey }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    log(`process ${sessionId} failed: ${err instanceof Error ? err.message : String(err)}`)
    throw err
  } finally {
    client.release()
    await pool.end()
  }
}

// ---------------------------------------------------------------------------
// Spool / worker
// ---------------------------------------------------------------------------
export function enqueue(op) {
  try {
    fs.mkdirSync(SPOOL_DIR, { recursive: true })
    const spoolFile = path.join(SPOOL_DIR, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`)
    fs.writeFileSync(spoolFile, JSON.stringify(op))
    if (process.env[NO_WORKER_ENV]) return spoolFile
    const child = spawn(process.execPath, [SELF, '--worker', spoolFile], {
      detached: true,
      stdio: 'ignore',
    })
    child.unref()
    return spoolFile
  } catch (err) {
    log(`enqueue failed: ${err instanceof Error ? err.message : String(err)}`)
    return null
  }
}

async function resolvePointerForEvent(sessionId, event, hintedPath) {
  const transcriptPath = hintedPath || resolveSessionJsonlPath(sessionId)
  if (!transcriptPath || !event) return { transcriptPath: transcriptPath ?? null, lineIndex: null }
  try {
    const text = await readTranscriptText(transcriptPath)
    return { transcriptPath, lineIndex: findEventLineIndex(text, event) }
  } catch (err) {
    log(`pointer resolve failed for ${sessionId}: ${err instanceof Error ? err.message : String(err)}`)
    return { transcriptPath, lineIndex: null }
  }
}

async function processOp(op) {
  const sessionId = op.sessionId || op.session_id || 'unknown'
  const hintedPath = op.sessionJsonlPath || op.session_jsonl_path || null
  let messages = []
  let transcriptPath = hintedPath
  if (op.kind === 'event' && op.event) {
    const pointer = await resolvePointerForEvent(sessionId, op.event, hintedPath)
    transcriptPath = pointer.transcriptPath
    messages = messagesFromSessionEvent(sessionId, op.event, {
      lineIndex: pointer.lineIndex,
      sessionJsonlPath: pointer.transcriptPath,
    })
    if (pointer.transcriptPath && messages.some(m => m.extra?.sourceEvent === 'tool/result')) {
      try {
        const parsed = parseSessionJsonl(await readTranscriptText(pointer.transcriptPath), sessionId, pointer.transcriptPath)
        const names = new Map(
          parsed.messages
            .filter(m => m.extra?.sourceEvent === 'tool/call' && m.extra?.callId)
            .map(m => [m.extra.callId, m.toolName]),
        )
        for (const m of messages) {
          if (m.extra?.sourceEvent === 'tool/result' && names.get(m.extra.callId)) {
            const name = names.get(m.extra.callId)
            m.toolName = name
            m.content = m.content.replace(/\[tool-(result|failure)\] unknown/, `[tool-$1] ${name}`)
          }
        }
      } catch {
        // keep unknown
      }
    }
  } else if (op.kind === 'backfill' && Array.isArray(op.messages)) {
    messages = op.messages
    transcriptPath = hintedPath || op.transcriptPath || transcriptPath
  }
  const finalize = Boolean(op.finalize) || (op.event && op.event.type === 'turn/end')
  if (messages.length === 0 && !finalize) {
    log(`process ${sessionId}: no messages extracted from ${op.event?.type ?? op.kind}`)
    return { inserted: 0, skipped: 0 }
  }
  try {
    return await ingestMessages(sessionId, messages, {
      title: op.title,
      cwd: op.cwd,
      triggerEvent: op.event?.type ?? op.kind,
      finalize,
      transcriptPath,
    })
  } catch (err) {
    log(`worker ingest failed: ${err instanceof Error ? err.message : String(err)}`)
    return { inserted: 0, skipped: 0, error: String(err) }
  }
}

async function runWorker(spoolFile) {
  fs.mkdirSync(SPOOL_DIR, { recursive: true })
  const files = spoolFile
    ? [spoolFile]
    : fs.readdirSync(SPOOL_DIR).filter(f => f.endsWith('.json')).map(f => path.join(SPOOL_DIR, f))
  for (const file of files) {
    try {
      const op = JSON.parse(fs.readFileSync(file, 'utf8'))
      await processOp(op)
      fs.unlinkSync(file)
    } catch (e) {
      log(`worker failed on ${file}: ${e}`)
    }
  }
}

async function readStdin() {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}

function loadEnvFile() {
  const envFile = process.env.RIVETOS_ENV_FILE ?? path.join(os.homedir(), '.rivetos', '.env')
  if (!fs.existsSync(envFile)) return
  const raw = fs.readFileSync(envFile, 'utf8')
  for (const line of raw.split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line)
    if (!m) continue
    if (process.env[m[1]]) continue
    process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
  }
}

async function main() {
  loadEnvFile()
  const args = process.argv.slice(2)
  if (args[0] === '--worker') {
    await runWorker(args[1])
    return
  }

  if (args[0] === '--event') {
    let payload = {}
    try {
      const input = await readStdin()
      if (input.trim()) payload = JSON.parse(input)
    } catch {
      payload = {}
    }
    const sessionId = payload.sessionId || payload.session_id || 'unknown-' + Date.now()
    enqueue({
      kind: 'event',
      sessionId,
      cwd: payload.cwd,
      title: payload.title,
      event: payload.event,
      finalize: payload.finalize,
      sessionJsonlPath: payload.sessionJsonlPath || payload.session_jsonl_path || null,
    })
    process.exit(0)
  }

  if (args[0] === '--backfill') {
    const rest = args.slice(1)
    const dry = rest.includes('--dump')
    const target = rest.find(a => a !== '--dump')
    if (!target) {
      console.error('Usage: deepseek-memory-capture --backfill <file-or-sessions-dir> [--dump]')
      process.exit(1)
    }
    const files = fs.existsSync(target) && fs.statSync(target).isDirectory()
      ? findSessionFiles(target)
      : [target]
    let totalInserted = 0
    let totalSkipped = 0
    for (const file of files) {
      const text = await readTranscriptText(file)
      const abs = path.resolve(file)
      const parsed = parseSessionJsonl(text, null, abs)
      if (dry) {
        console.log(JSON.stringify({ file: abs, ...parsed, messages: parsed.messages }, null, 2))
        continue
      }
      const result = await ingestMessages(parsed.sessionId, parsed.messages, {
        title: parsed.title || path.basename(path.dirname(file)),
        cwd: parsed.cwd,
        triggerEvent: 'backfill',
        finalize: true,
        transcriptPath: abs,
      })
      console.log(
        `${file}: session=${parsed.sessionId} msgs=${parsed.messages.length} inserted=${result.inserted} skipped=${result.skipped}`,
      )
      totalInserted += result.inserted
      totalSkipped += result.skipped
    }
    if (!dry) console.log(`total inserted=${totalInserted} skipped=${totalSkipped}`)
    return
  }

  console.log('Usage: deepseek-memory-capture --event | --worker [file] | --backfill <path> [--dump]')
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === SELF
if (isMain) {
  main().catch(err => {
    log(`fatal: ${err}`)
    process.exit(0)
  })
}
