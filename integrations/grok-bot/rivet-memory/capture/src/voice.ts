/**
 * Reader for Grok Bot `agents/<id>/voice-calls/*.json` turns.
 *
 * Real call JSON (verified read-only) has top-level `callId` and
 * `startedAtMs` (int). Each turn has `speaker` and `atMs` (int).
 * `toolCalls` is a call-level list (`$.toolCalls`); each item has
 * `argumentsJson` (string) and `result: { atMs, json }`. Nudges are
 * dropped (hidden-turn policy). Fixture content is synthetic.
 *
 * Turn indices are not the on-disk jsonl line index, so ingest uses
 * SESSION_SUFFIX_V3_VOICE (plus `-<stem>` per call file).
 */
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { capForStorage, isRecord } from '@rivetos/capture-core'
import { SESSION_SUFFIX_V3_VOICE, STORAGE_LIMIT } from './types.js'

export { SESSION_SUFFIX_V3_VOICE }

export interface VoiceToolCall {
  name: string
  input?: unknown
  /** Capped arguments JSON; kept on the tool row even when a result exists. */
  argumentsJson?: string
  id?: string
  result?: string
  atMs?: number
  started_at?: string
  truncated?: boolean
  fullResultLength?: number
  fullArgumentsLength?: number
}

export interface VoiceTurn {
  role: string
  text: string
  started_at?: string
  atMs?: number
  toolCalls: VoiceToolCall[]
  /** Present on the wire; dropped at record emit (hidden-turn policy). */
  nudgeCount: number
}

export interface VoiceCall {
  id: string
  started_at?: string
  startedAtMs?: number
  file: string
  turns: VoiceTurn[]
  toolCalls: VoiceToolCall[]
}

export function voiceCallsDir(agentsDir: string, agentId: string): string {
  return resolve(agentsDir, agentId, 'voice-calls')
}

export function listVoiceCallFiles(dir: string): string[] {
  if (!existsSync(dir)) return []
  try {
    if (!statSync(dir).isDirectory()) return []
  } catch {
    return []
  }
  return readdirSync(dir)
    .filter((n) => n.endsWith('.json'))
    .sort()
    .map((n) => join(dir, n))
}

export function parseVoiceCall(text: string, file = 'voice.json'): VoiceCall {
  const raw = JSON.parse(text) as unknown
  if (Array.isArray(raw)) {
    return {
      id: stemOf(file),
      file,
      turns: raw.map(turnFromUnknown),
      toolCalls: [],
    }
  }
  if (!isRecord(raw)) {
    throw new Error('voice-calls file must be a JSON object or an array of turns')
  }
  const turnsRaw = raw.turns ?? raw.messages ?? raw.utterances
  if (!Array.isArray(turnsRaw)) {
    throw new Error('voice-calls file is missing a turns/messages/utterances array')
  }
  const id =
    (typeof raw.callId === 'string' && raw.callId) ||
    (typeof raw.call_id === 'string' && raw.call_id) ||
    (typeof raw.id === 'string' && raw.id) ||
    stemOf(file)
  const startedAtMs =
    typeof raw.startedAtMs === 'number'
      ? raw.startedAtMs
      : typeof raw.started_at_ms === 'number'
        ? raw.started_at_ms
        : undefined
  const started = msToIso(startedAtMs) ?? stringTime(raw, ['started_at', 'startedAt'])
  const callTools = parseToolCalls(raw.toolCalls ?? raw.tool_calls)
  const turns = turnsRaw.map(turnFromUnknown)
  return { id, started_at: started, startedAtMs, file, turns, toolCalls: callTools }
}

export function readVoiceCallFile(file: string): VoiceCall {
  return parseVoiceCall(readFileSync(file, 'utf8'), file)
}

export function voiceCallToRecords(call: VoiceCall): { records: unknown[]; positions: number[] } {
  type Ev = {
    atMs: number
    turnIndex: number
    kind: 'turn' | 'tool'
    turn?: VoiceTurn
    tool?: VoiceToolCall
  }
  const events: Ev[] = []
  for (const [i, t] of call.turns.entries()) {
    const atMs = t.atMs ?? parseIsoMs(t.started_at) ?? call.startedAtMs ?? 0
    events.push({ atMs, turnIndex: i, kind: 'turn', turn: t })
    for (const tool of t.toolCalls) {
      events.push({
        atMs: tool.atMs ?? atMs,
        turnIndex: i,
        kind: 'tool',
        tool,
      })
    }
  }
  for (const tool of call.toolCalls) {
    const atMs = tool.atMs ?? call.startedAtMs ?? 0
    events.push({
      atMs,
      turnIndex: nearestTurnIndex(call.turns, atMs, call.startedAtMs),
      kind: 'tool',
      tool,
    })
  }
  events.sort((a, b) => a.atMs - b.atMs || kindRank(a.kind) - kindRank(b.kind))

  const records: unknown[] = []
  const positions: number[] = []
  for (const ev of events) {
    if (ev.kind === 'turn' && ev.turn) {
      if (!ev.turn.text) continue
      const created = ev.turn.started_at ?? msToIso(ev.atMs) ?? call.started_at
      records.push({
        role: ev.turn.role || 'assistant',
        message: {
          role: ev.turn.role || 'assistant',
          content: [{ type: 'text', text: ev.turn.text }],
        },
        created_at: created,
        voice_call_id: call.id,
        voice_turn: ev.turnIndex,
      })
      positions.push(ev.turnIndex)
      continue
    }
    if (ev.kind === 'tool' && ev.tool) {
      const created = ev.tool.started_at ?? msToIso(ev.atMs) ?? call.started_at
      const part: Record<string, unknown> = {
        type: 'tool_result',
        name: ev.tool.name,
        result: summarizeToolCall(ev.tool),
      }
      if (ev.tool.argumentsJson !== undefined) part.argumentsJson = ev.tool.argumentsJson
      if (ev.tool.truncated) {
        part.truncated = true
        if (ev.tool.fullResultLength !== undefined) {
          part.full_tool_result_length = ev.tool.fullResultLength
        }
        if (ev.tool.fullArgumentsLength !== undefined) {
          part.full_arguments_length = ev.tool.fullArgumentsLength
        }
      }
      records.push({
        role: 'tool',
        message: {
          content: [part],
        },
        created_at: created,
        voice_call_id: call.id,
        voice_turn: ev.turnIndex,
      })
      positions.push(ev.turnIndex)
    }
  }
  return { records, positions }
}

export function v3VoiceSession(session: string, callStem?: string): string {
  const base = session.includes(SESSION_SUFFIX_V3_VOICE)
    ? session
    : `${session}${SESSION_SUFFIX_V3_VOICE}`
  if (!callStem) return base
  const stem = slugStem(callStem)
  return base.endsWith(`-${stem}`) ? base : `${base}-${stem}`
}

export function slugStem(fileOrStem: string): string {
  return (
    basename(fileOrStem, '.json')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'call'
  )
}

export function msToIso(raw: unknown): string | undefined {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return undefined
  const ms = raw < 1e12 ? raw * 1000 : raw
  const d = new Date(ms)
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString()
}

function stemOf(file: string): string {
  return slugStem(file)
}

function kindRank(kind: 'turn' | 'tool'): number {
  return kind === 'turn' ? 0 : 1
}

function parseIsoMs(iso?: string): number | undefined {
  if (!iso) return undefined
  const n = Date.parse(iso)
  return Number.isNaN(n) ? undefined : n
}

function nearestTurnIndex(turns: VoiceTurn[], atMs: number, fallbackMs?: number): number {
  if (turns.length === 0) return 0
  let nearest = 0
  let best = Number.POSITIVE_INFINITY
  for (const [i, t] of turns.entries()) {
    const tMs = t.atMs ?? parseIsoMs(t.started_at) ?? fallbackMs ?? 0
    const d = Math.abs(atMs - tMs)
    if (d < best || (d === best && tMs <= atMs)) {
      best = d
      nearest = i
    }
  }
  return nearest
}

function speakerToRole(speaker: unknown): string {
  if (typeof speaker !== 'string') return 'assistant'
  const s = speaker.toLowerCase()
  if (s === 'user' || s === 'human') return 'user'
  if (s === 'assistant' || s === 'model' || s === 'bot' || s === 'agent') return 'assistant'
  if (s === 'tool') return 'tool'
  if (s === 'system') return 'system'
  return 'assistant'
}

function turnFromUnknown(raw: unknown): VoiceTurn {
  if (!isRecord(raw)) {
    const text =
      typeof raw === 'string'
        ? raw
        : typeof raw === 'number' || typeof raw === 'boolean'
          ? String(raw)
          : ''
    return { role: 'assistant', text, toolCalls: [], nudgeCount: 0 }
  }
  const role = speakerToRole(raw.speaker ?? raw.role)
  const text =
    stringField(raw, ['text', 'content', 'transcript', 'utterance']) ||
    (typeof raw.message === 'string' ? raw.message : '')
  const atMs =
    typeof raw.atMs === 'number'
      ? raw.atMs
      : typeof raw.at_ms === 'number'
        ? raw.at_ms
        : typeof raw.timestampMs === 'number'
          ? raw.timestampMs
          : undefined
  const started_at = msToIso(atMs) ?? stringField(raw, ['started_at', 'startedAt', 'created_at'])
  const toolCalls = parseToolCalls(raw.toolCalls ?? raw.tool_calls)
  return {
    role,
    text,
    started_at,
    atMs,
    toolCalls,
    nudgeCount: countNudges(raw.nudges ?? raw.nudge),
  }
}

function parseToolCalls(raw: unknown): VoiceToolCall[] {
  if (!Array.isArray(raw)) return []
  const out: VoiceToolCall[] = []
  for (const item of raw) {
    if (!isRecord(item)) continue
    const name =
      (typeof item.name === 'string' && item.name) ||
      (typeof item.toolName === 'string' && item.toolName) ||
      (isRecord(item.function) && typeof item.function.name === 'string'
        ? item.function.name
        : '') ||
      'tool'
    const input = parseArgumentsJson(item)
    const argsCap = capUnknown(argumentsJsonRaw(item, input))
    const resultCap = capUnknown(toolResultRaw(item))
    const atMs = toolAtMs(item)
    const truncated = Boolean((argsCap && argsCap.truncated) || (resultCap && resultCap.truncated))
    out.push({
      name,
      input,
      argumentsJson: argsCap?.text,
      id: typeof item.id === 'string' ? item.id : undefined,
      result: resultCap?.text,
      atMs,
      started_at: msToIso(atMs),
      truncated: truncated || undefined,
      fullResultLength: resultCap?.truncated ? resultCap.fullLength : undefined,
      fullArgumentsLength: argsCap?.truncated ? argsCap.fullLength : undefined,
    })
  }
  return out
}

function parseArgumentsJson(item: Record<string, unknown>): unknown {
  if (typeof item.argumentsJson === 'string') return parseJsonString(item.argumentsJson)
  if (item.input !== undefined) return item.input
  if (item.arguments !== undefined) return item.arguments
  if (item.args !== undefined) return item.args
  if (isRecord(item.function)) return item.function.arguments
  return undefined
}

function argumentsJsonRaw(item: Record<string, unknown>, input: unknown): string | undefined {
  if (typeof item.argumentsJson === 'string') return item.argumentsJson
  if (input === undefined) return undefined
  return typeof input === 'string' ? input : safeJson(input)
}

function toolResultRaw(item: Record<string, unknown>): string | undefined {
  const res = item.result
  if (isRecord(res) && res.json !== undefined) {
    return typeof res.json === 'string' ? res.json : safeJson(res.json)
  }
  if (typeof res === 'string') return res
  if (typeof item.output === 'string') return item.output
  return undefined
}

function toolAtMs(item: Record<string, unknown>): number | undefined {
  if (isRecord(item.result) && typeof item.result.atMs === 'number') return item.result.atMs
  if (typeof item.atMs === 'number') return item.atMs
  if (typeof item.at_ms === 'number') return item.at_ms
  return undefined
}

function parseJsonString(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown
  } catch {
    return raw
  }
}

function capUnknown(
  value: unknown,
): { text: string; truncated: boolean; fullLength: number } | undefined {
  if (value === undefined) return undefined
  const raw = typeof value === 'string' ? value : safeJson(value)
  return capForStorage(raw, { limit: STORAGE_LIMIT })
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value)
  } catch {
    return ''
  }
}

function summarizeToolCall(tool: VoiceToolCall): string {
  if (tool.result) return tool.result
  const name = tool.name || 'tool'
  if (tool.argumentsJson) return tool.argumentsJson
  if (tool.input == null) return name
  const raw = typeof tool.input === 'string' ? tool.input : safeJson(tool.input)
  const capped = capForStorage(raw, { limit: STORAGE_LIMIT }).text
  return capped ? `${name} ${capped}` : name
}

function countNudges(raw: unknown): number {
  if (Array.isArray(raw)) return raw.length
  return raw == null ? 0 : 1
}

function stringField(obj: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = obj[k]
    if (typeof v === 'string' && v) return v
  }
  return undefined
}

function stringTime(obj: Record<string, unknown>, keys: string[]): string | undefined {
  const s = stringField(obj, keys)
  if (!s) return undefined
  const d = new Date(s)
  return Number.isNaN(d.getTime()) ? s : d.toISOString()
}
