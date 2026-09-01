import { describe, expect, it } from 'vitest'
import { attachArgv, attachCommandString, shellQuote } from './attach-command.js'

const LOCAL = {
  socket: 'rivet',
  session: 'den-abc',
  host: 'ct116',
  sshUser: 'rivet',
  local: true,
}

const REMOTE = { ...LOCAL, local: false, host: '192.0.2.116', sshUser: 'rivet' }

describe('attachArgv', () => {
  it('local is tmux -L <socket> attach-session -t =<session>', () => {
    expect(attachArgv(LOCAL)).toEqual(['tmux', '-L', 'rivet', 'attach-session', '-t', '=den-abc'])
  })

  it('remote prefixes ssh -t user@host', () => {
    expect(attachArgv(REMOTE)).toEqual([
      'ssh',
      '-t',
      'rivet@192.0.2.116',
      'tmux',
      '-L',
      'rivet',
      'attach-session',
      '-t',
      '=den-abc',
    ])
  })

  it('emits a bare IPv6 ssh dest and leaves tmux target unchanged', () => {
    const v6 = { ...REMOTE, host: '2001:db8::1' }
    expect(attachArgv(v6)).toEqual([
      'ssh',
      '-t',
      'rivet@2001:db8::1',
      'tmux',
      '-L',
      'rivet',
      'attach-session',
      '-t',
      '=den-abc',
    ])
    expect(attachArgv({ ...REMOTE, host: '[2001:db8::1]' })[2]).toBe('rivet@2001:db8::1')
  })
})

describe('attachCommandString', () => {
  it('joins safe tokens without quotes', () => {
    expect(attachCommandString(attachArgv(LOCAL))).toBe('tmux -L rivet attach-session -t =den-abc')
    expect(attachCommandString(attachArgv(REMOTE))).toBe(
      'ssh -t rivet@192.0.2.116 tmux -L rivet attach-session -t =den-abc',
    )
    expect(attachCommandString(attachArgv({ ...REMOTE, host: '2001:db8::1' }))).toBe(
      'ssh -t rivet@2001:db8::1 tmux -L rivet attach-session -t =den-abc',
    )
  })

  it('shell-quotes tokens that need it', () => {
    expect(shellQuote('has space')).toBe("'has space'")
    expect(shellQuote('a;b')).toBe("'a;b'")
    expect(shellQuote('$HOME')).toBe("'$HOME'")
    expect(shellQuote("foo'bar")).toBe("'foo'\\''bar'")
    expect(attachCommandString(['tmux', '-L', 'sock with space'])).toBe("tmux -L 'sock with space'")
  })
})
