/**
 * Session page transcript fold. Mirrors the chat store's splice rules
 * (`applyTranscriptFrame` in stores/chat.ts) without the store: a from:0
 * snapshot replaces, a delta at `rev + 1` splices, anything else is a gap.
 *
 * `apply` returning `null` is the only case the page should hand `false` back
 * to attachHarnessSession (→ `{type:'sync'}`). Returning `false` for every
 * delta turns each incremental frame into a full snapshot round-trip.
 */

import {
  mergeTranscriptWindow,
  type HarnessTranscriptEvent,
  type HarnessTranscriptTurn,
} from '@rivetos/types'

export interface SessionTranscript {
  turns: HarnessTranscriptTurn[]
  /** Last applied WS rev. `undefined` after an HTTP resync (no rev on the wire). */
  rev: number | undefined
  /** Turns pinned ahead of a truncated tail-window snapshot. */
  offset: number
}

export function emptyTranscript(): SessionTranscript {
  return { turns: [], rev: undefined, offset: 0 }
}

/**
 * HTTP hard resync. The response carries no rev, so the next delta cannot be
 * validated and costs one `sync`; the from:0 snapshot that answers it re-seeds
 * the rev.
 */
export function resyncTranscript(turns: HarnessTranscriptTurn[]): SessionTranscript {
  return { turns, rev: undefined, offset: 0 }
}

export function applyTranscriptEvent(
  cur: SessionTranscript,
  event: HarnessTranscriptEvent,
): SessionTranscript | null {
  let turns: HarnessTranscriptTurn[]
  let offset = 0
  if (event.from === 0) {
    if (event.truncatedBefore && cur.turns.length > 0) {
      // Tail-window snapshot: keep earlier turns we already hold; later deltas
      // arrive in the server's window index space, so remember the pin.
      turns = mergeTranscriptWindow(cur.turns, event.turns, true)
      if (turns.length > event.turns.length) offset = turns.length - event.total
    } else {
      turns = event.turns
    }
  } else if (cur.rev !== undefined && event.rev === cur.rev + 1) {
    const at = event.from + cur.offset
    if (cur.turns.length < at) return null
    turns = [...cur.turns.slice(0, at), ...event.turns]
    offset = cur.offset
  } else {
    return null
  }
  if (turns.length - offset !== event.total) return null
  return { turns, rev: event.rev, offset }
}
