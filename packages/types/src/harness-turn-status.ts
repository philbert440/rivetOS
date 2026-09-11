/**
 * Shared turn-status derivation from a parsed transcript.
 * Pure: types only. den and web share this; Kotlin ports the same rules.
 */

import type { HarnessTranscriptTurn } from './gateway-api.js'

const PROMPT_TOOL_NAMES = new Set(['askuserquestion', 'ask_user_question', 'ask_user'])

/** Case-insensitive: AskUserQuestion, ask_user_question, ask_user. */
export function isPromptToolName(name: string): boolean {
  return PROMPT_TOOL_NAMES.has(name.trim().toLowerCase())
}

export function deriveTurnStatus(
  turns: HarnessTranscriptTurn[],
  command: string,
): {
  inFlight?: boolean
  phase?: 'thinking' | 'tool' | 'writing' | 'prompt'
  tool?: { name: string; toolCallId?: string }
  promptToolId?: string
} {
  void command
  if (turns.length === 0) return {}
  const last = turns[turns.length - 1]
  if (last.role === 'user') return { inFlight: true, phase: 'thinking' }

  const tools = last.tools ?? []
  for (let i = tools.length - 1; i >= 0; i--) {
    const t = tools[i]
    if (t.status !== 'running') continue
    const tool = t.id ? { name: t.name, toolCallId: t.id } : { name: t.name }
    if (isPromptToolName(t.name)) {
      return {
        inFlight: true,
        phase: 'prompt',
        tool,
        ...(t.id ? { promptToolId: t.id } : {}),
      }
    }
    return { inFlight: true, phase: 'tool', tool }
  }

  // `complete` first: a final line whose blocks are [text, thinking] is done
  // even though its last block is a thinking one.
  if (last.complete) return { inFlight: false }
  if (last.lastBlock === 'thinking') return { inFlight: true, phase: 'thinking' }
  if (last.lastBlock === 'text') return { inFlight: true, phase: 'writing' }
  // Trailing assistant with neither stopReason nor lastBlock (grok/hermes).
  return {}
}
