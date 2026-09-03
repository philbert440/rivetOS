import { describe, expect, it } from 'vitest'
import { shouldCloseDrawerOnSelection } from './drawer-selection.js'

describe('shouldCloseDrawerOnSelection', () => {
  it('closes on a narrow selection even when href is unchanged', () => {
    expect(shouldCloseDrawerOnSelection(true)).toBe(true)
  })

  it('does not close on desktop', () => {
    expect(shouldCloseDrawerOnSelection(false)).toBe(false)
  })
})
