/**
 * Clicks on a file-table row: which ones open the entry, and which text
 * selection belongs to the row being clicked.
 */

/**
 * Row click / double-click filters: checkbox cell, multi-click of a
 * double-click sequence, and drag-select of a filename must not open.
 */
export function shouldIgnoreRowActivate(ev: {
  detail: number
  target: EventTarget | null
  selectionText?: string | null
}): boolean {
  if (ev.detail > 1) return true
  if (ev.selectionText != null && ev.selectionText !== '') return true
  const el = ev.target as HTMLElement | null
  if (el != null && el.closest('[data-no-open]')) return true
  return false
}

/**
 * The selected text, but only when the selection touches [container]. A
 * selection elsewhere on the page (the editor, another pane) is not a
 * drag-select of this row and must not swallow its click.
 */
export function selectionTextWithin(
  sel: {
    isCollapsed: boolean
    anchorNode: unknown
    focusNode: unknown
    toString: () => string
  } | null,
  container: { contains: (node: never) => boolean } | null,
): string {
  if (!sel || sel.isCollapsed || !container) return ''
  const inside = (node: unknown): boolean => node != null && container.contains(node as never)
  return inside(sel.anchorNode) || inside(sel.focusNode) ? sel.toString() : ''
}
