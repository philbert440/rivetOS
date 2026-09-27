/**
 * Reader for Grok Bot `agents/<id>/voice-calls/*.json` turns.
 *
 * Real call JSON (verified read-only) has top-level `callId` and
 * `startedAtMs` (int). Each turn has `speaker` and `atMs` (int). Other
 * fields include `toolCalls` and `nudges`. Fixture content is synthetic.
 *
 * Turn indices are not the on-disk jsonl line index, so ingest uses
 * SESSION_SUFFIX_V3_VOICE (plus `-<stem>` per call file).
 */
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { isRecord } from '@rivetos/capture-core'
import { SESSION_SUFFIX_V3_VOICE } from './types.js'

export { SESSION_SUFFIX_V3_VOICE }

export interface VoiceToolCall {
  name: string
  input?: unknown
  id?: string
  result?: string
}

export interface VoiceTurn {
  role: string
  text: string
  started_at?: string
  toolCalls: VoiceToolCall[]
  /** Present on the wire; dropped at record emit (hidden-turn policy). */
  nudgeCount: number
}

export interface VoiceCall {
  id: string
  started_at?: string
  file: string
  turns: VoiceTurn[]
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
  const started =
    msToIso(raw.startedAtMs ?? raw.started_at_ms) ?? stringTime(raw, ['started_at', 'startedAt'])
  return { id, started_at: started, file, turns: turnsRaw.map(turnFromUnknown) }
}

export function readVoiceCallFile(file: string): VoiceCall {
  return parseVoiceCall(readFileSync(file, 'utf8'), file)
}

export function voiceCallToRecords(call: VoiceCall): { records: unknown[]; positions: number[] } {
  const records: unknown[] = []
  const positions: number[] = []
  for (let i = 0; i < call.turns.length; i++) {
    const t = call.turns[i]
    const created = t.started_at ?? call.started_at
    if (t.text) {
      records.push({
        role: t.role || 'assistant',
        message: { role: t.role || 'assistant', content: [{ type: 'text', text: t.text }] },
        created_at: created,
        voice_call_id: call.id,
        voice_turn: i,
      })
      positions.push(i)
    }
    for (const tool of t.toolCalls) {
      records.push({
        role: 'tool',
        message: {
          content: [
            {
              type: 'tool_result',
              name: tool.name,
              result: summarizeToolCall(tool),
            },
          ],
        },
        created_at: created,
        voice_call_id: call.id,
        voice_turn: i,
      })
      positions.push(i)
    }
    // nudges are hidden-turn noise — dropped, not stored as content
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
  const started_at =
    msToIso(raw.atMs ?? raw.at_ms ?? raw.timestampMs) ??
    stringField(raw, ['started_at', 'startedAt', 'created_at'])
  const toolCalls = parseToolCalls(raw.toolCalls ?? raw.tool_calls)
  const nudges = raw.nudges ?? raw.nudge
  const nudgeCount = Array.isArray(nudges) ? nudges.length : nudges == null ? 0 : 1
  return { role, text, started_at, toolCalls, nudgeCount }
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
    const input =
      item.input ??
      item.arguments ??
      item.args ??
      (isRecord(item.function) ? item.function.arguments : undefined)
    const result =
      typeof item.result === 'string'
        ? item.result
        : typeof item.output === 'string'
          ? item.output
          : undefined
    out.push({
      name,
      input,
      id: typeof item.id === 'string' ? item.id : undefined,
      result,
    })
  }
  return out
}

function summarizeToolCall(tool: VoiceToolCall): string {
  if (tool.result) return tool.result
  const name = tool.name || 'tool'
  if (tool.input == null) return name
  try {
    const raw = typeof tool.input === 'string' ? tool.input : JSON.stringify(tool.input)
    return raw.length > 240 ? `${name} ${raw.slice(0, 240)}…` : `${name} ${raw}`
  } catch {
    return name
  }
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
