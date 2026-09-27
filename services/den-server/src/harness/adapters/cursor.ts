/**
 * Cursor agent transcripts: `~/.cursor/projects/<slug>/agent-transcripts/<uuid>/<uuid>.jsonl`.
 *
 * Each line is `{ role, message: { content: [...] } }`. Content parts are
 * `text` and `tool_use`. The file never records tool results or a tool-call
 * id, so every tool is `done` (a `running` row would spin forever).
 * `SendMessage` carries the text the person sees in `input.content`; the
 * text parts are narration. Both land in the turn so chat is not narration-only.
 */

import type { HarnessTranscriptTool, HarnessTranscriptTurn } from '@rivetos/types'
import { summarizeTurnArgs } from './parse-helpers.js'
import type { HarnessAdapter } from './types.js'

function contentParts(message: unknown): unknown[] {
  if (!message || typeof message !== 'object') return []
  const content = (message as { content?: unknown }).content
  if (typeof content === 'string') return [{ type: 'text', text: content }]
  if (Array.isArray(content)) return content
  return []
}

export function cursorTurnsFromObjects(
  objects: Record<string, unknown>[],
): HarnessTranscriptTurn[] {
  const turns: HarnessTranscriptTurn[] = []
  for (const obj of objects) {
    const role = obj.role === 'user' || obj.role === 'assistant' ? obj.role : undefined
    if (!role) continue
    const texts: string[] = []
    const tools: HarnessTranscriptTool[] = []
    let lastBlock: HarnessTranscriptTurn['lastBlock']
    for (const part of contentParts(obj.message)) {
      if (!part || typeof part !== 'object') continue
      const p = part as Record<string, unknown>
      if (p.type === 'text' && typeof p.text === 'string' && p.text.trim()) {
        texts.push(p.text)
        lastBlock = 'text'
      }
      if (p.type !== 'tool_use' || typeof p.name !== 'string' || role !== 'assistant') continue
      const input = p.input
      if (p.name === 'SendMessage' && input && typeof input === 'object') {
        const body = (input as { content?: unknown }).content
        if (typeof body === 'string' && body.trim() && !texts.some((t) => t.includes(body))) {
          texts.push(body)
        }
      }
      const args = summarizeTurnArgs(input)
      tools.push(args ? { name: p.name, status: 'done', args } : { name: p.name, status: 'done' })
      lastBlock = 'tool_use'
    }
    const text = texts.join('\n').trim()
    if (!text && tools.length === 0) continue
    const turn: HarnessTranscriptTurn = { role, text }
    if (tools.length > 0) turn.tools = tools
    if (lastBlock) turn.lastBlock = lastBlock
    if (role === 'assistant') turn.complete = true
    turns.push(turn)
  }
  return turns
}

export const cursorAdapter: HarnessAdapter = {
  id: 'cursor',
  promptToolNames: [],
  capabilities: () => ({ liveTurn: false, prompts: false, approvals: false }),
  store: {
    parseObjects: cursorTurnsFromObjects,
  },
}
