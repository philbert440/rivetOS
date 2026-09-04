import { describe, expect, it } from 'vitest'
import { shouldCloseDrawerOnSelection, shouldCloseHistoryOnSelect } from './drawer-selection.js'

describe('shouldCloseDrawerOnSelection', () => {
  it('closes on a narrow selection even when href is unchanged', () => {
    expect(shouldCloseDrawerOnSelection(true)).toBe(true)
  })

  it('does not close on desktop', () => {
    expect(shouldCloseDrawerOnSelection(false)).toBe(false)
  })
})

describe('shouldCloseHistoryOnSelect', () => {
  it('closes the right history drawer when a narrow row is picked', () => {
    expect(shouldCloseHistoryOnSelect(true)).toBe(true)
  })

  it('never closes on desktop (the drawer is not mounted there)', () => {
    expect(shouldCloseHistoryOnSelect(false)).toBe(false)
  })
})
