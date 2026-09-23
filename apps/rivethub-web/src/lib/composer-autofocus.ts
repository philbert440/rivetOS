/** The slice of a DOM element `focusIsInUse` reads — lets tests pass plain objects. */
export interface FocusedElementLike {
  tagName: string
  isContentEditable?: boolean
  closest(selector: string): unknown
}

const TEXT_ENTRY_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT'])
const DIALOG_SELECTOR = 'dialog, [role="dialog"], [role="alertdialog"], [aria-modal="true"]'

/** Whether the focused element is something the user is actively using, so the
 *  composer must not take focus from it.
 *
 *  Text entry — an inline rename (commits on blur), the drawer filter, the
 *  terminal (xterm's hidden textarea) — and anything inside a dialog focus trap
 *  count. A focused button or link does not: clicking a conversation in the
 *  sidebar or the new-chat button leaves focus on that control, and treating it
 *  as "in use" meant the composer never autofocused after a click, only on a
 *  fresh page load. */
export function focusIsInUse(active: FocusedElementLike | null | undefined): boolean {
  if (!active) return false
  if (TEXT_ENTRY_TAGS.has(active.tagName.toUpperCase())) return true
  if (active.isContentEditable) return true
  return active.closest(DIALOG_SELECTOR) != null
}
