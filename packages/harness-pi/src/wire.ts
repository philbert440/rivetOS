/**
 * wire — pi print/JSON event schema, HarnessEvent translation, and the on-disk
 * half of the executor (finding a session transcript and reading back usage
 * stdout may not have carried).
 *
 * REVIEWER-CONFIRM: exact print/JSON event schema of
 * `@earendil-works/pi-coding-agent`. The shapes below are a working contract
 * the fake binary and tests speak; they have not been verified against an
 * installed `pi` binary. Swap field names / types here (and in fake-pi) if
 * the real stream differs.
 *
 * Assumed NDJSON (one JSON object per stdout line) for
 * `pi --print --mode json`:
 *
 *   {"type":"session","session_id":"<native>"}
 *   {"type":"assistant","content":"…"}
 *   {"type":"thinking","content":"…"}
 *   {"type":"tool_start","id":"<call-id>","name":"<tool>","input":{…}}
 *   {"type":"tool_end","id":"<call-id>","output":"…","is_error":false}
 *   {"type":"usage","input_tokens":N,"output_tokens":N,
 *     "cache_read_tokens":N,"usage_scope":"turn","time":…}
 *   {"type":"turn_end","reason":"completed","duration_ms":N,"time":…}
 *   {"type":"result","session_id":"<native>","text":"…","usage":{…}}
 *   {"type":"error","message":"…"}
 *
 * A successful one-shot emits `session` (or a terminal `result` carrying
 * `session_id`), zero or more assistant/tool events, then `result`. Usage may
 * arrive as standalone `usage` lines and/or nested on `result`.
 *
 * On-disk layout (also REVIEWER-CONFIRM):
 *   $PI_HOME/sessions/<session_id>/transcript.jsonl
 *   PI_HOME defaults to `~/.pi/agent`.
 *
 * Reconcile is POST-HOC: the executor reads the transcript after the child
 * has exited. A finished process leaves a complete file, and the one damaged
 * line a SIGKILL can leave behind is skipped, not fatal.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { HarnessEvent, SessionId } from '@rivetos/types'

/** Transcript file name inside a session directory. */
export const TRANSCRIPT_FILE = 'transcript.jsonl'

/** `$PI_HOME`, else `~/.pi/agent` — REVIEWER-CONFIRM vs real pi data dir. */
export function piHome(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.PI_HOME?.trim()
  return explicit && explicit.length > 0 ? explicit : path.join(os.homedir(), '.pi', 'agent')
}

/** `<home>/sessions`. */
export function sessionsRoot(home: string): string {
  return path.join(home, 'sessions')
}

export interface SessionLocation {
  home: string
  cwd: string
  sessionId: string
}

/** Absolute session directory for a known session id, or undefined. */
export function resolveSessionDir(loc: SessionLocation): string | undefined {
  const guess = path.join(sessionsRoot(loc.home), loc.sessionId)
  return dirExists(guess) ? guess : undefined
}

/**
 * Every session id pi knows under `home`.
 *
 * `cwd` is accepted for signature parity with kimi-code; this first cut does
 * not cwd-scope the listing (REVIEWER-CONFIRM: whether pi buckets sessions
 * by working directory). Used for the failure path that never printed a
 * session id: snapshot before spawn, diff after. One new id is the spawn's;
 * several means concurrent spawns and the executor declines to guess.
 */
export function listSessionIds(home: string, _cwd: string): Set<string> {
  const ids = new Set<string>()
  const root = sessionsRoot(home)
  let names: string[]
  try {
    names = fs.readdirSync(root)
  } catch {
    return ids
  }
  for (const name of names) {
    if (name.startsWith('.')) continue
    const full = path.join(root, name)
    try {
      if (fs.statSync(full).isDirectory()) ids.add(name)
      else if (name.endsWith('.jsonl')) ids.add(name.slice(0, -'.jsonl'.length))
    } catch {
      continue
    }
  }
  return ids
}

function dirExists(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory()
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Print/JSON event schema
// ---------------------------------------------------------------------------

export interface PiSessionEvent {
  type: 'session'
  session_id: string
}

export interface PiAssistantEvent {
  type: 'assistant'
  content: string
}

export interface PiThinkingEvent {
  type: 'thinking'
  content: string
}

export interface PiToolStartEvent {
  type: 'tool_start'
  id: string
  name: string
  input?: unknown
}

export interface PiToolEndEvent {
  type: 'tool_end'
  id: string
  output?: unknown
  is_error?: boolean
}

export interface PiUsageFields {
  input_tokens?: number
  output_tokens?: number
  cache_read_tokens?: number
  cache_write_tokens?: number
}

export interface PiUsageEvent extends PiUsageFields {
  type: 'usage'
  /** `"turn"` is summed; `"session"` rollups are ignored (kimi-code lesson). */
  usage_scope?: 'turn' | 'session'
  time?: number
}

export interface PiTurnEndEvent {
  type: 'turn_end'
  reason: string
  turn_id?: number
  duration_ms?: number
  time?: number
}

export interface PiResultEvent {
  type: 'result'
  session_id?: string
  text?: string
  usage?: PiUsageFields
}

export interface PiErrorEvent {
  type: 'error'
  message: string
}

export interface PiUnknownEvent {
  type: string
  [key: string]: unknown
}

export type PiJsonEvent =
  | PiSessionEvent
  | PiAssistantEvent
  | PiThinkingEvent
  | PiToolStartEvent
  | PiToolEndEvent
  | PiUsageEvent
  | PiTurnEndEvent
  | PiResultEvent
  | PiErrorEvent
  | PiUnknownEvent

/** Terminal stdout marker analogous to kimi's `session.resume_hint`. */
export const RESULT_TYPE = 'result'
/** Opening (or anytime) carrier of the native session id. */
export const SESSION_TYPE = 'session'

/**
 * Parse one NDJSON line into a `PiJsonEvent`. Non-JSON / non-object / missing
 * `type` → undefined (skipped, never fatal).
 */
export function parsePiJsonLine(line: string): PiJsonEvent | undefined {
  const trimmed = line.trim()
  if (!trimmed) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  const type = (parsed as { type?: unknown }).type
  if (typeof type !== 'string' || type === '') return undefined
  return parsed as PiJsonEvent
}

/**
 * Map one print/JSON event onto control-plane `HarnessEvent`s.
 *
 * REVIEWER-CONFIRM: this mapping is the assumed schema → HarnessEvent. The
 * executor itself emits `TaskEvent` (den bodies) the way kimi-code does;
 * this helper is the typed wire for drivers/tests that want HarnessEvent.
 *
 * `sessionId` must already be canonical (`pi:<native>`) or a native id —
 * callers that have neither get `[]` (nothing to attribute).
 */
export function toHarnessEvents(event: PiJsonEvent, sessionId: string): HarnessEvent[] {
  if (!sessionId) return []
  const sid = sessionId as SessionId

  switch (event.type) {
    case 'session':
      return [
        {
          type: 'session-updated',
          sessionId: sid,
          status: 'active',
        },
      ]
    case 'assistant': {
      const content = (event as PiAssistantEvent).content
      if (typeof content !== 'string' || content === '') return []
      return [{ type: 'assistant-delta', sessionId: sid, text: content }]
    }
    case 'thinking': {
      const content = (event as PiThinkingEvent).content
      if (typeof content !== 'string' || content === '') return []
      return [{ type: 'reasoning-delta', sessionId: sid, text: content }]
    }
    case 'tool_start': {
      const start = event as PiToolStartEvent
      if (typeof start.id !== 'string' || typeof start.name !== 'string') return []
      return [
        {
          type: 'tool-use',
          sessionId: sid,
          toolCallId: start.id,
          name: start.name,
          input: start.input ?? {},
        },
      ]
    }
    case 'tool_end': {
      const end = event as PiToolEndEvent
      if (typeof end.id !== 'string') return []
      return [
        {
          type: 'tool-result',
          sessionId: sid,
          toolCallId: end.id,
          name: '',
          output: end.output ?? '',
          ...(end.is_error === true ? { isError: true } : {}),
        },
      ]
    }
    case 'result':
      return [
        {
          type: 'turn-complete',
          sessionId: sid,
          stopReason: 'end-turn',
        },
      ]
    case 'turn_end': {
      const ended = event as PiTurnEndEvent
      return [
        {
          type: 'turn-complete',
          sessionId: sid,
          stopReason: ended.reason,
        },
      ]
    }
    case 'error': {
      const err = event as PiErrorEvent
      if (typeof err.message !== 'string' || err.message === '') return []
      return [
        {
          type: 'error',
          sessionId: sid,
          code: 'pi_error',
          message: err.message,
        },
      ]
    }
    default:
      return []
  }
}

/** Sum token fields the way kimi sums inputOther + cache read/write. */
export function tokensFromUsage(u: PiUsageFields | undefined): { inputTokens: number; outputTokens: number } {
  if (u === undefined) return { inputTokens: 0, outputTokens: 0 }
  return {
    inputTokens: num(u.input_tokens) + num(u.cache_read_tokens) + num(u.cache_write_tokens),
    outputTokens: num(u.output_tokens),
  }
}

export function usageFromEvent(event: PiJsonEvent): { inputTokens: number; outputTokens: number } | undefined {
  if (event.type === 'usage') {
    const usage = event as PiUsageEvent
    if (usage.usage_scope === 'session') return undefined
    return tokensFromUsage(usage)
  }
  if (event.type === 'result') {
    const usage = (event as PiResultEvent).usage
    if (usage === undefined) return undefined
    return tokensFromUsage(usage)
  }
  return undefined
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
  /** `usage` lines counted into `usage`. Zero means "found nothing". */
  usageRecords: number
  /** Newest `turn_end` at or after the spawn clock. */
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

/** `<sessionDir>/transcript.jsonl` when present. */
export function transcriptFilesFor(sessionDir: string): string[] {
  const file = path.join(sessionDir, TRANSCRIPT_FILE)
  try {
    return fs.statSync(file).isFile() ? [file] : []
  } catch {
    return []
  }
}

/**
 * Sum one turn's usage out of a session's transcript.
 *
 * `sinceMs` is the spawn clock: usage records that carry `time` are filtered
 * to this turn. Records without `time` are counted (print/JSON copies may
 * omit it). Session-scoped rollups (`usage_scope:"session"`) are ignored.
 *
 * Never throws: an unreadable file or a torn line degrades the numbers, and
 * zero usage is a truthful "we could not tell", not a failed turn.
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
      const record = event as PiUnknownEvent
      const timeMs = typeof record.time === 'number' ? record.time : undefined
      if (timeMs !== undefined && timeMs < opts.sinceMs) continue

      if (event.type === 'usage') {
        const usage = event as PiUsageEvent
        if (usage.usage_scope === 'session') continue
        const tokens = tokensFromUsage(usage)
        facts.usage.inputTokens += tokens.inputTokens
        facts.usage.outputTokens += tokens.outputTokens
        facts.usageRecords += 1
        continue
      }

      if (event.type === 'turn_end' && typeof (event as PiTurnEndEvent).reason === 'string') {
        const endedEvent = event as PiTurnEndEvent
        const ended: PiTurnEnd = {
          reason: endedEvent.reason,
          timeMs: timeMs ?? 0,
          ...(typeof endedEvent.turn_id === 'number' ? { turnId: endedEvent.turn_id } : {}),
          ...(typeof endedEvent.duration_ms === 'number'
            ? { durationMs: endedEvent.duration_ms }
            : {}),
        }
        if (facts.turnEnded === undefined || ended.timeMs >= facts.turnEnded.timeMs) {
          facts.turnEnded = ended
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
