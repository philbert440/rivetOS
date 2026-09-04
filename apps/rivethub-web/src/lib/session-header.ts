/**
 * Narrow session-chrome rules (Phil 2026-09-03): on the phone a session owns
 * ONE 48px header row — the wordmark bar (MobileTopBar) is not shown while a
 * session is open, and there is no back chevron ("back" is the right-side
 * history drawer). Wide layout is untouched.
 */

/** The wordmark bar shows on every narrow screen EXCEPT an open session. */
export function showMobileTopBar(narrow: boolean, sessionOpen: boolean): boolean {
  return narrow && !sessionOpen
}

/** Ordered items of the one-row narrow session header. `stop` rides only
 *  while a turn is interruptible; `remote` only for cross-node threads.
 *  Mirrors the desktop header's order (title · context · stop · segments)
 *  with ☰ leading and the history (conversations) button trailing. */
export type NarrowHeaderItem =
  'menu' | 'title' | 'remote' | 'context' | 'stop' | 'segmented' | 'history'

export function narrowHeaderItems(opts: { running: boolean; remote: boolean }): NarrowHeaderItem[] {
  return [
    'menu',
    'title',
    ...(opts.remote ? (['remote'] as const) : []),
    'context',
    ...(opts.running ? (['stop'] as const) : []),
    'segmented',
    'history',
  ]
}
