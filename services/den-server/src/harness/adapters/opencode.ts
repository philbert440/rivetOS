import type { HarnessTranscriptTool, HarnessTranscriptTurn } from '@rivetos/types'
import { openOpencodeDb } from '../../term/opencode-db.js'
import {
  extractTurnText,
  summarizeTurnArgs,
  THINKING_TAIL_CHARS,
  type HarnessTurn,
} from './parse-helpers.js'
import type { HarnessAdapter } from './types.js'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseJson(value: unknown): Record<string, unknown> {
  if (isRecord(value)) return value
  if (typeof value !== 'string' || value.trim() === '') return {}
  try {
    const parsed: unknown = JSON.parse(value)
    return isRecord(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

function usageFromMsg(msg: Record<string, unknown>): HarnessTranscriptTurn['usage'] | undefined {
  const tokens = isRecord(msg.tokens) ? msg.tokens : undefined
  if (!tokens) return undefined
  const cache = isRecord(tokens.cache) ? tokens.cache : undefined
  const prompt = num(tokens.input) + num(cache?.read) + num(cache?.write)
  const completion = num(tokens.output) + num(tokens.reasoning)
  if (prompt <= 0 && completion <= 0) return undefined
  return {
    promptTokens: prompt,
    completionTokens: completion,
    cachedTokens: num(cache?.read),
  }
}

function partText(part: Record<string, unknown>): string {
  if (typeof part.text === 'string') return part.text
  if (isRecord(part.text) && typeof part.text.value === 'string') return part.text.value
  return extractTurnText(part.content, 'assistant') ?? ''
}

/**
 * Fold OpenCode `message` + `part` rows into logical turns.
 *
 * Message `data` JSON: user `{role,time,agent,model}`; assistant
 * `{role,parentID,tokens,modelID,providerID,time,…}`. Part `data` JSON:
 * `{type: text|reasoning|step-start|step-finish|tool, text?, state?}`.
 * Tool parts are read defensively (`type`, `tool`, `state.status/input/output/title`).
 */
export function opencodeTurnsFromMessages(
  messages: Array<Record<string, unknown>>,
  partsByMessage: Map<string, Array<Record<string, unknown>>> = new Map(),
): HarnessTurn[] {
  const ordered = [...messages].sort((a, b) => {
    const ta = messageTime(a)
    const tb = messageTime(b)
    return ta - tb
  })
  const turns: HarnessTurn[] = []
  for (const msg of ordered) {
    const roleRaw = typeof msg.role === 'string' ? msg.role : ''
    const role: 'user' | 'assistant' = roleRaw === 'assistant' ? 'assistant' : 'user'
    if (roleRaw === 'system') continue
    const id = typeof msg.id === 'string' ? msg.id : ''
    const inline = Array.isArray(msg.parts)
      ? msg.parts.filter(isRecord)
      : Array.isArray(msg.content)
        ? msg.content.filter(isRecord)
        : []
    const extra = id ? (partsByMessage.get(id) ?? []) : []
    const parts = [...inline, ...extra]
    if (role === 'user') {
      const text =
        (typeof msg.content === 'string' ? msg.content : '') ||
        parts.map(partText).join('') ||
        extractTurnText(msg.content, 'user') ||
        ''
      if (text.trim()) turns.push({ role: 'user', text: text.trim() })
      continue
    }
    let text = ''
    let thinking = ''
    let lastBlock: HarnessTurn['lastBlock']
    let sawStepFinish = false
    const tools: HarnessTranscriptTool[] = []
    for (const part of parts) {
      const type = typeof part.type === 'string' ? part.type : ''
      if (type === 'step-start' || type === 'step_start') {
        continue
      }
      if (type === 'step-finish' || type === 'step_finish') {
        sawStepFinish = true
        continue
      }
      if (type === 'reasoning' || type === 'thinking' || type === 'think') {
        thinking += partText(part)
        lastBlock = 'thinking'
        continue
      }
      if (type === 'tool' || type === 'tool_use' || type === 'tool-call') {
        const name =
          (typeof part.tool === 'string' && part.tool) ||
          (typeof part.name === 'string' && part.name) ||
          (isRecord(part.tool) && typeof part.tool.name === 'string' && part.tool.name) ||
          'tool'
        const state = isRecord(part.state) ? part.state : undefined
        const callId =
          (typeof part.id === 'string' && part.id) ||
          (typeof part.toolCallId === 'string' && part.toolCallId) ||
          (typeof part.callID === 'string' && part.callID) ||
          `${name}_${String(tools.length)}`
        const args =
          (state && 'input' in state ? state.input : undefined) ??
          (isRecord(part.tool) ? (part.tool.input ?? part.tool.args) : undefined) ??
          part.input ??
          part.args
        const status =
          part.isError === true || (state && state.status === 'error')
            ? 'error'
            : state && state.status === 'running'
              ? 'running'
              : 'done'
        tools.push({
          name,
          status,
          args: summarizeTurnArgs(args),
          id: callId,
        })
        lastBlock = status === 'running' ? 'tool_use' : 'tool_result'
        continue
      }
      if (type === 'text' || type === '' || type === 'content') {
        text += partText(part)
        if (partText(part)) lastBlock = 'text'
      }
    }
    if (!text && typeof msg.content === 'string') text = msg.content
    if (!text && parts.length === 0) text = extractTurnText(msg.content, 'assistant') ?? ''
    const turn: HarnessTurn = { role: 'assistant', text: text.trim() }
    if (thinking) {
      turn.thinking =
        thinking.length > THINKING_TAIL_CHARS
          ? '…' + thinking.slice(-THINKING_TAIL_CHARS)
          : thinking
    }
    if (tools.length > 0) turn.tools = tools
    if (typeof msg.modelID === 'string') {
      const provider = typeof msg.providerID === 'string' ? msg.providerID : ''
      turn.model = provider ? `${provider}/${msg.modelID}` : msg.modelID
    } else if (isRecord(msg.model) && typeof msg.model.modelID === 'string') {
      turn.model = msg.model.modelID
    } else if (typeof msg.model === 'string') {
      turn.model = msg.model
    }
    const usage = usageFromMsg(msg)
    if (usage) turn.usage = usage
    const time = isRecord(msg.time) ? msg.time : undefined
    const completedAt = typeof time?.completed === 'number' ? time.completed : undefined
    const running = tools.some((t) => t.status === 'running')
    const finished = sawStepFinish || completedAt !== undefined
    if (lastBlock) turn.lastBlock = lastBlock
    if (running) {
      turn.stopReason = 'tool_use'
    } else if (finished) {
      turn.stopReason = 'end_turn'
      if (turn.text) turn.lastBlock = 'text'
      turn.complete = true
    }
    if (turn.text || turn.thinking || turn.tools) turns.push(turn)
  }
  return turns
}

function messageTime(msg: Record<string, unknown>): number {
  if (typeof msg.time_created === 'number' && Number.isFinite(msg.time_created))
    return msg.time_created
  if (isRecord(msg.time) && typeof msg.time.created === 'number') return msg.time.created
  if (typeof msg.createdAt === 'number') return msg.createdAt
  return 0
}

/** Read one session's turns out of `opencode.db`. Empty on miss / sqlite unavailable. */
export function readOpencodeTurns(id: string): HarnessTurn[] {
  const db = openOpencodeDb()
  if (!db) return []
  try {
    const messages = db
      .prepare(
        `SELECT id, time_created, data FROM message WHERE session_id = ? ORDER BY time_created ASC`,
      )
      .all(id)
    const parts = db
      .prepare(
        `SELECT id, message_id, time_created, data FROM part WHERE session_id = ? ORDER BY time_created ASC`,
      )
      .all(id)
    const partsByMessage = new Map<string, Array<Record<string, unknown>>>()
    for (const p of parts) {
      const mid = str(p.message_id)
      if (!mid) continue
      const data = parseJson(p.data)
      const rec: Record<string, unknown> = {
        ...data,
        id: str(p.id),
        time_created: p.time_created,
      }
      const arr = partsByMessage.get(mid) ?? []
      arr.push(rec)
      partsByMessage.set(mid, arr)
    }
    const msgs = messages.map((m) => {
      const data = parseJson(m.data)
      return { ...data, id: str(m.id), time_created: m.time_created }
    })
    return opencodeTurnsFromMessages(msgs, partsByMessage)
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

export const opencodeAdapter: HarnessAdapter = {
  id: 'opencode',
  store: {
    readTurns(_ref, _maxBytes, sessionId): Promise<HarnessTranscriptTurn[]> {
      return Promise.resolve(sessionId ? readOpencodeTurns(sessionId) : [])
    },
  },
  promptToolNames: [],
  capabilities: () => ({ liveTurn: true, prompts: false, approvals: false }),
}
