/**
 * Right-click context menu — the shell shipped without one, so right-click
 * in the composer, the transcript, Files, and the terminal did nothing and
 * clipboard access was chord-only (four-agent desktop review, consolidated
 * punch list #2; user-reported "copy and paste broken").
 *
 * The template builder is pure so the menu policy is testable without
 * Electron. Roles only for edit actions — Chromium routes them to the
 * FOCUSED frame, so they behave in den iframes too without the shell ever
 * touching iframe content. The one custom item (Copy Link Address) is a
 * clipboard write of a parsed http(s) URL, the same rule as
 * shell:openExternal's validation — a context menu on untrusted content must
 * not become a side door to anything beyond the clipboard.
 */

export interface ContextMenuParams {
  isEditable: boolean
  selectionText: string
  linkURL: string
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
}

function webLink(url: string): string | undefined {
  try {
    const p = new URL(url).protocol
    return p === 'http:' || p === 'https:' ? url : undefined
  } catch {
    return undefined
  }
}

/** Empty array = no menu (right-click on inert chrome stays inert). */
export function contextMenuTemplate(params: ContextMenuParams): ContextMenuItem[] {
  const items: ContextMenuItem[] = []
  const link = webLink(params.linkURL)
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
    return items
  }

  if (params.selectionText.trim().length > 0) {
    if (items.length > 0) items.push({ type: 'separator' })
    items.push({ role: 'copy', enabled: params.editFlags.canCopy })
  }
  return items
}
