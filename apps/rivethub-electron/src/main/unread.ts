/** Tray unread policy: the tooltip/badge shows the SUM across windows —
 *  per-window last-write-wins understated the count with two windows open. */
export function totalUnread(counts: Iterable<number>): number {
  let total = 0
  for (const n of counts) total += Number.isFinite(n) && n > 0 ? n : 0
  return total
}
