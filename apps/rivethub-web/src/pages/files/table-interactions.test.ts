import { describe, expect, it } from 'vitest'
import { selectionTextWithin, shouldIgnoreRowActivate } from './table-interactions.js'

describe('shouldIgnoreRowActivate', () => {
  it('ignores the checkbox cell via data-no-open', () => {
    const cell = { closest: (sel: string) => (sel.includes('[data-no-open]') ? {} : null) }
    expect(shouldIgnoreRowActivate({ detail: 1, target: cell as unknown as EventTarget })).toBe(
      true,
    )
  })

  it('ignores detail > 1 (second click of a double-click)', () => {
    expect(shouldIgnoreRowActivate({ detail: 2, target: null })).toBe(true)
  })

  it('ignores a non-empty text selection', () => {
    expect(shouldIgnoreRowActivate({ detail: 1, target: null, selectionText: 'filename.md' })).toBe(
      true,
    )
  })

  it('allows a plain single click with no selection', () => {
    const el = { closest: () => null }
    expect(
      shouldIgnoreRowActivate({
        detail: 1,
        target: el as unknown as EventTarget,
        selectionText: '',
      }),
    ).toBe(false)
  })
})

describe('selectionTextWithin', () => {
  const row = { contains: (n: never) => n === ('in-row' as never) }
  const sel = (anchor: unknown, focus: unknown, collapsed = false) => ({
    isCollapsed: collapsed,
    anchorNode: anchor,
    focusNode: focus,
    toString: () => 'report.md',
  })

  it('returns the text when the selection starts or ends inside the row', () => {
    expect(selectionTextWithin(sel('in-row', 'elsewhere'), row)).toBe('report.md')
    expect(selectionTextWithin(sel('elsewhere', 'in-row'), row)).toBe('report.md')
  })

  it('ignores a selection elsewhere on the page, so it cannot swallow the row click', () => {
    expect(selectionTextWithin(sel('editor', 'editor'), row)).toBe('')
    expect(
      shouldIgnoreRowActivate({
        detail: 1,
        target: null,
        selectionText: selectionTextWithin(sel('editor', 'editor'), row),
      }),
    ).toBe(false)
  })

  it('ignores a collapsed selection, a missing selection and a missing row', () => {
    expect(selectionTextWithin(sel('in-row', 'in-row', true), row)).toBe('')
    expect(selectionTextWithin(null, row)).toBe('')
    expect(selectionTextWithin(sel('in-row', 'in-row'), null)).toBe('')
  })
})
