import { describe, expect, it } from 'vitest'
import {
  attachArgv,
  execPrefixFor,
  HOST_RE,
  LINUX_TERMINAL_CANDIDATES,
  MAC_COMMAND_UNLINK_MS,
  macCommandPath,
  macCommandScript,
  openInTerminal,
  parseTermAttach,
  resolveTerminalLauncher,
  SESSION_RE,
  shellQuote,
  SOCKET_RE,
  SSH_USER_RE,
  type OpenInTerminalIo,
  type SpawnFn,
  type TermAttachInfo,
} from './external-terminal.js'

function whichOf(...names: string[]): (cmd: string) => string | undefined {
  const set = new Set(names)
  return (cmd) => (set.has(cmd) ? `/usr/bin/${cmd}` : undefined)
}

function existsOf(...paths: string[]): (p: string) => boolean {
  const set = new Set(paths)
  return (p) => set.has(p)
}

const LOCAL: TermAttachInfo = {
  socket: 'rivet',
  session: 'sess',
  host: 'ct116',
  sshUser: 'rivet',
  local: true,
}

const LOCAL_ARGV = ['tmux', '-L', 'rivet', 'attach-session', '-t', '=sess'] as const

function fakeSpawn(
  log: {
    command?: string
    args?: string[]
    opts?: unknown
    unrefed?: boolean
  },
  emit: 'spawn' | 'error' = 'spawn',
  err: Error = new Error('ENOENT'),
): SpawnFn {
  return (command, args, opts) => {
    log.command = command
    log.args = args
    log.opts = opts
    return {
      unref() {
        log.unrefed = true
      },
      on(event, cb) {
        if (event === emit) cb(err)
      },
    }
  }
}

const silentIo: Partial<OpenInTerminalIo> = {
  writeFileSync: () => undefined,
  unlinkSync: () => undefined,
  tmpdir: () => '/tmp',
  randomId: () => 'id',
  setTimeout: () => ({}),
  exists: () => false,
}

describe('execPrefixFor', () => {
  it('matches the T5 per-emulator flags', () => {
    expect(execPrefixFor('ghostty')).toEqual(['-e'])
    expect(execPrefixFor('kitty')).toEqual([])
    expect(execPrefixFor('wezterm')).toEqual(['start', '--'])
    expect(execPrefixFor('alacritty')).toEqual(['-e'])
    expect(execPrefixFor('foot')).toEqual([])
    expect(execPrefixFor('gnome-terminal')).toEqual(['--'])
    expect(execPrefixFor('konsole')).toEqual(['-e'])
    expect(execPrefixFor('xfce4-terminal')).toEqual(['-x'])
    expect(execPrefixFor('xterm')).toEqual(['-e'])
    expect(execPrefixFor('/usr/bin/xdg-terminal-exec')).toEqual([])
    expect(execPrefixFor('x-terminal-emulator')).toEqual(['-e'])
  })

  it('defaults unknown $TERMINAL names to -e', () => {
    expect(execPrefixFor('myterm')).toEqual(['-e'])
  })
})

describe('resolveTerminalLauncher linux', () => {
  it('prefers $TERMINAL over xdg-terminal-exec and candidates', () => {
    const l = resolveTerminalLauncher(
      'linux',
      { TERMINAL: 'kitty' },
      whichOf('kitty', 'xdg-terminal-exec', 'ghostty'),
    )
    expect(l).toEqual({ kind: 'argv', command: '/usr/bin/kitty', prefix: [] })
  })

  it('applies wezterm flags when $TERMINAL names wezterm', () => {
    const l = resolveTerminalLauncher('linux', { TERMINAL: 'wezterm' }, whichOf('wezterm'))
    expect(l).toEqual({
      kind: 'argv',
      command: '/usr/bin/wezterm',
      prefix: ['start', '--'],
    })
  })

  it('uses an absolute $TERMINAL path when which confirms it exists', () => {
    const which = (cmd: string) =>
      cmd === '/opt/ghostty/ghostty' ? '/opt/ghostty/ghostty' : undefined
    const l = resolveTerminalLauncher('linux', { TERMINAL: '/opt/ghostty/ghostty' }, which)
    expect(l).toEqual({
      kind: 'argv',
      command: '/opt/ghostty/ghostty',
      prefix: ['-e'],
    })
  })

  it('skips an absolute $TERMINAL that which cannot find', () => {
    const l = resolveTerminalLauncher(
      'linux',
      { TERMINAL: '/opt/ghostty/ghostty' },
      whichOf('xterm'),
    )
    expect(l).toEqual({ kind: 'argv', command: '/usr/bin/xterm', prefix: ['-e'] })
  })

  it('skips $TERMINAL when it is not on PATH and is not absolute', () => {
    const l = resolveTerminalLauncher(
      'linux',
      { TERMINAL: 'ghostty' },
      whichOf('xdg-terminal-exec'),
    )
    expect(l).toEqual({
      kind: 'argv',
      command: '/usr/bin/xdg-terminal-exec',
      prefix: [],
    })
  })

  it('skips $TERMINAL with unsafe characters rather than throwing', () => {
    const l = resolveTerminalLauncher(
      'linux',
      { TERMINAL: 'kitty -e' },
      whichOf('xterm'),
    )
    expect(l).toEqual({ kind: 'argv', command: '/usr/bin/xterm', prefix: ['-e'] })
  })

  it('uses xdg-terminal-exec before x-terminal-emulator and candidates', () => {
    const l = resolveTerminalLauncher(
      'linux',
      {},
      whichOf('xdg-terminal-exec', 'x-terminal-emulator', 'ghostty'),
    )
    expect(l).toEqual({
      kind: 'argv',
      command: '/usr/bin/xdg-terminal-exec',
      prefix: [],
    })
  })

  it('uses x-terminal-emulator before the candidate list', () => {
    const l = resolveTerminalLauncher(
      'linux',
      {},
      whichOf('x-terminal-emulator', 'ghostty', 'xterm'),
    )
    expect(l).toEqual({
      kind: 'argv',
      command: '/usr/bin/x-terminal-emulator',
      prefix: ['-e'],
    })
  })

  it('walks the candidate list in the documented order', () => {
    expect(LINUX_TERMINAL_CANDIDATES).toEqual([
      'ghostty',
      'kitty',
      'wezterm',
      'alacritty',
      'foot',
      'gnome-terminal',
      'konsole',
      'xfce4-terminal',
      'xterm',
    ])
    const l = resolveTerminalLauncher(
      'linux',
      {},
      whichOf('xterm', 'gnome-terminal', 'alacritty'),
    )
    expect(l).toEqual({
      kind: 'argv',
      command: '/usr/bin/alacritty',
      prefix: ['-e'],
    })
  })

  it('returns undefined when nothing is available', () => {
    expect(resolveTerminalLauncher('linux', {}, () => undefined)).toBeUndefined()
  })
})

describe('resolveTerminalLauncher darwin / win32', () => {
  it('prefers Ghostty when /Applications/Ghostty.app exists', () => {
    expect(
      resolveTerminalLauncher(
        'darwin',
        {},
        () => undefined,
        existsOf('/Applications/Ghostty.app', '/Applications/iTerm.app'),
      ),
    ).toEqual({
      kind: 'mac-command',
      app: 'Ghostty',
    })
  })

  it('falls through to iTerm then Terminal.app', () => {
    expect(
      resolveTerminalLauncher(
        'darwin',
        {},
        () => undefined,
        existsOf('/Applications/iTerm.app'),
      ),
    ).toEqual({
      kind: 'mac-command',
      app: 'iTerm',
    })
    expect(resolveTerminalLauncher('darwin', {}, () => undefined, () => false)).toEqual({
      kind: 'mac-command',
      app: 'Terminal',
    })
  })

  it('prefers wt.exe new-tab -- argv on Windows', () => {
    const which = (cmd: string) =>
      cmd === 'wt.exe' ? 'C:\\Windows\\System32\\wt.exe' : undefined
    expect(resolveTerminalLauncher('win32', {}, which)).toEqual({
      kind: 'argv',
      command: 'C:\\Windows\\System32\\wt.exe',
      prefix: ['new-tab', '--'],
    })
  })

  it('falls back to cmd /c start when wt is absent', () => {
    expect(resolveTerminalLauncher('win32', {}, () => undefined)).toEqual({
      kind: 'win-cmd-start',
    })
  })

  it('returns undefined on unknown platforms', () => {
    expect(
      resolveTerminalLauncher('freebsd' as NodeJS.Platform, {}, () => undefined),
    ).toBeUndefined()
  })
})

describe('parseTermAttach / attachArgv', () => {
  it('accepts roster-shaped fields and builds local argv', () => {
    expect(parseTermAttach(LOCAL)).toEqual(LOCAL)
    expect(attachArgv(LOCAL)).toEqual([...LOCAL_ARGV])
  })

  it('builds remote argv as ssh -t user@host + tmux', () => {
    const remote = { ...LOCAL, local: false, host: '192.0.2.116' }
    expect(attachArgv(parseTermAttach(remote))).toEqual([
      'ssh',
      '-t',
      'rivet@192.0.2.116',
      ...LOCAL_ARGV,
    ])
  })

  it('rejects an argv array (old API / wrong argv[0])', () => {
    expect(() => parseTermAttach(['tmux', '-L', 'rivet'])).toThrow(
      'attach must be a TermAttachInfo object',
    )
    expect(() => parseTermAttach(['ssh', '-oProxyCommand=/x', 'h'])).toThrow(
      'attach must be a TermAttachInfo object',
    )
  })

  it('rejects leading - in any field, -f, and -o…', () => {
    for (const [name, value] of [
      ['socket', '-rivet'],
      ['session', '-sess'],
      ['host', '-ct116'],
      ['sshUser', '-rivet'],
      ['socket', '-f'],
      ['host', '-oProxyCommand=/x'],
      ['session', '-t'],
    ] as const) {
      expect(() => parseTermAttach({ ...LOCAL, [name]: value }), `${name}=${value}`).toThrow(
        `invalid attach field: ${name}`,
      )
    }
  })

  it('rejects field-regex edge cases', () => {
    expect(SOCKET_RE.test('a'.repeat(64))).toBe(true)
    expect(SOCKET_RE.test('a'.repeat(65))).toBe(false)
    expect(SESSION_RE.test('a'.repeat(128))).toBe(true)
    expect(SESSION_RE.test('a'.repeat(129))).toBe(false)
    expect(HOST_RE.test('a'.repeat(253))).toBe(true)
    expect(HOST_RE.test('a'.repeat(254))).toBe(false)
    expect(SSH_USER_RE.test('r' + 'a'.repeat(31))).toBe(true)
    expect(SSH_USER_RE.test('r' + 'a'.repeat(32))).toBe(false)

    expect(() => parseTermAttach({ ...LOCAL, socket: 'a'.repeat(65) })).toThrow(
      'invalid attach field: socket',
    )
    expect(() => parseTermAttach({ ...LOCAL, session: 'a'.repeat(129) })).toThrow(
      'invalid attach field: session',
    )
    expect(() => parseTermAttach({ ...LOCAL, host: 'user@host' })).toThrow(
      'invalid attach field: host',
    )
    expect(() => parseTermAttach({ ...LOCAL, host: '' })).toThrow('invalid attach field: host')
    expect(() => parseTermAttach({ ...LOCAL, sshUser: 'RivET' })).toThrow(
      'invalid attach field: sshUser',
    )
    expect(() => parseTermAttach({ ...LOCAL, sshUser: '1rivet' })).toThrow(
      'invalid attach field: sshUser',
    )
    expect(() => parseTermAttach({ ...LOCAL, session: '=sess' })).toThrow(
      'invalid attach field: session',
    )
    expect(() => parseTermAttach({ ...LOCAL, socket: 'has space' })).toThrow(
      'invalid attach field: socket',
    )
    expect(() => parseTermAttach({ ...LOCAL, local: 'true' })).toThrow(
      'invalid attach field: local',
    )
    expect(() => parseTermAttach({ ...LOCAL, socket: 'a;b' })).toThrow(
      'invalid attach field: socket',
    )
  })
})

describe('macOS temp-file path shape', () => {
  it('is {tmpdir}/rivet-attach-{id}.command with quoted tokens', () => {
    const p = macCommandPath('/var/folders/xx/T', 'deadbeef')
    expect(p.endsWith('.command')).toBe(true)
    expect(p).toContain('rivet-attach-deadbeef')
    expect(p.startsWith('/var/folders/xx/T')).toBe(true)
    expect(macCommandScript(['tmux', '-L', 'rivet'])).toBe(
      "#!/bin/sh\nexec 'tmux' '-L' 'rivet'\n",
    )
    expect(shellQuote("foo'bar")).toBe("'foo'\\''bar'")
  })
})

describe('openInTerminal', () => {
  it('rejects unsafe / old-argv payloads before spawn', async () => {
    const spawn: SpawnFn = () => {
      throw new Error('should not spawn')
    }
    await expect(
      openInTerminal(['tmux', 'bad;token'], {
        ...silentIo,
        platform: 'linux',
        env: {},
        which: whichOf('xterm'),
        spawn,
      }),
    ).rejects.toThrow('attach must be a TermAttachInfo object')
    await expect(
      openInTerminal({ ...LOCAL, socket: '-f' }, {
        ...silentIo,
        platform: 'linux',
        env: {},
        which: whichOf('xterm'),
        spawn,
      }),
    ).rejects.toThrow('invalid attach field: socket')
  })

  it('linux ghostty: detached ignore spawn with -e + built argv', async () => {
    const log: { command?: string; args?: string[]; opts?: unknown; unrefed?: boolean } = {}
    await openInTerminal(LOCAL, {
      ...silentIo,
      platform: 'linux',
      env: {},
      which: whichOf('ghostty'),
      spawn: fakeSpawn(log),
    })
    expect(log.command).toBe('/usr/bin/ghostty')
    expect(log.args).toEqual(['-e', ...LOCAL_ARGV])
    expect(log.opts).toEqual({ detached: true, stdio: 'ignore' })
    expect(log.unrefed).toBe(true)
  })

  it('macos writes a 0700 wx .command and open -a, then unlinks after 60s', async () => {
    const written: { file?: string; data?: string; mode?: number; flag?: string } = {}
    const log: { command?: string; args?: string[]; unrefed?: boolean } = {}
    let scheduled: { fn?: () => void; ms?: number } = {}
    let unlinked: string | undefined
    await openInTerminal(LOCAL, {
      platform: 'darwin',
      env: {},
      which: () => undefined,
      exists: () => false,
      tmpdir: () => '/tmp',
      randomId: () => 'deadbeef',
      writeFileSync: (file, data, opts) => {
        written.file = file
        written.data = String(data)
        written.mode = opts?.mode
        written.flag = opts?.flag
      },
      unlinkSync: (file) => {
        unlinked = file
      },
      spawn: fakeSpawn(log),
      setTimeout: (fn, ms) => {
        scheduled = { fn, ms }
        return {}
      },
    })
    expect(written.file).toMatch(/rivet-attach-deadbeef\.command$/)
    expect(written.file?.endsWith('.command')).toBe(true)
    expect(written.mode).toBe(0o700)
    expect(written.flag).toBe('wx')
    expect(written.data).toBe(`#!/bin/sh\nexec ${LOCAL_ARGV.map((t) => `'${t}'`).join(' ')}\n`)
    expect(log.command).toBe('open')
    expect(log.args).toEqual(['-a', 'Terminal', written.file])
    expect(scheduled.ms).toBe(MAC_COMMAND_UNLINK_MS)
    expect(MAC_COMMAND_UNLINK_MS).toBe(60_000)
    scheduled.fn?.()
    expect(unlinked).toBe(written.file)
  })

  it('macos prefers Ghostty.app when exists reports it', async () => {
    const log: { command?: string; args?: string[] } = {}
    await openInTerminal(LOCAL, {
      ...silentIo,
      platform: 'darwin',
      env: {},
      which: () => undefined,
      exists: existsOf('/Applications/Ghostty.app'),
      spawn: fakeSpawn(log),
    })
    expect(log.command).toBe('open')
    expect(log.args?.[0]).toBe('-a')
    expect(log.args?.[1]).toBe('Ghostty')
  })

  it('windows wt.exe new-tab -- argv', async () => {
    const log: { command?: string; args?: string[] } = {}
    await openInTerminal(LOCAL, {
      ...silentIo,
      platform: 'win32',
      env: {},
      which: (cmd) => (cmd === 'wt.exe' ? 'C:\\wt.exe' : undefined),
      spawn: fakeSpawn(log),
    })
    expect(log.command).toBe('C:\\wt.exe')
    expect(log.args).toEqual(['new-tab', '--', ...LOCAL_ARGV])
  })

  it('windows cmd /c start with empty title placeholder', async () => {
    const log: { command?: string; args?: string[] } = {}
    await openInTerminal(LOCAL, {
      ...silentIo,
      platform: 'win32',
      env: { ComSpec: 'C:\\Windows\\System32\\cmd.exe' },
      which: () => undefined,
      spawn: fakeSpawn(log),
    })
    expect(log.command).toBe('C:\\Windows\\System32\\cmd.exe')
    expect(log.args).toEqual(['/c', 'start', '', ...LOCAL_ARGV])
  })

  it('windows cmd falls back to cmd.exe when ComSpec is unset', async () => {
    const log: { command?: string; args?: string[] } = {}
    await openInTerminal(LOCAL, {
      ...silentIo,
      platform: 'win32',
      env: {},
      which: () => undefined,
      spawn: fakeSpawn(log),
    })
    expect(log.command).toBe('cmd.exe')
    expect(log.args).toEqual(['/c', 'start', '', ...LOCAL_ARGV])
  })

  it('rejects spawn error as failed to launch <cmd>', async () => {
    const log: { command?: string; args?: string[] } = {}
    await expect(
      openInTerminal(LOCAL, {
        ...silentIo,
        platform: 'linux',
        env: {},
        which: whichOf('xterm'),
        spawn: fakeSpawn(log, 'error', new Error('ENOENT')),
      }),
    ).rejects.toThrow('failed to launch /usr/bin/xterm: ENOENT')
    expect(log.command).toBe('/usr/bin/xterm')
  })

  it('throws when no emulator is found', async () => {
    await expect(
      openInTerminal(LOCAL, {
        ...silentIo,
        platform: 'linux',
        env: {},
        which: () => undefined,
        spawn: () => {
          throw new Error('should not spawn')
        },
      }),
    ).rejects.toThrow('no terminal emulator found')
  })
})
