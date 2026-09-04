import { describe, expect, it, vi } from 'vitest'
import type { HarnessStatusFrame } from '@rivetos/types'
import {
  HERDR_DEFAULT_PANE,
  HERDR_PINNED_VERSION,
  classifyExistingHerdrSession,
  createHerdrStatusHub,
  createRealHerdrCtl,
  decodeHerdrName,
  encodeHerdrName,
  herdrAgentStartArgv,
  herdrAttachArgv,
  herdrConfigHome,
  herdrEventsSubscribeRequest,
  herdrKindForCommand,
  herdrServerArgv,
  herdrSocketPath,
  herdrStatusToFrame,
  herdrSupported,
  herdrVersion,
  herdrWorkspaceCreateArgv,
  isDenHerdrName,
  parseHerdrVersion,
  parsePaneSize,
  parseWorkspaceCreate,
  type HerdrExec,
  type HerdrSessionInfo,
} from './herdr.js'

const sample: HerdrSessionInfo = {
  name: encodeHerdrName('chat-f'),
  activity: 1,
  created: 1,
  command: '',
  user: '',
}

describe('herdr name encoding', () => {
  it('reuses the tmux reversible mapping', () => {
    expect(encodeHerdrName('claude:11111111-1111-1111-1111-111111111111')).toBe(
      'claude_c11111111-1111-1111-1111-111111111111',
    )
    expect(isDenHerdrName(encodeHerdrName('chat-f'))).toBe(true)
    expect(decodeHerdrName(encodeHerdrName('a__b'))).toBe('a__b')
    expect(() => encodeHerdrName('-leading')).toThrow(/must not start with '-'/)
  })

  it('classify matches tmux: untagged decodable → adopt; tagged mismatch → refuse', () => {
    expect(classifyExistingHerdrSession({ ...sample, command: '', user: '' })).toBe('adopt')
    expect(
      classifyExistingHerdrSession({ ...sample, command: 'claude', user: 'phil' }, 'coco'),
    ).toBe('user-mismatch')
    expect(
      classifyExistingHerdrSession({ ...sample, command: 'claude', user: 'coco' }, 'coco'),
    ).toBe('attach')
  })
})

describe('herdr argv builders', () => {
  it('server / attach / workspace create / agent start keep env off the agent argv', () => {
    expect(herdrServerArgv('chat-f')).toEqual(['herdr', '--session', 'chat-f', 'server'])
    expect(herdrAttachArgv('chat-f')).toEqual(['herdr', '--session', 'chat-f'])
    const ws = herdrWorkspaceCreateArgv(
      'chat-f',
      { RIVET_DEN_TOKEN: 'sekrit', COLORTERM: 'truecolor' },
      '/tmp/work',
    )
    expect(ws.slice(0, 6)).toEqual([
      'herdr',
      '--session',
      'chat-f',
      'workspace',
      'create',
      '--cwd',
    ])
    expect(ws).toContain('--env')
    expect(ws).toContain('RIVET_DEN_TOKEN=sekrit')
    const agent = herdrAgentStartArgv('chat-f', 'chat-f', 'grok', 'w1:p1', ['grok'])
    expect(agent).toEqual([
      'herdr',
      '--session',
      'chat-f',
      'agent',
      'start',
      'chat-f',
      '--kind',
      'grok',
      '--pane',
      'w1:p1',
      '--',
      'grok',
    ])
    // secrets never appear after `--` (the agent argv)
    const after = agent.slice(agent.indexOf('--') + 1)
    expect(after.join(' ')).not.toMatch(/sekrit|TOKEN/)
    const req = JSON.parse(herdrEventsSubscribeRequest('w1:p1', 'den-status'))
    expect(req).toEqual({
      id: 'den-status',
      method: 'events.subscribe',
      params: { subscriptions: [
        { type: 'pane.agent_status_changed', pane_id: 'w1:p1' },
        { type: 'pane.agent_detected', pane_id: 'w1:p1' },
      ] },
    })
  })

  it('kind mapping passes known roster keys through', () => {
    expect(herdrKindForCommand('claude')).toBe('claude')
    expect(herdrKindForCommand('grok')).toBe('grok')
    expect(herdrKindForCommand('kimi')).toBe('kimi')
    expect(herdrKindForCommand('dsh')).toBe('deepseek')
    expect(herdrKindForCommand('shell')).toBe('shell')
  })

  it('per-den config home is under stateDir and the sock path is session-scoped', () => {
    expect(herdrConfigHome('/state/a')).toBe('/state/a/den/herdr-config')
    expect(herdrSocketPath('/cfg', 'chat-f')).toBe('/cfg/herdr/sessions/chat-f/herdr.sock')
  })
})

describe('herdr --version pin', () => {
  it('parses 0.8.2 from common --version shapes', () => {
    expect(parseHerdrVersion('herdr 0.8.2\n')).toBe('0.8.2')
    expect(parseHerdrVersion('0.8.2')).toBe('0.8.2')
    expect(parseHerdrVersion('herdr 0.9.0')).toBe('0.9.0')
    expect(parseHerdrVersion('nope')).toBeNull()
  })

  it('herdrSupported is true ONLY for the pinned 0.8.2', () => {
    const exec =
      (out: string): HerdrExec =>
      () =>
        out
    expect(herdrSupported('/bin/herdr', exec('herdr 0.8.2'))).toBe(true)
    expect(herdrSupported('/bin/herdr', exec('herdr 0.8.1'))).toBe(false)
    expect(herdrSupported('/bin/herdr', exec('herdr 0.9.0'))).toBe(false)
    expect(herdrVersion('/bin/herdr', exec('herdr 0.8.2'))).toBe(HERDR_PINNED_VERSION)
  })
})

describe('parseWorkspaceCreate / parsePaneSize', () => {
  it('reads pane_id and falls back to w1:p1', () => {
    expect(parseWorkspaceCreate('{"pane_id":"w2:p3"}')).toEqual({ paneId: 'w2:p3' })
    expect(parseWorkspaceCreate('not-json')).toEqual({ paneId: HERDR_DEFAULT_PANE })
  })

  it('reads cols/rows from pane list JSON', () => {
    expect(parsePaneSize('[{"cols":120,"rows":40}]')).toEqual({ cols: 120, rows: 40 })
    expect(parsePaneSize('[{"width":80,"height":24}]')).toEqual({ cols: 80, rows: 24 })
    expect(parsePaneSize('garbage')).toBeUndefined()
    expect(parsePaneSize('[{"cols":0,"rows":24}]')).toBeUndefined()
  })
})

describe('herdrStatusToFrame', () => {
  it('maps pane.agent_status_changed (dotted and underscored) to working/blocked/idle', () => {
    expect(
      herdrStatusToFrame({
        event: 'pane.agent_status_changed',
        data: { agent_status: 'working', pane_id: 'w1:p1' },
      }),
    ).toMatchObject({ type: 'status', status: 'working' })
    expect(
      herdrStatusToFrame({
        event: 'pane_agent_status_changed',
        pane_id: 'w1:p1',
        agent_status: 'blocked',
      }),
    ).toMatchObject({ type: 'status', status: 'blocked' })
    expect(
      herdrStatusToFrame({
        type: 'pane.agent_status_changed',
        agent_status: 'idle',
        sessionId: 'claude:abc',
      }),
    ).toMatchObject({ type: 'status', status: 'idle', sessionId: 'claude:abc' })
    expect(herdrStatusToFrame({ event: 'pane.agent_status_changed', data: { agent_status: 'done' } }))
      .toMatchObject({ status: 'idle' })
    expect(
      herdrStatusToFrame({ event: 'pane.agent_status_changed', data: { agent_status: 'unknown' } }),
    ).toBeUndefined()
    expect(herdrStatusToFrame({ event: 'pane.focused', data: { pane_id: 'w1:p1' } })).toBeUndefined()
    expect(
      herdrStatusToFrame(
        JSON.stringify({ event: 'pane.agent_status_changed', data: { agent_status: 'working' } }),
      ),
    ).toMatchObject({ status: 'working' })
  })
})

describe('createHerdrStatusHub', () => {
  it('starts one subscribe on first retain, stops on last release (no leaks)', () => {
    const unsubs: Array<() => void> = []
    let live = 0
    const subscribe = (
      _name: string,
      _onEvent: (evt: unknown) => void,
      _onClose: () => void,
    ): (() => void) => {
      live += 1
      const unsub = (): void => {
        live -= 1
      }
      unsubs.push(unsub)
      return unsub
    }
    const frames: HarnessStatusFrame[] = []
    const hub = createHerdrStatusHub({
      subscribe,
      onFrame: (_n, f) => frames.push(f),
    })
    hub.retain('chat-f', 'sess-1')
    hub.retain('chat-f', 'sess-1')
    expect(hub.refs('chat-f')).toBe(2)
    expect(live).toBe(1)
    hub.release('chat-f')
    expect(live).toBe(1)
    hub.release('chat-f')
    expect(live).toBe(0)
    expect(hub.refs('chat-f')).toBe(0)
  })

  it('reconnects with backoff after onClose, and close() drops the timer', () => {
    vi.useFakeTimers()
    const closers: Array<() => void> = []
    let live = 0
    const subscribe = (
      _name: string,
      onEvent: (evt: unknown) => void,
      onClose: () => void,
    ): (() => void) => {
      live += 1
      closers.push(onClose)
      onEvent({ event: 'pane.agent_status_changed', data: { agent_status: 'working' } })
      return () => {
        live -= 1
      }
    }
    const frames: HarnessStatusFrame[] = []
    const hub = createHerdrStatusHub({
      subscribe,
      onFrame: (_n, f) => frames.push(f),
      backoffMs: [50, 100],
    })
    hub.retain('n', 'sid')
    expect(live).toBe(1)
    expect(frames).toHaveLength(1)
    expect(frames[0].status).toBe('working')
    closers[0]()
    expect(live).toBe(0)
    vi.advanceTimersByTime(50)
    expect(live).toBe(1)
    hub.close()
    expect(live).toBe(0)
    vi.advanceTimersByTime(10_000)
    expect(live).toBe(0)
    vi.useRealTimers()
  })
})

describe('createRealHerdrCtl argv', () => {
  it('create runs server → workspace create → agent start, env on workspace not agent', () => {
    const calls: string[][] = []
    const exec: HerdrExec = (_bin, args) => {
      calls.push(args)
      if (args.includes('workspace') && args.includes('create')) {
        return JSON.stringify({ pane_id: 'w1:p1' })
      }
      return ''
    }
    const spawned: string[][] = []
    const spawnFake: HerdrSpawn = (_bin, args, opts) => {
      spawned.push(args)
      expect(opts.detached).toBe(true)
      return { kill: () => undefined } as unknown as ReturnType<HerdrSpawn>
    }
    const ctl = createRealHerdrCtl('/usr/bin/herdr', '/tmp/herdr-cfg', exec, spawnFake, () => true)
    ctl.create({
      name: 'chat-f',
      argv: ['grok', '--resume', 'abc'],
      env: { RIVET_DEN_TOKEN: 'sekrit' },
      cwd: '/work',
      kind: 'grok',
      command: 'grok',
      user: 'owner',
    })
    // the session server is a foreground daemon: detached spawn, never exec'd to completion
    expect(spawned[0]).toEqual(['--session', 'chat-f', 'server'])
    expect(calls[0]?.slice(0, 5)).toEqual(['--session', 'chat-f', 'workspace', 'create', '--cwd'])
    expect(calls[0]).toContain('RIVET_DEN_TOKEN=sekrit')
    const agent = calls.find((c) => c.includes('agent') && c.includes('start'))
    expect(agent).toBeDefined()
    const dash = agent!.indexOf('--')
    expect(agent!.slice(dash + 1)).toEqual(['grok', '--resume', 'abc'])
    expect(agent!.slice(dash + 1).join(' ')).not.toMatch(/sekrit/)
    expect(ctl.attachArgv('chat-f')).toEqual(['herdr', '--session', 'chat-f'])
  })
})

describe('createRealHerdrCtl subscribeEvents (socket transport)', () => {
  it('socket transport: subscribe request, envelopes only, destroy on unsub', async () => {
    const { PassThrough } = await import('node:stream')
    const written: string[] = []
    let destroyed = false
    const sock = new PassThrough()
    const orig = sock.write.bind(sock)
    ;(sock as unknown as { write: (c: string) => boolean }).write = (c: string) => { written.push(String(c)); return true }
    ;(sock as unknown as { destroy: () => void }).destroy = () => { destroyed = true }
    const ctl = createRealHerdrCtl('/usr/bin/herdr', '/tmp/herdr-cfg', () => '', undefined, () => true, () => sock as never)
    const events: unknown[] = []
    let closes = 0
    const unsub = ctl.subscribeEvents!('chat-f', (e) => events.push(e), () => { closes += 1 })
    sock.emit('connect')
    expect(written[0]).toBe(herdrEventsSubscribeRequest('w1:p1'))
    expect(JSON.parse(written[0]!).params.subscriptions[0]).toEqual({ type: 'pane.agent_status_changed', pane_id: 'w1:p1' })
    sock.emit('data', '{"id":"den-status","result":{"type":"subscription_started"}}\n')
    sock.emit('data', '{"event":"pane_agent_status_changed","data":{"pane_id":"w1:p1","agent_status":"working"}}\n{"event":"pane_agent_detected"')
    expect(events).toHaveLength(1)
    sock.emit('data', ',"data":{"pane_id":"w1:p1"}}\n')
    expect(events).toHaveLength(2)
    unsub()
    expect(destroyed).toBe(true)
    sock.emit('close')
    expect(closes).toBe(0)
    void orig
  })
})
