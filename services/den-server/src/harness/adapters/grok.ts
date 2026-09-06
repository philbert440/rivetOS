import {
  isPromptToolName,
  type HarnessTranscriptTool,
  type HarnessTranscriptTurn,
} from '@rivetos/types'
import {
  extractTurnText,
  objectsFromLines,
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

function parseGrokToolCall(
  raw: unknown,
): { id?: string; name: string; args?: unknown } | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const o = raw as Record<string, unknown>
  const fn =
    o.function && typeof o.function === 'object'
      ? (o.function as Record<string, unknown>)
      : undefined
  const name =
    typeof o.name === 'string' ? o.name : typeof fn?.name === 'string' ? fn.name : undefined
  if (!name) return undefined
  const id = typeof o.id === 'string' ? o.id : undefined
  return { id, name, args: parseArgs(o.arguments ?? fn?.arguments) }
}

function grokReasoningText(obj: Record<string, unknown>): string {
  const summary = obj.summary
  if (!Array.isArray(summary)) return ''
  const parts: string[] = []
  for (const item of summary) {
    if (!item || typeof item !== 'object') continue
    const block = item as { type?: unknown; text?: unknown }
    if (block.type === 'summary_text' && typeof block.text === 'string' && block.text.trim()) {
      parts.push(block.text)
    }
  }
  return parts.join('\n')
}

/**
 * Keep grokPickTurn as the single-line text extractor (user/assistant content
 * only). Folding of tool_calls / tool_result / reasoning lives in
 * grokTurnsFromLines — a line-at-a-time pick cannot pair results.
 */
export function grokPickTurn(obj: Record<string, unknown>): HarnessTurn | null {
  const type =
    typeof obj.type === 'string' ? obj.type : typeof obj.role === 'string' ? obj.role : ''
  if (type !== 'user' && type !== 'assistant') return null
  if (type === 'user' && obj.synthetic_reason != null && obj.synthetic_reason !== '') return null
  const text = extractTurnText(obj.content, type)
  return text ? { role: type, text } : null
}

/**
 * Fold grok `chat_history.jsonl` into logical turns.
 *
 * One JSON object per line, `type` discriminator. An assistant line WITH
 * `tool_calls` means more steps follow; WITHOUT `tool_calls` is the final
 * text of the turn (`complete`). `tool_result` pairs by `tool_call_id`.
 * `reasoning.summary[].text` is the thinking tail. User lines with
 * `synthetic_reason` are system reminders (Claude `isMeta` equivalent).
 */
export function grokTurnsFromLines(lines: Record<string, unknown>[]): HarnessTurn[] {
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

  for (const obj of lines) {
    const type =
      typeof obj.type === 'string' ? obj.type : typeof obj.role === 'string' ? obj.role : ''
    if (type === 'system') continue

    if (type === 'reasoning') {
      cur ??= { role: 'assistant', text: '', tools: [] }
      const text = grokReasoningText(obj)
      if (text) thinking += text
      cur.lastBlock = 'thinking'
      if (cur.stopReason !== 'end_turn') cur.stopReason = 'tool_use'
      lastLineWasFinalText = false
      continue
    }

    if (type === 'tool_result' || type === 'tool') {
      if (cur) cur.lastBlock = 'tool_result'
      const id = typeof obj.tool_call_id === 'string' ? obj.tool_call_id : undefined
      const entry = id ? toolsById.get(id) : undefined
      if (entry) {
        entry.status = 'done'
        if (isPromptToolName(entry.name)) {
          const content = obj.content
          const text =
            typeof content === 'string'
              ? content
              : content !== undefined
                ? JSON.stringify(content)
                : ''
          if (text) entry.resultText = text.length > 2048 ? text.slice(0, 2048) : text
        }
      }
      lastLineWasFinalText = false
      continue
    }

    if (type === 'user') {
      // synthetic_reason marks grok system reminders — skip like Claude isMeta.
      if (obj.synthetic_reason != null && obj.synthetic_reason !== '') continue
      const text = extractTurnText(obj.content, 'user')
      if (text) {
        finishAssistant()
        turns.push({ role: 'user', text })
      }
      continue
    }

    if (type !== 'assistant') continue

    cur ??= { role: 'assistant', text: '', tools: [] }
    const model =
      typeof obj.model_id === 'string' && obj.model_id.trim()
        ? obj.model_id.trim()
        : typeof obj.model === 'string' && obj.model.trim()
          ? obj.model.trim()
          : undefined
    if (model) cur.model = model

    const text = extractTurnText(obj.content, 'assistant')
    if (text) {
      cur.text = cur.text ? cur.text + '\n\n' + text : text
    }

    const toolCalls = Array.isArray(obj.tool_calls) ? obj.tool_calls : []
    if (toolCalls.length > 0) {
      for (const tc of toolCalls) {
        const parsed = parseGrokToolCall(tc)
        if (!parsed) continue
        const entry: HarnessTranscriptTool = { name: parsed.name, status: 'running' }
        if (parsed.id) {
          entry.id = parsed.id
          toolsById.set(parsed.id, entry)
        }
        const args = summarizeTurnArgs(parsed.args)
        if (args) entry.args = args
        if (isPromptToolName(parsed.name)) entry.input = promptInput(parsed.args)
        cur.tools?.push(entry)
      }
      cur.lastBlock = 'tool_use'
      cur.stopReason = 'tool_use'
      lastLineWasFinalText = false
    } else {
      // No tool_calls = final text of the turn.
      if (text) cur.lastBlock = 'text'
      cur.stopReason = 'end_turn'
      lastLineWasFinalText = true
    }
  }
  finishAssistant()
  return turns
}

export const grokAdapter: HarnessAdapter = {
  id: 'grok-build',
  store: {
    parseLines(lines: string[]): HarnessTranscriptTurn[] {
      return grokTurnsFromLines(objectsFromLines(lines))
    },
    parseObjects(objects: Record<string, unknown>[]): HarnessTranscriptTurn[] {
      return grokTurnsFromLines(objects)
    },
  },
  promptToolNames: [],
  capabilities: () => ({ liveTurn: true, prompts: false, approvals: true }),
}
