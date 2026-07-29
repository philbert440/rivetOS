/**
 * Unit tests for memory_browse / memory_search window= resolution.
 * Pure timezone math — no Postgres required.
 */

import { describe, expect, it } from 'vitest'
import {
  applyWindowArgs,
  fmtHitWhen,
  fmtLocalDate,
  fmtLocalTs,
  isWindowChoice,
  normalizeWindowInput,
  resolveWindow,
  timeSince,
  WINDOW_CHOICES,
} from './helpers.js'

/** Local-midnight of the calendar day containing `d` (process TZ). */
function localMidnight(d: Date): Date {
  const x = new Date(d.getTime())
  x.setHours(0, 0, 0, 0)
  return x
}

describe('WINDOW_CHOICES', () => {
  it('lists the Hermes-parity enum values plus rolling multi-day windows', () => {
    expect(WINDOW_CHOICES).toEqual([
      'today',
      'yesterday',
      'this_morning',
      'this_week',
      'last_24h',
      'last_7d',
      'last_14d',
    ])
  })

  it('isWindowChoice accepts only known values', () => {
    expect(isWindowChoice('today')).toBe(true)
    expect(isWindowChoice('last_7d')).toBe(true)
    expect(isWindowChoice('last_14d')).toBe(true)
    expect(isWindowChoice('not_a_real_window')).toBe(false)
  })
})

describe('normalizeWindowInput', () => {
  it('maps spaced / hyphenated forms onto snake_case choices', () => {
    expect(normalizeWindowInput('this morning')).toBe('this_morning')
    expect(normalizeWindowInput('this week')).toBe('this_week')
    expect(normalizeWindowInput('last 24h')).toBe('last_24h')
    expect(normalizeWindowInput('last 24 hours')).toBe('last_24h')
    expect(normalizeWindowInput('last-24h')).toBe('last_24h')
    expect(normalizeWindowInput('  TODAY  ')).toBe('today')
    expect(normalizeWindowInput('last 7 days')).toBe('last_7d')
    expect(normalizeWindowInput('last-7d')).toBe('last_7d')
    expect(normalizeWindowInput('past 14 days')).toBe('last_14d')
    expect(normalizeWindowInput('last week')).toBe('last_7d')
    expect(normalizeWindowInput('last two weeks')).toBe('last_14d')
  })

  it('returns null for empty input', () => {
    expect(normalizeWindowInput('')).toBeNull()
    expect(normalizeWindowInput('   ')).toBeNull()
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

  it('normalizes spaced this morning', () => {
    expect(resolveWindow('this morning', now)).toEqual(resolveWindow('this_morning', now))
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

  it('last_7d → rolling 7×24h from now', () => {
    const { since, before } = resolveWindow('last_7d', now)
    expect(before).toBeNull()
    expect(since).toBe(new Date(now.getTime() - 7 * 86_400_000).toISOString())
  })

  it('last_14d → rolling 14×24h from now', () => {
    const { since, before } = resolveWindow('last_14d', now)
    expect(before).toBeNull()
    expect(since).toBe(new Date(now.getTime() - 14 * 86_400_000).toISOString())
  })

  it('last_week aliases to rolling last_7d (not calendar previous week)', () => {
    expect(resolveWindow('last_week', now)).toEqual(resolveWindow('last_7d', now))
    expect(resolveWindow('past week', now)).toEqual(resolveWindow('last_7d', now))
  })

  it('unknown window throws with valid choices listed', () => {
    expect(() => resolveWindow('not_a_real_window', now)).toThrow(/Unknown window/)
    expect(() => resolveWindow('not_a_real_window', now)).toThrow(/today/)
    expect(() => resolveWindow('not_a_real_window', now)).toThrow(/last_24h/)
    expect(() => resolveWindow('not_a_real_window', now)).toThrow(/last_7d/)
  })

  it('empty window throws', () => {
    expect(() => resolveWindow('   ', now)).toThrow(/Invalid window/)
  })

  it('returns ISO-8601 UTC strings', () => {
    const { since } = resolveWindow('today', now)
    expect(since).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.\d{3}Z$/)
  })
})

describe('fmtLocalTs', () => {
  // Fixed UTC instant. Local wall-clock depends on process TZ; we assert the
  // contract that agents need: date+time plus a zone label so UTC is never
  // mistaken for local (the old browse format was unlabeled UTC).
  const utcInstant = new Date('2026-07-15T19:30:00.000Z')

  it('renders YYYY-MM-DD HH:MM:SS with a timezone suffix', () => {
    const s = fmtLocalTs(utcInstant)
    expect(s).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\b/)
    // At least three space-separated tokens: date, time, zone (zone may be
    // multi-word like "GMT+2" in some locales; require a non-digit tail).
    expect(s.length).toBeGreaterThan('YYYY-MM-DD HH:MM:SS'.length)
    const unlabeledUtc = utcInstant.toISOString().replace('T', ' ').slice(0, 19)
    // Either the local wall-clock differs from UTC, or we appended a label
    // onto the UTC wall-clock — never return bare unlabeled UTC.
    if (s.startsWith(unlabeledUtc)) {
      expect(s.length).toBeGreaterThan(unlabeledUtc.length)
      expect(s.slice(unlabeledUtc.length).trim().length).toBeGreaterThan(0)
    }
  })

  it('matches process-local calendar fields', () => {
    const s = fmtLocalTs(utcInstant)
    const pad = (n: number) => String(n).padStart(2, '0')
    const expectedPrefix =
      `${String(utcInstant.getFullYear())}-${pad(utcInstant.getMonth() + 1)}-${pad(utcInstant.getDate())} ` +
      `${pad(utcInstant.getHours())}:${pad(utcInstant.getMinutes())}:${pad(utcInstant.getSeconds())}`
    expect(s.startsWith(expectedPrefix)).toBe(true)
  })
})

describe('fmtLocalDate', () => {
  it('returns process-local YYYY-MM-DD (not UTC date-only)', () => {
    // Late evening US Eastern is next calendar day in UTC — local date must win.
    const eveningUs = new Date('2026-07-29T03:30:00.000Z') // 23:30 EDT Jul 28
    const local = fmtLocalDate(eveningUs)
    const pad = (n: number) => String(n).padStart(2, '0')
    const expected = `${String(eveningUs.getFullYear())}-${pad(eveningUs.getMonth() + 1)}-${pad(eveningUs.getDate())}`
    expect(local).toBe(expected)
    // On America/* offsets west of UTC this differs from the UTC date string.
    const utcDate = eveningUs.toISOString().split('T')[0]
    if (eveningUs.getTimezoneOffset() > 0) {
      expect(local).not.toBe(utcDate)
    }
  })

  it('returns ? for null', () => {
    expect(fmtLocalDate(null)).toBe('?')
  })
})

describe('timeSince / fmtHitWhen', () => {
  it('uses hour/minute granularity for same-day hits (not 0d ago)', () => {
    const threeHoursAgo = new Date(Date.now() - 3 * 3_600_000)
    expect(timeSince(threeHoursAgo)).toMatch(/^\d+h ago$/)
    expect(timeSince(threeHoursAgo)).not.toBe('0d ago')
  })

  it('pairs relative age with absolute local timestamp', () => {
    const d = new Date(Date.now() - 45 * 60_000)
    const s = fmtHitWhen(d)
    expect(s).toMatch(/^\d+m ago · \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/)
    expect(s).toContain(fmtLocalTs(d))
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

  it('unknown window throws (does not silently drop the filter)', () => {
    expect(() => applyWindowArgs({ window: 'not_a_real_window' })).toThrow(/Unknown window/)
  })

  it('accepts last_week as rolling last_7d alias', () => {
    const out = applyWindowArgs({ window: 'last_week' })
    expect(out.since).toBeTruthy()
    expect(out.before).toBeUndefined()
    const age = Date.now() - new Date(out.since!).getTime()
    expect(age).toBeGreaterThan(6.5 * 86_400_000)
    expect(age).toBeLessThan(7.5 * 86_400_000)
  })

  it('accepts natural-language spaced window after normalize', () => {
    const out = applyWindowArgs({ window: 'this morning' })
    expect(out.since).toBeTruthy()
    expect(out.before).toBeUndefined()
  })
})
