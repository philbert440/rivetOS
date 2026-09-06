import type { HarnessTranscriptTurn } from '@rivetos/types'
import { extractTurnText, objectsFromLines, type HarnessTurn } from './parse-helpers.js'
import type { HarnessAdapter } from './types.js'

export function grokPickTurn(obj: Record<string, unknown>): HarnessTurn | null {
  const type =
    typeof obj.type === 'string' ? obj.type : typeof obj.role === 'string' ? obj.role : ''
  if (type !== 'user' && type !== 'assistant') return null
  const text = extractTurnText(obj.content, type)
  return text ? { role: type, text } : null
}

/** Per-line loop that used to live in parseJsonlTurns(file, grokPickTurn). */
export function grokTurnsFromLines(lines: Record<string, unknown>[]): HarnessTurn[] {
  const out: HarnessTurn[] = []
  for (const obj of lines) {
    const turn = grokPickTurn(obj)
    if (turn) out.push(turn)
  }
  return out
}

export const grokAdapter: HarnessAdapter = {
  id: 'grok-build',
  store: {
    parseLines(lines: string[]): HarnessTranscriptTurn[] {
      return grokTurnsFromLines(objectsFromLines(lines))
    },
  },
  promptToolNames: [],
  capabilities: () => ({ liveTurn: false, prompts: false, approvals: true }),
}
