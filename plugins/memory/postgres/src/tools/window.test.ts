/**
 * Unit tests for memory_browse / memory_search window= resolution.
 * Pure timezone math — no Postgres required.
 */

import { describe, expect, it } from 'vitest'
import { applyWindowArgs, isWindowChoice, resolveWindow, WINDOW_CHOICES } from './helpers.js'

/** Local-midnight of the calendar day containing `d` (process TZ). */
function localMidnight(d: Date): Date {
  const x = new Date(d.getTime())
  x.setHours(0, 0, 0, 0)
  return x
}

describe('WINDOW_CHOICES', () => {
  it('lists the Hermes-parity enum values', () => {
    expect(WINDOW_CHOICES).toEqual([
      'today',
      'yesterday',
      'this_morning',
      'this_week',
      'last_24h',
    ])
  })

  it('isWindowChoice accepts only known values', () => {
    expect(isWindowChoice('today')).toBe(true)
    expect(isWindowChoice('not_a_real_window')).toBe(false)
  })
})

describe('resolveWindow', () => {
  // Fixed instant — local calendar day depends on process TZ, so expected
  // bounds are computed with the same local helpers the implementation uses.
  const now = new Date('2026-07-15T19:30:00.000Z') // Wed afternoon UTC

  it('today → local midnight ISO, no upper bound', () => {
    const { since, before } = resolveWindow('today', now)
    expect(before).toBeNull()
    expect(since).toBe(localMidnight(now).toISOString())
  })

  it('this_morning shares today lower bound', () => {
    expect(resolveWindow('this_morning', now)).toEqual(resolveWindow('today', now))
  })

  it('yesterday → [local-yesterday-00:00, local-today-00:00)', () => {
    const { since, before } = resolveWindow('yesterday', now)
    const today = localMidnight(now)
    const yest = new Date(today.getTime())
    yest.setDate(yest.getDate() - 1)
    expect(since).toBe(yest.toISOString())
    expect(before).toBe(today.toISOString())
  })

  it('this_week → local Monday 00:00', () => {
    const { since, before } = resolveWindow('this_week', now)
    expect(before).toBeNull()
    const today = localMidnight(now)
    const monday = new Date(today.getTime())
    const day = monday.getDay()
    monday.setDate(monday.getDate() - (day === 0 ? 6 : day - 1))
    expect(since).toBe(monday.toISOString())
    expect(new Date(since!).getDay()).toBe(1)
  })

  it('last_24h → rolling 24h from now', () => {
    const { since, before } = resolveWindow('last_24h', now)
    expect(before).toBeNull()
    expect(since).toBe(new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString())
  })

  it('unknown window → (null, null)', () => {
    expect(resolveWindow('not_a_real_window', now)).toEqual({ since: null, before: null })
  })

  it('returns ISO-8601 UTC strings', () => {
    const { since } = resolveWindow('today', now)
    expect(since).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.\d{3}Z$/)
  })
})

describe('applyWindowArgs', () => {
  it('uses explicit since/before over window', () => {
    const out = applyWindowArgs({
      window: 'today',
      since: '2026-01-01T00:00:00.000Z',
      before: '2026-01-02T00:00:00.000Z',
    })
    expect(out).toEqual({
      since: '2026-01-01T00:00:00.000Z',
      before: '2026-01-02T00:00:00.000Z',
    })
  })

  it('applies window when neither since nor before is set', () => {
    const out = applyWindowArgs({ window: 'last_24h' })
    expect(out.since).toBeTruthy()
    expect(out.before).toBeUndefined()
    const age = Date.now() - new Date(out.since!).getTime()
    expect(age).toBeGreaterThan(23 * 60 * 60 * 1000)
    expect(age).toBeLessThan(25 * 60 * 60 * 1000)
  })

  it('returns empty bounds when nothing provided', () => {
    expect(applyWindowArgs({})).toEqual({ since: undefined, before: undefined })
  })

  it('explicit since alone suppresses window', () => {
    const out = applyWindowArgs({
      window: 'yesterday',
      since: '2026-06-01T12:00:00.000Z',
    })
    expect(out).toEqual({ since: '2026-06-01T12:00:00.000Z', before: undefined })
  })
})
