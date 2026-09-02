import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  classifyExistingTmuxSession,
  createRealTmuxCtl,
  encodeTmuxName,
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
    expect(argv[0]).toBe('tmux')
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
  },
)
