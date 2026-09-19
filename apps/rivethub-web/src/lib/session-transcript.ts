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
  type HarnessStatusFrame,
  type HarnessTranscriptEvent,
  type HarnessTranscriptTurn,
} from '@rivetos/types'
import type { LiveTurn } from './fold-stream.js'
import { liveFromTranscript } from './harness-turns.js'

export interface SessionTranscript {
  turns: HarnessTranscriptTurn[]
  /** Last applied WS rev. `undefined` after an HTTP resync (no rev on the wire). */
  rev: number | undefined
  /** Turns pinned ahead of a truncated tail-window snapshot. */
  offset: number
  /** epoch ms of the gap whose `sync` is still unanswered (no from:0 yet). */
  gapSince?: number
}

/**
 * While a gap's `sync` is outstanding, later deltas are dropped without asking
 * again (the snapshot carries them); after this long, ask once more.
 * attachHarnessSession already re-arms a dropped `sync` once at 3 s.
 */
export const GAP_RESYNC_MS = 5_000

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

/**
 * A delta could not be applied. `requestSync` is true for the first gap (and
 * again once GAP_RESYNC_MS passes unanswered); in between the caller drops the
 * frame quietly, so one gap costs one `sync`, not one per streamed frame.
 */
export function noteTranscriptGap(
  cur: SessionTranscript,
  now: number,
): { next: SessionTranscript; requestSync: boolean } {
  if (cur.gapSince !== undefined && now - cur.gapSince < GAP_RESYNC_MS) {
    return { next: cur, requestSync: false }
  }
  return { next: { ...cur, gapSince: now }, requestSync: true }
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

/**
 * Transcript-sourced live bubble, with Chat's `liveFloor` guard
 * (stores/chat.ts overlayTranscriptLive): `floor` is the turn count when the
 * last `idle` status frame arrived. A trailing turn below it was already
 * settled as solid (an interrupted reply has no `complete: true`), so the next
 * turn's `working` must not pull it back out of history as the live reply.
 */
export function transcriptLiveOverlay(
  turns: HarnessTranscriptTurn[],
  status: HarnessStatusFrame | undefined,
  floor: number,
): LiveTurn | undefined {
  const candidate = liveFromTranscript(turns, status)
  return candidate && turns.length - 1 >= floor ? candidate : undefined
}
