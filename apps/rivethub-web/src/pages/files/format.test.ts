import { describe, expect, it } from 'vitest'
import { fmtMtime, fmtSize } from './format.js'

describe('fmtSize', () => {
  it('renders bytes, KB, MB, GB', () => {
    expect(fmtSize(0)).toBe('0 B')
    expect(fmtSize(1023)).toBe('1023 B')
    expect(fmtSize(1024)).toBe('1.0 KB')
    expect(fmtSize(5 * 1024 * 1024)).toBe('5.0 MB')
    expect(fmtSize(2.5 * 1024 * 1024 * 1024)).toBe('2.50 GB')
  })
})

describe('fmtMtime', () => {
  it('renders date with two-digit minute and no seconds column', () => {
    const out = fmtMtime(new Date('2026-10-14T18:30:00').getTime())
    expect(out).toContain(':30')
    expect(out).not.toMatch(/:\d\d:\d\d/)
  })
})
