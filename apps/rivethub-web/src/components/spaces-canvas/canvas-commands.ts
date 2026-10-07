/**
 * Pure decisions for find, "needs you", the MRU cycle, and the remove-space
 * confirm. The canvas applies them; these stay free of the DOM.
 */

export interface WaitingTile {
  id: string
  since: number
}

/**
 * Next blocked tile. Oldest `since` first. At thread altitude, cycle forward
 * from the current tile (wrapping). Anywhere else, jump to the oldest.
 */
export function nextWaitingId(
  waiting: readonly WaitingTile[],
  currentId: string | undefined,
  atThread: boolean,
): string | undefined {
  if (waiting.length === 0) return undefined
  const list = waiting
    .slice()
    .sort((a, b) => a.since - b.since || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  if (!atThread || currentId === undefined) return list[0]?.id
  const index = list.findIndex((tile) => tile.id === currentId)
  if (index < 0) return list[0]?.id
  return list[(index + 1) % list.length]?.id
}

export interface FindRow {
  id: string
  needs: boolean
  updatedAt: number
  haystack: string
}

/** Needs-you hits first, then newer `updatedAt`. Empty query matches nothing. */
export function rankFindHits<T extends FindRow>(rows: readonly T[], query: string): T[] {
  const q = query.trim().toLowerCase()
  if (!q) return []
  return rows
    .filter((row) => row.haystack.toLowerCase().includes(q))
    .sort((a, b) => {
      if (a.needs !== b.needs) return a.needs ? -1 : 1
      if (a.updatedAt !== b.updatedAt) return b.updatedAt - a.updatedAt
      return 0
    })
}

/** Most-recently opened first. Re-opening a thread moves it to the front. */
export function rememberThread(list: readonly string[], id: string): string[] {
  return [id, ...list.filter((entry) => entry !== id)]
}

/**
 * Preview id while Ctrl is held. `step` is 1-based (the mock increments
 * before indexing), so the first tap leaves the current thread for the
 * previous one when the list starts with the open thread.
 */
export function mruPreviewId(list: readonly string[], step: number): string | undefined {
  if (list.length === 0 || step <= 0) return undefined
  return list[step % list.length]
}

/** Mock copy. Removing a space unplaces its threads; it does not delete them. */
export function removeSpaceMessage(name: string, threadCount: number, liveCount: number): string {
  const threads =
    threadCount === 0
      ? `It has no threads yet. This can't be undone, and you'll have to make a new one if you want it back.`
      : `This closes its ${String(threadCount)} thread${threadCount === 1 ? '' : 's'}${
          liveCount > 0 ? `, ${String(liveCount)} of them still active` : ''
        }. This can't be undone, and you'll have to make a new one if you want it back.`
  return `Remove “${name}”? ${threads}`
}
