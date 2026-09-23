import { describe, expect, it } from 'vitest'
import { builtinRosterArgv0, defaultRoster } from './roster.js'

describe('builtinRosterArgv0', () => {
  it('returns the built-in program, not later argv, and nothing for an operator key', () => {
    expect(builtinRosterArgv0('claude')).toBe('claude')
    expect(builtinRosterArgv0('grok')).toBe(defaultRoster().commands.grok?.cmd[0])
    expect(builtinRosterArgv0('grok')).toBe('grok')
    expect(builtinRosterArgv0('not-a-builtin')).toBeUndefined()
  })
})
