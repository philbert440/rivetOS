import { describe, expect, it } from 'vitest'
import {
  DIALOG_SELECTOR,
  INERT_SELECTOR,
  focusIsInUse,
  type FocusedElementLike,
} from './composer-autofocus.js'

/** A focused element whose ancestors match `within` (selector clauses such as
 *  `[role="dialog"]`). `closest(sel)` finds one only when `sel` lists a clause
 *  in `within`, so a typo in the real selector fails these tests. */
function el(
  tagName: string,
  opts: { editable?: boolean; within?: string[] } = {},
): FocusedElementLike & { asked: string[] } {
  const asked: string[] = []
  return {
    tagName,
    isContentEditable: opts.editable ?? false,
    asked,
    closest: (selector: string) => {
      asked.push(selector)
      const clauses = selector.split(',').map((c) => c.trim())
      return (opts.within ?? []).some((w) => clauses.includes(w)) ? {} : null
    },
  }
}

describe('focusIsInUse', () => {
  it('nothing focused (or body) is free to take', () => {
    expect(focusIsInUse(null)).toBe(false)
    expect(focusIsInUse(undefined)).toBe(false)
    expect(focusIsInUse(el('BODY'))).toBe(false)
  })

  it('a clicked sidebar link or new-chat button does not block autofocus', () => {
    expect(focusIsInUse(el('A'))).toBe(false)
    expect(focusIsInUse(el('BUTTON'))).toBe(false)
  })

  it('text entry is in use: rename/filter inputs, the terminal textarea, selects', () => {
    expect(focusIsInUse(el('INPUT'))).toBe(true)
    expect(focusIsInUse(el('TEXTAREA'))).toBe(true)
    expect(focusIsInUse(el('SELECT'))).toBe(true)
    expect(focusIsInUse(el('input'))).toBe(true)
  })

  it('contenteditable is in use', () => {
    expect(focusIsInUse(el('DIV', { editable: true }))).toBe(true)
  })

  it('asks for the dialog selector', () => {
    const button = el('BUTTON')
    focusIsInUse(button)
    expect(button.asked).toContain(DIALOG_SELECTOR)
  })

  it.each(['dialog', '[role="dialog"]', '[role="alertdialog"]', '[aria-modal="true"]'])(
    'anything inside %s is in use, even a button',
    (ancestor) => {
      expect(focusIsInUse(el('BUTTON', { within: [ancestor] }))).toBe(true)
    },
  )

  it('a Radix picker popover (role="dialog") keeps its focus', () => {
    expect(focusIsInUse(el('BUTTON', { within: ['[role="dialog"]'] }))).toBe(true)
  })

  it('a row button in the closed (inert) narrow history drawer does not block autofocus', () => {
    const row = el('BUTTON', { within: ['[role="dialog"]', INERT_SELECTOR] })
    expect(focusIsInUse(row)).toBe(false)
  })

  it('an input inside an inert subtree is not in use either', () => {
    expect(focusIsInUse(el('INPUT', { within: [INERT_SELECTOR] }))).toBe(false)
  })

  it('the open drawer (not inert) still protects its filter input and rows', () => {
    expect(focusIsInUse(el('INPUT', { within: ['[role="dialog"]'] }))).toBe(true)
    expect(focusIsInUse(el('BUTTON', { within: ['[role="dialog"]'] }))).toBe(true)
  })
})
