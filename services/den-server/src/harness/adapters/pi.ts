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

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function usageFromMessage(message: Record<string, unknown>): HarnessTurn['usage'] | undefined {
  const u = message.usage
  if (!isRecord(u)) return undefined
  // Real pi 0.85.1 keys: input/output/cacheRead/cacheWrite. Snake/camel aliases are fallbacks.
  const input = num(u.input) || num(u.input_tokens) || num(u.inputTokens) || num(u.promptTokens)
  const output =
    num(u.output) || num(u.output_tokens) || num(u.outputTokens) || num(u.completionTokens)
  const cached = num(u.cacheRead) || num(u.cache_read_tokens)
  const cacheWrite = num(u.cacheWrite) || num(u.cache_write_tokens)
  const cachedTokens = cached + cacheWrite
  if (input <= 0 && output <= 0 && cachedTokens <= 0) return undefined
  return {
    promptTokens: input + cachedTokens,
    completionTokens: output,
    cachedTokens,
  }
}

function completeRunningTool(
  turns: HarnessTurn[],
  id: string | undefined,
  name: string | undefined,
): void {
  for (let i = turns.length - 1; i >= 0; i--) {
    const tools = turns[i].tools
    if (!tools) continue
    const entry = id
      ? tools.find((t) => t.id === id && t.status === 'running')
      : tools.find((t) => t.status === 'running' && (!name || t.name === name))
    if (entry) {
      entry.status = 'done'
      return
    }
  }
}

/**
 * Fold a pi session JSONL (version 3) into logical turns.
 *
 * Message lines map to turns. Assistant content items become text / thinking
 * / tool-call events. Tool results arrive as a SEPARATE message
 * `{role:"toolResult", toolCallId, toolName, content:[…]}` (not an assistant
 * content item) and complete the matching running tool on the prior turn.
 * Usage is taken from assistant `message.usage` when present
 * (`input`/`output`/`cacheRead`/`cacheWrite`; snake/camel aliases as fallbacks).
 * Tool-call fields are read defensively (`name`/`toolName`, `id`/`toolCallId`,
 * `arguments`/`input`). Nested `type:toolResult` content items are still
 * honoured as a fallback.
 */
export function piTurnsFromLines(lines: Record<string, unknown>[]): HarnessTurn[] {
  const turns: HarnessTurn[] = []
  for (const obj of lines) {
    if (obj.type !== 'message' || !isRecord(obj.message)) continue
    const message = obj.message
    const rawRole = typeof message.role === 'string' ? message.role : ''

    if (rawRole === 'toolResult' || rawRole === 'tool_result') {
      completeRunningTool(
        turns,
        pickStr(message, 'toolCallId', 'id'),
        pickStr(message, 'toolName', 'name'),
      )
      continue
    }

    const role = rawRole === 'assistant' ? 'assistant' : rawRole === 'user' ? 'user' : ''
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
        const id = pickStr(item, 'id', 'toolCallId')
        const last = (id ? tools.find((t) => t.id === id && t.status === 'running') : undefined) ?? tools.at(-1)
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
