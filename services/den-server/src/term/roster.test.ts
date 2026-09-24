import { homedir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { builtinRosterArgv0, defaultRoster, defaultSpawnCwd, type TermRoster } from './roster.js'

describe('builtinRosterArgv0', () => {
  it('returns the built-in program, not later argv, and nothing for an operator key', () => {
    expect(builtinRosterArgv0('claude')).toBe('claude')
    expect(builtinRosterArgv0('grok')).toBe(defaultRoster().commands.grok?.cmd[0])
    expect(builtinRosterArgv0('grok')).toBe('grok')
    expect(builtinRosterArgv0('not-a-builtin')).toBeUndefined()
  })
})

describe('defaultSpawnCwd', () => {
  it('uses homedir for room entries, entry cwd for opencode, roster cwd when unknown', () => {
    const roster = defaultRoster()
    expect(defaultSpawnCwd(roster, 'claude')).toBe(homedir())
    expect(defaultSpawnCwd(roster, 'opencode')).toBe(join(homedir(), '.rivetos', 'workspace'))
    expect(defaultSpawnCwd(roster, 'shell')).toBe(homedir())
    expect(defaultSpawnCwd(roster, 'nope')).toBe(roster.cwd)
    const custom: TermRoster = {
      ...roster,
      cwd: '/roster',
      commands: {
        ...roster.commands,
        shell: { ...roster.commands.shell, cwd: '/entry' },
      },
    }
    expect(defaultSpawnCwd(custom, 'shell')).toBe('/entry')
    expect(defaultSpawnCwd(custom, 'claude')).toBe(homedir())
    expect(defaultSpawnCwd(custom, 'missing')).toBe('/roster')
  })
})
