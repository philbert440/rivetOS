/**
 * Turn rail: the per-prompt ladder on the transcript's right edge (after the
 * DeepSeek Harness chat's TurnNavigator). One mark per user message; hovering
 * a mark previews the prompt and the reply, clicking scrolls the transcript
 * to that turn, and the active mark follows the reading position.
 *
 * Pure derivations live here so they unit-test without a DOM. The component
 * (`components/turn-navigator.tsx`) only measures and paints.
 */

import type { SessionMessage } from '@rivetos/types'

export interface TurnRailItem {
  /** 0-based position in the ladder; `data-turn` on the user row carries it. */
  readonly index: number
  /** The user message that opens the turn. */
  readonly messageId: string
  /** epoch ms of the prompt, when known. */
  readonly ts?: number
  /** One-line prompt preview, plain text. */
  readonly prompt: string
  /** Short plain-text preview of the first non-empty reply; '' when none yet. */
  readonly response: string
}

export const PROMPT_PREVIEW_CHARS = 140
export const RESPONSE_PREVIEW_CHARS = 220

/**
 * Markdown → a single line of plain text, clamped. Fenced code bodies, image
 * syntax and link targets are dropped; inline marks are unwrapped; whitespace
 * collapses. Good enough for a 1–3 line preview, not a renderer.
 */
export function previewText(source: string, max: number): string {
  let s = source
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/~~~[\s\S]*?~~~/g, ' ')
    .replace(/!\[[^\]]*]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)]\([^)]*\)/g, '$1')
    .replace(/<[^>\n]{1,80}>/g, ' ')
    .replace(/^\s{0,3}(?:[-*+]|\d+[.)])\s+/gm, '')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s{0,3}>\s?/gm, '')
    .replace(/(\*\*|__|\*|_|`{1,3}|~~)/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (s.length <= max) return s
  // Cut on a word boundary when one is reasonably close; otherwise hard cut.
  const cut = s.lastIndexOf(' ', max)
  s = s.slice(0, cut > max * 0.6 ? cut : max).trimEnd()
  return `${s}…`
}

/**
 * One rail item per user message, in transcript order. The response preview
 * is the first non-empty assistant text before the next user message.
 */
export function turnRailItems(messages: readonly SessionMessage[]): TurnRailItem[] {
  const items: TurnRailItem[] = []
  let open: { messageId: string; ts?: number; prompt: string } | undefined
  let response = ''
  const close = (): void => {
    if (!open) return
    items.push({
      index: items.length,
      messageId: open.messageId,
      ts: open.ts,
      prompt: open.prompt,
      response,
    })
    open = undefined
    response = ''
  }
  for (const m of messages) {
    if (m.role === 'user') {
      close()
      open = {
        messageId: m.id,
        ts: m.ts,
        prompt: previewText(m.text, PROMPT_PREVIEW_CHARS),
      }
    } else if (open && response === '' && m.text) {
      response = previewText(m.text, RESPONSE_PREVIEW_CHARS)
    }
  }
  close()
  return items
}

/** Default reading line: this far below the scrollport's top edge. */
export const READING_LINE_PX = 20
/** Within this many px of the floor the reader is "at the end": last turn wins. */
const FLOOR_SLACK_PX = 4

/**
 * Which turn the reader is on. `tops` are each turn's content offsets (px
 * from the top of the scroll content, ascending). At the floor the last turn
 * is active; otherwise the last turn whose top is at or above the reading
 * line (`lineOffset` px below the viewport's top edge, so a turn the rail just
 * landed with a small inset counts as its own); before the first turn, the
 * first.
 * @returns index into `tops`, or null when there are no turns.
 */
export function activeTurnIndex(
  tops: readonly number[],
  scrollTop: number,
  viewportHeight: number,
  scrollHeight: number,
  lineOffset = READING_LINE_PX,
): number | null {
  if (tops.length === 0) return null
  if (scrollTop + viewportHeight >= scrollHeight - FLOOR_SLACK_PX) return tops.length - 1
  const line = scrollTop + lineOffset
  let active = 0
  for (const [i, top] of tops.entries()) {
    if (top > line) break
    active = i
  }
  return active
}

/** Label for a mark whose prompt is empty (attachment-only turn, say). */
export function turnLabel(index: number): string {
  return `turn ${String(index + 1)}`
}
