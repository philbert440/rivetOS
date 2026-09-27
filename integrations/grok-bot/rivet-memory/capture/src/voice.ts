/**
 * Reader for Grok Bot `agents/<id>/voice-calls/*.json` turns.
 *
 * No live voice-calls/*.json sample was available in this environment. The
 * shape below is reconstructed from the review's "voice-calls/*.json turns"
 * description plus the same role/text fields as on-disk transcript records.
 * If a real dump appears with different keys, update this file from that
 * structure only.
 *
 * Turn indices are not the on-disk jsonl line index, so ingest uses
 * SESSION_SUFFIX_V3_VOICE (plus `-<stem>` per call file).
 */
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { isRecord } from '@rivetos/capture-core'
import { SESSION_SUFFIX_V3_VOICE } from './types.js'

export { SESSION_SUFFIX_V3_VOICE }

export interface VoiceTurn {
  role: string
  text: string
  started_at?: string
  ended_at?: string
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
    (typeof raw.id === 'string' && raw.id) ||
    (typeof raw.call_id === 'string' && raw.call_id) ||
    stemOf(file)
  const started =
    (typeof raw.started_at === 'string' && raw.started_at) ||
    (typeof raw.startedAt === 'string' && raw.startedAt) ||
    undefined
  return { id, started_at: started, file, turns: turnsRaw.map(turnFromUnknown) }
}

export function readVoiceCallFile(file: string): VoiceCall {
  return parseVoiceCall(readFileSync(file, 'utf8'), file)
}

export function voiceCallToRecords(call: VoiceCall): { records: unknown[]; positions: number[] } {
  const records = call.turns.map((t, i) => {
    if (isOnDiskTurn(t)) return t
    return {
      role: t.role || 'assistant',
      message: { role: t.role || 'assistant', content: [{ type: 'text', text: t.text }] },
      created_at: t.started_at,
      voice_call_id: call.id,
      voice_turn: i,
    }
  })
  return { records, positions: call.turns.map((_, i) => i) }
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

function stemOf(file: string): string {
  return slugStem(file)
}

function isOnDiskTurn(t: unknown): boolean {
  return isRecord(t) && Boolean(t.message || (Array.isArray(t.content) && t.role))
}

function turnFromUnknown(raw: unknown): VoiceTurn {
  if (isRecord(raw) && isOnDiskTurn(raw)) {
    const role = typeof raw.role === 'string' ? raw.role : 'assistant'
    const text = onDiskText(raw)
    return { role, text, started_at: stringField(raw, ['started_at', 'startedAt', 'created_at']) }
  }
  if (!isRecord(raw)) {
    const text =
      typeof raw === 'string'
        ? raw
        : typeof raw === 'number' || typeof raw === 'boolean'
          ? String(raw)
          : ''
    return { role: 'assistant', text }
  }
  const role = typeof raw.role === 'string' ? raw.role : 'assistant'
  const text =
    stringField(raw, ['text', 'content', 'transcript', 'utterance']) ||
    (typeof raw.message === 'string' ? raw.message : '')
  return {
    role,
    text,
    started_at: stringField(raw, ['started_at', 'startedAt', 'created_at']),
    ended_at: stringField(raw, ['ended_at', 'endedAt']),
  }
}

function onDiskText(raw: Record<string, unknown>): string {
  const msg = isRecord(raw.message) ? raw.message : raw
  const content = msg.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((p) => (isRecord(p) && typeof p.text === 'string' ? p.text : ''))
      .filter(Boolean)
      .join('\n')
  }
  return ''
}

function stringField(obj: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = obj[k]
    if (typeof v === 'string' && v) return v
  }
  return undefined
}
