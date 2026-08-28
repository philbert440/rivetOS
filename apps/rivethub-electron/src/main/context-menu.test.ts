import { describe, expect, it } from 'vitest'
import { contextMenuTemplate, type ContextMenuParams } from './context-menu.js'

function params(over: Partial<ContextMenuParams>): ContextMenuParams {
  return {
    isEditable: false,
    selectionText: '',
    linkURL: '',
    mainFrame: true,
    editFlags: { canCut: false, canCopy: false, canPaste: true, canSelectAll: true },
    ...over,
  }
}

describe('contextMenuTemplate', () => {
  it('inert chrome gets no menu at all', () => {
    expect(contextMenuTemplate(params({}))).toEqual([])
  })

  it('editable fields get the full edit set with enablement from editFlags', () => {
    const items = contextMenuTemplate(
      params({
        isEditable: true,
        editFlags: { canCut: false, canCopy: false, canPaste: true, canSelectAll: true },
      }),
    )
    expect(items).toEqual([
      { role: 'cut', enabled: false },
      { role: 'copy', enabled: false },
      { role: 'paste', enabled: true },
      { type: 'separator' },
      { role: 'selectAll', enabled: true },
    ])
  })

  it('a text selection outside an editable gets Copy only', () => {
    const items = contextMenuTemplate(
      params({
        selectionText: 'some transcript text',
        editFlags: { canCut: false, canCopy: true, canPaste: false, canSelectAll: true },
      }),
    )
    expect(items).toEqual([{ role: 'copy', enabled: true }])
  })

  it('whitespace-only selection is not a selection', () => {
    expect(contextMenuTemplate(params({ selectionText: '  \n ' }))).toEqual([])
  })

  it('links add Copy Link Address for parsed http(s) URLs only', () => {
    expect(contextMenuTemplate(params({ linkURL: 'https://example.com/x' }))).toEqual([
      { label: 'Copy Link Address', copyLink: 'https://example.com/x' },
    ])
    // file:, custom schemes, junk: no link item — same rule as shell:openExternal
    for (const bad of ['file:///etc/passwd', 'app://bundle/index.html', 'not a url']) {
      expect(contextMenuTemplate(params({ linkURL: bad }))).toEqual([])
    }
  })

  it('copies the CANONICAL href, capped — never the raw string', () => {
    // canonicalization: parser-normalized form goes to the clipboard
    expect(contextMenuTemplate(params({ linkURL: 'https://example.com' }))).toEqual([
      { label: 'Copy Link Address', copyLink: 'https://example.com/' },
    ])
    // an enormous href must not become a clipboard bomb (2048 cap, both raw
    // and canonicalized length)
    const huge = 'https://example.com/' + 'a'.repeat(3000)
    expect(contextMenuTemplate(params({ linkURL: huge }))).toEqual([])
  })

  it('non-role items are main-frame only — den iframes get roles, nothing custom', () => {
    // a link inside an untrusted iframe grows NO Copy Link item…
    expect(
      contextMenuTemplate(params({ linkURL: 'https://example.com/x', mainFrame: false })),
    ).toEqual([])
    // …but the role-based edit menu still works there
    const items = contextMenuTemplate(params({ isEditable: true, mainFrame: false }))
    expect(items.some((i) => i.role === 'paste')).toBe(true)
    expect(items.some((i) => i.copyLink !== undefined)).toBe(false)
  })

  it('link + editable stack with a separator between', () => {
    const items = contextMenuTemplate(
      params({ isEditable: true, linkURL: 'http://10.0.0.1:5174/f' }),
    )
    expect(items[0]).toEqual({ label: 'Copy Link Address', copyLink: 'http://10.0.0.1:5174/f' })
    expect(items[1]).toEqual({ type: 'separator' })
    expect(items.some((i) => i.role === 'paste')).toBe(true)
  })
})
