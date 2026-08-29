import { describe, expect, it } from 'vitest'
import { totalUnread } from './unread.js'

describe('totalUnread', () => {
  it('sums counts across windows', () => {
    expect(totalUnread([2, 3, 0])).toBe(5)
  })
  it('is 0 for no windows', () => {
    expect(totalUnread([])).toBe(0)
  })
  it('ignores junk values', () => {
    expect(totalUnread([2, Number.NaN, -5, Number.POSITIVE_INFINITY])).toBe(2)
  })
})
