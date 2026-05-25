#!/usr/bin/env node
/**
 * Grok Memory Capture — ingest Grok Build session transcripts into the
 * shared RivetOS memory DB as `rivet-grok` conversations.
 *
 * Architecture (mirrors plugins/providers/claude-cli/src/transcript-capture.ts):
 *
 *   Grok persists every session to ~/.grok/sessions/<urlencoded-cwd>/<sid>/.
 *   The authoritative log is `updates.jsonl` (ACP session/update events).
 *   The TUI itself uses this file to drive `/load` and session restore, so we
 *   read it directly rather than reverse-engineering hook payloads. Hook
 *   payloads carry only signals (sessionId, reason, timestamp) — not content.
 *
 *   Pipeline:
 *     Grok hook fires (Stop / SessionEnd / PreCompact / etc.)
 *       └── bin/grok-memory-hook.sh
 *           └── this script (--hook) — spools a CaptureOp {kind: 'ingest', sessionId, finalize?}
 *               └── detached worker (--worker spoolFile)
 *                   └── ingestSession(sessionId)
 *                       1. locate ~/.grok/sessions/.../<sid>/
 *                       2. parse updates.jsonl → list of normalized messages
 *                       3. find/create the conversation row
 *                       4. count existing messages for it
 *                       5. INSERT only parsed[count:]
 *                       6. (finalize) flip ros_conversations.active = false
 *
 *   Idempotency comes from slice-by-count, identical to Claude transcript-capture:
 *   the parser is deterministic, updates.jsonl is append-only, so parsed[k] always
 *   maps to stored message k. A per-session pg_advisory_xact_lock serialises
 *   concurrent worker fires (Grok bursts events).
 *
 *   "Best effort": every error path swallows; the calling Grok session is
 *   never blocked. Failures go to ~/.rivetos/grok-memory-capture.log.
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import type { PoolClient } from 'pg'

const { Pool } = pg

// ---------------------------------------------------------------------------
// Constants (must match other Rivet agents)
// ---------------------------------------------------------------------------
export const CAPTURE_AGENT = 'rivet-grok'
export const CAPTURE_CHANNEL = 'grok-build'

const LOG_FILE = path.join(os.homedir(), '.rivetos', 'grok-memory-capture.log')
const SPOOL_DIR = path.join(os.tmpdir(), 'rivetos-grok-capture')
const SESSIONS_ROOT = path.join(os.homedir(), '.grok', 'sessions')
const MAX_CONTENT = 16000               // keep in sync with plugins/providers/claude-cli/src/transcript-capture.ts
const STATEMENT_TIMEOUT_MS = 15000      // keep in sync with plugins/providers/claude-cli/src/transcript-capture.ts

// Hint for tests: when set, enqueue() writes the spool file but skips the
// detached worker spawn. Production never sets this.
const NO_WORKER_ENV = 'GROK_CAPTURE_NO_WORKER'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
interface CaptureOp {
  kind: 'ingest'
  sessionId: string
  /** When true, mark the conversation inactive after ingest (SessionEnd). */
  finalize?: boolean
  /** Optional hint from the hook event; recorded in metadata for traceability. */
  sourceEvent?: string
}

/** Normalized row destined for ros_messages. */
interface PendingMessage {
  role: string
  content: string
  toolName?: string | null
  toolArgs?: unknown
  toolResult?: string | null
  /** Stored as metadata.event_id; provides a stable id for future dedup work. */
  eventId?: string | null
  /** Wall-clock from the ACP event (agentTimestampMs). Stored as metadata.event_ts. */
  eventTs?: string | null
  /** Extra fields persisted into metadata. */
  extra?: Record<string, unknown>
}

interface SessionSummary {
  title?: string
  modelId?: string
  agentName?: string
  cwd?: string
  generatedTitle?: string
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

function trunc(s: string | null | undefined): string | null {
  if (!s) return null
  return s.length > MAX_CONTENT ? s.slice(0, MAX_CONTENT) + '\n…[truncated]' : s
}

function deriveSessionKey(sessionId: string): string {
  return `grok-build:${sessionId}`
}

// ---------------------------------------------------------------------------
// Session directory resolution
// ---------------------------------------------------------------------------
/**
 * Find a Grok session directory by id. Grok organises sessions under
 * ~/.grok/sessions/<urlencoded-cwd>/<sessionId>/. We try the workspace-root
 * env var (if set), then scan all cwd buckets for the matching session id.
 */
export function findSessionDir(sessionId: string, workspaceRootHint?: string): string | null {
  if (workspaceRootHint) {
    const enc = encodeURIComponent(workspaceRootHint)
    const candidate = path.join(SESSIONS_ROOT, enc, sessionId)
    if (fs.existsSync(candidate)) return candidate
  }
  try {
    for (const cwd of fs.readdirSync(SESSIONS_ROOT)) {
      const candidate = path.join(SESSIONS_ROOT, cwd, sessionId)
      try {
        if (fs.statSync(candidate).isDirectory()) return candidate
      } catch {}
    }
  } catch {}
  return null
}

// ---------------------------------------------------------------------------
// ACP updates.jsonl → PendingMessage[] mapping
// ---------------------------------------------------------------------------
/**
 * Parse a Grok updates.jsonl file into a normalized, ordered list of pending
 * message rows. The mapper is deterministic and side-effect free; slice-by-count
 * idempotency depends on parsed[k] always being the same row for the same input.
 *
 * Event-type mapping:
 *   user_message_chunk        → role=user
 *   agent_message_chunk       → role=assistant
 *   agent_thought_chunk       → role=assistant, content prefixed "[thinking] "
 *                               (matches the rivet-claude convention)
 *   tool_call (collected, emitted when matching tool_call_update completes)
 *   tool_call_update (status=completed)
 *                             → role=tool, with toolName/toolArgs/toolResult
 *   memory_flush_started/completed → role=system marker
 *
 * Skipped (high volume, low recall value):
 *   hook_execution            (our own hooks firing)
 *   available_commands_update (slash-command catalog dumps)
 *   tool_call_update with status != completed (in-progress chatter)
 */
export function parseUpdates(jsonlText: string): PendingMessage[] {
  const out: PendingMessage[] = []
  // Tool calls accrue input data when first seen and emit on completion.
  const pendingTools = new Map<string, {
    name: string | null
    rawInput: unknown
    eventId: string | null
    eventTs: string | null
  }>()

  for (const rawLine of jsonlText.split('\n')) {
    const line = rawLine.trim()
    if (!line) continue
    let evt: any
    try { evt = JSON.parse(line) } catch { continue }
    const params = evt?.params
    const update = params?.update
    if (!update) continue
    const type = update.sessionUpdate
    if (!type) continue
    const eventId: string | null = params?._meta?.eventId ?? null
    const eventTs: string | null = params?._meta?.agentTimestampMs
      ? new Date(params._meta.agentTimestampMs).toISOString()
      : null

    if (type === 'user_message_chunk') {
      const text = extractText(update.content)
      if (text) {
        out.push({
          role: 'user',
          content: text,
          eventId,
          eventTs,
          extra: { sessionUpdate: type, modelId: update._meta?.modelId, promptIndex: update._meta?.promptIndex },
        })
      }
    } else if (type === 'agent_message_chunk') {
      const text = extractText(update.content)
      if (text) {
        out.push({
          role: 'assistant',
          content: text,
          eventId,
          eventTs,
          extra: { sessionUpdate: type },
        })
      }
    } else if (type === 'agent_thought_chunk') {
      const text = extractText(update.content)
      if (text) {
        out.push({
          role: 'assistant',
          content: `[thinking] ${text}`,
          eventId,
          eventTs,
          extra: { sessionUpdate: type },
        })
      }
    } else if (type === 'tool_call') {
      const id = update.toolCallId
      if (typeof id === 'string') {
        pendingTools.set(id, {
          name: update.title ?? null,
          rawInput: update.rawInput,
          eventId,
          eventTs,
        })
      }
    } else if (type === 'tool_call_update') {
      const id = update.toolCallId
      const status = update.status
      if (status === 'completed' && typeof id === 'string') {
        const initial = pendingTools.get(id) ?? { name: null, rawInput: undefined, eventId: null, eventTs: null }
        // Some tool calls only show up via tool_call_update (no preceding tool_call),
        // so fall back to update.title / update.rawInput.
        const toolName = initial.name ?? update.title ?? null
        const rawInput = initial.rawInput ?? update.rawInput ?? undefined
        const toolResult = formatToolResult(update)
        out.push({
          role: 'tool',
          content: `[tool] ${toolName ?? '?'}`,
          toolName,
          toolArgs: rawInput,
          toolResult,
          eventId,  // dedup on the completion event so re-emits don't double
          eventTs,
          extra: {
            sessionUpdate: type,
            toolCallId: id,
            toolCallEventId: initial.eventId,
            kind: update.kind ?? null,
          },
        })
        pendingTools.delete(id)
      }
    } else if (type === 'memory_flush_started' || type === 'memory_flush_completed') {
      out.push({
        role: 'system',
        content: `[grok.${type}]`,
        eventId,
        eventTs,
        extra: { sessionUpdate: type },
      })
    }
    // hook_execution, available_commands_update, in-progress tool_call_update
    // are intentionally skipped.
  }
  return out
}

function extractText(content: unknown): string | null {
  if (!content || typeof content !== 'object') return null
  const c = content as { type?: string; text?: string }
  if (c.type === 'text' && typeof c.text === 'string') return c.text
  return null
}

function formatToolResult(update: any): string | null {
  // Prefer the structured rawOutput when present (carries exit_code, command,
  // output_for_prompt for Bash; tool_name+server_name+output for MCP).
  if (update.rawOutput !== undefined) {
    try {
      return trunc(JSON.stringify(update.rawOutput))
    } catch {}
  }
  // Fall back to the textual content payload.
  if (Array.isArray(update.content)) {
    const parts: string[] = []
    for (const item of update.content) {
      const inner = item?.content
      const t = extractText(inner)
      if (t) parts.push(t)
    }
    if (parts.length) return trunc(parts.join('\n'))
  }
  return null
}

// ---------------------------------------------------------------------------
// summary.json reader (best-effort)
// ---------------------------------------------------------------------------
export function readSessionSummary(sessionDir: string): SessionSummary {
  const p = path.join(sessionDir, 'summary.json')
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'))
    return {
      title: raw.generated_title ?? raw.session_summary ?? raw.title,
      modelId: raw.current_model_id ?? raw.model,
      agentName: raw.agent_name,
      cwd: raw.info?.cwd,
      generatedTitle: raw.generated_title,
    }
  } catch {
    return {}
  }
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

async function countExisting(client: PoolClient, conversationId: string): Promise<number> {
  const r = await client.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM ros_messages WHERE conversation_id = $1`,
    [conversationId]
  )
  return parseInt(r.rows[0]?.count ?? '0', 10) || 0
}

async function insertMessage(
  client: PoolClient,
  conversationId: string,
  m: PendingMessage
): Promise<void> {
  const meta: Record<string, unknown> = {
    source: 'grok-jsonl',
    ...(m.extra ?? {}),
  }
  if (m.eventId) meta.event_id = m.eventId
  if (m.eventTs) meta.event_ts = m.eventTs
  await client.query(
    `INSERT INTO ros_messages
       (conversation_id, agent, channel, role, content, tool_name, tool_args, tool_result, metadata, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())`,
    [
      conversationId,
      CAPTURE_AGENT,
      CAPTURE_CHANNEL,
      m.role,
      trunc(m.content) ?? '',
      m.toolName ?? null,
      m.toolArgs != null ? JSON.stringify(m.toolArgs) : null,
      m.toolResult ?? null,
      JSON.stringify(meta),
    ]
  )
}

// ---------------------------------------------------------------------------
// Hot path: Enqueue (very fast, non-blocking)
// ---------------------------------------------------------------------------
export function enqueue(op: CaptureOp): void {
  try {
    fs.mkdirSync(SPOOL_DIR, { recursive: true })
    const spoolFile = path.join(SPOOL_DIR, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`)
    fs.writeFileSync(spoolFile, JSON.stringify(op))

    if (process.env[NO_WORKER_ENV]) return

    // Pick a worker invocation that can re-exec the worker. Layout (kept in
    // sync with bin/grok-memory-hook.sh):
    //   capture/src/grok-memory-capture.ts   (source — needs tsx)
    //   capture/dist/grok-memory-capture.js  (built — bare node)
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
// Worker: ingest one session
// ---------------------------------------------------------------------------
async function ingestSession(op: CaptureOp): Promise<void> {
  const pgUrl = resolvePgUrl()
  const pool = new Pool({ connectionString: pgUrl, max: 1 })
  const client = await pool.connect()

  try {
    const sessionKey = deriveSessionKey(op.sessionId)
    const sessionDir = findSessionDir(op.sessionId, process.env.GROK_WORKSPACE_ROOT)
    if (!sessionDir) {
      log(`ingest ${sessionKey}: session dir not found (workspaceRoot=${process.env.GROK_WORKSPACE_ROOT ?? 'unset'})`)
      return
    }

    const updatesPath = path.join(sessionDir, 'updates.jsonl')
    let jsonlText: string
    try {
      jsonlText = fs.readFileSync(updatesPath, 'utf8')
    } catch (err) {
      log(`ingest ${sessionKey}: updates.jsonl unreadable: ${(err as Error).message}`)
      return
    }
    const parsed = parseUpdates(jsonlText)
    const summary = readSessionSummary(sessionDir)
    const title = summary.title?.trim() || 'Grok Build session'

    await client.query(`SET statement_timeout = ${STATEMENT_TIMEOUT_MS}`)
    await client.query('BEGIN')
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [sessionKey])

    const conv = await findOrCreateConversation(client, sessionKey, {
      title,
      settings: {
        source: 'grok-jsonl',
        sessionId: op.sessionId,
        sessionDir,
        modelId: summary.modelId ?? null,
        agentName: summary.agentName ?? null,
        triggerEvent: op.sourceEvent ?? null,
      },
      active: !op.finalize,
    })

    const stored = await countExisting(client, conv.id)
    const toInsert = parsed.slice(stored)
    for (const m of toInsert) {
      await insertMessage(client, conv.id, m)
    }

    if (op.finalize) {
      await client.query(
        `UPDATE ros_conversations
            SET active = false, updated_at = now()
          WHERE id = $1 AND active = true`,
        [conv.id]
      )
    } else if (toInsert.length > 0) {
      await client.query(
        `UPDATE ros_conversations SET updated_at = now() WHERE id = $1`,
        [conv.id]
      )
    }

    await client.query('COMMIT')
    log(`ingest ${sessionKey}: parsed=${parsed.length} stored_before=${stored} inserted=${toInsert.length}${op.finalize ? ' finalized' : ''}`)
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    log(`ingest ${op.sessionId} failed: ${err instanceof Error ? err.message : String(err)}`)
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
      await ingestSession(op)
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

  // Hook mode — Grok writes the event JSON to stdin; we only need a few fields.
  // sessionId resolution order: env (GROK_SESSION_ID is always injected by
  // Grok per the docs) → payload.sessionId → time-based nonce.
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
      process.env.GROK_SESSION_ID ||
      (typeof payload.sessionId === 'string' ? payload.sessionId : undefined) ||
      ('unknown-' + Date.now())

    // SessionEnd marks the conversation inactive. Other events just trigger an
    // ingest pass; the worker is fully idempotent so extra fires are harmless.
    const finalize = /end|End/.test(event)

    enqueue({ kind: 'ingest', sessionId, finalize, sourceEvent: event })
    process.exit(0) // always succeed fast
  }

  console.log('Usage: grok-memory-capture --hook <event>  |  --worker [file]')
}

main().catch(err => {
  log(`fatal: ${err}`)
  process.exit(0) // never fail the caller
})
