/**
 * wire — Qwen Code 0.23.4 schemas, HarnessEvent translation, and the on-disk
 * half of the executor (finding a session file and reading back usage stdout
 * may not have carried).
 *
 * TWO formats, do not mix:
 *
 *   1. Runtime stdout (`qwen -p --output-format stream-json`) is a
 *      Claude-shaped event stream:
 *      system/init → stream_event (content_block_delta thinking_delta /
 *      text_delta / input_json_delta) → assistant (one line per content
 *      block: thinking | text | tool_use) → user (tool_result) → result.
 *      Usage on the non-thinking assistant block is the per-turn figure;
 *      result.usage is the whole-run total (fallback). This is what
 *      `toHarnessEvents` maps for live turns.
 *
 *   2. On-disk jsonl uses gemini-style parts
 *      (`type:user|assistant|tool_result|system`). That reader
 *      (`toHarnessEventsFromDisk`, `reconcileTurn`) is for the den
 *      transcript / post-hoc usage — never for stdout.
 *
 * Binary: `qwen` (`@qwen-code/qwen-code`). Data dir is `~/.qwen` (no env
 * override documented). Session files:
 *
 *   ~/.qwen/projects/<encoded-cwd>/chats/<uuid>.jsonl
 *
 * encoded-cwd replaces every `/` with `-` (leading `/` → leading `-`, NO
 * trailing dash: `/home/rivet` → `-home-rivet`). Native id is a UUID (any
 * version). Skip `*.runtime.json` sidecars when listing.
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
export const QWEN_NATIVE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** `<uuid>.jsonl` inside a project chats dir. Sidecar `*.runtime.json` is not a transcript. */
export const QWEN_SESSION_FILE_RE =
  /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i

/** `~/.qwen` — no `$QWEN_HOME` is documented. Config `home` overrides at the caller. */
export function qwenHome(_env: NodeJS.ProcessEnv = process.env): string {
  return path.join(os.homedir(), '.qwen')
}

/** `<home>/projects`. */
export function qwenProjectsRoot(home: string): string {
  return path.join(home, 'projects')
}

/**
 * Cwd bucket name: replace every `/` with `-`. Leading slash becomes a
 * leading dash; no trailing dash.
 * `/home/rivet` → `-home-rivet`. `/home/rivet/` → `-home-rivet`.
 */
export function encodeQwenCwd(cwd: string): string {
  const trimmed = cwd.replace(/\/+$/, '') || '/'
  return trimmed.replaceAll('/', '-')
}

export interface SessionLocation {
  home: string
  cwd: string
  sessionId: string
}

function nativeFromFilename(name: string): string | undefined {
  if (name.endsWith('.runtime.json')) return undefined
  const m = name.match(QWEN_SESSION_FILE_RE)
  return m?.[1]
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
  const root = qwenProjectsRoot(home)
  let projects: string[]
  try {
    projects = fs.readdirSync(root)
  } catch {
    return out
  }
  for (const project of projects) {
    if (project.startsWith('.')) continue
    const chats = path.join(root, project, 'chats')
    let names: string[]
    try {
      names = fs.readdirSync(chats)
    } catch {
      continue
    }
    for (const name of names) {
      pushSessionFile(out, path.join(chats, name), name)
    }
  }
  return out
}

/**
 * Absolute jsonl path for a known session id, preferring the cwd bucket when
 * given, else the newest mtime across every project chats dir.
 */
export function findSessionFile(loc: SessionLocation): string | undefined {
  if (!QWEN_NATIVE_RE.test(loc.sessionId)) return undefined
  const root = qwenProjectsRoot(loc.home)
  if (loc.cwd) {
    const file = path.join(root, encodeQwenCwd(loc.cwd), 'chats', `${loc.sessionId}.jsonl`)
    try {
      if (fs.statSync(file).isFile()) return file
    } catch {
      /* fall through to a full walk */
    }
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
 * Every session id qwen knows under `home`. Walks every
 * `projects/<enc-cwd>/chats/<uuid>.jsonl`. Skips `*.runtime.json`. `cwd` is accepted
 * for signature parity; listing is not scoped to it.
 */
export function listSessionIds(home: string, _cwd: string): Set<string> {
  const ids = new Set<string>()
  for (const row of walkSessionFiles(home)) ids.add(row.id)
  return ids
}

// ---------------------------------------------------------------------------
// Runtime stream-json schema
// ---------------------------------------------------------------------------

export interface QwenUsageFields {
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number
  total_tokens?: number
  input?: number
  output?: number
  cacheRead?: number
}

export interface QwenContentThinking {
  type: 'thinking'
  thinking?: string
  signature?: string
}

export interface QwenContentText {
  type: 'text'
  text?: string
}

export interface QwenContentToolUse {
  type: 'tool_use'
  id?: string
  name?: string
  input?: unknown
}

export type QwenContentItem =
  | QwenContentThinking
  | QwenContentText
  | QwenContentToolUse
  | { type: string; [key: string]: unknown }

export interface QwenAssistantMessage {
  id?: string
  type?: string
  role?: string
  model?: string
  content?: QwenContentItem[]
  /** On-disk gemini-style parts (not present on stdout assistant lines). */
  parts?: unknown
  stop_reason?: string | null
  usage?: QwenUsageFields
}

export interface QwenSystemInitEvent {
  type: 'system'
  subtype?: string
  session_id?: string
  uuid?: string
  cwd?: string
  model?: string
  permission_mode?: string
  qwen_code_version?: string
  tools?: unknown
  mcp_servers?: unknown
  [key: string]: unknown | undefined
}

export interface QwenStreamDelta {
  type?: string
  thinking?: string
  text?: string
  partial_json?: string
}

export interface QwenStreamInner {
  type?: string
  index?: number
  delta?: QwenStreamDelta
  content_block?: Record<string, unknown>
  message?: Record<string, unknown>
}

export interface QwenStreamEvent {
  type: 'stream_event'
  session_id?: string
  uuid?: string
  parent_tool_use_id?: unknown
  event?: QwenStreamInner
  [key: string]: unknown | undefined
}

export interface QwenAssistantEvent {
  type: 'assistant'
  session_id?: string
  uuid?: string
  parent_tool_use_id?: unknown
  message?: QwenAssistantMessage
  usageMetadata?: Record<string, unknown>
  [key: string]: unknown | undefined
}

export interface QwenToolResultItem {
  type?: string
  tool_use_id?: string
  is_error?: boolean
  content?: unknown
}

export interface QwenUserEvent {
  type: 'user'
  session_id?: string
  uuid?: string
  parent_tool_use_id?: unknown
  message?: { role?: string; content?: QwenToolResultItem[] }
  [key: string]: unknown | undefined
}

export interface QwenResultEvent {
  type: 'result'
  subtype?: string
  session_id?: string
  uuid?: string
  is_error?: boolean
  result?: string
  usage?: QwenUsageFields
  num_turns?: number
  duration_ms?: number
  duration_api_ms?: number
  permission_denials?: unknown
  [key: string]: unknown | undefined
}

export interface QwenUnknownEvent {
  type: string
  [key: string]: unknown | undefined
}

export type QwenJsonEvent =
  | QwenSystemInitEvent
  | QwenStreamEvent
  | QwenAssistantEvent
  | QwenUserEvent
  | QwenResultEvent
  | QwenUnknownEvent

/** Opening carrier of the native session id (`system` + `subtype:init`). */
export const SESSION_TYPE = 'system'

/** Runtime stdout types that mean the agent turn has finished emitting. */
export const RUNTIME_TERMINAL_TYPES = new Set(['result'])

/**
 * `result.is_error` or a non-success `subtype` is fatal. Empty/missing
 * subtype is not treated as success.
 */
export function isFatalQwenResult(
  result: { is_error?: boolean; subtype?: string } | undefined,
): boolean {
  if (result === undefined) return false
  if (result.is_error === true) return true
  return result.subtype !== 'success'
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

/** Nested `event` on a runtime `stream_event` line. */
export function streamEventInner(event: QwenJsonEvent): QwenStreamInner | undefined {
  if (event.type !== 'stream_event') return undefined
  const inner = (event as QwenStreamEvent).event
  return isRecord(inner) ? inner : undefined
}

/** Nested `message` on a runtime `assistant` line. */
export function assistantMessage(event: QwenJsonEvent): QwenAssistantMessage | undefined {
  if (event.type !== 'assistant') return undefined
  const msg = (event as QwenAssistantEvent).message
  return isRecord(msg) ? msg : undefined
}

/** Parse one NDJSON line into a `QwenJsonEvent`. Non-JSON / non-object /
 *  missing `type` → undefined (skipped, never fatal). */
export function parseQwenJsonLine(line: string): QwenJsonEvent | undefined {
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
  return parsed as QwenJsonEvent
}

export function sessionIdFromEvent(event: QwenJsonEvent): string | undefined {
  const rec = event as unknown as Record<string, unknown>
  if (event.type === 'system') {
    const subtype = rec.subtype
    if (subtype !== undefined && subtype !== 'init') return undefined
  }
  const id = pickStr(rec, 'session_id', 'sessionId', 'id')
  if (!id) return undefined
  return id
}

function isInitLine(event: QwenJsonEvent): boolean {
  if (event.type !== 'system') return false
  const subtype = (event as QwenSystemInitEvent).subtype
  return subtype === undefined || subtype === 'init'
}

function contentItems(message: QwenAssistantMessage | undefined): QwenContentItem[] {
  if (!message) return []
  const content = message.content
  if (!Array.isArray(content)) return []
  return content
}

function isQwenToolUse(item: QwenContentItem): item is QwenContentToolUse {
  return item.type === 'tool_use'
}

function toolResultOutput(raw: unknown): unknown {
  if (typeof raw === 'string') return raw
  if (Array.isArray(raw)) {
    const texts = raw.filter(isRecord).flatMap((item) => {
      if (typeof item.text === 'string' && item.text !== '') return [item.text]
      return []
    })
    if (texts.length > 0) return texts.join('\n')
  }
  return raw ?? ''
}

/**
 * Map one runtime stdout event onto control-plane `HarnessEvent`s.
 *
 * Text/thinking come from `stream_event` deltas only — the final `assistant`
 * snapshot is NOT replayed here (callers that saw no deltas may fall back to
 * the snapshot themselves). Tool calls from `assistant` `tool_use` blocks;
 * tool results from `user` `tool_result`. `result.is_error` /
 * `subtype !== 'success'` → `error`. `result` → `turn-complete`.
 *
 * `sessionId` must already be canonical (`qwen-code:<native>`) or a native
 * id — callers that have neither get `[]`.
 */
export function toHarnessEvents(event: QwenJsonEvent, sessionId: string): HarnessEvent[] {
  if (!sessionId) return []
  const sid = sessionId as SessionId

  switch (event.type) {
    case 'system':
      if (!isInitLine(event)) return []
      return [{ type: 'session-updated', sessionId: sid, status: 'active' }]
    case 'stream_event': {
      const inner = streamEventInner(event)
      if (!inner || inner.type !== 'content_block_delta') return []
      const delta = inner.delta
      if (!isRecord(delta)) return []
      if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string' && delta.thinking) {
        return [{ type: 'reasoning-delta', sessionId: sid, text: delta.thinking }]
      }
      if (delta.type === 'text_delta' && typeof delta.text === 'string' && delta.text) {
        return [{ type: 'assistant-delta', sessionId: sid, text: delta.text }]
      }
      return []
    }
    case 'assistant': {
      const msg = assistantMessage(event)
      const out: HarnessEvent[] = []
      for (const item of contentItems(msg)) {
        if (!isQwenToolUse(item)) continue
        const id = typeof item.id === 'string' && item.id !== '' ? item.id : undefined
        const name = typeof item.name === 'string' && item.name !== '' ? item.name : undefined
        if (!id || !name) continue
        out.push({
          type: 'tool-use',
          sessionId: sid,
          toolCallId: id,
          name,
          input: item.input ?? {},
        })
      }
      return out
    }
    case 'user': {
      const msg = (event as QwenUserEvent).message
      if (!isRecord(msg) || !Array.isArray(msg.content)) return []
      const out: HarnessEvent[] = []
      for (const raw of msg.content) {
        if (!isRecord(raw) || raw.type !== 'tool_result') continue
        const id = pickStr(raw, 'tool_use_id', 'toolUseId', 'id')
        if (!id) continue
        out.push({
          type: 'tool-result',
          sessionId: sid,
          toolCallId: id,
          name: pickStr(raw, 'name') ?? '',
          output: toolResultOutput(raw.content) ?? '',
          isError: raw.is_error === true,
        })
      }
      return out
    }
    case 'result': {
      const rec = event as QwenResultEvent
      const out: HarnessEvent[] = []
      if (isFatalQwenResult(rec)) {
        out.push({
          type: 'error',
          sessionId: sid,
          code: rec.subtype ?? 'error',
          message: `qwen result: ${rec.subtype ?? 'error'}`,
        })
      }
      out.push({
        type: 'turn-complete',
        sessionId: sid,
        stopReason: rec.subtype,
      })
      return out
    }
    default:
      return []
  }
}

// ---------------------------------------------------------------------------
// On-disk gemini-style jsonl
// ---------------------------------------------------------------------------

interface DiskPart {
  text?: string
  thought?: boolean
  functionCall?: { id?: string; name?: string; args?: unknown }
  functionResponse?: {
    id?: string
    name?: string
    response?: { output?: unknown }
  }
}

function diskParts(event: QwenJsonEvent): DiskPart[] {
  const rec = event as unknown as Record<string, unknown>
  const message = isRecord(rec.message) ? rec.message : undefined
  const parts = message?.parts
  if (!Array.isArray(parts)) return []
  return parts.filter(isRecord) as DiskPart[]
}

/**
 * Map one on-disk jsonl line onto control-plane `HarnessEvent`s.
 * Used by the den transcript path. Skip `type:system`. Do not feed stdout
 * through this.
 */
export function toHarnessEventsFromDisk(event: QwenJsonEvent, sessionId: string): HarnessEvent[] {
  if (!sessionId) return []
  const sid = sessionId as SessionId
  const rec = event as unknown as Record<string, unknown>
  const out: HarnessEvent[] = []

  if (event.type === 'system') return []

  if (event.type === 'assistant') {
    for (const part of diskParts(event)) {
      if (part.functionCall) {
        const id = part.functionCall.id
        const name = part.functionCall.name
        if (!id || !name) continue
        out.push({
          type: 'tool-use',
          sessionId: sid,
          toolCallId: id,
          name,
          input: part.functionCall.args ?? {},
        })
        continue
      }
      if (typeof part.text !== 'string' || part.text === '') continue
      if (part.thought === true) {
        out.push({ type: 'reasoning-delta', sessionId: sid, text: part.text })
      } else {
        out.push({ type: 'assistant-delta', sessionId: sid, text: part.text })
      }
    }
    return out
  }

  if (event.type === 'tool_result') {
    for (const part of diskParts(event)) {
      const fr = part.functionResponse
      if (!fr?.id) continue
      out.push({
        type: 'tool-result',
        sessionId: sid,
        toolCallId: fr.id,
        name: fr.name ?? '',
        output: fr.response?.output ?? '',
      })
    }
    return out
  }

  if (event.type === 'user' && rec.provenance === 'real_user') {
    return []
  }

  return out
}

/**
 * Sum token fields; unknown shapes degrade to 0. Runtime keys first, disk aliases fallback.
 *
 * Prompt totals (`input_tokens` / `promptTokenCount` / `input_token_count`)
 * already include cache. `cacheRead` is a subset of that prompt, not extra —
 * same as the den adapter. Callers must not add `cacheRead` onto `inputTokens`.
 */
export function tokensFromUsage(u: QwenUsageFields | Record<string, unknown> | undefined): {
  inputTokens: number
  outputTokens: number
  cacheRead: number
} {
  if (u === undefined) return { inputTokens: 0, outputTokens: 0, cacheRead: 0 }
  const input =
    num(u.input_tokens) ||
    num((u as Record<string, unknown>).promptTokenCount) ||
    num((u as Record<string, unknown>).input_token_count) ||
    num(u.input)
  const output =
    num(u.output_tokens) ||
    num((u as Record<string, unknown>).candidatesTokenCount) ||
    num((u as Record<string, unknown>).output_token_count) ||
    num(u.output)
  const cacheRead =
    num(u.cache_read_input_tokens) ||
    num((u as Record<string, unknown>).cachedContentTokenCount) ||
    num((u as Record<string, unknown>).cached_content_token_count) ||
    num(u.cacheRead)
  return { inputTokens: input, outputTokens: output, cacheRead }
}

function usageIsNonZero(tokens: {
  inputTokens: number
  outputTokens: number
  cacheRead: number
}): boolean {
  return tokens.inputTokens !== 0 || tokens.outputTokens !== 0 || tokens.cacheRead !== 0
}

/**
 * Per-turn usage from a runtime `assistant` line with non-zero usage, or
 * `result.usage` as the whole-run fallback. Disk `assistant.usageMetadata`
 * and `ui_telemetry` `qwen-code.api_response` are accepted for reconcile.
 */
export function usageFromEvent(
  event: QwenJsonEvent,
): { inputTokens: number; outputTokens: number; cacheRead: number } | undefined {
  if (event.type === 'assistant') {
    const msg = assistantMessage(event)
    if (msg?.usage) {
      const tokens = tokensFromUsage(msg.usage)
      return usageIsNonZero(tokens) ? tokens : undefined
    }
    const rec = event as unknown as Record<string, unknown>
    if (isRecord(rec.usageMetadata)) {
      const tokens = tokensFromUsage(rec.usageMetadata)
      return usageIsNonZero(tokens) ? tokens : undefined
    }
    return undefined
  }
  if (event.type === 'result') {
    const tokens = tokensFromUsage((event as QwenResultEvent).usage)
    return usageIsNonZero(tokens) ? tokens : undefined
  }
  if (event.type === 'system') {
    const rec = event as unknown as Record<string, unknown>
    if (rec.subtype !== 'ui_telemetry') return undefined
    const payload = isRecord(rec.systemPayload) ? rec.systemPayload : undefined
    const uiEvent = isRecord(payload?.uiEvent) ? payload.uiEvent : undefined
    if (!uiEvent || uiEvent['event.name'] !== 'qwen-code.api_response') return undefined
    const tokens = tokensFromUsage(uiEvent)
    return usageIsNonZero(tokens) ? tokens : undefined
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Reconcile
// ---------------------------------------------------------------------------

export interface QwenTurnUsage {
  inputTokens: number
  outputTokens: number
  totalTokens: number
  cacheRead?: number
}

export interface QwenTurnEnd {
  reason: string
  turnId?: number
  durationMs?: number
  timeMs: number
}

export interface QwenTurnFacts {
  usage: QwenTurnUsage
  /** Usage records counted into `usage`. Zero means "found nothing". */
  usageRecords: number
  /** Newest assistant/result timestamp at or after the spawn clock. */
  turnEnded?: QwenTurnEnd
  /** Transcript files read. */
  files: number
  /** Lines that were not parseable JSON — tolerated, never fatal. */
  malformed: number
}

export function emptyQwenTurnFacts(): QwenTurnFacts {
  return {
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    usageRecords: 0,
    files: 0,
    malformed: 0,
  }
}

/** The session jsonl itself (qwen stores one file per session, not a dir). */
export function transcriptFilesFor(sessionFile: string): string[] {
  try {
    return fs.statSync(sessionFile).isFile() ? [sessionFile] : []
  } catch {
    return []
  }
}

function eventTimeMs(event: QwenJsonEvent): number | undefined {
  const rec = event as QwenUnknownEvent
  if (typeof rec.timestamp === 'number') return rec.timestamp
  if (typeof rec.timestamp === 'string') {
    const parsed = Date.parse(rec.timestamp)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

/**
 * Sum one turn's usage out of a session jsonl.
 *
 * Prefers `type:assistant` `usageMetadata`. `ui_telemetry`
 * `qwen-code.api_response` is counted only when no assistant usage was
 * found. `sinceMs` is the spawn clock. Never throws.
 *
 * Cached tokens are a subset of the prompt total: they are recorded on
 * `cacheRead` and not added to `inputTokens`.
 *
 * `sessionDir` is the jsonl path (name kept so executor call sites stay small).
 */
export function reconcileTurn(opts: { sessionDir: string; sinceMs: number }): QwenTurnFacts {
  const facts = emptyQwenTurnFacts()
  const telemetry: Array<{ tokens: ReturnType<typeof tokensFromUsage>; timeMs: number }> = []
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
      const event = parseQwenJsonLine(line)
      if (event === undefined) {
        facts.malformed += 1
        continue
      }
      const timeMs = eventTimeMs(event)
      if (timeMs !== undefined && timeMs < opts.sinceMs) continue

      if (event.type === 'assistant') {
        const tokens = usageFromEvent(event)
        if (tokens) {
          facts.usage.inputTokens += tokens.inputTokens
          facts.usage.outputTokens += tokens.outputTokens
          facts.usage.cacheRead = (facts.usage.cacheRead ?? 0) + tokens.cacheRead
          facts.usageRecords += 1
        }
        const ended: QwenTurnEnd = { reason: 'completed', timeMs: timeMs ?? 0 }
        if (facts.turnEnded === undefined || ended.timeMs >= facts.turnEnded.timeMs) {
          facts.turnEnded = ended
        }
      } else if (event.type === 'system') {
        const tokens = usageFromEvent(event)
        if (tokens) telemetry.push({ tokens, timeMs: timeMs ?? 0 })
      }
    }
  }
  if (facts.usageRecords === 0) {
    for (const row of telemetry) {
      facts.usage.inputTokens += row.tokens.inputTokens
      facts.usage.outputTokens += row.tokens.outputTokens
      facts.usage.cacheRead = (facts.usage.cacheRead ?? 0) + row.tokens.cacheRead
      facts.usageRecords += 1
    }
  }
  facts.usage.totalTokens = facts.usage.inputTokens + facts.usage.outputTokens
  return facts
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}
