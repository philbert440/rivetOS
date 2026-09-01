import { describe, expect, it } from 'vitest'
import { composeTermAttach, wirePtyInfo } from './attach.js'
import type { PtyInfo } from './manager.js'

const TMUX: PtyInfo = {
  id: 'pty-aaa',
  denSession: 'chat-p1',
  command: 'claude',
  pid: 4321,
  attached: 0,
  createdAt: 1,
  cols: 80,
  rows: 24,
  state: 'running',
  lastOutputTs: 1,
  mux: 'tmux',
  socket: 'rivet-deadbeef',
  session: 'chat-p1',
}

const NONE: PtyInfo = {
  id: 'pty-bbb',
  denSession: 'den-pty-bbb',
  command: 'shell',
  pid: 1,
  attached: 0,
  createdAt: 1,
  cols: 80,
  rows: 24,
  state: 'running',
  lastOutputTs: 1,
}

const IDENTITY = { host: '192.0.2.116', sshUser: 'rivet' }

describe('composeTermAttach', () => {
  it('is present only for tmux PTYs and never carries argv/env', () => {
    expect(composeTermAttach(NONE, IDENTITY, true)).toBeUndefined()
    const attach = composeTermAttach(TMUX, IDENTITY, true)
    expect(attach).toEqual({
      socket: 'rivet-deadbeef',
      session: 'chat-p1',
      host: '192.0.2.116',
      sshUser: 'rivet',
      local: true,
    })
    expect(attach).not.toHaveProperty('argv')
    expect(attach).not.toHaveProperty('env')
  })

  it('local reflects the http-layer loopback flag (not inferred)', () => {
    expect(composeTermAttach(TMUX, IDENTITY, true)?.local).toBe(true)
    expect(composeTermAttach(TMUX, IDENTITY, false)?.local).toBe(false)
    expect(composeTermAttach(TMUX, IDENTITY, false)).toMatchObject({
      host: '192.0.2.116',
      sshUser: 'rivet',
    })
  })

  it('is absent when socket or session is missing even if mux is tmux', () => {
    expect(
      composeTermAttach({ mux: 'tmux', socket: 'rivet', session: '' }, IDENTITY, true),
    ).toBeUndefined()
    expect(
      composeTermAttach({ mux: 'tmux', socket: '', session: 's' }, IDENTITY, true),
    ).toBeUndefined()
    expect(composeTermAttach({ mux: 'tmux' }, IDENTITY, true)).toBeUndefined()
  })
})

describe('wirePtyInfo', () => {
  it('strips manager socket/session and stamps attach for tmux rows', () => {
    const wired = wirePtyInfo(TMUX, IDENTITY, false)
    expect(wired).not.toHaveProperty('socket')
    expect(wired).not.toHaveProperty('session')
    expect(wired.attach).toEqual({
      socket: 'rivet-deadbeef',
      session: 'chat-p1',
      host: '192.0.2.116',
      sshUser: 'rivet',
      local: false,
    })
    expect(JSON.stringify(wired)).not.toMatch(/"argv"/)
    expect(JSON.stringify(wired)).not.toMatch(/"env"/)
  })

  it('leaves mux:none rows without attach', () => {
    const wired = wirePtyInfo(NONE, IDENTITY, true)
    expect(wired).not.toHaveProperty('attach')
    expect(wired).not.toHaveProperty('socket')
    expect(wired).not.toHaveProperty('session')
  })
})
