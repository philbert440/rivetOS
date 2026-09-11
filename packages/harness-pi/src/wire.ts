/**
 * wire — pi 0.85.1 print/JSON event schema (`--print --mode json` emits the
 * same JSONL as the on-disk session file), HarnessEvent translation, and the
 * on-disk half of the executor (finding a session file and reading back usage
 * stdout may not have carried).
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
 * JSONL version 3, one object per line. `--print --mode json` prints these
 * same lines on stdout (the `session` line first, so the native id is on the
 * first stdout line):
 *
 *   {"type":"session","version":3,"id":"<uuid>","timestamp":"…","cwd":"…"}
 *   {"type":"model_change","provider":"deepseek","modelId":"deepseek-v4-flash"}
 *   {"type":"thinking_level_change","thinkingLevel":"high"}
 *   {"type":"message","id":"<8-hex>","parentId":…,"timestamp":"…",
 *     "message":{"role":"user"|"assistant","content":[…],"timestamp":ms,"usage"?}}
 *
 * Assistant `content` items: `{type:text,text}`, `{type:thinking,thinking}`,
 * `{type:toolCall,…}`, `{type:toolResult,…}` — tool fields are read
 * defensively (`name`/`toolName`, `id`/`toolCallId`, `arguments`/`input`,
 * `result`/`content`).
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
export const PI_NATIVE_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

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
  return `-${trimmed.replaceAll('/', '-')}-`
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

function walkSessionFiles(home: string): Array<{ id: string; path: string; mtime: number }> {
  const out: Array<{ id: string; path: string; mtime: number }> = []
  const root = sessionsRoot(home)
  let buckets: string[]
  try {
    buckets = fs.readdirSync(root)
  } catch {
    return out
  }
  for (const bucket of buckets) {
    if (bucket.startsWith('.')) continue
    const dir = path.join(root, bucket)
    let names: string[]
    try {
      if (!fs.statSync(dir).isDirectory()) continue
      names = fs.readdirSync(dir)
    } catch {
      continue
    }
    for (const name of names) {
      const id = nativeFromFilename(name)
      if (!id) continue
      const full = path.join(dir, name)
      try {
        const st = fs.statSync(full)
        if (!st.isFile()) continue
        out.push({ id, path: full, mtime: st.mtimeMs })
      } catch {
        continue
      }
    }
  }
  return out
}

/**
 * Absolute jsonl path for a known session id, preferring the cwd bucket when
 * given, else the newest mtime across every cwd bucket.
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

/** @deprecated name kept for call-site parity — returns the jsonl path. */
export function resolveSessionDir(loc: SessionLocation): string | undefined {
  return findSessionFile(loc)
}

/**
 * Every session id pi knows under `home`. Walks all cwd buckets. `cwd` is
 * accepted for signature parity; listing is not scoped to it.
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
  input_tokens?: number
  output_tokens?: number
  cache_read_tokens?: number
  cache_write_tokens?: number
  inputTokens?: number
  outputTokens?: number
  promptTokens?: number
  completionTokens?: number
  input?: number
  output?: number
}

export interface PiMessageBody {
  role?: string
  content?: PiContentItem[] | string
  timestamp?: number
  usage?: PiUsageFields
  stopReason?: string
}

export interface PiMessageEvent {
  type: 'message'
  id?: string
  parentId?: string | null
  timestamp?: string
  message: PiMessageBody
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
  | PiUnknownEvent

/** Opening (or anytime) carrier of the native session id. */
export const SESSION_TYPE = 'session'

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
  return content.filter(isRecord)
}

/**
 * Map one print/JSON event onto control-plane `HarnessEvent`s.
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
    case 'message': {
      const msg = (event as PiMessageEvent).message
      if (!isRecord(msg)) return []
      const role = msg.role
      const out: HarnessEvent[] = []
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
          const id = pickStr(item, 'id', 'toolCallId')
          if (!id) continue
          out.push({
            type: 'tool-result',
            sessionId: sid,
            toolCallId: id,
            name: '',
            output: item.result ?? item.content ?? '',
          })
        }
      }
      return out
    }
    default:
      return []
  }
}

/** Sum token fields; unknown shapes degrade to 0. */
export function tokensFromUsage(u: PiUsageFields | undefined): { inputTokens: number; outputTokens: number } {
  if (u === undefined) return { inputTokens: 0, outputTokens: 0 }
  const input =
    num(u.input_tokens) || num(u.inputTokens) || num(u.promptTokens) || num(u.input)
  const output =
    num(u.output_tokens) || num(u.outputTokens) || num(u.completionTokens) || num(u.output)
  const cacheRead = num(u.cache_read_tokens)
  const cacheWrite = num(u.cache_write_tokens)
  return {
    inputTokens: input + cacheRead + cacheWrite,
    outputTokens: output,
  }
}

export function usageFromEvent(event: PiJsonEvent): { inputTokens: number; outputTokens: number } | undefined {
  if (event.type !== 'message') return undefined
  const msg = (event as PiMessageEvent).message
  if (!isRecord(msg) || msg.role !== 'assistant' || msg.usage === undefined) return undefined
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
