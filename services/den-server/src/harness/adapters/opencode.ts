import type { HarnessTranscriptTool, HarnessTranscriptTurn } from '@rivetos/types'
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

function partText(part: Record<string, unknown>): string {
  if (typeof part.text === 'string') return part.text
  if (isRecord(part.text) && typeof part.text.value === 'string') return part.text.value
  return extractTurnText(part.content, 'assistant') ?? ''
}

/**
 * Fold OpenCode message (+ optional part) records into logical turns.
 *
 * // REVIEWER-CONFIRM: assumed shape is one JSON object per message
 * (`role`/`time`/`id`) with parts either inline (`parts[]`) or in sibling
 * `storage/part/<messageID>/*.json` files (`type: text | reasoning | tool`).
 * A real on-disk dump should replace this guess.
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
    const tools: HarnessTranscriptTool[] = []
    for (const part of parts) {
      const type = typeof part.type === 'string' ? part.type : ''
      if (type === 'reasoning' || type === 'thinking' || type === 'think') {
        thinking += partText(part)
        continue
      }
      if (type === 'tool' || type === 'tool_use' || type === 'tool-call') {
        const name =
          (typeof part.tool === 'string' && part.tool) ||
          (typeof part.name === 'string' && part.name) ||
          (isRecord(part.tool) && typeof part.tool.name === 'string' && part.tool.name) ||
          'tool'
        const callId =
          (typeof part.id === 'string' && part.id) ||
          (typeof part.toolCallId === 'string' && part.toolCallId) ||
          `${name}_${String(tools.length)}`
        const args = isRecord(part.tool)
          ? (part.tool.input ?? part.tool.args ?? part.state)
          : (part.input ?? part.args)
        const status =
          part.isError === true || (isRecord(part.state) && part.state.status === 'error')
            ? 'error'
            : 'done'
        tools.push({
          name,
          status,
          args: summarizeTurnArgs(args),
          id: callId,
        })
        continue
      }
      if (type === 'text' || type === '' || type === 'content') {
        text += partText(part)
      }
    }
    if (!text && typeof msg.content === 'string') text = msg.content
    if (!text && parts.length === 0) text = extractTurnText(msg.content, 'assistant') ?? ''
    const turn: HarnessTurn = { role: 'assistant', text: text.trim() }
    if (thinking) {
      turn.thinking =
        thinking.length > THINKING_TAIL_CHARS ? '…' + thinking.slice(-THINKING_TAIL_CHARS) : thinking
    }
    if (tools.length > 0) turn.tools = tools
    if (isRecord(msg.model) && typeof msg.model.modelID === 'string') {
      turn.model = msg.model.modelID
    } else if (typeof msg.model === 'string') {
      turn.model = msg.model
    }
    if (turn.text || turn.thinking || turn.tools) turns.push(turn)
  }
  return turns
}

function messageTime(msg: Record<string, unknown>): number {
  if (isRecord(msg.time) && typeof msg.time.created === 'number') return msg.time.created
  if (typeof msg.createdAt === 'number') return msg.createdAt
  return 0
}

export const opencodeAdapter: HarnessAdapter = {
  id: 'opencode',
  store: {
    parseObjects(objects: Record<string, unknown>[]): HarnessTranscriptTurn[] {
      return opencodeTurnsFromMessages(objects)
    },
  },
  promptToolNames: [],
  capabilities: () => ({ liveTurn: false, prompts: false, approvals: false }),
}
