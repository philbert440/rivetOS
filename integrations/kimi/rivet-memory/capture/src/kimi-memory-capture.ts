#!/usr/bin/env node
/**
 * Kimi Memory Capture — ingest Kimi Code CLI sessions into the shared RivetOS
 * memory DB as `rivet-kimi` conversations.
 *
 * Architecture (hook-payload first; session-file path optional):
 *
 *   kimi-code hooks fire lifecycle events with JSON on stdin. Unlike Grok
 *   (whose hooks were signals-only, forcing an updates.jsonl tailer), we
 *   prefer to extract content from the hook payload itself. If live payloads
 *   prove lossy (no assistant text, truncated tool results), enable the
 *   session-file path by setting SESSIONS_ROOT / findSessionDir constants
 *   after empirical discovery.
 *
 *   Pipeline:
 *     Kimi hook fires (Stop / SessionEnd / PreCompact / etc.)
 *       └── bin/kimi-memory-hook.sh
 *           └── this script (--hook) — spools a CaptureOp with full payload
 *               └── detached worker (--worker spoolFile)
 *                   └── processOp(op)
 *                       1. find/create conversation for session_id
 *                       2. extract PendingMessage[] from payload
 *                       3. for each message: content-hash event_id
 *                       4. INSERT only if event_id not already present
 *                       5. (finalize) flip ros_conversations.active = false
 *
 *   Idempotency: content-hash event_id. Firing the same payload twice must
 *   yield inserted=1 skipped=0 then inserted=0 skipped=1.
 *
 *   "Best effort": every error path swallows; the calling Kimi session is
 *   never blocked. Failures go to ~/.rivetos/kimi-memory-capture.log.
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import type { PoolClient } from 'pg'

const { Pool } = pg

// ---------------------------------------------------------------------------
// Constants (adjust after live verify — config home / sessions layout)
// ---------------------------------------------------------------------------
export const CAPTURE_AGENT = 'rivet-kimi'
export const CAPTURE_CHANNEL = 'kimi-code'

const LOG_FILE = path.join(os.homedir(), '.rivetos', 'kimi-memory-capture.log')
const SPOOL_DIR = path.join(os.tmpdir(), 'rivetos-kimi-capture')

/**
 * Candidate kimi config / session homes. Docs disagree between ~/.kimi and
 * ~/.kimi-code (+ KIMI_CODE_HOME). Prefer env, then newer name, then legacy.
 * Empirically verify on the target host and reorder if needed.
 */
export function resolveKimiHomes(): string[] {
  const out: string[] = []
  if (process.env.KIMI_CODE_HOME) out.push(process.env.KIMI_CODE_HOME)
  out.push(path.join(os.homedir(), '.kimi-code'))
  out.push(path.join(os.homedir(), '.kimi'))
  return [...new Set(out)]
}

/**
 * Optional session transcript roots. Empty until live discovery of where
 * kimi-code writes session files. When set, processOp may prefer JSONL
 * ingest (slice-by-count) over pure hook-payload extraction.
 */
export const SESSIONS_ROOT_CANDIDATES = (): string[] =>
  resolveKimiHomes().flatMap(h => [
    path.join(h, 'sessions'),
    path.join(h, 'projects'),
  ])

const MAX_CONTENT = 16000
const STATEMENT_TIMEOUT_MS = 15000

// Hint for tests: when set, enqueue() writes the spool file but skips the
// detached worker spawn. Production never sets this.
const NO_WORKER_ENV = 'KIMI_CAPTURE_NO_WORKER'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
export interface CaptureOp {
  kind: 'hook'
  sessionId: string
  /** Lifecycle event name (SessionStart, PostToolUse, …). */
  sourceEvent: string
  /** When true, mark the conversation inactive after ingest (SessionEnd). */
  finalize?: boolean
  /** Full hook stdin payload (best-effort parsed). */
  payload: Record<string, unknown>
}

/** Normalized row destined for ros_messages. */
export interface PendingMessage {
  role: string
  content: string
  toolName?: string | null
  toolArgs?: unknown
  toolResult?: string | null
  /** Stored as metadata.event_id; content-hash for dedup. */
  eventId: string
  eventTs?: string | null
  extra?: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// Logging (never throws)
// ---------------------------------------------------------------------------
function log(msg: string): void {
  const line = `${new Date().toISOString()} ${msg}\n`
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true })
    fs.appendFileSync(LOG_FILE, line)
  } catch {
    // ignore
  }
}

// ---------------------------------------------------------------------------
// Field accessors — accept both snake_case (docs) and camelCase (Grok gotcha)
// ---------------------------------------------------------------------------
export function pickString(obj: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const k of keys) {
    const v = obj[k]
    if (typeof v === 'string' && v.length > 0) return v
  }
  return undefined
}

export function pickUnknown(obj: Record<string, unknown>, ...keys: string[]): unknown {
  for (const k of keys) {
    if (k in obj && obj[k] !== undefined && obj[k] !== null) return obj[k]
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Content-hash event_id (idempotency)
// ---------------------------------------------------------------------------
/**
 * Stable SHA-256 hex of the fields that define message identity. Same payload
 * twice → same event_id → second insert skipped.
 */
export function contentHashEventId(parts: {
  sessionId: string
  role: string
  content: string
  toolName?: string | null
  toolResult?: string | null
  sourceEvent?: string
}): string {
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

// ---------------------------------------------------------------------------
// Hook payload → PendingMessage[]
// ---------------------------------------------------------------------------
/**
 * Extract zero or more normalized messages from a single hook fire.
 * Lifecycle-only events (SessionStart without content) produce system markers
 * so the conversation still exists and PreCompact/SessionEnd have a home.
 */
export function messagesFromHookPayload(
  sourceEvent: string,
  sessionId: string,
  payload: Record<string, unknown>
): PendingMessage[] {
  const event = sourceEvent || pickString(payload, 'hook_event_name', 'hookEventName') || 'unknown'
  const out: PendingMessage[] = []
  const eventTs =
    pickString(payload, 'timestamp', 'event_ts', 'eventTs') ??
    (typeof payload.timestamp === 'number'
      ? new Date(payload.timestamp).toISOString()
      : new Date().toISOString())

  // User prompt
  if (/userpromptsubmit/i.test(event) || /UserPromptSubmit/i.test(event)) {
    const prompt = pickString(payload, 'prompt', 'user_prompt', 'userPrompt', 'text', 'content')
    if (prompt) {
      const eventId = contentHashEventId({
        sessionId,
        role: 'user',
        content: prompt,
        sourceEvent: event,
      })
      out.push({
        role: 'user',
        content: prompt,
        eventId,
        eventTs,
        extra: { sourceEvent: event, source: 'kimi-hook' },
      })
    }
  }

  // Tool success / failure
  if (/posttooluse/i.test(event)) {
    const toolName =
      pickString(payload, 'tool_name', 'toolName', 'name') ?? 'unknown'
    const toolInput = pickUnknown(payload, 'tool_input', 'toolInput', 'input', 'arguments')
    const toolOutput = pickUnknown(
      payload,
      'tool_output',
      'toolOutput',
      'output',
      'result',
      'error',
      'message'
    )
    const isFailure = /failure/i.test(event)
    const toolResult =
      toolOutput == null
        ? isFailure
          ? '[tool failed]'
          : null
        : typeof toolOutput === 'string'
          ? toolOutput
          : safeJson(toolOutput)
    const content = isFailure
      ? `[tool-failure] ${toolName}`
      : `[tool] ${toolName}`
    const eventId = contentHashEventId({
      sessionId,
      role: 'tool',
      content,
      toolName,
      toolResult: toolResult ?? '',
      sourceEvent: event,
    })
    out.push({
      role: 'tool',
      content,
      toolName,
      toolArgs: toolInput,
      toolResult,
      eventId,
      eventTs,
      extra: {
        sourceEvent: event,
        source: 'kimi-hook',
        failure: isFailure,
      },
    })
  }

  // Assistant text on Stop (if payload carries it — verify live)
  if (/^stop$/i.test(event) || event === 'Stop') {
    const assistant =
      pickString(payload, 'response', 'assistant', 'assistant_text', 'assistantText', 'text', 'content')
    if (assistant) {
      const eventId = contentHashEventId({
        sessionId,
        role: 'assistant',
        content: assistant,
        sourceEvent: event,
      })
      out.push({
        role: 'assistant',
        content: assistant,
        eventId,
        eventTs,
        extra: { sourceEvent: event, source: 'kimi-hook' },
      })
    }
  }

  // Lifecycle markers (always record something for SessionStart/End/PreCompact
  // so the conversation row exists and audits show capture is firing)
  if (/sessionstart|sessionend|precompact|postcompact|stopfailure|notification/i.test(event)) {
    const reason = pickString(payload, 'reason', 'source', 'trigger') ?? ''
    const content = `[kimi.${event}]${reason ? ' ' + reason : ''}`
    const eventId = contentHashEventId({
      sessionId,
      role: 'system',
      content,
      sourceEvent: event,
    })
    out.push({
      role: 'system',
      content,
      eventId,
      eventTs,
      extra: { sourceEvent: event, source: 'kimi-hook' },
    })
  }

  // If nothing matched but payload has a bare prompt, still capture it
  if (out.length === 0) {
    const prompt = pickString(payload, 'prompt')
    if (prompt) {
      const eventId = contentHashEventId({
        sessionId,
        role: 'user',
        content: prompt,
        sourceEvent: event,
      })
      out.push({
        role: 'user',
        content: prompt,
        eventId,
        eventTs,
        extra: { sourceEvent: event, source: 'kimi-hook', fallback: true },
      })
    }
  }

  return out
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v)
  } catch {
    return String(v)
  }
}

// ---------------------------------------------------------------------------
// Env / DB helpers
// ---------------------------------------------------------------------------
function resolvePgUrl(): string {
  if (process.env.RIVETOS_PG_URL) return process.env.RIVETOS_PG_URL
  const envFile = process.env.RIVETOS_ENV_FILE ?? path.join(os.homedir(), '.rivetos', '.env')
  try {
    const raw = fs.readFileSync(envFile, 'utf8')
    for (const line of raw.split('\n')) {
      const m = /^\s*RIVETOS_PG_URL\s*=\s*(.+?)\s*$/.exec(line)
      if (m) return m[1].replace(/^["']|["']$/g, '')
    }
  } catch {}
  throw new Error('RIVETOS_PG_URL not set and not found in ~/.rivetos/.env')
}

export function deriveSessionKey(sessionId: string): string {
  return `kimi-code:${sessionId}`
}

/**
 * Find a session directory by id under candidate roots. Returns null until
 * SESSIONS_ROOT layout is known (hook-payload path does not require this).
 */
export function findSessionDir(sessionId: string, workspaceRootHint?: string): string | null {
  const roots = SESSIONS_ROOT_CANDIDATES()
  for (const root of roots) {
    if (workspaceRootHint) {
      const enc = encodeURIComponent(workspaceRootHint)
      const candidate = path.join(root, enc, sessionId)
      if (fs.existsSync(candidate)) return candidate
    }
    try {
      if (!fs.existsSync(root)) continue
      // Flat: root/<sessionId>
      const flat = path.join(root, sessionId)
      if (fs.existsSync(flat) && fs.statSync(flat).isDirectory()) return flat
      // Nested: root/<cwd>/<sessionId>
      for (const cwd of fs.readdirSync(root)) {
        const candidate = path.join(root, cwd, sessionId)
        try {
          if (fs.statSync(candidate).isDirectory()) return candidate
        } catch {}
      }
    } catch {}
  }
  return null
}

// ---------------------------------------------------------------------------
// DB primitives
// ---------------------------------------------------------------------------
async function findOrCreateConversation(
  client: PoolClient,
  sessionKey: string,
  init: { title: string; settings: Record<string, unknown>; active: boolean }
): Promise<{ id: string; created: boolean }> {
  const existing = await client.query<{ id: string }>(
    `SELECT id FROM ros_conversations WHERE session_key = $1 AND agent = $2`,
    [sessionKey, CAPTURE_AGENT]
  )
  if (existing.rows.length > 0) {
    return { id: existing.rows[0].id, created: false }
  }
  const conv = await client.query<{ id: string }>(
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
    ]
  )
  return { id: conv.rows[0].id, created: true }
}

async function eventIdExists(
  client: PoolClient,
  conversationId: string,
  eventId: string
): Promise<boolean> {
  const r = await client.query(
    `SELECT 1 FROM ros_messages
      WHERE conversation_id = $1
        AND metadata->>'event_id' = $2
      LIMIT 1`,
    [conversationId, eventId]
  )
  return (r.rowCount ?? 0) > 0
}

async function insertMessage(
  client: PoolClient,
  conversationId: string,
  m: PendingMessage
): Promise<'inserted' | 'skipped'> {
  if (await eventIdExists(client, conversationId, m.eventId)) {
    return 'skipped'
  }

  const contentFull = m.content ?? ''
  const contentStored =
    contentFull.length > MAX_CONTENT
      ? contentFull.slice(0, MAX_CONTENT) + '\n…[truncated]'
      : contentFull
  const contentTruncated = contentStored.length !== contentFull.length

  const toolResultFull = m.toolResult ?? null
  let toolResultStored: string | null = null
  let toolResultTruncated = false
  if (typeof toolResultFull === 'string') {
    if (toolResultFull.length > MAX_CONTENT) {
      toolResultStored = toolResultFull.slice(0, MAX_CONTENT) + '\n…[truncated]'
      toolResultTruncated = true
    } else {
      toolResultStored = toolResultFull
    }
  }

  const meta: Record<string, unknown> = {
    source: 'kimi-hook',
    event_id: m.eventId,
    ...(m.extra ?? {}),
  }
  if (m.eventTs) meta.event_ts = m.eventTs
  if (contentTruncated) {
    meta.full_content_length = contentFull.length
    meta.truncated = true
  }
  if (toolResultTruncated && toolResultFull) {
    meta.full_tool_result_length = toolResultFull.length
    meta.truncated = true
  }

  await client.query(
    `INSERT INTO ros_messages
       (conversation_id, agent, channel, role, content, tool_name, tool_args, tool_result, metadata, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())`,
    [
      conversationId,
      CAPTURE_AGENT,
      CAPTURE_CHANNEL,
      m.role,
      contentStored,
      m.toolName ?? null,
      m.toolArgs != null ? JSON.stringify(m.toolArgs) : null,
      toolResultStored,
      JSON.stringify(meta),
    ]
  )
  return 'inserted'
}

// ---------------------------------------------------------------------------
// Hot path: Enqueue (very fast, non-blocking)
// ---------------------------------------------------------------------------
export function enqueue(op: CaptureOp): void {
  try {
    fs.mkdirSync(SPOOL_DIR, { recursive: true })
    const spoolFile = path.join(
      SPOOL_DIR,
      `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`
    )
    fs.writeFileSync(spoolFile, JSON.stringify(op))

    if (process.env[NO_WORKER_ENV]) return

    // Pick a worker invocation that can re-exec the worker. Layout (kept in
    // sync with bin/kimi-memory-hook.sh):
    //   capture/src/kimi-memory-capture.ts   (source — needs tsx)
    //   capture/dist/kimi-memory-capture.js  (built — bare node)
    const self = process.argv[1] ?? fileURLToPath(import.meta.url)
    const selfDir = path.dirname(self)
    const selfBase = path.basename(self)
    let spawnPlan: { cmd: string; args: string[] }
    if (selfBase.endsWith('.ts')) {
      const builtJs = path.join(selfDir, '..', 'dist', selfBase.replace(/\.ts$/, '.js'))
      spawnPlan = fs.existsSync(builtJs)
        ? { cmd: process.execPath, args: [builtJs, '--worker', spoolFile] }
        : { cmd: 'npx', args: ['--yes', 'tsx', self, '--worker', spoolFile] }
    } else {
      spawnPlan = { cmd: process.execPath, args: [self, '--worker', spoolFile] }
    }
    const child = spawn(spawnPlan.cmd, spawnPlan.args, {
      detached: true,
      stdio: 'ignore',
    })
    child.unref()
  } catch (err) {
    log(`enqueue failed: ${err instanceof Error ? err.message : String(err)}`)
  }
}

// ---------------------------------------------------------------------------
// Worker: process one spool op
// ---------------------------------------------------------------------------
async function processOp(op: CaptureOp): Promise<void> {
  const messages = messagesFromHookPayload(op.sourceEvent, op.sessionId, op.payload)
  if (messages.length === 0 && !op.finalize) {
    log(`process ${op.sessionId}: no messages extracted from ${op.sourceEvent}`)
    return
  }

  let pgUrl: string
  try {
    pgUrl = resolvePgUrl()
  } catch (err) {
    log(`process ${op.sessionId}: no PG url: ${err instanceof Error ? err.message : String(err)}`)
    return
  }

  const pool = new Pool({ connectionString: pgUrl, max: 1 })
  const client = await pool.connect()

  try {
    const sessionKey = deriveSessionKey(op.sessionId)
    const cwd = pickString(op.payload, 'cwd', 'working_directory', 'workingDirectory')
    const title =
      pickString(op.payload, 'title', 'session_title', 'sessionTitle')?.trim() ||
      'Kimi Code session'

    await client.query(`SET statement_timeout = ${STATEMENT_TIMEOUT_MS}`)
    await client.query('BEGIN')
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [sessionKey])

    const conv = await findOrCreateConversation(client, sessionKey, {
      title,
      settings: {
        source: 'kimi-hook',
        sessionId: op.sessionId,
        cwd: cwd ?? null,
        triggerEvent: op.sourceEvent,
      },
      active: !op.finalize,
    })

    let inserted = 0
    let skipped = 0
    for (const m of messages) {
      const result = await insertMessage(client, conv.id, m)
      if (result === 'inserted') inserted++
      else skipped++
    }

    if (op.finalize) {
      await client.query(
        `UPDATE ros_conversations
            SET active = false, updated_at = now()
          WHERE id = $1 AND active = true`,
        [conv.id]
      )
    } else if (inserted > 0) {
      await client.query(
        `UPDATE ros_conversations SET updated_at = now() WHERE id = $1`,
        [conv.id]
      )
    }

    await client.query('COMMIT')
    log(
      `process ${sessionKey}: event=${op.sourceEvent} msgs=${messages.length} inserted=${inserted} skipped=${skipped}${op.finalize ? ' finalized' : ''}`
    )
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    log(`process ${op.sessionId} failed: ${err instanceof Error ? err.message : String(err)}`)
  } finally {
    client.release()
    await pool.end()
  }
}

async function runWorker(spoolFile?: string) {
  fs.mkdirSync(SPOOL_DIR, { recursive: true })
  const files = spoolFile
    ? [spoolFile]
    : fs.readdirSync(SPOOL_DIR).filter(f => f.endsWith('.json')).map(f => path.join(SPOOL_DIR, f))

  for (const file of files) {
    try {
      const op = JSON.parse(fs.readFileSync(file, 'utf8')) as CaptureOp
      await processOp(op)
      fs.unlinkSync(file)
    } catch (e) {
      log(`worker failed on ${file}: ${e}`)
    }
  }
}

// ---------------------------------------------------------------------------
// CLI entrypoint (for hooks and worker)
// ---------------------------------------------------------------------------
async function main() {
  const args = process.argv.slice(2)

  if (args[0] === '--worker') {
    await runWorker(args[1])
    return
  }

  // Hook mode — kimi-code writes the event JSON to stdin.
  // session_id resolution: env → payload (snake or camel) → time-based nonce.
  if (args[0] === '--hook') {
    const event = args[1] || 'unknown'
    let payload: Record<string, unknown> = {}
    try {
      const input = await new Promise<string>((resolve) => {
        let data = ''
        process.stdin.on('data', chunk => (data += chunk))
        process.stdin.on('end', () => resolve(data))
      })
      if (input.trim()) payload = JSON.parse(input)
    } catch {}

    const sessionId =
      process.env.KIMI_SESSION_ID ||
      process.env.KIMI_CODE_SESSION_ID ||
      pickString(payload, 'session_id', 'sessionId') ||
      ('unknown-' + Date.now())

    // SessionEnd marks the conversation inactive.
    const finalize = /^sessionend$/i.test(event)

    enqueue({
      kind: 'hook',
      sessionId,
      sourceEvent: event,
      finalize,
      payload,
    })
    process.exit(0) // always succeed fast
  }

  console.log('Usage: kimi-memory-capture --hook <event>  |  --worker [file]')
}

main().catch(err => {
  log(`fatal: ${err}`)
  process.exit(0) // never fail the caller
})
