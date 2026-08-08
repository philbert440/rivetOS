import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  COMMANDS,
  helpText,
  parseArgv,
  routePlugin,
  routeSkill,
  run,
  type CommandHandler,
} from './cli.js'

/**
 * Pull every `rivetos <command>` token out of the help screen.
 * Matches the leading word after `rivetos` on an indented usage line, so
 * `rivetos model <provider> <model>` yields `model` and the `Docs:` footer
 * yields nothing.
 */
function documentedCommands(): Set<string> {
  const tokens = new Set<string>()
  for (const match of helpText().matchAll(/^\s+rivetos\s+([a-z][a-z-]*)/gm)) {
    tokens.add(match[1])
  }
  return tokens
}

/** Temporarily install a fake handler so `run()` can be exercised in-process. */
function withStubCommand(name: string, handler: CommandHandler, fn: () => Promise<void>) {
  const had = Object.prototype.hasOwnProperty.call(COMMANDS, name)
  const previous = COMMANDS[name]
  COMMANDS[name] = handler
  return fn().finally(() => {
    if (had) COMMANDS[name] = previous
    else delete COMMANDS[name]
  })
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('parseArgv', () => {
  it('treats a bare invocation as a help request', () => {
    expect(parseArgv([])).toEqual({ args: [], wantsHelp: true })
  })

  it('treats --help and -h as help requests, not commands', () => {
    expect(parseArgv(['--help']).wantsHelp).toBe(true)
    expect(parseArgv(['--help']).command).toBeUndefined()
    expect(parseArgv(['-h']).wantsHelp).toBe(true)
    expect(parseArgv(['-h']).command).toBeUndefined()
  })

  it('splits the command from the arguments that follow it', () => {
    expect(parseArgv(['start', '--config', '/etc/rivetos.yaml'])).toEqual({
      command: 'start',
      args: ['--config', '/etc/rivetos.yaml'],
      wantsHelp: false,
    })
  })

  it('keeps a --help that comes after a command as an argument for that command', () => {
    // `rivetos logs --help` must reach the logs command, not the global help.
    const parsed = parseArgv(['logs', '--help'])
    expect(parsed.command).toBe('logs')
    expect(parsed.args).toEqual(['--help'])
    expect(parsed.wantsHelp).toBe(false)
  })

  it('does not swallow a repeated command name', () => {
    expect(parseArgv(['plugin', 'init', 'provider', 'mistral']).args).toEqual([
      'init',
      'provider',
      'mistral',
    ])
  })
})

describe('command registry', () => {
  it('registers every command as a callable handler', () => {
    for (const [name, handler] of Object.entries(COMMANDS)) {
      expect(typeof handler, `${name} handler`).toBe('function')
    }
  })

  it('exposes the commands the runtime and docs depend on', () => {
    // Not the full list (that is asserted against the help screen below) —
    // these are the ones scripts, systemd units and the README invoke.
    for (const name of ['init', 'start', 'stop', 'status', 'update', 'doctor', 'version']) {
      expect(Object.keys(COMMANDS)).toContain(name)
    }
  })

  it('names commands in lowercase kebab-case', () => {
    for (const name of Object.keys(COMMANDS)) {
      expect(name, `command "${name}"`).toMatch(/^[a-z][a-z-]*$/)
    }
  })
})

describe('help output completeness', () => {
  it('documents every registered command', () => {
    const documented = documentedCommands()
    const undocumented = Object.keys(COMMANDS).filter((name) => !documented.has(name))
    expect(undocumented, 'commands missing from `rivetos help`').toEqual([])
  })

  it('does not advertise commands that are not registered', () => {
    const registered = new Set(Object.keys(COMMANDS))
    const phantom = [...documentedCommands()].filter((name) => !registered.has(name))
    expect(phantom, 'help entries with no handler behind them').toEqual([])
  })

  it('gives every documented command a description column', () => {
    const lines = helpText()
      .split('\n')
      .filter((line) => /^\s+rivetos\s+[a-z]/.test(line))
    expect(lines.length).toBeGreaterThan(0)
    for (const line of lines) {
      // usage and description are separated by at least two spaces
      const description = line.trimEnd().split(/ {2,}/).slice(1).join(' ')
      expect(description.trim(), `no description: "${line.trim()}"`).not.toBe('')
    }
  })
})

describe('sub-command routing', () => {
  it('routes `plugin init` to the scaffolder and forwards the rest of the args', () => {
    expect(routePlugin(['init', 'provider', 'mistral'])).toEqual({
      module: 'plugin-init',
      args: ['provider', 'mistral'],
    })
  })

  it('falls back to the plugin list for a bare or unknown plugin sub-command', () => {
    expect(routePlugin([]).module).toBe('plugins')
    expect(routePlugin(['list']).module).toBe('plugins')
    expect(routePlugin(['nonsense']).module).toBe('plugins')
  })

  it('routes `skill init` and `skill validate` to their own modules', () => {
    expect(routeSkill(['init', 'weather'])).toEqual({
      module: 'skill-init',
      args: ['weather'],
    })
    expect(routeSkill(['validate', './skills/weather'])).toEqual({
      module: 'skill-validate',
      args: ['./skills/weather'],
    })
  })

  it('falls back to the skill list for a bare or unknown skill sub-command', () => {
    expect(routeSkill([]).module).toBe('skills')
    expect(routeSkill(['list']).module).toBe('skills')
  })
})

describe('run', () => {
  it('prints help and succeeds when no command is given', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    await expect(run([])).resolves.toBe(0)
    expect(log).toHaveBeenCalledOnce()
    expect(log.mock.calls[0][0]).toContain('rivetos — Lightweight, stable agent runtime')
  })

  it('prints help and succeeds for the explicit help command', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    await expect(run(['help'])).resolves.toBe(0)
    expect(log.mock.calls[0][0]).toContain('rivetos init')
  })

  it('reports an unknown command on stderr, prints help, and exits non-zero', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    await expect(run(['definitely-not-a-command'])).resolves.toBe(1)
    expect(error).toHaveBeenCalledWith('Unknown command: definitely-not-a-command')
    expect(log).toHaveBeenCalledOnce()
  })

  it('hands the handler only the args that follow the command name', async () => {
    const handler = vi.fn()
    await withStubCommand('__probe', handler, async () => {
      await expect(run(['__probe', 'a', '--flag', 'b'])).resolves.toBe(0)
    })
    expect(handler).toHaveBeenCalledWith(['a', '--flag', 'b'])
  })

  it('awaits an async handler before resolving', async () => {
    let settled = false
    const handler = () =>
      new Promise<void>((resolve) =>
        setTimeout(() => {
          settled = true
          resolve()
        }, 5),
      )
    await withStubCommand('__probe', handler, async () => {
      await expect(run(['__probe'])).resolves.toBe(0)
    })
    expect(settled).toBe(true)
  })

  it('turns a thrown handler error into exit code 1 instead of an unhandled rejection', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const handler = () => {
      throw new Error('boom')
    }
    await withStubCommand('__probe', handler, async () => {
      await expect(run(['__probe'])).resolves.toBe(1)
    })
    expect(error).toHaveBeenCalledWith('Error: boom')
  })

  it('turns a rejected async handler into exit code 1', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const handler = () => Promise.reject(new Error('async boom'))
    await withStubCommand('__probe', handler, async () => {
      await expect(run(['__probe'])).resolves.toBe(1)
    })
    expect(error).toHaveBeenCalledWith('Error: async boom')
  })
})
