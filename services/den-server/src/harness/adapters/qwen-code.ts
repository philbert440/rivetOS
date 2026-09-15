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

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function messageParts(message: Record<string, unknown> | undefined): Record<string, unknown>[] {
  if (!message || !Array.isArray(message.parts)) return []
  return message.parts.filter(isRecord)
}

/**
 * Gemini-style `usageMetadata` → MessageUsage.
 *
 * `promptTokenCount` is the full prompt (cache is a subset, not extra —
 * unlike Claude's uncached `input_tokens`). `thoughtsTokenCount` has no
 * field on MessageUsage; thinking text is carried on `turn.thinking`.
 */
function usageFromMetadata(obj: Record<string, unknown>): HarnessTurn['usage'] | undefined {
  const u = obj.usageMetadata
  if (!isRecord(u)) return undefined
  const input = num(u.promptTokenCount)
  const output = num(u.candidatesTokenCount)
  const cacheRead = num(u.cachedContentTokenCount)
  if (input <= 0 && output <= 0 && cacheRead <= 0) return undefined
  return {
    promptTokens: input,
    completionTokens: output,
    cachedTokens: cacheRead,
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

function closeLastAssistant(turns: HarnessTurn[]): void {
  const last = turns.at(-1)
  if (last?.role !== 'assistant' || last.complete === true) return
  last.complete = true
  if (!last.stopReason || last.stopReason === 'tool_use') last.stopReason = 'end_turn'
}

function uiEventRecord(obj: Record<string, unknown>): Record<string, unknown> | undefined {
  if (obj.type !== 'system' || obj.subtype !== 'ui_telemetry') return undefined
  const payload = isRecord(obj.systemPayload) ? obj.systemPayload : undefined
  const uiEvent = payload && isRecord(payload.uiEvent) ? payload.uiEvent : undefined
  return uiEvent
}

/**
 * Fold a qwen-code on-disk session JSONL (gemini-style `parts`) into logical
 * turns.
 *
 *   - `type:user` + `provenance:real_user` → user turn (`message.parts[].text`);
 *     also closes the previous assistant turn
 *   - `type:assistant` `message.parts` → `{text,thought:true}` reasoning,
 *     `{text}` text, `{functionCall}` tool call
 *   - an assistant whose parts *end* in text (no following `functionCall`) is
 *     `complete`; a trailing `functionCall` is `stopReason: tool_use`
 *   - `type:tool_result` → completes the matching running tool
 *     (`functionResponse.response.output`); not a turn of its own
 *   - `type:system` `ui_telemetry` `qwen-code.api_response` with `response_text`
 *     marks the end of a model call (closes a text-bearing assistant)
 *   - other `type:system` skipped
 *   - usage from `usageMetadata` (`promptTokenCount` → input,
 *     `candidatesTokenCount` → output, `cachedContentTokenCount` → cacheRead)
 *   - model from the assistant line's `model`
 */
export function qwenCodeTurnsFromLines(lines: Record<string, unknown>[]): HarnessTurn[] {
  const turns: HarnessTurn[] = []
  for (const obj of lines) {
    if (obj.type === 'system') {
      const uiEvent = uiEventRecord(obj)
      if (
        uiEvent &&
        pickStr(uiEvent, 'event.name') === 'qwen-code.api_response' &&
        typeof uiEvent.response_text === 'string'
      ) {
        const last = turns.at(-1)
        if (
          last?.role === 'assistant' &&
          last.complete !== true &&
          last.lastBlock === 'text' &&
          !(last.tools ?? []).some((t) => t.status === 'running')
        ) {
          closeLastAssistant(turns)
        }
      }
      continue
    }

    if (obj.type === 'tool_result') {
      const message = isRecord(obj.message) ? obj.message : undefined
      for (const part of messageParts(message)) {
        const fr = isRecord(part.functionResponse) ? part.functionResponse : undefined
        if (!fr) continue
        completeRunningTool(turns, pickStr(fr, 'id'), pickStr(fr, 'name'))
      }
      continue
    }

    if (obj.type === 'user') {
      if (obj.provenance !== 'real_user') continue
      const message = isRecord(obj.message) ? obj.message : undefined
      const textParts: string[] = []
      for (const part of messageParts(message)) {
        if (typeof part.text === 'string' && part.text.trim()) textParts.push(part.text.trim())
      }
      const joined = textParts.join('\n')
      const text = extractTurnText(joined, 'user') ?? joined.trim()
      if (!text) continue
      closeLastAssistant(turns)
      turns.push({ role: 'user', text })
      continue
    }

    if (obj.type !== 'assistant') continue
    const message = isRecord(obj.message) ? obj.message : undefined
    const tools: HarnessTranscriptTool[] = []
    let thinking = ''
    const textParts: string[] = []
    let lastBlock: HarnessTurn['lastBlock']
    for (const part of messageParts(message)) {
      if (part.thought === true && typeof part.text === 'string' && part.text) {
        thinking += part.text
        lastBlock = 'thinking'
        continue
      }
      if (typeof part.text === 'string' && part.text.trim()) {
        textParts.push(part.text.trim())
        lastBlock = 'text'
        continue
      }
      const fc = isRecord(part.functionCall) ? part.functionCall : undefined
      if (!fc) continue
      const name = pickStr(fc, 'name')
      if (!name) continue
      const entry: HarnessTranscriptTool = { name, status: 'running' }
      const id = pickStr(fc, 'id')
      if (id) entry.id = id
      const summarized = summarizeTurnArgs(fc.args)
      if (summarized) entry.args = summarized
      tools.push(entry)
      lastBlock = 'tool_use'
    }

    const extracted = extractTurnText(textParts.join('\n'), 'assistant')
    const text = extracted ?? textParts.join('\n').trim()
    if (!text && !thinking && tools.length === 0) continue

    const turn: HarnessTurn = { role: 'assistant', text: text || '' }
    if (thinking) {
      turn.thinking =
        thinking.length > THINKING_TAIL_CHARS
          ? '…' + thinking.slice(-THINKING_TAIL_CHARS)
          : thinking
    }
    if (tools.length > 0) turn.tools = tools
    if (lastBlock) turn.lastBlock = lastBlock
    const usage = usageFromMetadata(obj)
    if (usage) turn.usage = usage
    if (typeof obj.model === 'string' && obj.model.trim()) turn.model = obj.model.trim()
    // Parts that end in text (no following functionCall) close the model call.
    // A trailing functionCall is still in flight until the answer lands.
    if (lastBlock === 'text' && !tools.some((t) => t.status === 'running')) {
      turn.stopReason = 'end_turn'
      turn.complete = true
    } else if (tools.length > 0) {
      turn.stopReason = 'tool_use'
    }
    turns.push(turn)
  }
  return turns
}

export const qwenCodeAdapter: HarnessAdapter = {
  id: 'qwen-code',
  store: {
    parseLines(lines: string[]): HarnessTranscriptTurn[] {
      return qwenCodeTurnsFromLines(objectsFromLines(lines))
    },
    parseObjects(objects: Record<string, unknown>[]): HarnessTranscriptTurn[] {
      return qwenCodeTurnsFromLines(objects)
    },
  },
  promptToolNames: [],
  capabilities: () => ({ liveTurn: true, prompts: false, approvals: false }),
}
