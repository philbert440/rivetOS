import { describe, expect, it } from 'vitest'
import {
  CAPTURE_HOOK_EVENTS,
  isolationFlags,
  parseAllowedTools,
  parseTaskIsolation,
} from './isolation.js'

describe('parseTaskIsolation / parseAllowedTools', () => {
  it('accepts the two levels and nothing else', () => {
    expect(parseTaskIsolation('inherit')).toBe('inherit')
    expect(parseTaskIsolation('isolated')).toBe('isolated')
    expect(parseTaskIsolation('tools')).toBeUndefined()
    expect(parseTaskIsolation('Isolated')).toBeUndefined()
    expect(parseTaskIsolation(true)).toBeUndefined()
    expect(parseTaskIsolation(undefined)).toBeUndefined()
  })

  it('keeps permission rules, drops anything that could parse as a flag', () => {
    expect(
      parseAllowedTools([
        'mcp__rivetos',
        ' Bash(git status:*) ',
        '--dangerously-skip-permissions',
        '',
        7,
        'mcp__rivetos',
        'bad\nrule',
      ]),
    ).toEqual(['mcp__rivetos', 'Bash(git status:*)'])
    expect(parseAllowedTools([])).toBeUndefined()
    expect(parseAllowedTools('mcp__x')).toBeUndefined()
  })
})

describe('isolationFlags', () => {
  it('inherit adds nothing', () => {
    expect(isolationFlags('inherit')).toEqual({})
  })

  it('isolated: project settings only, strict MCP, capture hooks from this package', () => {
    const flags = isolationFlags('isolated', { hookCommand: '"node" "/pkg/hooks.js"' })
    expect(flags.settingSources).toBe('project')
    expect(flags.strictMcpConfig).toBe(true)
    const settings = JSON.parse(flags.settingsJson ?? '{}') as Record<string, unknown> & {
      hooks: Record<string, { hooks: { command: string }[] }[]>
    }
    // nothing personal rides along: the object holds the capture hooks and nothing else
    expect(Object.keys(settings)).toEqual(['hooks'])
    expect(Object.keys(settings.hooks).sort()).toEqual([...CAPTURE_HOOK_EVENTS].sort())
    for (const event of CAPTURE_HOOK_EVENTS) {
      expect(settings.hooks[event]).toEqual([
        { hooks: [{ type: 'command', command: '"node" "/pkg/hooks.js"', timeout: 10 }] },
      ])
    }
  })

  it('defaults the hook command to this package handler', () => {
    const settings = JSON.parse(isolationFlags('isolated').settingsJson ?? '{}') as {
      hooks: Record<string, { hooks: { command: string }[] }[]>
    }
    expect(settings.hooks.Stop[0].hooks[0].command).toMatch(/hooks\.js"$/)
  })
})
