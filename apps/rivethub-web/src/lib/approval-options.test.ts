import { describe, expect, it } from 'vitest'
import { supportsSessionApproval } from './approval-options.js'

describe('session approval choices', () => {
  it('hides session approval for the complete Codex allow/deny capture', () => {
    expect(
      supportsSessionApproval(['Yes, proceed', 'No, and tell Codex what to do differently']),
    ).toBe(false)
  })
  it('preserves driver fallback for partial Kimi and absent captures', () => {
    expect(supportsSessionApproval(['Reject', 'Reject with feedback'])).toBe(true)
    expect(supportsSessionApproval([])).toBe(true)
  })
  it.each([
    "Yes, don't ask again",
    'Yes, dont ask again',
    'Always allow',
    'Never ask again',
    'Allow for this session',
  ])('recognizes backend remember label %s', (label) => {
    expect(supportsSessionApproval(['Yes', label, 'Reject'])).toBe(true)
  })
  it('does not mistake a negative remember choice for permission', () => {
    expect(supportsSessionApproval(['Yes', 'No, never ask again'])).toBe(false)
  })
})
