/** The slice of a DOM element `focusIsInUse` reads — lets tests pass plain objects. */
export interface FocusedElementLike {
  tagName: string
  isContentEditable?: boolean
  closest(selector: string): unknown
}

const TEXT_ENTRY_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT'])
/** Focus traps the composer must not steal from. Deliberately broad: the model
 *  and effort pickers are Radix `PopoverContent`, which renders `role="dialog"`,
 *  so narrowing this would let autofocus pull focus out of an open picker. */
export const DIALOG_SELECTOR = 'dialog, [role="dialog"], [role="alertdialog"], [aria-modal="true"]'
/** A subtree nobody can interact with, such as the narrow history drawer once closed. */
export const INERT_SELECTOR = '[inert]'

/** Whether the focused element is something the user is actively using, so the
 *  composer must not take focus from it.
 *
 *  Text entry — an inline rename (commits on blur), the drawer filter, the
 *  terminal (xterm's hidden textarea) — and anything inside a dialog focus trap
 *  count, unless that subtree is inert. A focused button or link does not: clicking a conversation in the
 *  sidebar or the new-chat button leaves focus on that control, and treating it
 *  as "in use" meant the composer never autofocused after a click, only on a
 *  fresh page load. */
export function focusIsInUse(active: FocusedElementLike | null | undefined): boolean {
  if (!active) return false
  // The narrow history drawer is always `role="dialog"` and turns inert when
  // picking a row closes it, leaving focus on that row. Nothing inert can be
  // in use, so it must not hold autofocus off (#948).
  if (active.closest(INERT_SELECTOR) != null) return false
  if (TEXT_ENTRY_TAGS.has(active.tagName.toUpperCase())) return true
  if (active.isContentEditable) return true
  return active.closest(DIALOG_SELECTOR) != null
}
