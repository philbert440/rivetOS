import { describe, expect, it } from 'vitest'
import {
  clampDrawerWidth,
  DRAWER_WIDTH_DEFAULT,
  DRAWER_WIDTH_MAX,
  DRAWER_WIDTH_MIN,
} from './split-handle.js'

describe('clampDrawerWidth', () => {
  it('clamps into the drag range', () => {
    expect(clampDrawerWidth(10)).toBe(DRAWER_WIDTH_MIN)
    expect(clampDrawerWidth(10_000)).toBe(DRAWER_WIDTH_MAX)
    expect(clampDrawerWidth(300)).toBe(300)
    expect(clampDrawerWidth(300.6)).toBe(301)
  })

  it('falls back to the default on non-finite input', () => {
    expect(clampDrawerWidth(Number.NaN)).toBe(DRAWER_WIDTH_DEFAULT)
    expect(clampDrawerWidth(Number.POSITIVE_INFINITY)).toBe(DRAWER_WIDTH_DEFAULT)
  })
})
