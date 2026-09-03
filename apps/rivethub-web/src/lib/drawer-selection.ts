/**
 * Close-on-selection rule for the narrow off-canvas rail.
 *
 * Location.href is deliberately ignored: draft sessions, Conversations from
 * `/`, and a repeat tap on the current route leave the URL unchanged and
 * must still close the drawer.
 */
export function shouldCloseDrawerOnSelection(narrow: boolean): boolean {
  return narrow
}
