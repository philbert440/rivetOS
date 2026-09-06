import {
  isPromptToolName,
  type HarnessTranscriptTool,
  type HarnessTranscriptTurn,
} from '@rivetos/types'
import { openHermesDb } from '../../term/hermes-db.js'
import {
  extractTurnText,
  summarizeTurnArgs,
  THINKING_TAIL_CHARS,
  type HarnessTurn,
} from './parse-helpers.js'
import type { HarnessAdapter } from './types.js'

const PROMPT_INPUT_MAX = 8192

function promptInput(raw: unknown): unknown {
  try {
    const s = JSON.stringify(raw)
    if (s.length > PROMPT_INPUT_MAX) return { truncated: true }
    return raw
  } catch {
    return { truncated: true }
  }
}

function parseArgs(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw
  try {
    return JSON.parse(raw) as unknown
  } catch {
    return raw
  }
}

function parseHermesToolCalls(raw: unknown): Array<{ id?: string; name: string; args?: unknown }> {
  let v: unknown = raw
  if (typeof v === 'string') {
    const t = v.trim()
    if (!t) return []
    try {
      v = JSON.parse(t) as unknown
    } catch {
      return []
    }
  }
  if (!Array.isArray(v)) return []
  const out: Array<{ id?: string; name: string; args?: unknown }> = []
  for (const item of v) {
    if (!item || typeof item !== 'object') continue
    const o = item as Record<string, unknown>
    const fn =
      o.function && typeof o.function === 'object'
        ? (o.function as Record<string, unknown>)
        : undefined
    const name =
      typeof o.name === 'string' ? o.name : typeof fn?.name === 'string' ? fn.name : undefined
    if (!name) continue
    const id = typeof o.id === 'string' ? o.id : undefined
    out.push({ id, name, args: parseArgs(o.arguments ?? fn?.arguments) })
  }
  return out
}

function hermesThinking(row: Record<string, unknown>): string {
  const a = typeof row.reasoning === 'string' ? row.reasoning : ''
  const b = typeof row.reasoning_content === 'string' ? row.reasoning_content : ''
  return (a || b).trim()
}

function asToolEntry(
  parsed: { id?: string; name: string; args?: unknown },
  status: HarnessTranscriptTool['status'],
): HarnessTranscriptTool {
  const entry: HarnessTranscriptTool = { name: parsed.name, status }
  if (parsed.id) entry.id = parsed.id
  const args = summarizeTurnArgs(parsed.args)
  if (args) entry.args = args
  if (isPromptToolName(parsed.name)) entry.input = promptInput(parsed.args)
  return entry
}

/**
 * Fold hermes sqlite `messages` into logical turns.
 *
 * Assistant rows with `tool_calls` are running tools; `tool` rows pair by
 * `tool_call_id` (+ `tool_name`). `finish_reason` `'stop'` vs `'tool_calls'`
 * stamps `complete` / `stopReason`. `reasoning` / `reasoning_content` is the
 * thinking tail. Extra columns are optional so older test DBs (role+content
 * only) still parse.
 */
export function readHermesTurns(id: string): HarnessTurn[] {
  const db = openHermesDb()
  if (!db) return []
  try {
    // SELECT * so a messages table without the live-node tool columns still
    // answers; missing fields are simply undefined.
    const rows = db
      .prepare(
        `SELECT * FROM messages
         WHERE session_id = ?
         ORDER BY timestamp ASC, rowid ASC`,
      )
      .all(id)
    const turns: HarnessTurn[] = []
    let toolsById = new Map<string, HarnessTranscriptTool>()
    let cur: HarnessTurn | null = null
    let thinking = ''
    let lastLineWasFinalText = false

    const finishAssistant = (): void => {
      if (cur) {
        if (thinking) {
          cur.thinking =
            thinking.length > THINKING_TAIL_CHARS
              ? '…' + thinking.slice(-THINKING_TAIL_CHARS)
              : thinking
        }
        if (cur.tools && cur.tools.length === 0) delete cur.tools
        if (
          cur.stopReason === 'end_turn' &&
          lastLineWasFinalText &&
          !(cur.tools ?? []).some((t) => t.status === 'running')
        ) {
          cur.complete = true
        }
        if (cur.text || cur.thinking || cur.tools) turns.push(cur)
      }
      cur = null
      thinking = ''
      lastLineWasFinalText = false
      toolsById = new Map()
    }

    for (const raw of rows) {
      const r = raw as Record<string, unknown>
      const role = typeof r.role === 'string' ? r.role : ''

      if (role === 'user') {
        const text = extractTurnText(r.content, 'user')
        if (text) {
          finishAssistant()
          turns.push({ role: 'user', text })
        }
        continue
      }

      if (role === 'tool') {
        if (cur) cur.lastBlock = 'tool_result'
        const callId = typeof r.tool_call_id === 'string' ? r.tool_call_id : undefined
        let entry = callId ? toolsById.get(callId) : undefined
        if (!entry && (callId || typeof r.tool_name === 'string')) {
          const name = typeof r.tool_name === 'string' ? r.tool_name : 'unknown'
          entry = { name, status: 'done' }
          if (callId) {
            entry.id = callId
            toolsById.set(callId, entry)
          }
          cur ??= { role: 'assistant', text: '', tools: [] }
          cur.tools?.push(entry)
        }
        if (entry) {
          entry.status = 'done'
          if (isPromptToolName(entry.name)) {
            const text = typeof r.content === 'string' ? r.content : ''
            if (text) entry.resultText = text.length > 2048 ? text.slice(0, 2048) : text
          }
        }
        lastLineWasFinalText = false
        continue
      }

      if (role !== 'assistant') continue

      cur ??= { role: 'assistant', text: '', tools: [] }
      const thought = hermesThinking(r)
      if (thought) thinking += thought

      const text = extractTurnText(r.content, 'assistant')
      if (text) {
        cur.text = cur.text ? cur.text + '\n\n' + text : text
      }

      const toolCalls = parseHermesToolCalls(r.tool_calls)
      if (toolCalls.length > 0) {
        for (const parsed of toolCalls) {
          const entry = asToolEntry(parsed, 'running')
          if (parsed.id) toolsById.set(parsed.id, entry)
          cur.tools?.push(entry)
        }
        cur.lastBlock = 'tool_use'
        cur.stopReason = 'tool_use'
        lastLineWasFinalText = false
      } else if (thought && !text) {
        cur.lastBlock = 'thinking'
        if (cur.stopReason !== 'end_turn') cur.stopReason = 'tool_use'
        lastLineWasFinalText = false
      } else if (text) {
        cur.lastBlock = 'text'
      }

      const finish = typeof r.finish_reason === 'string' ? r.finish_reason : ''
      if (finish === 'stop') {
        cur.stopReason = 'end_turn'
        if (text) lastLineWasFinalText = true
      } else if (finish === 'tool_calls') {
        cur.stopReason = 'tool_use'
        lastLineWasFinalText = false
      } else if (toolCalls.length === 0 && text && finish === '') {
        // Older DBs have no finish_reason: a text-only assistant row is the
        // final line of the turn (same rule as grok's no-tool_calls line).
        cur.stopReason = 'end_turn'
        lastLineWasFinalText = true
      }
    }
    finishAssistant()
    return turns
  } catch {
    return []
  } finally {
    try {
      db.close()
    } catch {
      /* ignore */
    }
  }
}

export const hermesAdapter: HarnessAdapter = {
  id: 'hermes',
  store: {
    readTurns(_ref, _maxBytes, sessionId): Promise<HarnessTranscriptTurn[]> {
      return Promise.resolve(sessionId ? readHermesTurns(sessionId) : [])
    },
  },
  promptToolNames: [],
  capabilities: () => ({ liveTurn: true, prompts: false, approvals: true }),
}
