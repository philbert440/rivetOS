/**
 * wire — pi 0.85.1 schemas, HarnessEvent translation, and the on-disk half
 * of the executor (finding a session file and reading back usage stdout may
 * not have carried).
 *
 * TWO formats, do not mix:
 *
 *   1. Runtime stdout (`pi --print --mode json`) is an event stream:
 *      session → agent_start → turn_start → message_start/update/end
 *      (user, assistant, toolResult) → turn_end → agent_end → agent_settled.
 *      Assistant text/thinking/tool calls arrive as
 *      `message_update.assistantMessageEvent` (`text_delta`/`thinking_delta`/
 *      `toolcall_*`). Final usage + stopReason live on assistant
 *      `message_end` / `turn_end`. This is what `toHarnessEvents` maps for
 *      live turns.
 *
 *   2. On-disk v3 session JSONL uses `{type:"message", message:{role,content}}`
 *      lines (`model_change`, `thinking_level_change`, …). That reader
 *      (`usageFromEvent` on `type:message`, `reconcileTurn`) is for the den
 *      transcript / post-hoc usage — never for stdout.
 *
 * Binary: `pi` (`@earendil-works/pi-coding-agent`). Data dir is `~/.pi/agent`
 * (no `$PI_HOME`). Session files:
 *
 *   ~/.pi/agent/sessions/<encoded-cwd>/<ISO-timestamp>_<uuid>.jsonl
 *
 * encoded-cwd replaces every `/` with `-` and wraps in dashes
 * (`/home/rivet` → `--home-rivet--`). Timestamp colons/dots become dashes
 * (`2026-09-11T14-25-16-803Z`). Native id is a UUID (any version; pi mints v7).
 *
 * Assistant `content` items on disk: `{type:text,text}`, `{type:thinking,thinking}`,
 * `{type:toolCall, id, name, arguments}`. Tool results are a SEPARATE
 * message `{role:"toolResult", toolCallId, toolName, content:[…]}`. Nested
 * `type:toolResult` items are still read as a fallback. Tool fields:
 * `name`/`toolName`, `id`/`toolCallId`, `arguments`/`input`, `result`/`content`.
 *
 * Assistant `message.usage` is `{input, output, cacheRead, cacheWrite,
 * reasoning, totalTokens}` (snake/camel aliases as fallbacks).
 *
 * Session files are cwd-bucketed under `~/.pi/agent/sessions/<encoded-cwd>/`
 * by default. A custom `--session-dir` is FLAT: `<dir>/<ts>_<id>.jsonl`
 * (no cwd bucket). Readers/listers accept both layouts.
 *
 * Reconcile is POST-HOC: the executor reads the jsonl after the child has
 * exited. A finished process leaves a complete file, and the one damaged
 * line a SIGKILL can leave behind is skipped, not fatal.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { HarnessEvent, SessionId } from '@rivetos/types'

/** Native session id — UUID, any version. */
export const PI_NATIVE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** `<ISO-timestamp-with-dashes>_<uuid>.jsonl` inside a cwd bucket. */
export const PI_SESSION_FILE_RE =
  /^(.+)_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i

/** `~/.pi/agent` — pi does not document `$PI_HOME`. */
export function piHome(_env: NodeJS.ProcessEnv = process.env): string {
  return path.join(os.homedir(), '.pi', 'agent')
}

/** `<home>/sessions`. */
export function sessionsRoot(home: string): string {
  return path.join(home, 'sessions')
}

/**
 * Cwd bucket name: replace every `/` with `-` and wrap in dashes.
 * `/home/rivet` → `--home-rivet--`.
 */
export function encodePiCwd(cwd: string): string {
  const trimmed = cwd.replace(/\/+$/, '') || '/'
  // Encode a trailing `/` so `/home/rivet` → `--home-rivet--`, not `--home-rivet-`.
  const slashed = trimmed === '/' ? '/' : `${trimmed}/`
  return `-${slashed.replaceAll('/', '-')}-`
}

export interface SessionLocation {
  home: string
  cwd: string
  sessionId: string
}

function nativeFromFilename(name: string): string | undefined {
  const m = name.match(PI_SESSION_FILE_RE)
  return m?.[2]
}

function pushSessionFile(
  out: Array<{ id: string; path: string; mtime: number }>,
  full: string,
  name: string,
): void {
  const id = nativeFromFilename(name)
  if (!id) return
  try {
    const st = fs.statSync(full)
    if (!st.isFile()) return
    out.push({ id, path: full, mtime: st.mtimeMs })
  } catch {
    /* skip */
  }
}

function walkSessionFiles(home: string): Array<{ id: string; path: string; mtime: number }> {
  const out: Array<{ id: string; path: string; mtime: number }> = []
  const root = sessionsRoot(home)
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
    // Custom `--session-dir` writes `<dir>/<ts>_<id>.jsonl` with no cwd bucket.
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
 * Absolute jsonl path for a known session id, preferring the cwd bucket when
 * given, else the newest mtime across flat `--session-dir` files and every
 * cwd bucket.
 */
export function findSessionFile(loc: SessionLocation): string | undefined {
  if (!PI_NATIVE_RE.test(loc.sessionId)) return undefined
  const root = sessionsRoot(loc.home)
  if (loc.cwd) {
    const bucket = path.join(root, encodePiCwd(loc.cwd))
    let names: string[]
    try {
      names = fs.readdirSync(bucket)
    } catch {
      names = []
    }
    let best: { path: string; mtime: number } | undefined
    for (const name of names) {
      if (nativeFromFilename(name) !== loc.sessionId) continue
      const full = path.join(bucket, name)
      try {
        const st = fs.statSync(full)
        if (!st.isFile()) continue
        if (!best || st.mtimeMs >= best.mtime) best = { path: full, mtime: st.mtimeMs }
      } catch {
        continue
      }
    }
    if (best) return best.path
  }
  let best: { path: string; mtime: number } | undefined
  for (const row of walkSessionFiles(loc.home)) {
    if (row.id !== loc.sessionId) continue
    if (!best || row.mtime >= best.mtime) best = row
  }
  return best?.path
}

/** Absolute jsonl path for a known session id, or undefined. */
export function resolveSessionPath(loc: SessionLocation): string | undefined {
  return findSessionFile(loc)
}

/**
 * Every session id pi knows under `home`. Walks flat files at the sessions
 * root (custom `--session-dir`) and every cwd bucket. `cwd` is accepted for
 * signature parity; listing is not scoped to it.
 */
export function listSessionIds(home: string, _cwd: string): Set<string> {
  const ids = new Set<string>()
  for (const row of walkSessionFiles(home)) ids.add(row.id)
  return ids
}

// ---------------------------------------------------------------------------
// Print/JSON event schema (session JSONL version 3)
// ---------------------------------------------------------------------------

export interface PiSessionEvent {
  type: 'session'
  version?: number
  id: string
  timestamp?: string
  cwd?: string
}

export interface PiModelChangeEvent {
  type: 'model_change'
  provider?: string
  modelId?: string
}

export interface PiThinkingLevelEvent {
  type: 'thinking_level_change'
  thinkingLevel?: string
}

export interface PiContentText {
  type: 'text'
  text: string
}

export interface PiContentThinking {
  type: 'thinking'
  thinking: string
  thinkingSignature?: string
}

export interface PiContentToolCall {
  type: 'toolCall' | 'tool_call' | 'toolUse' | 'tool_use'
  id?: string
  toolCallId?: string
  name?: string
  toolName?: string
  arguments?: unknown
  input?: unknown
}

export interface PiContentToolResult {
  type: 'toolResult' | 'tool_result'
  id?: string
  toolCallId?: string
  result?: unknown
  content?: unknown
}

export type PiContentItem =
  | PiContentText
  | PiContentThinking
  | PiContentToolCall
  | PiContentToolResult
  | { type: string; [key: string]: unknown }

export interface PiUsageFields {
  input?: number
  output?: number
  cacheRead?: number
  cacheWrite?: number
  reasoning?: number
  totalTokens?: number
  input_tokens?: number
  output_tokens?: number
  cache_read_tokens?: number
  cache_write_tokens?: number
  inputTokens?: number
  outputTokens?: number
  promptTokens?: number
  completionTokens?: number
}

export interface PiMessageBody {
  role?: string
  content?: PiContentItem[] | string
  timestamp?: number
  usage?: PiUsageFields
  stopReason?: string
  toolCallId?: string
  toolName?: string
  id?: string
  name?: string
}

export interface PiMessageEvent {
  type: 'message'
  id?: string
  parentId?: string | null
  timestamp?: string
  message: PiMessageBody
}

/** `message_update.assistantMessageEvent` — incremental stdout only. */
export interface PiAssistantMessageEvent {
  type: string
  contentIndex?: number
  delta?: string
  content?: unknown
  id?: string
  toolCallId?: string
  name?: string
  toolName?: string
  arguments?: unknown
  input?: unknown
  partial?: unknown
  toolCall?: unknown
}

export interface PiMessageUpdateEvent {
  type: 'message_update'
  usage?: PiUsageFields
  assistantMessageEvent?: PiAssistantMessageEvent
}

export interface PiRuntimeMessageEvent {
  type: 'message_start' | 'message_end' | 'turn_end'
  message?: PiMessageBody
}

export interface PiAgentLifecycleEvent {
  type: 'agent_start' | 'turn_start' | 'agent_end' | 'agent_settled'
  messages?: unknown
}

export interface PiUnknownEvent {
  type: string
  [key: string]: unknown
}

export type PiJsonEvent =
  | PiSessionEvent
  | PiModelChangeEvent
  | PiThinkingLevelEvent
  | PiMessageEvent
  | PiMessageUpdateEvent
  | PiRuntimeMessageEvent
  | PiAgentLifecycleEvent
  | PiUnknownEvent

/** Opening (or anytime) carrier of the native session id. */
export const SESSION_TYPE = 'session'

/** Runtime stdout types that mean the agent turn has finished emitting. */
export const RUNTIME_TERMINAL_TYPES = new Set(['agent_end', 'agent_settled', 'turn_end'])

/** stopReason values that are errors, not a normal stop. */
export function isFatalPiStopReason(reason: string | undefined): boolean {
  if (reason === undefined || reason === '') return false
  const r = reason.toLowerCase()
  return r === 'error' || r === 'aborted'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function pickStr(obj: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const v = obj[key]
    if (typeof v === 'string' && v !== '') return v
  }
  return undefined
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined
}

/** Nested `message` on runtime `message_start` / `message_end` / `turn_end`. */
export function runtimeMessage(event: PiJsonEvent): PiMessageBody | undefined {
  if (event.type !== 'message_start' && event.type !== 'message_end' && event.type !== 'turn_end') {
    return undefined
  }
  const msg = (event as PiRuntimeMessageEvent).message
  return isRecord(msg) ? msg : undefined
}

/** Incremental assistant event on a runtime `message_update` line. */
export function assistantMessageEvent(event: PiJsonEvent): PiAssistantMessageEvent | undefined {
  if (event.type !== 'message_update') return undefined
  const inner = (event as PiMessageUpdateEvent).assistantMessageEvent
  return isRecord(inner) ? inner : undefined
}

function toolCallFields(raw: Record<string, unknown>): {
  id?: string
  name?: string
  input: unknown
} {
  const nested =
    asRecord(raw.content) ??
    asRecord(raw.partial) ??
    asRecord(raw.toolCall) ??
    asRecord(raw.tool_call)
  const id =
    pickStr(raw, 'id', 'toolCallId') ?? (nested ? pickStr(nested, 'id', 'toolCallId') : undefined)
  const name =
    pickStr(raw, 'name', 'toolName') ?? (nested ? pickStr(nested, 'name', 'toolName') : undefined)
  const input = raw.arguments ?? raw.input ?? nested?.arguments ?? nested?.input ?? {}
  return { id, name, input }
}

/** Parse one NDJSON line into a `PiJsonEvent`. Non-JSON / non-object / missing
 *  `type` → undefined (skipped, never fatal). */
export function parsePiJsonLine(line: string): PiJsonEvent | undefined {
  const trimmed = line.trim()
  if (!trimmed) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return undefined
  }
  if (!isRecord(parsed)) return undefined
  const type = parsed.type
  if (typeof type !== 'string' || type === '') return undefined
  return parsed as PiJsonEvent
}

export function sessionIdFromEvent(event: PiJsonEvent): string | undefined {
  if (event.type !== 'session') return undefined
  const rec = event as unknown as Record<string, unknown>
  const id = pickStr(rec, 'id', 'session_id', 'sessionId')
  return id && PI_NATIVE_RE.test(id) ? id : id
}

function contentItems(message: PiMessageBody | undefined): Record<string, unknown>[] {
  if (!message) return []
  const content = message.content
  if (typeof content === 'string') {
    return content ? [{ type: 'text', text: content }] : []
  }
  if (!Array.isArray(content)) return []
  return content.filter(isRecord).map((item) => Object.fromEntries(Object.entries(item)))
}

function toolResultOutput(raw: unknown): unknown {
  if (typeof raw === 'string') return raw
  if (Array.isArray(raw)) {
    const texts = raw.filter(isRecord).flatMap((item) => {
      if (typeof item.text === 'string' && item.text !== '') return [item.text]
      if (typeof item.result === 'string' && item.result !== '') return [item.result]
      return []
    })
    if (texts.length > 0) return texts.join('\n')
  }
  return raw ?? ''
}

function emitToolResult(out: HarnessEvent[], sid: SessionId, rec: Record<string, unknown>): void {
  const id = pickStr(rec, 'toolCallId', 'id')
  if (!id) return
  out.push({
    type: 'tool-result',
    sessionId: sid,
    toolCallId: id,
    name: pickStr(rec, 'toolName', 'name') ?? '',
    output: rec.result ?? toolResultOutput(rec.content) ?? '',
  })
}

/**
 * Map one on-disk v3 `type:message` line onto control-plane `HarnessEvent`s.
 * Used by the den transcript path. Do not feed stdout through this.
 */
export function toHarnessEventsFromDisk(event: PiJsonEvent, sessionId: string): HarnessEvent[] {
  if (!sessionId) return []
  const sid = sessionId as SessionId
  if (event.type === 'session') {
    return [{ type: 'session-updated', sessionId: sid, status: 'active' }]
  }
  if (event.type !== 'message') return []
  const msg = (event as PiMessageEvent).message
  if (!isRecord(msg)) return []
  const role = msg.role
  const out: HarnessEvent[] = []
  if (role === 'toolResult' || role === 'tool_result') {
    emitToolResult(out, sid, msg)
    return out
  }
  for (const item of contentItems(msg)) {
    const t = item.type
    if (t === 'text' && typeof item.text === 'string' && item.text !== '') {
      if (role === 'assistant') {
        out.push({ type: 'assistant-delta', sessionId: sid, text: item.text })
      }
    } else if (t === 'thinking' && typeof item.thinking === 'string' && item.thinking !== '') {
      out.push({ type: 'reasoning-delta', sessionId: sid, text: item.thinking })
    } else if (t === 'toolCall' || t === 'tool_call' || t === 'toolUse' || t === 'tool_use') {
      const id = pickStr(item, 'id', 'toolCallId')
      const name = pickStr(item, 'name', 'toolName')
      if (!id || !name) continue
      out.push({
        type: 'tool-use',
        sessionId: sid,
        toolCallId: id,
        name,
        input: item.arguments ?? item.input ?? {},
      })
    } else if (t === 'toolResult' || t === 'tool_result') {
      emitToolResult(out, sid, item)
    }
  }
  return out
}

/**
 * Map one runtime stdout event onto control-plane `HarnessEvent`s.
 *
 * Text/thinking come from `message_update` deltas only — the final
 * `message_end` snapshot is NOT replayed here (callers that saw no deltas
 * may fall back to the snapshot themselves). Tool calls from
 * `toolcall_start`/`toolcall_end`; tool results from `role:toolResult`
 * `message_end`. `stopReason` error/aborted → `error`. `turn_end` →
 * `turn-complete`.
 *
 * `sessionId` must already be canonical (`pi:<native>`) or a native id —
 * callers that have neither get `[]` (nothing to attribute).
 */
export function toHarnessEvents(event: PiJsonEvent, sessionId: string): HarnessEvent[] {
  if (!sessionId) return []
  const sid = sessionId as SessionId

  switch (event.type) {
    case 'session':
      return [{ type: 'session-updated', sessionId: sid, status: 'active' }]
    case 'message_update': {
      const inner = assistantMessageEvent(event)
      if (!inner) return []
      const t = inner.type
      if (t === 'text_delta' && typeof inner.delta === 'string' && inner.delta !== '') {
        return [{ type: 'assistant-delta', sessionId: sid, text: inner.delta }]
      }
      if (t === 'thinking_delta' && typeof inner.delta === 'string' && inner.delta !== '') {
        return [{ type: 'reasoning-delta', sessionId: sid, text: inner.delta }]
      }
      if (
        t === 'toolcall_start' ||
        t === 'toolcall_end' ||
        t === 'tool_call_start' ||
        t === 'tool_call_end'
      ) {
        const fields = toolCallFields(inner as unknown as Record<string, unknown>)
        if (!fields.id || !fields.name) return []
        return [
          {
            type: 'tool-use',
            sessionId: sid,
            toolCallId: fields.id,
            name: fields.name,
            input: fields.input,
          },
        ]
      }
      return []
    }
    case 'message_start':
    case 'message_end': {
      const msg = runtimeMessage(event)
      if (!msg) return []
      const out: HarnessEvent[] = []
      if (msg.role === 'toolResult' || msg.role === 'tool_result') {
        emitToolResult(out, sid, msg as unknown as Record<string, unknown>)
      }
      if (
        event.type === 'message_end' &&
        msg.role === 'assistant' &&
        isFatalPiStopReason(msg.stopReason)
      ) {
        out.push({
          type: 'error',
          sessionId: sid,
          code: msg.stopReason ?? 'error',
          message: `pi stopReason: ${msg.stopReason}`,
        })
      }
      return out
    }
    case 'turn_end': {
      const msg = runtimeMessage(event)
      const stopReason = msg?.stopReason
      const out: HarnessEvent[] = []
      if (isFatalPiStopReason(stopReason)) {
        out.push({
          type: 'error',
          sessionId: sid,
          code: stopReason ?? 'error',
          message: `pi stopReason: ${stopReason}`,
        })
      }
      out.push({ type: 'turn-complete', sessionId: sid, stopReason })
      return out
    }
    case 'message':
      return toHarnessEventsFromDisk(event, sessionId)
    default:
      return []
  }
}

/** Sum token fields; unknown shapes degrade to 0. Real keys first, aliases fallback. */
export function tokensFromUsage(u: PiUsageFields | undefined): {
  inputTokens: number
  outputTokens: number
} {
  if (u === undefined) return { inputTokens: 0, outputTokens: 0 }
  const input = num(u.input) || num(u.input_tokens) || num(u.inputTokens) || num(u.promptTokens)
  const output =
    num(u.output) || num(u.output_tokens) || num(u.outputTokens) || num(u.completionTokens)
  const cacheRead = num(u.cacheRead) || num(u.cache_read_tokens)
  const cacheWrite = num(u.cacheWrite) || num(u.cache_write_tokens)
  return {
    inputTokens: input + cacheRead + cacheWrite,
    outputTokens: output,
  }
}

function assistantUsageMessage(event: PiJsonEvent): PiMessageBody | undefined {
  if (event.type === 'message') {
    const msg = (event as PiMessageEvent).message
    return isRecord(msg) ? msg : undefined
  }
  if (event.type === 'message_end' || event.type === 'turn_end') {
    return runtimeMessage(event)
  }
  return undefined
}

export function usageFromEvent(
  event: PiJsonEvent,
): { inputTokens: number; outputTokens: number } | undefined {
  const msg = assistantUsageMessage(event)
  if (!msg || msg.role !== 'assistant' || msg.usage === undefined) return undefined
  if (msg.stopReason === 'pending') return undefined
  const tokens = tokensFromUsage(msg.usage)
  if (tokens.inputTokens === 0 && tokens.outputTokens === 0) return undefined
  return tokens
}

// ---------------------------------------------------------------------------
// Reconcile
// ---------------------------------------------------------------------------

export interface PiTurnUsage {
  inputTokens: number
  outputTokens: number
  totalTokens: number
}

export interface PiTurnEnd {
  reason: string
  turnId?: number
  durationMs?: number
  timeMs: number
}

export interface PiTurnFacts {
  usage: PiTurnUsage
  /** Usage records counted into `usage`. Zero means "found nothing". */
  usageRecords: number
  /** Newest assistant stopReason at or after the spawn clock. */
  turnEnded?: PiTurnEnd
  /** Transcript files read. */
  files: number
  /** Lines that were not parseable JSON — tolerated, never fatal. */
  malformed: number
}

export function emptyPiTurnFacts(): PiTurnFacts {
  return {
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    usageRecords: 0,
    files: 0,
    malformed: 0,
  }
}

/** The session jsonl itself (pi stores one file per session, not a dir). */
export function transcriptFilesFor(sessionFile: string): string[] {
  try {
    return fs.statSync(sessionFile).isFile() ? [sessionFile] : []
  } catch {
    return []
  }
}

function eventTimeMs(event: PiJsonEvent): number | undefined {
  const rec = event as PiUnknownEvent
  if (typeof rec.timestamp === 'number') return rec.timestamp
  if (typeof rec.timestamp === 'string') {
    const parsed = Date.parse(rec.timestamp)
    if (Number.isFinite(parsed)) return parsed
  }
  if (event.type === 'message') {
    const ts = (event as PiMessageEvent).message?.timestamp
    if (typeof ts === 'number') return ts
  }
  return undefined
}

/**
 * Sum one turn's usage out of a session jsonl.
 *
 * `sinceMs` is the spawn clock: records that carry a timestamp are filtered
 * to this turn. Records without a timestamp are counted. Never throws.
 *
 * `sessionDir` is the jsonl path (name kept so executor call sites stay small).
 */
export function reconcileTurn(opts: { sessionDir: string; sinceMs: number }): PiTurnFacts {
  const facts = emptyPiTurnFacts()
  for (const file of transcriptFilesFor(opts.sessionDir)) {
    let text: string
    try {
      text = fs.readFileSync(file, 'utf8')
    } catch {
      continue
    }
    facts.files += 1
    for (const raw of text.split('\n')) {
      const line = raw.trim()
      if (!line) continue
      const event = parsePiJsonLine(line)
      if (event === undefined) {
        facts.malformed += 1
        continue
      }
      const timeMs = eventTimeMs(event)
      if (timeMs !== undefined && timeMs < opts.sinceMs) continue

      const tokens = usageFromEvent(event)
      if (tokens) {
        facts.usage.inputTokens += tokens.inputTokens
        facts.usage.outputTokens += tokens.outputTokens
        facts.usageRecords += 1
      }

      if (event.type === 'message') {
        const msg = (event as PiMessageEvent).message
        if (msg?.role === 'assistant' && typeof msg.stopReason === 'string' && msg.stopReason) {
          const ended: PiTurnEnd = {
            reason: msg.stopReason,
            timeMs: timeMs ?? 0,
          }
          if (facts.turnEnded === undefined || ended.timeMs >= facts.turnEnded.timeMs) {
            facts.turnEnded = ended
          }
        }
      }
    }
  }
  facts.usage.totalTokens = facts.usage.inputTokens + facts.usage.outputTokens
  return facts
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}
