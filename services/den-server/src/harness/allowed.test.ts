import { describe, expect, it } from 'vitest'
import {
  createAllowedProbe,
  harnessNotAllowedMessage,
  normalizeAllowedHarnesses,
} from './allowed.js'

describe('normalizeAllowedHarnesses', () => {
  it('returns undefined when the list is unset (opt-in off)', () => {
    expect(normalizeAllowedHarnesses(undefined)).toBeUndefined()
    expect(normalizeAllowedHarnesses(null)).toBeUndefined()
  })

  it('trims and drops blanks; empty array is an empty set', () => {
    expect([...normalizeAllowedHarnesses([])!]).toEqual([])
    expect([...normalizeAllowedHarnesses(['  claude-code ', '', 'codex'])!].sort()).toEqual([
      'claude-code',
      'codex',
    ])
  })
})

describe('createAllowedProbe', () => {
  it('returns undefined when the list is unset (caller skips the gate)', () => {
    expect(createAllowedProbe(undefined)).toBeUndefined()
    expect(createAllowedProbe(null)).toBeUndefined()
  })

  it('membership-checks a configured list (empty = none)', () => {
    expect(createAllowedProbe([])!('claude-code')).toBe(false)
    const probe = createAllowedProbe(['claude-code', 'codex'])!
    expect(probe('claude-code')).toBe(true)
    expect(probe('codex')).toBe(true)
    expect(probe('hermes')).toBe(false)
  })
})

describe('harnessNotAllowedMessage', () => {
  it('names the harness and the config key', () => {
    expect(harnessNotAllowedMessage('hermes')).toContain('hermes')
    expect(harnessNotAllowedMessage('hermes')).toContain('den.allowed_harnesses')
  })
})
