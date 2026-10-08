/**
 * When the chat transcript snaps to its newest message on its own.
 */

/** What the arrival jump compares between renders. */
export interface TranscriptEdge {
  lastId: string | undefined
  live: boolean
  reasoning: boolean
}

/**
 * Moments that bring the transcript to the bottom even when scrolled up: a
 * new message at the end (a reply, or your own send), a turn finishing, or
 * the agent done thinking and starting to write. Prepending history leaves
 * the last id alone, so paging back never jumps.
 */
export function arrivalJump(prev: TranscriptEdge, next: TranscriptEdge): boolean {
  if (next.lastId !== undefined && next.lastId !== prev.lastId) return true
  if (prev.live && !next.live) return true
  return prev.live && next.live && prev.reasoning && !next.reasoning
}
