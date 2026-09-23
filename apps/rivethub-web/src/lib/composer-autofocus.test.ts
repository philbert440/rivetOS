import { describe, expect, it } from 'vitest'
import { focusIsInUse, type FocusedElementLike } from './composer-autofocus.js'

function el(
  tagName: string,
  opts: { editable?: boolean; inDialog?: boolean } = {},
): FocusedElementLike {
  return {
    tagName,
    isContentEditable: opts.editable ?? false,
    closest: () => (opts.inDialog ? {} : null),
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

  it('anything inside a dialog focus trap is in use, even a button', () => {
    expect(focusIsInUse(el('BUTTON', { inDialog: true }))).toBe(true)
  })
})
