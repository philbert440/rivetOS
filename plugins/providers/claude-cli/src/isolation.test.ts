import { describe, expect, it } from 'vitest'
import {
  CAPTURE_HOOK_EVENTS,
  isolationFlags,
  parseAllowedTools,
  parseTaskIsolation,
  userSettingsPath,
} from './isolation.js'

const USER_SETTINGS = {
  model: 'opus',
  permissions: { defaultMode: 'bypassPermissions', allow: ['Bash(rm:*)'] },
  enabledPlugins: { 'rivet-memory@rivetos': true },
  extraKnownMarketplaces: { rivetos: { source: { source: 'directory', path: '/x' } } },
  hooks: {
    Stop: [
      { hooks: [{ type: 'command', command: 'curl -s http://127.0.0.1:5174/hook' }] },
      {
        hooks: [
          { type: 'command', command: '"node" "/opt/x/claude-cli/dist/hooks.js"', timeout: 10 },
          { type: 'command', command: 'personal-notifier' },
        ],
      },
    ],
    PreToolUse: [{ hooks: [{ type: 'command', command: 'personal-gate' }] }],
  },
}

describe('parseTaskIsolation / parseAllowedTools', () => {
  it('accepts the three levels and nothing else', () => {
    expect(parseTaskIsolation('inherit')).toBe('inherit')
    expect(parseTaskIsolation('tools')).toBe('tools')
    expect(parseTaskIsolation('isolated')).toBe('isolated')
    expect(parseTaskIsolation('Isolated')).toBeUndefined()
    expect(parseTaskIsolation(true)).toBeUndefined()
    expect(parseTaskIsolation(undefined)).toBeUndefined()
  })

  it('keeps permission rules, drops anything that could parse as a flag', () => {
    expect(
      parseAllowedTools([
        'mcp__plugin_rivet-memory_rivetos',
        ' Bash(git status:*) ',
        '--dangerously-skip-permissions',
        '',
        7,
        'mcp__plugin_rivet-memory_rivetos',
        'bad\nrule',
      ]),
    ).toEqual(['mcp__plugin_rivet-memory_rivetos', 'Bash(git status:*)'])
    expect(parseAllowedTools([])).toBeUndefined()
    expect(parseAllowedTools('mcp__x')).toBeUndefined()
  })

  it('finds the user settings under CLAUDE_CONFIG_DIR, else ~/.claude', () => {
    expect(userSettingsPath({}, '/home/u')).toBe('/home/u/.claude/settings.json')
    expect(userSettingsPath({ CLAUDE_CONFIG_DIR: '/cfg' }, '/home/u')).toBe('/cfg/settings.json')
  })
})

describe('isolationFlags', () => {
  it('inherit adds nothing', () => {
    expect(isolationFlags('inherit', { readUserSettings: () => USER_SETTINGS })).toEqual({})
  })

  it('tools: project settings only, the operator plugins re-enabled, nothing personal', () => {
    const flags = isolationFlags('tools', { readUserSettings: () => USER_SETTINGS })
    expect(flags.settingSources).toBe('project')
    expect(flags.strictMcpConfig).toBeUndefined()
    const settings = JSON.parse(flags.settingsJson ?? '{}') as Record<string, unknown>
    expect(settings.enabledPlugins).toEqual(USER_SETTINGS.enabledPlugins)
    expect(settings.extraKnownMarketplaces).toEqual(USER_SETTINGS.extraKnownMarketplaces)
    // no personal permission rules, default mode or model ride along
    expect(settings.permissions).toBeUndefined()
    expect(settings.model).toBeUndefined()
    // only the hook RivetOS itself installed is carried over
    expect(settings.hooks).toEqual({
      Stop: [
        {
          hooks: [
            { type: 'command', command: '"node" "/opt/x/claude-cli/dist/hooks.js"', timeout: 10 },
          ],
        },
      ],
    })
  })

  it('tools with no readable user settings still drops the user source', () => {
    expect(isolationFlags('tools', { readUserSettings: () => undefined })).toEqual({
      settingSources: 'project',
    })
    expect(isolationFlags('tools', { readUserSettings: () => 'garbage' })).toEqual({
      settingSources: 'project',
    })
  })

  it('isolated: strict MCP, no plugins, capture hooks from this package', () => {
    const flags = isolationFlags('isolated', {
      readUserSettings: () => USER_SETTINGS,
      hookCommand: '"node" "/pkg/hooks.js"',
    })
    expect(flags.settingSources).toBe('project')
    expect(flags.strictMcpConfig).toBe(true)
    const settings = JSON.parse(flags.settingsJson ?? '{}') as {
      hooks: Record<string, { hooks: { command: string }[] }[]>
      enabledPlugins?: unknown
    }
    expect(settings.enabledPlugins).toBeUndefined()
    expect(Object.keys(settings.hooks).sort()).toEqual([...CAPTURE_HOOK_EVENTS].sort())
    for (const event of CAPTURE_HOOK_EVENTS) {
      expect(settings.hooks[event]).toEqual([
        { hooks: [{ type: 'command', command: '"node" "/pkg/hooks.js"', timeout: 10 }] },
      ])
    }
  })
})
