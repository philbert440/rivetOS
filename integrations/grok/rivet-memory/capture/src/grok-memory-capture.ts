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
 *   Den transport sends the entire session with grok-build:<sid>:<ordinal>
 *   event ids. The den deduplicates retries; the legacy pg transport retains
 *   slice-by-count. A local directory lock serializes state publication.
 *
 *   "Best effort": every error path swallows; the calling Grok session is
 *   never blocked. Failures go to ~/.rivetos/grok-memory-capture.log.
 */

import { createHash } from 'node:crypto'
import {
  isRecord,
  asString,
  createCaptureWriter,
  resolveCaptureTransport,
  withFileLock,
} from '@rivetos/capture-core'
import type { CaptureBatch, CaptureMessage, CaptureWriterOptions } from '@rivetos/capture-core'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import type { PoolClient } from 'pg'

// ---------------------------------------------------------------------------
// Constants (must match other Rivet agents)
// ---------------------------------------------------------------------------
export const CAPTURE_AGENT = 'rivet-grok'
export const CAPTURE_CHANNEL = 'grok-build'

const LOG_FILE = path.join(os.homedir(), '.rivetos', 'grok-memory-capture.log')
/**
 * The hook payload spool. A session spawned for another registry user spools
 * apart: a payload that outlives its worker is ingested by whichever worker
 * next sweeps the directory, with that worker's identity, and must not be
 * ingested as someone else's.
 */
function spoolDirFor(name: string): string {
  const base = path.join(os.tmpdir(), name)
  const userId = process.env.RIVETOS_USER_ID
  if (userId === undefined || userId === '') return base
  return `${base}-user-${createHash('sha256').update(userId).digest('hex').slice(0, 32)}`
}
const SPOOL_DIR = spoolDirFor('rivetos-grok-capture')
const stateDir = (): string => path.join(os.homedir(), '.rivetos', 'capture-state')
const sessionsRoot = (): string => path.join(os.homedir(), '.grok', 'sessions')
const MAX_CONTENT = 16000 // keep in sync with plugins/providers/claude-cli/src/transcript-capture.ts
const STATEMENT_TIMEOUT_MS = 15000 // keep in sync with plugins/providers/claude-cli/src/transcript-capture.ts

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
  /** herdr pane identity, stamped at hook time from HERDR_PANE_ID /
   *  HERDR_WORKSPACE_ID + hostname when the session runs inside a herdr pane.
   *  Spooled (not re-read from env) because the detached worker must not
   *  depend on env inheritance. Merged into message metadata. */
  herdr?: {
    paneId?: string
    workspaceId?: string
    host?: string
  }
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
  /**
   * Stable logical sort key (turn * 1_000_000 + sub_order). Stored as
   * metadata.ordinal so the memory plugin can ORDER BY it instead of created_at,
   * correcting the case where Grok appends user_message_chunk to updates.jsonl
   * after the agent has already started responding to that prompt. The capture
   * itself stays in file order so slice-by-count idempotency is preserved; the
   * ordinal is recovered at query time.
   */
  ordinal?: number
  /** Line number (0-indexed) of the source event in updates.jsonl. Stored as
   *  metadata.session_jsonl_line so the full raw payload is recoverable from
   *  disk when the row's content / tool_result has been truncated. */
  lineIndex?: number
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
// Session state tracking (for fail-loud)
// ---------------------------------------------------------------------------
// Stuck policy — MUST match run-once.sh:
// ≥3 failures whose timestamps fall inside a rolling 2h window ending at now.
// Samples older than 2h (or in the future / clock-rollback) are dropped.
// Success clears the window. A fresh burst of 3 failures within 2h re-alarms
// regardless of older history.
const STUCK_FAILURE_COUNT = 3
const STUCK_WINDOW_MS = 2 * 60 * 60 * 1000
const STATE_LOCK_RETRY_MS = 50
const STATE_LOCK_TIMEOUT_MS = 20_000

interface SessionState {
  sessionId: string
  lastAttemptMs: number
  lastStatus: 'success' | 'failure'
  lastError?: string
  consecutiveFailures: number
  /** Epoch ms of the oldest failure still inside the rolling window. */
  firstFailureMs?: number
  /** Recent failure timestamps (epoch ms) retained for the rolling window. */
  failureTimestampsMs?: number[]
}

function isErrnoCode(err: unknown, code: string): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === code
  )
}

/**
 * True when a candidate path cannot exist, as opposed to one we failed to read.
 *
 * ENOENT is the session simply not living in this bucket. ENOTDIR is a
 * non-directory sitting in the sessions root — Grok keeps its own
 * session_search.sqlite index beside the cwd buckets — so `<that file>/<id>`
 * can never resolve. Neither is an access failure, so both skip the candidate.
 * Real access errors (EACCES, EPERM, EIO) still fail loud, so the worker never
 * deletes the spool of a session it merely could not read.
 */
function isUnresolvablePath(err: unknown): boolean {
  return isErrnoCode(err, 'ENOENT') || isErrnoCode(err, 'ENOTDIR')
}

function readSessionState(sessionId: string): SessionState | null {
  try {
    const statePath = path.join(stateDir(), `${sessionId}.json`)
    const raw = fs.readFileSync(statePath, 'utf8')
    return JSON.parse(raw) as SessionState
  } catch {
    return null
  }
}

function writeSessionState(state: SessionState): void {
  const statePath = path.join(stateDir(), `${state.sessionId}.json`)
  const tmpPath = path.join(
    stateDir(),
    `.${state.sessionId}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`,
  )
  try {
    fs.mkdirSync(stateDir(), { recursive: true })
    fs.writeFileSync(tmpPath, JSON.stringify(state, null, 2))
    fs.renameSync(tmpPath, statePath)
  } catch (err) {
    log(`writeSessionState failed: ${err instanceof Error ? err.message : String(err)}`)
    try {
      fs.unlinkSync(tmpPath)
    } catch {
      // ignore
    }
  }
}

function lockPathFor(sessionId: string): string {
  const safe = sessionId.replace(/[^A-Za-z0-9._-]/g, '_')
  return path.join(stateDir(), `.${safe}.lock`)
}

/**
 * Directory lock keyed by sessionId in stateDir(). Held across
 * read → modify → publish so state serializes even when Postgres is down.
 * The PG advisory lock still covers DB writes; this lock covers local state.
 */

function pruneFailureTimestamps(timestamps: number[], now: number): number[] {
  return timestamps
    .filter((ts) => {
      if (typeof ts !== 'number' || !Number.isFinite(ts)) return false
      const age = now - ts
      return age >= 0 && age <= STUCK_WINDOW_MS
    })
    .sort((a, b) => a - b)
}

function priorFailureTimestamps(prior: SessionState | null): number[] {
  if (prior?.lastStatus !== 'failure') return []
  if (Array.isArray(prior.failureTimestampsMs)) {
    return prior.failureTimestampsMs.filter((ts) => typeof ts === 'number')
  }
  const seeded: number[] = []
  if (typeof prior.firstFailureMs === 'number') seeded.push(prior.firstFailureMs)
  if (typeof prior.lastAttemptMs === 'number' && prior.lastAttemptMs !== prior.firstFailureMs) {
    seeded.push(prior.lastAttemptMs)
  }
  return seeded
}

function nextFailureState(
  sessionId: string,
  errMsg: string,
  prior: SessionState | null,
): SessionState {
  const now = Date.now()
  const timestamps = pruneFailureTimestamps([...priorFailureTimestamps(prior), now], now)
  return {
    sessionId,
    lastAttemptMs: now,
    lastStatus: 'failure',
    lastError: errMsg,
    consecutiveFailures: timestamps.length,
    firstFailureMs: timestamps[0],
    failureTimestampsMs: timestamps,
  }
}

function nextSuccessState(sessionId: string): SessionState {
  return {
    sessionId,
    lastAttemptMs: Date.now(),
    lastStatus: 'success',
    consecutiveFailures: 0,
  }
}

function isStuckSession(state: SessionState, now = Date.now()): boolean {
  if (state.lastStatus !== 'failure') return false
  if (typeof state.lastAttemptMs !== 'number') return false
  const lastAge = now - state.lastAttemptMs
  if (lastAge < 0 || lastAge > STUCK_WINDOW_MS) return false
  const timestamps = pruneFailureTimestamps(priorFailureTimestamps(state), now)
  return timestamps.length >= STUCK_FAILURE_COUNT
}

function checkStuckSessions(): string[] {
  const stuck: string[] = []
  try {
    fs.mkdirSync(stateDir(), { recursive: true })
    const files = fs.readdirSync(stateDir()).filter((f) => f.endsWith('.json'))
    const now = Date.now()

    for (const file of files) {
      try {
        const statePath = path.join(stateDir(), file)
        const state = JSON.parse(fs.readFileSync(statePath, 'utf8')) as SessionState
        if (isStuckSession(state, now)) {
          stuck.push(
            `${state.sessionId} (${state.consecutiveFailures} failures, last: ${state.lastError || 'unknown'})`,
          )
        }
      } catch {
        // Skip malformed state files
      }
    }
  } catch {
    // State dir doesn't exist or can't be read
  }
  return stuck
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
  } catch {
    /* best effort */
  }
  throw new Error('RIVETOS_PG_URL not set and not found in ~/.rivetos/.env')
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
  // Real layout is ~/.grok/sessions/<urlencoded-cwd>/<sessionId>/. Directory
  // access errors are not "not found" — they must fail loud so the worker
  // does not delete a spool for an inaccessible session.
  if (workspaceRootHint) {
    const enc = encodeURIComponent(workspaceRootHint)
    const candidate = path.join(sessionsRoot(), enc, sessionId)
    try {
      if (fs.statSync(candidate).isDirectory()) return candidate
    } catch (err) {
      if (!isUnresolvablePath(err)) throw err
    }
  }
  let cwdEntries: string[]
  try {
    cwdEntries = fs.readdirSync(sessionsRoot())
  } catch (err) {
    if (isErrnoCode(err, 'ENOENT')) return null
    throw err
  }
  let accessError: unknown
  for (const cwd of cwdEntries) {
    const candidate = path.join(sessionsRoot(), cwd, sessionId)
    try {
      if (fs.statSync(candidate).isDirectory()) return candidate
    } catch (err) {
      if (isUnresolvablePath(err)) continue
      accessError = err
    }
  }
  if (accessError)
    throw accessError instanceof Error
      ? accessError
      : new Error('session directory inaccessible', { cause: accessError })
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
  // Split once; re-use across both passes so they see identical line numbering.
  const lines = jsonlText.split('\n')

  // ---------- Pass 1: number distinct promptIds in file order. ---------------
  // Grok writes agent_thought / tool_call / tool_call_update / agent_message
  // events with outer params._meta.promptId. user_message_chunk events carry an
  // integer promptIndex instead (no promptId). The nth distinct promptId in the
  // file corresponds to the user_message_chunk with promptIndex = n, so we can
  // recover the turn association without a direct field linkage.
  //
  // This pass is the reason we can compute a stable logical ordinal even when
  // Grok appends the user_message_chunk to the file AFTER the agent has already
  // started responding to it (observed live on rivet-grok 2026-05-25).
  const promptIdToTurn = new Map<string, number>()
  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line) continue
    let evt: unknown
    try {
      evt = JSON.parse(line)
    } catch {
      continue
    }
    if (!isRecord(evt) || !isRecord(evt.params)) continue
    const promptId = isRecord(evt.params._meta) ? evt.params._meta.promptId : undefined
    if (typeof promptId === 'string' && !promptIdToTurn.has(promptId)) {
      promptIdToTurn.set(promptId, promptIdToTurn.size)
    }
  }

  // ---------- Pass 2: emit normalized PendingMessages with ordinals. ----------
  const userChunks = new Map<number, number>()
  const SUB_OTHER_BASE = 10_000
  const TURN_STRIDE = 1_000_000
  const out: PendingMessage[] = []
  const pendingTools = new Map<
    string,
    {
      name: string | null
      rawInput: unknown
      eventId: string | null
      eventTs: string | null
    }
  >()
  /** Last known turn for events that lack their own promptId/promptIndex
   *  (memory_flush, the rare orphan tool_call_update). Starts at -1 ("no
   *  turn yet seen"); falls forward as we see scoped events. */
  let currentTurn = -1

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line) continue
    let evt: unknown
    try {
      evt = JSON.parse(line)
    } catch {
      continue
    }
    if (!isRecord(evt) || !isRecord(evt.params)) continue
    const params = evt.params
    const update = params.update
    if (!isRecord(update)) continue
    const meta = isRecord(params._meta) ? params._meta : {}
    const updateMeta = isRecord(update._meta) ? update._meta : {}
    const type = update.sessionUpdate
    if (!type) continue
    const eventId: string | null = asString(meta.eventId)
    const eventTs: string | null =
      typeof meta.agentTimestampMs === 'number' && meta.agentTimestampMs
        ? new Date(meta.agentTimestampMs).toISOString()
        : null

    // Resolve turn + sub_order. user_message_chunk uses promptIndex directly;
    // everything else looks up the outer promptId in the map from Pass 1.
    let turn: number
    let subOrder: number
    if (type === 'user_message_chunk') {
      const pi = updateMeta.promptIndex
      turn = typeof pi === 'number' ? pi : currentTurn < 0 ? 0 : currentTurn
      // Preserve sub-order zero for the first chunk, including existing fixtures.
      subOrder = userChunks.get(turn) ?? 0
      userChunks.set(turn, subOrder + 1)
      currentTurn = turn
    } else {
      const promptId = meta.promptId
      if (typeof promptId === 'string' && promptIdToTurn.has(promptId)) {
        turn = promptIdToTurn.get(promptId)!
        currentTurn = turn
      } else {
        turn = currentTurn // -1 for events before any turn is known
      }
      subOrder = SUB_OTHER_BASE + i
    }
    const ordinal = turn * TURN_STRIDE + subOrder

    if (type === 'user_message_chunk') {
      const text = extractText(update.content)
      if (text) {
        out.push({
          role: 'user',
          content: text,
          eventId,
          eventTs,
          ordinal,
          lineIndex: i,
          extra: {
            sessionUpdate: type,
            modelId: updateMeta.modelId,
            promptIndex: updateMeta.promptIndex,
          },
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
          ordinal,
          lineIndex: i,
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
          ordinal,
          lineIndex: i,
          extra: { sessionUpdate: type },
        })
      }
    } else if (type === 'tool_call') {
      const id = update.toolCallId
      if (typeof id === 'string') {
        pendingTools.set(id, {
          name: asString(update.title),
          rawInput: update.rawInput,
          eventId,
          eventTs,
        })
      }
    } else if (type === 'tool_call_update') {
      const id = update.toolCallId
      const status = update.status
      if (status === 'completed' && typeof id === 'string') {
        const initial = pendingTools.get(id) ?? {
          name: null,
          rawInput: undefined,
          eventId: null,
          eventTs: null,
        }
        // Some tool calls only show up via tool_call_update (no preceding tool_call),
        // so fall back to update.title / update.rawInput.
        const toolName = initial.name ?? asString(update.title)
        const rawInput = initial.rawInput ?? update.rawInput ?? undefined
        const toolResult = formatToolResult(update)
        out.push({
          role: 'tool',
          content: `[tool] ${toolName ?? '?'}`,
          toolName,
          toolArgs: rawInput,
          toolResult,
          eventId,
          eventTs,
          ordinal,
          lineIndex: i,
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
        ordinal,
        lineIndex: i,
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

/**
 * Pull a human-readable string out of the rawOutput envelope, switching on the
 * structured type. Grok's rawOutput for Bash and similar tools stores stdout
 * twice: as a byte-array under `output` (or `stdout`) AND as a UTF-8 string
 * under `output_for_prompt`. Stringifying the raw object leaks the byte arrays
 * as decimal numbers and is unreadable, so prefer the prompt-friendly text
 * field per known type. For unknown types we still fall back to JSON, but with
 * byte arrays decoded/elided defensively.
 */
function formatToolResult(update: Record<string, unknown>): string | null {
  // Returns the full (un-truncated) human-readable result; truncation happens
  // at the insertion layer so we can record the original length + a disk
  // pointer in metadata when truncation occurs.
  const out = update?.rawOutput
  if (isRecord(out)) {
    const t = out.type
    if (t === 'Bash') {
      if (typeof out.output_for_prompt === 'string') {
        const tail = `exit_code=${typeof out.exit_code === 'number' ? out.exit_code : '?'}${out.timed_out ? ' timed_out=true' : ''}${out.truncated ? ' truncated=true' : ''}`
        return `${out.output_for_prompt}\n[${tail}]`
      }
    } else if (t === 'GrepSearch') {
      if (typeof out.output_for_prompt === 'string') return out.output_for_prompt
      if (Array.isArray(out.stdout))
        return bytesToString(out.stdout.filter((v): v is number => typeof v === 'number'))
    } else if (t === 'ReadFile') {
      if (isRecord(out.FileContent) && typeof out.FileContent.content === 'string')
        return out.FileContent.content
    } else if (t === 'SearchTool') {
      if (typeof out.content === 'string') {
        const prefix =
          typeof out.result_count === 'number' ? `[result_count=${out.result_count}]\n` : ''
        return prefix + out.content
      }
    } else if (t === 'MCP') {
      const header = `[mcp ${asString(out.server_name) ?? '?'}/${asString(out.tool_name) ?? '?'}]`
      const o = out.output
      if (typeof o === 'string') return `${header}\n${o}`
      if (isRecord(o) && typeof o.OkayOutput === 'string') return `${header}\n${o.OkayOutput}`
      if (isRecord(o) && typeof o.ErrorOutput === 'string')
        return `${header} ERROR\n${o.ErrorOutput}`
      // Unknown MCP envelope — JSON-stringify after stripping byte arrays.
      try {
        return `${header}\n${JSON.stringify(stripByteArrays(o))}`
      } catch {
        /* best effort */
      }
    } else if (t === 'ListDir') {
      if (isRecord(out.Content) && typeof out.Content.content === 'string')
        return out.Content.content
    } else if (t === 'Todo') {
      if (isRecord(out.TodosUpdated) && typeof out.TodosUpdated.summary_for_prompt === 'string') {
        return out.TodosUpdated.summary_for_prompt
      }
    }
    // Unknown rawOutput.type — JSON.stringify but with byte arrays decoded so
    // the row stays human-readable.
    try {
      return JSON.stringify(stripByteArrays(out))
    } catch {
      /* best effort */
    }
  }
  // Final fallback: textual content payload (rare; some tool_call_updates
  // carry a content[] array instead of rawOutput).
  if (Array.isArray(update?.content)) {
    const parts: string[] = []
    for (const item of update.content) {
      const inner: unknown = isRecord(item) ? item.content : undefined
      const t = extractText(inner)
      if (t) parts.push(t)
    }
    if (parts.length) return parts.join('\n')
  }
  return null
}

/** Decode a numeric byte array as UTF-8, used by Bash/GrepSearch outputs. */
function bytesToString(arr: number[]): string {
  try {
    return Buffer.from(arr).toString('utf8')
  } catch {
    return `[${arr.length} bytes]`
  }
}

/**
 * Walk an object and replace numeric byte arrays (Vec<u8> serialised as JSON
 * array of small ints) with their UTF-8 decoded text. Used when stringifying
 * unknown rawOutput types so the row stays readable instead of dumping
 * thousands of decimal digits.
 */
function stripByteArrays(obj: unknown, depth = 0): unknown {
  if (depth > 6 || obj == null) return obj
  if (Array.isArray(obj)) {
    const looksLikeBytes =
      obj.length >= 16 &&
      obj.every((v) => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 255)
    if (looksLikeBytes) return bytesToString(obj as number[])
    return obj.map((v) => stripByteArrays(v, depth + 1))
  }
  if (typeof obj === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      out[k] = stripByteArrays(v, depth + 1)
    }
    return out
  }
  return obj
}

// ---------------------------------------------------------------------------
// summary.json reader (best-effort)
// ---------------------------------------------------------------------------
export function readSessionSummary(sessionDir: string): SessionSummary {
  const p = path.join(sessionDir, 'summary.json')
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(p, 'utf8'))
    const raw = isRecord(parsed) ? parsed : {}
    return {
      title:
        asString(raw.generated_title) ??
        asString(raw.session_summary) ??
        asString(raw.title) ??
        undefined,
      modelId: asString(raw.current_model_id) ?? asString(raw.model) ?? undefined,
      agentName: asString(raw.agent_name) ?? undefined,
      cwd: isRecord(raw.info) ? (asString(raw.info.cwd) ?? undefined) : undefined,
      generatedTitle: asString(raw.generated_title) ?? undefined,
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
  init: { title: string; settings: Record<string, unknown>; active: boolean },
): Promise<{ id: string; created: boolean }> {
  const existing = await client.query<{ id: string }>(
    `SELECT id FROM ros_conversations WHERE session_key = $1 AND agent = $2`,
    [sessionKey, CAPTURE_AGENT],
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
    ],
  )
  return { id: conv.rows[0].id, created: true }
}

async function countExisting(client: PoolClient, conversationId: string): Promise<number> {
  const r = await client.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM ros_messages WHERE conversation_id = $1`,
    [conversationId],
  )
  return parseInt(r.rows[0]?.count ?? '0', 10) || 0
}

async function insertMessage(
  client: PoolClient,
  conversationId: string,
  m: PendingMessage,
  sessionJsonlPath: string | null,
  herdr?: CaptureOp['herdr'],
): Promise<void> {
  // PendingMessage now carries un-truncated content + toolResult; trunc runs
  // here so we can record the original length and a disk-pointer back to the
  // source line in updates.jsonl when content was elided. Recall queries that
  // hit a truncated row can read the full payload from disk via that pointer.
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
    source: 'grok-jsonl',
    ...(m.extra ?? {}),
  }
  if (m.eventId) meta.event_id = m.eventId
  if (m.eventTs) meta.event_ts = m.eventTs
  if (typeof m.ordinal === 'number') meta.ordinal = m.ordinal
  if (sessionJsonlPath) meta.session_jsonl_path = sessionJsonlPath
  // herdr pane identity — lets the federated view join captured messages to
  // the pane/workspace/host that produced them. Absent when not under herdr.
  if (herdr?.paneId) {
    meta.herdr_pane_id = herdr.paneId
    if (herdr.workspaceId) meta.herdr_workspace_id = herdr.workspaceId
    if (herdr.host) meta.herdr_host = herdr.host
  }
  if (typeof m.lineIndex === 'number') meta.session_jsonl_line = m.lineIndex
  // Record original lengths whenever truncation occurred — recall consumers
  // use full_content_length / full_tool_result_length to decide whether to
  // re-read the source line from disk.
  if (contentTruncated) meta.full_content_length = contentFull.length
  if (toolResultTruncated && toolResultFull) meta.full_tool_result_length = toolResultFull.length
  if (contentTruncated || toolResultTruncated) meta.truncated = true

  // Use eventTs for created_at when available, falling back to now().
  // This preserves the original wall-clock timestamp from the Grok event
  // so ORDER BY created_at reflects the true chronological order.
  // Defensive: if eventTs is malformed, fall back to null (DB defaults to NOW())
  // to preserve the never-fail property.
  let createdAt: string | null = null
  if (m.eventTs) {
    const parsedMs = Date.parse(m.eventTs)
    if (!Number.isNaN(parsedMs)) {
      createdAt = m.eventTs
    }
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
      contentStored,
      m.toolName ?? null,
      m.toolArgs != null ? JSON.stringify(m.toolArgs) : null,
      toolResultStored,
      JSON.stringify(meta),
      createdAt,
    ],
  )
}

// ---------------------------------------------------------------------------
// Hot path: Enqueue (very fast, non-blocking)
// ---------------------------------------------------------------------------
export function enqueue(op: CaptureOp): void {
  try {
    fs.mkdirSync(SPOOL_DIR, { recursive: true })
    const spoolFile = path.join(
      SPOOL_DIR,
      `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`,
    )
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
export function toCaptureMessage(
  m: PendingMessage,
  sessionKey: string,
  sourcePath: string,
  herdr?: CaptureOp['herdr'],
): CaptureMessage {
  if (!['user', 'assistant', 'tool', 'system'].includes(m.role))
    throw new Error(`Invalid role: ${m.role}`)
  const eventId = `${sessionKey}:${String(m.ordinal)}`
  const metadata: Record<string, unknown> = {
    source: 'grok-jsonl',
    ...m.extra,
    event_id: eventId,
    ordinal: m.ordinal,
    session_jsonl_path: sourcePath,
  }
  if (typeof m.lineIndex === 'number') metadata.session_jsonl_line = m.lineIndex
  if (m.eventId) metadata.native_event_id = m.eventId
  if (m.eventTs) metadata.event_ts = m.eventTs
  if (herdr?.paneId) {
    metadata.herdr_pane_id = herdr.paneId
    if (herdr.workspaceId) metadata.herdr_workspace_id = herdr.workspaceId
    if (herdr.host) metadata.herdr_host = herdr.host
  }
  return {
    event_id: eventId,
    role: m.role as CaptureMessage['role'],
    content: m.content ?? '',
    metadata,
    ...(m.toolName ? { tool_name: m.toolName } : {}),
    ...(m.toolArgs != null ? { tool_args: m.toolArgs } : {}),
    ...(typeof m.toolResult === 'string' ? { tool_result: m.toolResult } : {}),
    ...(m.eventTs && !Number.isNaN(Date.parse(m.eventTs)) ? { created_at: m.eventTs } : {}),
  }
}

export async function ingestSession(
  op: CaptureOp,
  sink: Partial<CaptureWriterOptions> = {},
): Promise<void> {
  return withFileLock(lockPathFor(op.sessionId), () => ingestSessionLocked(op, sink), {
    waitMs: STATE_LOCK_TIMEOUT_MS,
    pollMs: STATE_LOCK_RETRY_MS,
  })
}

async function ingestSessionLocked(
  op: CaptureOp,
  sink: Partial<CaptureWriterOptions>,
): Promise<void> {
  const transport = resolveCaptureTransport(process.env)

  const sessionKey = deriveSessionKey(op.sessionId)
  let pool: import('pg').Pool | undefined
  let client: PoolClient | undefined
  let inTx = false
  let statePublished = false

  try {
    if (transport.kind === 'none') throw new Error(transport.reason)
    if (transport.kind === 'pg') {
      const { default: pg } = await import('pg')
      pool = new pg.Pool({ connectionString: resolvePgUrl(), max: 1 })
      client = await pool.connect()
      await client.query(`SET statement_timeout = ${STATEMENT_TIMEOUT_MS}`)
      await client.query('BEGIN')
      inTx = true
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [sessionKey])
    }

    // Read → mutate → publish entirely inside the per-session locks.
    const priorState = readSessionState(op.sessionId)

    const sessionDir = findSessionDir(op.sessionId, process.env.GROK_WORKSPACE_ROOT)
    if (!sessionDir) {
      const err = `session dir not found (workspaceRoot=${process.env.GROK_WORKSPACE_ROOT ?? 'unset'})`
      log(`ingest ${sessionKey}: ${err}`)
      // Genuine miss under <sessions>/<cwd>/<id>. Access errors throw above
      // and are recorded as failures; do not treat them as not-found.
      if (client) await client.query('COMMIT')
      inTx = false
      return
    }

    const updatesPath = path.join(sessionDir, 'updates.jsonl')
    let jsonlText: string
    try {
      jsonlText = fs.readFileSync(updatesPath, 'utf8')
    } catch (err) {
      const msg = `updates.jsonl unreadable: ${(err as Error).message}`
      log(`ingest ${sessionKey}: ${msg}`)
      writeSessionState(nextFailureState(op.sessionId, msg, priorState))
      statePublished = true
      throw new Error(msg, { cause: err })
    }

    const parsed = parseUpdates(jsonlText)
    const summary = readSessionSummary(sessionDir)
    const title = summary.title?.trim() || 'Grok Build session'

    if (transport.kind === 'den') {
      const batch: CaptureBatch = {
        session_key: sessionKey,
        agent: CAPTURE_AGENT,
        channel: CAPTURE_CHANNEL,
        title: title.slice(0, 120),
        settings: {
          source: 'grok-jsonl',
          sessionId: op.sessionId,
          sessionDir,
          modelId: summary.modelId ?? null,
          agentName: summary.agentName ?? null,
          triggerEvent: op.sourceEvent ?? null,
        },
        finalize: op.finalize,
        messages: parsed.map((m) => toCaptureMessage(m, sessionKey, updatesPath, op.herdr)),
      }
      const result = await createCaptureWriter({ ...sink, denUrl: transport.denUrl, log }).write(
        batch,
      )
      if ('spooled' in result && !result.spooled) throw new Error(result.error)
      writeSessionState(nextSuccessState(op.sessionId))
      statePublished = true
      return
    }
    if (!client) throw new Error('pg capture requires a client')

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
    const sessionJsonlPath = path.join(sessionDir, 'updates.jsonl')
    for (const m of toInsert) {
      await insertMessage(client, conv.id, m, sessionJsonlPath, op.herdr)
    }

    if (op.finalize) {
      await client.query(
        `UPDATE ros_conversations
            SET active = false, updated_at = now()
          WHERE id = $1 AND active = true`,
        [conv.id],
      )
    } else if (toInsert.length > 0) {
      await client.query(`UPDATE ros_conversations SET updated_at = now() WHERE id = $1`, [conv.id])
    }

    await client.query('COMMIT')
    inTx = false
    // Publish success only after COMMIT so a rejected commit increments the
    // prior failure streak instead of resetting it to 1.
    writeSessionState(nextSuccessState(op.sessionId))
    statePublished = true

    const msg = `parsed=${parsed.length} stored_before=${stored} inserted=${toInsert.length}${op.finalize ? ' finalized' : ''}`
    log(`ingest ${sessionKey}: ${msg}`)
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err)
    log(`ingest ${op.sessionId} FAIL: ${errMsg}`)

    // Local file lock (acquired at the start of try) serializes this RMW
    // even when connect/advisory-lock failed. Commit failures land here
    // with statePublished still false, so the prior streak is preserved.
    if (!statePublished) {
      const priorState = readSessionState(op.sessionId)
      writeSessionState(nextFailureState(op.sessionId, errMsg, priorState))
    }

    if (inTx && client) {
      await client.query('ROLLBACK').catch(() => {})
    }

    throw err
  } finally {
    if (client) {
      try {
        client.release()
      } catch {
        // ignore
      }
    }
    if (pool) {
      await pool.end().catch(() => {})
    }
  }
}

async function runWorker(spoolFile?: string) {
  let files: string[]
  if (spoolFile) {
    files = [spoolFile]
  } else {
    fs.mkdirSync(SPOOL_DIR, { recursive: true })
    files = fs
      .readdirSync(SPOOL_DIR)
      .filter((f) => f.endsWith('.json'))
      .map((f) => path.join(SPOOL_DIR, f))
  }

  let hadFailure = false
  for (const file of files) {
    let op: CaptureOp
    try {
      op = JSON.parse(fs.readFileSync(file, 'utf8')) as CaptureOp
    } catch (e) {
      if (isErrnoCode(e, 'ENOENT')) {
        // Spool file already gone (e.g. a concurrent, idempotent worker processed
        // it). Benign no-op — not an ingest failure.
        log(`worker: spool file already gone, skipping ${file}`)
        continue
      }
      const msg = `worker failed reading ${file}: ${e}`
      log(msg)
      hadFailure = true
      continue
    }

    try {
      await ingestSession(op)
    } catch (e) {
      const msg = `worker failed on ${file}: ${e}`
      log(msg)
      hadFailure = true
      // Don't unlink the spool file on failure - retry later
      continue
    }

    try {
      fs.unlinkSync(file)
    } catch (e) {
      if (isErrnoCode(e, 'ENOENT')) {
        log(`worker: spool already unlinked, skipping ${file}`)
        continue
      }
      const msg = `worker failed unlinking ${file}: ${e}`
      log(msg)
      hadFailure = true
    }
  }

  // Exit non-zero if any ingest failed
  if (hadFailure) {
    process.exit(1)
  }
}

// ---------------------------------------------------------------------------
// CLI entrypoint (for hooks and worker)
// ---------------------------------------------------------------------------
async function main() {
  const args = process.argv.slice(2)
  if (args[0] === '--status') {
    console.log(`transport=${resolveCaptureTransport(process.env).kind}`)
    return
  }

  if (args[0] === '--worker') {
    await runWorker(args[1])
    return
  }

  if (args[0] === '--health') {
    // Health check: report stuck sessions
    const stuck = checkStuckSessions()
    if (stuck.length > 0) {
      console.error('STUCK SESSIONS DETECTED:')
      for (const s of stuck) {
        console.error(`  ${s}`)
      }
      process.exit(1)
    }
    console.log('OK: No stuck sessions')
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
        process.stdin.on('data', (chunk: Buffer) => {
          data += chunk.toString()
        })
        process.stdin.on('end', () => resolve(data))
      })
      if (input.trim()) {
        const parsed: unknown = JSON.parse(input)
        if (isRecord(parsed)) payload = parsed
      }
    } catch {
      /* best effort */
    }

    const sessionId =
      process.env.GROK_SESSION_ID ||
      (typeof payload.sessionId === 'string' ? payload.sessionId : undefined) ||
      `unknown-${String(Date.now())}`

    // SessionEnd marks the conversation inactive. Other events just trigger an
    // ingest pass; the worker is fully idempotent so extra fires are harmless.
    const finalize = /end|End/.test(event)

    // herdr pane identity rides the spool (the detached worker must not
    // depend on env inheritance). Absent when the pane is not herdr-launched.
    const herdr =
      process.env.HERDR_ENV === '1' && process.env.HERDR_PANE_ID
        ? {
            paneId: process.env.HERDR_PANE_ID,
            workspaceId: process.env.HERDR_WORKSPACE_ID,
            host: os.hostname(),
          }
        : undefined

    enqueue({ kind: 'ingest', sessionId, finalize, sourceEvent: event, herdr })
    process.exit(0) // always succeed fast
  }

  console.log('Usage:')
  console.log('  grok-memory-capture --hook <event>  # enqueue ingest from Grok hook')
  console.log('  grok-memory-capture --worker [file] # run detached worker')
  console.log('  grok-memory-capture --health        # check for stuck sessions')
}

main().catch((err: unknown) => {
  log(`fatal: ${err}`)
  // Worker init (mkdir/readdir of spool, etc.) must fail loud. Hook mode
  // still exits 0 so the Grok session is never blocked.
  process.exit(process.argv.includes('--worker') ? 1 : 0)
})
