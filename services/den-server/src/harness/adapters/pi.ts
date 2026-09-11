import type { HarnessTranscriptTool, HarnessTranscriptTurn } from '@rivetos/types'
import {
  extractTurnText,
  objectsFromLines,
  summarizeTurnArgs,
  THINKING_TAIL_CHARS,
  type HarnessTurn,
} from './parse-helpers.js'
import type { HarnessAdapter } from './types.js'

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

function contentItems(message: Record<string, unknown>): Record<string, unknown>[] {
  const content = message.content
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : []
  if (!Array.isArray(content)) return []
  return content.filter(isRecord)
}

function usageFromMessage(message: Record<string, unknown>): HarnessTurn['usage'] | undefined {
  const u = message.usage
  if (!isRecord(u)) return undefined
  const input =
    (typeof u.input_tokens === 'number' ? u.input_tokens : 0) ||
    (typeof u.inputTokens === 'number' ? u.inputTokens : 0) ||
    (typeof u.promptTokens === 'number' ? u.promptTokens : 0)
  const output =
    (typeof u.output_tokens === 'number' ? u.output_tokens : 0) ||
    (typeof u.outputTokens === 'number' ? u.outputTokens : 0) ||
    (typeof u.completionTokens === 'number' ? u.completionTokens : 0)
  const cached = typeof u.cache_read_tokens === 'number' ? u.cache_read_tokens : 0
  if (input <= 0 && output <= 0) return undefined
  return {
    promptTokens: input + cached,
    completionTokens: output,
    cachedTokens: cached,
  }
}

/**
 * Fold a pi session JSONL (version 3) into logical turns.
 *
 * Message lines map to turns. Assistant content items become text / thinking
 * / tool events. Usage is taken from assistant `message.usage` when present.
 * Tool-call / tool-result fields are read defensively (`name`/`toolName`,
 * `id`/`toolCallId`, `arguments`/`input`, `result`/`content`).
 */
export function piTurnsFromLines(lines: Record<string, unknown>[]): HarnessTurn[] {
  const turns: HarnessTurn[] = []
  for (const obj of lines) {
    if (obj.type !== 'message' || !isRecord(obj.message)) continue
    const message = obj.message
    const role = message.role === 'assistant' ? 'assistant' : message.role === 'user' ? 'user' : ''
    if (!role) continue

    const tools: HarnessTranscriptTool[] = []
    let thinking = ''
    const textParts: string[] = []
    for (const item of contentItems(message)) {
      const t = item.type
      if (t === 'text' && typeof item.text === 'string' && item.text.trim()) {
        textParts.push(item.text.trim())
      } else if (t === 'thinking' && typeof item.thinking === 'string' && item.thinking) {
        thinking += item.thinking
      } else if (t === 'toolCall' || t === 'tool_call' || t === 'toolUse' || t === 'tool_use') {
        const name = pickStr(item, 'name', 'toolName')
        if (!name) continue
        const entry: HarnessTranscriptTool = { name, status: 'running' }
        const id = pickStr(item, 'id', 'toolCallId')
        if (id) entry.id = id
        const summarized = summarizeTurnArgs(item.arguments ?? item.input)
        if (summarized) entry.args = summarized
        tools.push(entry)
      } else if (t === 'toolResult' || t === 'tool_result') {
        const last = tools.at(-1)
        if (last && last.status === 'running') last.status = 'done'
      }
    }

    const extracted = extractTurnText(textParts.join('\n'), role)
    const text = extracted ?? textParts.join('\n').trim()
    if (!text && !thinking && tools.length === 0) continue

    const turn: HarnessTurn = { role, text: text || '' }
    if (thinking) {
      turn.thinking =
        thinking.length > THINKING_TAIL_CHARS ? '…' + thinking.slice(-THINKING_TAIL_CHARS) : thinking
    }
    if (tools.length > 0) turn.tools = tools
    if (role === 'assistant') {
      const usage = usageFromMessage(message)
      if (usage) turn.usage = usage
      if (typeof message.stopReason === 'string' && message.stopReason) {
        turn.stopReason = message.stopReason
      }
    }
    turns.push(turn)
  }
  return turns
}

export const piAdapter: HarnessAdapter = {
  id: 'pi',
  store: {
    parseLines(lines: string[]): HarnessTranscriptTurn[] {
      return piTurnsFromLines(objectsFromLines(lines))
    },
    parseObjects(objects: Record<string, unknown>[]): HarnessTranscriptTurn[] {
      return piTurnsFromLines(objects)
    },
  },
  promptToolNames: [],
  capabilities: () => ({ liveTurn: true, prompts: false, approvals: false }),
}
