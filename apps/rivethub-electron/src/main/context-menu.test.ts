import { describe, expect, it } from 'vitest'
import {
  contextMenuTemplate,
  type ContextMenuItem,
  type ContextMenuParams,
} from './context-menu.js'

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

const NEW_WINDOW: ContextMenuItem = { label: 'New Window', newWindow: true }

/** Every menu ends with New Window (after a separator when anything else is
 *  above it); strip that tail to assert on the contextual part. */
function contextual(items: ContextMenuItem[]): ContextMenuItem[] {
  expect(items.at(-1)).toEqual(NEW_WINDOW)
  const rest = items.slice(0, -1)
  if (rest.length > 0) {
    expect(rest.at(-1)).toEqual({ type: 'separator' })
    return rest.slice(0, -1)
  }
  return rest
}

describe('contextMenuTemplate', () => {
  it('inert chrome still gets New Window (the only discoverable path with no menu bar)', () => {
    expect(contextMenuTemplate(params({}))).toEqual([NEW_WINDOW])
  })

  it('editable fields get the full edit set with enablement from editFlags', () => {
    const items = contextual(
      contextMenuTemplate(
        params({
          isEditable: true,
          editFlags: { canCut: false, canCopy: false, canPaste: true, canSelectAll: true },
        }),
      ),
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
    const items = contextual(
      contextMenuTemplate(
        params({
          selectionText: 'some transcript text',
          editFlags: { canCut: false, canCopy: true, canPaste: false, canSelectAll: true },
        }),
      ),
    )
    expect(items).toEqual([{ role: 'copy', enabled: true }])
  })

  it('whitespace-only selection is not a selection', () => {
    expect(contextual(contextMenuTemplate(params({ selectionText: '  \n ' })))).toEqual([])
  })

  it('links add Copy Link Address for parsed http(s) URLs only', () => {
    expect(contextual(contextMenuTemplate(params({ linkURL: 'https://example.com/x' })))).toEqual([
      { label: 'Copy Link Address', copyLink: 'https://example.com/x' },
    ])
    // file:, custom schemes, junk: no link item — same rule as shell:openExternal
    for (const bad of ['file:///etc/passwd', 'app://bundle/index.html', 'not a url']) {
      expect(contextual(contextMenuTemplate(params({ linkURL: bad })))).toEqual([])
    }
  })

  it('copies the CANONICAL href, capped — never the raw string', () => {
    // canonicalization: parser-normalized form goes to the clipboard
    expect(contextual(contextMenuTemplate(params({ linkURL: 'https://example.com' })))).toEqual([
      { label: 'Copy Link Address', copyLink: 'https://example.com/' },
    ])
    // an enormous href must not become a clipboard bomb (2048 cap, both raw
    // and canonicalized length)
    const huge = 'https://example.com/' + 'a'.repeat(3000)
    expect(contextual(contextMenuTemplate(params({ linkURL: huge })))).toEqual([])
  })

  it('non-role items except New Window are main-frame only — den iframes get roles', () => {
    // a link inside an untrusted iframe grows NO Copy Link item…
    expect(
      contextual(
        contextMenuTemplate(params({ linkURL: 'https://example.com/x', mainFrame: false })),
      ),
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
