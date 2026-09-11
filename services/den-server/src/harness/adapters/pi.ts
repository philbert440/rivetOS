import type { HarnessTranscriptTurn } from '@rivetos/types'
import {
  extractTurnText,
  objectsFromLines,
  type HarnessTurn,
} from './parse-helpers.js'
import type { HarnessAdapter } from './types.js'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Fold a pi JSONL transcript into logical turns.
 *
 * // REVIEWER-CONFIRM: pi's on-disk transcript shape is unverified. This
 * reader accepts OpenAI-ish `{role, content}` and Claude-ish `{type, text}` /
 * `{type, message.content}` objects, one user/assistant line per turn.
 */
export function piTurnsFromLines(lines: Record<string, unknown>[]): HarnessTurn[] {
  const turns: HarnessTurn[] = []
  for (const obj of lines) {
    const type =
      typeof obj.type === 'string' ? obj.type : typeof obj.role === 'string' ? obj.role : ''
    if (type !== 'user' && type !== 'assistant') continue
    const nested = isRecord(obj.message) ? obj.message.content : undefined
    const content = obj.content ?? obj.text ?? nested
    const extracted = extractTurnText(content, type)
    const fallback = typeof obj.text === 'string' ? obj.text.trim() : ''
    const text = extracted ?? (fallback || null)
    if (!text) continue
    turns.push({ role: type, text })
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
