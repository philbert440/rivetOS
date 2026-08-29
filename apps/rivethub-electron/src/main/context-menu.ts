/**
 * Right-click context menu. The template builder is pure so the menu policy
 * is testable without Electron. Roles only for edit actions — Chromium
 * routes them to the FOCUSED frame, so they behave in den iframes too
 * without the shell ever touching iframe content. Custom items (Copy Link
 * Address, New Window) never carry frame content: a context menu on
 * untrusted content must not become a side door beyond the clipboard.
 */

export interface ContextMenuParams {
  isEditable: boolean
  selectionText: string
  linkURL: string
  /** True when the right-click landed in the window's MAIN frame. Non-role
   *  items (Copy Link) are main-frame-only: policy must fail closed on
   *  unknown frames, not rely on which items happen to exist today — the
   *  next custom item added to this template must not become a den side
   *  door (grok review of this PR). */
  mainFrame: boolean
  editFlags: {
    canCut: boolean
    canCopy: boolean
    canPaste: boolean
    canSelectAll: boolean
  }
}

export interface ContextMenuItem {
  role?: 'cut' | 'copy' | 'paste' | 'selectAll'
  label?: string
  enabled?: boolean
  type?: 'separator'
  /** Present only on Copy Link Address — the parsed, validated URL. */
  copyLink?: string
  /** Present only on New Window. */
  newWindow?: true
}

/** Same 2048 cap as shell:openExternal — an enormous href must not become a
 *  clipboard bomb pasted into a terminal. Canonicalized (.href), never the
 *  raw string. */
const LINK_MAX = 2048

function webLink(url: string): string | undefined {
  if (url.length > LINK_MAX) return undefined
  try {
    const u = new URL(url)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return undefined
    return u.href.length > LINK_MAX ? undefined : u.href
  } catch {
    return undefined
  }
}

/** New Window rides every menu: with no menu bar (and none at all on
 *  Windows), right-click is the discoverable path to a second window. */
export function contextMenuTemplate(params: ContextMenuParams): ContextMenuItem[] {
  const items: ContextMenuItem[] = []
  const link = params.mainFrame ? webLink(params.linkURL) : undefined
  if (link) items.push({ label: 'Copy Link Address', copyLink: link })

  if (params.isEditable) {
    if (items.length > 0) items.push({ type: 'separator' })
    items.push(
      { role: 'cut', enabled: params.editFlags.canCut },
      { role: 'copy', enabled: params.editFlags.canCopy },
      { role: 'paste', enabled: params.editFlags.canPaste },
      { type: 'separator' },
      { role: 'selectAll', enabled: params.editFlags.canSelectAll },
    )
  } else if (params.selectionText.trim().length > 0) {
    if (items.length > 0) items.push({ type: 'separator' })
    items.push({ role: 'copy', enabled: params.editFlags.canCopy })
  }

  if (items.length > 0) items.push({ type: 'separator' })
  items.push({ label: 'New Window', newWindow: true })
  return items
}
