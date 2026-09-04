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

/**
 * Same rule for the narrow RIGHT history drawer: picking a conversation row
 * switches the session and closes the drawer. Wide never mounts that drawer,
 * so the answer there is moot but stays false for symmetry.
 */
export function shouldCloseHistoryOnSelect(narrow: boolean): boolean {
  return narrow
}
