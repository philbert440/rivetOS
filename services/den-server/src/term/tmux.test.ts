import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  classifyExistingTmuxSession,
  createRealTmuxCtl,
  encodeTmuxName,
  ensureUtf8Locale,
  isDenTmuxName,
  TMUX_ENV_WRAP_SCRIPT,
  tmuxAttachArgv,
  tmuxConfContent,
  tmuxCreateArgv,
  type TmuxExec,
  type TmuxSessionInfo,
} from './tmux.js'

const sample: TmuxSessionInfo = {
  name: encodeTmuxName('chat-f'),
  activity: 1,
  created: 1,
  command: '',
  user: '',
}

describe('tmuxConfContent', () => {
  it('enables mouse and extended-keys', () => {
    const conf = tmuxConfContent(false)
    expect(conf).toContain('set -g mouse on')
    expect(conf).toContain('set -g extended-keys on')
    expect(conf).not.toContain('mouse off')
    expect(conf).toContain('bind -n WheelUpPane if -F "#{mouse_any_flag}"')
    expect(conf).toContain('bind -n WheelDownPane')
    expect(conf).toContain('unbind -n MouseDown3Pane')
    const wheelUp = conf.split('\n').find((l) => l.includes('WheelUpPane'))
    expect(wheelUp).toContain('send-keys -M')
    expect(wheelUp).toContain('copy-mode -e')
  })
})

describe('isDenTmuxName / classifyExistingTmuxSession', () => {
  it('round-trips encoded den session keys and rejects non-encodings', () => {
    expect(isDenTmuxName(encodeTmuxName('chat-f'))).toBe(true)
    expect(isDenTmuxName(encodeTmuxName('claude:11111111-1111-1111-1111-111111111111'))).toBe(true)
    expect(isDenTmuxName(encodeTmuxName('a_b'))).toBe(true) // encoded form a__b
    expect(isDenTmuxName('a_b')).toBe(false)
    expect(isDenTmuxName('foo.bar')).toBe(false)
    expect(isDenTmuxName('foo:bar')).toBe(false)
    expect(isDenTmuxName('')).toBe(false)
    expect(isDenTmuxName('-leading')).toBe(false)
    expect(isDenTmuxName('~' + Buffer.from('x y').toString('base64url'))).toBe(false)
  })

  it('untagged decodable → adopt; untagged non-decodable → foreign; user mismatch → refuse', () => {
    expect(classifyExistingTmuxSession({ ...sample, command: '', user: '' })).toBe('adopt')
    expect(classifyExistingTmuxSession({ ...sample, name: 'a_b', command: '', user: '' })).toBe(
      'foreign',
    )
    expect(
      classifyExistingTmuxSession({ ...sample, command: 'claude', user: 'phil' }, 'coco'),
    ).toBe('user-mismatch')
    expect(classifyExistingTmuxSession({ ...sample, command: '', user: 'phil' }, 'coco')).toBe(
      'user-mismatch',
    )
    expect(
      classifyExistingTmuxSession({ ...sample, command: 'claude', user: 'coco' }, 'coco'),
    ).toBe('attach')
    expect(classifyExistingTmuxSession({ ...sample, command: 'claude', user: '' })).toBe('attach')
    expect(classifyExistingTmuxSession({ ...sample, command: 'claude', user: 'owner' })).toBe(
      'attach',
    )
    // empty @rivet_user with @rivet_command set means 'owner'
    expect(classifyExistingTmuxSession({ ...sample, command: 'claude', user: '' }, 'coco')).toBe(
      'user-mismatch',
    )
    // untagged + decodable: only owner may adopt
    expect(classifyExistingTmuxSession({ ...sample, command: '', user: '' }, 'coco')).toBe(
      'user-mismatch',
    )
    expect(classifyExistingTmuxSession({ ...sample, command: '', user: '' }, 'owner')).toBe('adopt')
  })
})

describe('tmux argv builders', () => {
  it('create sequence has set-option/set-environment WITHOUT -t after new-session, and stamps tags', () => {
    const argv = tmuxCreateArgv({
      socket: 'rivet-deadbeef',
      confPath: '/tmp/tmux.conf',
      name: 'chat-f',
      cwd: '/tmp',
      cols: 80,
      rows: 24,
      envPairs: ['-e', 'COLORTERM=truecolor'],
      envFile: '/tmp/chat-f.env',
      harness: ['claude'],
      command: 'claude',
      user: 'coco',
      unsetKeys: ['RIVETOS_PG_URL', 'RIVETOS_USER_ID'],
    })
    expect(argv.slice(0, 4)).toEqual(['tmux', '-u', '-L', 'rivet-deadbeef'])
    expect(argv).toContain('new-session')
    expect(argv).not.toContain('-A')
    const fromNew = argv.slice(argv.indexOf('new-session'))
    expect(fromNew).not.toContain('-t')
    expect(argv).toContain('@rivet_command')
    expect(argv[argv.indexOf('@rivet_command') + 1]).toBe('claude')
    expect(argv).toContain('@rivet_user')
    expect(argv[argv.indexOf('@rivet_user') + 1]).toBe('coco')
    expect(argv).toContain('set-environment')
    // -u is the unset flag, not a target
    const se = argv.indexOf('set-environment')
    expect(argv.slice(se, se + 3)).toEqual(['set-environment', '-r', 'RIVETOS_PG_URL'])
    expect(argv).toContain(TMUX_ENV_WRAP_SCRIPT)
  })

  it('attach argv keeps -t =<name> (session already exists)', () => {
    expect(tmuxAttachArgv('rivet-x', '/tmp/c', 'chat-f')).toEqual([
      'tmux',
      '-u',
      '-L',
      'rivet-x',
      '-f',
      '/tmp/c',
      'attach-session',
      '-t',
      '=chat-f',
    ])
  })

  it('createRealTmuxCtl setOption uses -t =<name>: (exact-match session form) and drops the list memo', () => {
    const calls: string[][] = []
    const exec: TmuxExec = (_bin, args) => {
      calls.push(args)
      if (args.includes('list-sessions')) return 'chat-f\t1\t1\t1\t\t\n'
      return ''
    }
    const ctl = createRealTmuxCtl('/usr/bin/tmux', 's', 'c', exec)
    ctl.listSessions()
    expect(calls).toHaveLength(1)
    ctl.setOption?.('chat-f', '@rivet_command', 'claude')
    expect(calls.at(-1)).toEqual([
      '-u',
      '-L',
      's',
      '-f',
      'c',
      'set-option',
      '-t',
      '=chat-f:',
      '@rivet_command',
      'claude',
    ])
    ctl.listSessions()
    expect(calls.filter((c) => c.includes('list-sessions'))).toHaveLength(2)
  })

  it('every ctl argv is prefixed with -u so LANG=C cannot mangle the -F tab separators (regression)', () => {
    // 2026-09-03: a den under LANG=C served an empty/garbled session list —
    // tmux rendered the TAB in `-F` output as `_`, so rows parsed with name =
    // the whole line and command = '' (dropped by /term/list; unmatched by
    // spawn-or-get → "session exists but is not listable"). `-u` (as the spawn
    // path already uses) forces UTF-8 and keeps the tabs.
    const calls: string[][] = []
    const exec: TmuxExec = (_bin, args) => {
      calls.push(args)
      return args.includes('list-sessions') ? 'a\t1\t1\t1\tclaude\towner\n' : ''
    }
    const ctl = createRealTmuxCtl('/usr/bin/tmux', 'sock', 'conf', exec)
    ctl.listSessions()
    ctl.hasSession('a')
    ctl.killSession('a')
    ctl.setOption?.('a', '@rivet_command', 'claude')
    expect(calls.length).toBeGreaterThan(0)
    for (const c of calls) expect(c[0]).toBe('-u')
  })
})

describe('ensureUtf8Locale', () => {
  it('rewrites the deciding locale key to C.UTF-8 and leaves UTF-8 alone', () => {
    const cases: Array<{
      env: Record<string, string>
      after: Record<string, string>
      changed: string[]
    }> = [
      { env: {}, after: { LANG: 'C.UTF-8' }, changed: ['LANG'] },
      { env: { LANG: 'C' }, after: { LANG: 'C.UTF-8' }, changed: ['LANG'] },
      { env: { LANG: 'POSIX' }, after: { LANG: 'C.UTF-8' }, changed: ['LANG'] },
      { env: { LANG: 'en_US.UTF-8' }, after: { LANG: 'en_US.UTF-8' }, changed: [] },
      { env: { LANG: 'en_US.utf8' }, after: { LANG: 'en_US.utf8' }, changed: [] },
      {
        env: { LC_ALL: 'C', LANG: 'en_US.UTF-8' },
        after: { LC_ALL: 'C.UTF-8', LANG: 'en_US.UTF-8' },
        changed: ['LC_ALL'],
      },
      {
        env: { LC_ALL: 'en_US.UTF-8', LANG: 'C' },
        after: { LC_ALL: 'en_US.UTF-8', LANG: 'C' },
        changed: [],
      },
      {
        env: { LC_CTYPE: 'C', LANG: 'C' },
        after: { LC_CTYPE: 'C.UTF-8', LANG: 'C' },
        changed: ['LC_CTYPE'],
      },
      {
        env: { LC_ALL: '', LANG: 'C' },
        after: { LC_ALL: '', LANG: 'C.UTF-8' },
        changed: ['LANG'],
      },
    ]
    for (const c of cases) {
      const env = { ...c.env }
      expect({ input: c.env, changed: ensureUtf8Locale(env) }).toEqual({
        input: c.env,
        changed: c.changed,
      })
      expect({ input: c.env, env }).toEqual({ input: c.env, env: c.after })
    }
  })
})

function tmuxAvailable(): boolean {
  try {
    const out = execFileSync('tmux', ['-V'], {
      encoding: 'utf8',
      timeout: 2000,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    const m = /(\d+)\.(\d+)/.exec(out)
    return m !== null && (Number(m[1]) > 3 || (Number(m[1]) === 3 && Number(m[2]) >= 2))
  } catch {
    return false
  }
}

describe.skipIf(!tmuxAvailable())(
  'real tmux stamps @rivet_command from the manager create argv',
  () => {
    const socket = `rivet-test-${process.pid}`
    const uid = typeof process.getuid === 'function' ? process.getuid() : 0
    const socketPath = join(process.env.TMUX_TMPDIR || `/tmp/tmux-${uid}`, socket)
    const dirs: string[] = []
    afterEach(() => {
      try {
        execFileSync('tmux', ['-L', socket, 'kill-server'], {
          timeout: 2000,
          stdio: ['ignore', 'ignore', 'ignore'],
        })
      } catch {
        // server already gone
      }
      try {
        unlinkSync(socketPath)
      } catch {
        // kill-server usually removes it; stale sockets were left behind
      }
      for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
    })

    it('running the create argv (-d variant) leaves list-sessions #{@rivet_command} set', () => {
      const dir = mkdtempSync(join(tmpdir(), 'den-tmux-int-'))
      dirs.push(dir)
      const conf = join(dir, 'tmux.conf')
      writeFileSync(conf, tmuxConfContent(false))
      const envFile = join(dir, 't1.env')
      writeFileSync(envFile, '')
      const argv = tmuxCreateArgv({
        socket,
        confPath: conf,
        name: 't1',
        cwd: dir,
        cols: 80,
        rows: 24,
        envPairs: [],
        envFile,
        harness: ['/bin/sh', '-c', 'sleep 60'],
        command: 'claude',
        user: 'owner',
        unsetKeys: ['RIVETOS_PG_URL'],
        detached: true,
      })
      expect(argv.slice(argv.indexOf('new-session'))).not.toContain('-t')
      execFileSync(argv[0], argv.slice(1), {
        timeout: 5000,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, RIVETOS_PG_URL: 'postgres://should-be-unset' },
      })
      const out = execFileSync(
        'tmux',
        ['-L', socket, 'list-sessions', '-F', '#{@rivet_command}\t#{@rivet_user}'],
        {
          encoding: 'utf8',
          timeout: 2000,
          stdio: ['ignore', 'pipe', 'ignore'],
        },
      )
      expect(out.trim()).toBe('claude\towner')
      const envOut = execFileSync('tmux', ['-L', socket, 'show-environment', '-t', '=t1'], {
        encoding: 'utf8',
        timeout: 2000,
        stdio: ['ignore', 'pipe', 'ignore'],
      })
      expect(envOut).toMatch(/^-RIVETOS_PG_URL$/m)
      expect(envOut).not.toMatch(/^RIVETOS_PG_URL=/m)
    })

    it('client -u reports #{client_utf8}=1 under LANG=C; without -u it is 0', async ({ skip }) => {
      type PtySpawnFn = (
        file: string,
        args: string[],
        options: {
          name: string
          cols: number
          rows: number
          cwd: string
          env: Record<string, string>
        },
      ) => { pid: number; kill: (signal?: string) => void }
      let ptySpawn: PtySpawnFn
      try {
        // non-literal specifier: node-pty is optional and may be absent
        const specifier: string = 'node-pty'
        const mod = (await import(specifier)) as { spawn: PtySpawnFn }
        ptySpawn = mod.spawn
      } catch {
        skip()
        return
      }

      const dir = mkdtempSync(join(tmpdir(), 'den-tmux-utf8-'))
      dirs.push(dir)
      const conf = join(dir, 'tmux.conf')
      writeFileSync(conf, tmuxConfContent(false))
      const envFile = join(dir, 'utf8.env')
      writeFileSync(envFile, '')
      const argv = tmuxCreateArgv({
        socket,
        confPath: conf,
        name: 'utf8',
        cwd: dir,
        cols: 80,
        rows: 24,
        envPairs: [],
        envFile,
        harness: ['/bin/sh', '-c', 'sleep 60'],
        command: 'claude',
        user: 'owner',
        unsetKeys: [],
        detached: false,
      })
      expect(argv.slice(0, 3)).toEqual(['tmux', '-u', '-L'])

      const clientEnv = {
        PATH: process.env.PATH ?? '/usr/bin',
        TERM: 'xterm-256color',
        HOME: process.env.HOME ?? dir,
        LANG: 'C',
      }

      const waitClientUtf8 = async (): Promise<string | null> => {
        const deadline = Date.now() + 5000
        while (Date.now() < deadline) {
          try {
            const out = execFileSync(
              'tmux',
              ['-L', socket, 'list-clients', '-F', '#{client_utf8}'],
              {
                encoding: 'utf8',
                timeout: 2000,
                stdio: ['ignore', 'pipe', 'ignore'],
              },
            )
            const line = out.split('\n').find((l) => l.length > 0)
            if (line !== undefined) return line.trim()
          } catch {
            // server/client not up yet
          }
          await new Promise((r) => setTimeout(r, 50))
        }
        return null
      }

      const run = async (clientArgv: string[]): Promise<string | null> => {
        writeFileSync(envFile, '')
        const proc = ptySpawn(clientArgv[0], clientArgv.slice(1), {
          name: 'xterm-256color',
          cols: 80,
          rows: 24,
          cwd: dir,
          env: clientEnv,
        })
        try {
          return await waitClientUtf8()
        } finally {
          try {
            proc.kill()
          } catch {
            // already dead
          }
          try {
            execFileSync('tmux', ['-L', socket, 'kill-server'], {
              timeout: 2000,
              stdio: ['ignore', 'ignore', 'ignore'],
            })
          } catch {
            // server already gone
          }
        }
      }

      expect(await run(argv)).toBe('1')
      const control = argv.slice()
      control.splice(control.indexOf('-u'), 1)
      expect(control.slice(0, 2)).toEqual(['tmux', '-L'])
      expect(await run(control)).toBe('0')
    }, 15_000)

    it('loads mouse on and the WheelUpPane mouse_any_flag binding from conf', () => {
      const dir = mkdtempSync(join(tmpdir(), 'den-tmux-mouse-'))
      dirs.push(dir)
      const conf = join(dir, 'tmux.conf')
      writeFileSync(conf, tmuxConfContent(false))
      execFileSync(
        'tmux',
        [
          '-L',
          socket,
          '-f',
          conf,
          'new-session',
          '-d',
          '-s',
          'mouse-keys',
          '--',
          '/bin/sh',
          '-c',
          'sleep 60',
        ],
        { timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] },
      )
      const mouse = execFileSync('tmux', ['-L', socket, 'show-options', '-g', 'mouse'], {
        encoding: 'utf8',
        timeout: 2000,
        stdio: ['ignore', 'pipe', 'ignore'],
      })
      expect(mouse).toContain('mouse on')
      const keys = execFileSync('tmux', ['-L', socket, 'list-keys', '-T', 'root', 'WheelUpPane'], {
        encoding: 'utf8',
        timeout: 2000,
        stdio: ['ignore', 'pipe', 'ignore'],
      })
      expect(keys).toContain('mouse_any_flag')
    })
  },
)
