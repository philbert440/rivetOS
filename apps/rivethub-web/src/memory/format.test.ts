import { describe, expect, it } from 'vitest'
import { relativeTime, shortTime } from './format.js'

describe('relativeTime', () => {
  it('treats a numeric lastActive as epoch ms instead of throwing', () => {
    const now = 1_792_943_500_000
    expect(relativeTime(now - 5 * 60_000, now)).toBe('5m ago')
    expect(relativeTime(now - 30_000, now)).toBe('just now')
    expect(relativeTime(now - 3 * 86_400_000, now)).toBe('3d ago')
  })
  it('still handles ISO strings and blanks', () => {
    const now = Date.parse('2026-10-25T12:00:00Z')
    expect(relativeTime('2026-10-25T10:00:00Z', now)).toBe('2h ago')
    expect(relativeTime(undefined)).toBe('—')
    expect(relativeTime(null)).toBe('—')
    expect(relativeTime('')).toBe('—')
    expect(relativeTime('not-a-date')).toBe('not-a-date')
  })
})

describe('shortTime', () => {
  it('accepts epoch ms and ISO strings', () => {
    expect(shortTime(1_792_943_500_000)).not.toBe('—')
    expect(shortTime('2026-10-25T10:00:00Z')).not.toBe('—')
    expect(shortTime(undefined)).toBe('—')
    expect(shortTime('garbage')).toBe('garbage')
  })
})
