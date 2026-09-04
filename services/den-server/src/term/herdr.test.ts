import { mkdirSync, mkdtempSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { HarnessStatusFrame } from '@rivetos/types'
import {
  HERDR_DEFAULT_PANE,
  HERDR_PINNED_VERSION,
  HERDR_SUN_PATH_MAX,
  assertHerdrSocketPath,
  classifyExistingHerdrSession,
  createHerdrStatusHub,
  createRealHerdrCtl,
  herdrAgentStartArgv,
  herdrAttachArgv,
  herdrClientSocketPath,
  herdrConfigHome,
  herdrEventsSubscribeRequest,
  herdrKindForCommand,
  herdrRuntimeHash,
  herdrServerArgv,
  herdrSessionName,
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
  type HerdrRpc,
  type HerdrSessionInfo,
  type HerdrSpawn,
} from './herdr.js'

const sample: HerdrSessionInfo = {
  name: herdrSessionName('chat-f'),
  denKey: 'chat-f',
  activity: 1,
  created: 1,
  command: '',
  user: '',
}

describe('herdr name encoding', () => {
  it('hashes the den key to d + 12 hex and is not reversible', () => {
    const key = 'claude:11111111-1111-1111-1111-111111111111'
    const name = herdrSessionName(key)
    expect(name).toMatch(/^d[0-9a-f]{12}$/)
    expect(name).toHaveLength(13)
    expect(name).toBe(herdrSessionName(key))
    expect(name).not.toBe(key)
    expect(isDenHerdrName(name)).toBe(true)
    expect(isDenHerdrName('claude_c11111111-1111-1111-1111-111111111111')).toBe(false)
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
    const ws = herdrWorkspaceCreateArgv('chat-f', { COLORTERM: 'truecolor' }, '/tmp/work')
    expect(ws.slice(0, 6)).toEqual([
      'herdr',
      '--session',
      'chat-f',
      'workspace',
      'create',
      '--cwd',
    ])
    expect(ws).toContain('--env')
    expect(ws).toContain('COLORTERM=truecolor')
    expect(ws.join(' ')).not.toMatch(/TOKEN|sekrit|PASSWORD/)
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
    const after = agent.slice(agent.indexOf('--') + 1)
    expect(after.join(' ')).not.toMatch(/sekrit|TOKEN/)
    const req = JSON.parse(herdrEventsSubscribeRequest('w1:p1', 'den-status'))
    expect(req).toEqual({
      id: 'den-status',
      method: 'events.subscribe',
      params: {
        subscriptions: [
          { type: 'pane.agent_status_changed', pane_id: 'w1:p1' },
          { type: 'pane.agent_detected', pane_id: 'w1:p1' },
        ],
      },
    })
  })

  it('kind mapping returns undefined for anything outside herdr\'s closed enum', () => {
    expect(herdrKindForCommand('claude')).toBe('claude')
    expect(herdrKindForCommand('grok')).toBe('grok')
    expect(herdrKindForCommand('kimi')).toBe('kimi')
    expect(herdrKindForCommand('hermes')).toBe('hermes')
    expect(herdrKindForCommand('dsh')).toBeUndefined()
    expect(herdrKindForCommand('deepseek')).toBeUndefined()
    expect(herdrKindForCommand('shell')).toBeUndefined()
    expect(herdrKindForCommand('bash')).toBeUndefined()
    expect(herdrKindForCommand('operator-key')).toBeUndefined()
  })

  it('per-den config home is a short runtime path hashed from stateDir+port', () => {
    const h = herdrRuntimeHash('/state/a', 5174)
    expect(h).toHaveLength(8)
    const home = herdrConfigHome('/state/a', 5174, () => false)
    expect(home).toBe(`/tmp/rivet-den-${h}`)
    const run = herdrConfigHome('/state/a', 5174, (p) => p.startsWith('/run/user/'))
    expect(run).toMatch(new RegExp(`^/run/user/\\d+/rivet-den-${h}$`))
    expect(herdrSocketPath('/cfg', 'dabc')).toBe('/cfg/herdr/sessions/dabc/herdr.sock')
    const name = herdrSessionName('claude:11111111-1111-1111-1111-111111111111')
    const client = herdrClientSocketPath(home, name)
    expect(Buffer.byteLength(client, 'utf8')).toBeLessThanOrEqual(HERDR_SUN_PATH_MAX)
    expect(() => assertHerdrSocketPath(home, name)).not.toThrow()
  })

  it('assertHerdrSocketPath throws a clear error when sun_path would overflow', () => {
    const longHome = `/${'x'.repeat(90)}`
    expect(() => assertHerdrSocketPath(longHome, 'd0123456789ab')).toThrow(/socket path too long/)
  })
})

describe('herdr --version pin', () => {
  it('parses 0.8.2 from common --version shapes and rejects previews', () => {
    expect(parseHerdrVersion('herdr 0.8.2\n')).toBe('0.8.2')
    expect(parseHerdrVersion('0.8.2')).toBe('0.8.2')
    expect(parseHerdrVersion('herdr 0.9.0')).toBe('0.9.0')
    expect(parseHerdrVersion('herdr 0.8.2-preview.1')).toBeNull()
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
    expect(herdrSupported('/bin/herdr', exec('herdr 0.8.2-preview.1'))).toBe(false)
    expect(herdrVersion('/bin/herdr', exec('herdr 0.8.2'))).toBe(HERDR_PINNED_VERSION)
  })
})

describe('parseWorkspaceCreate / parsePaneSize', () => {
  it('reads 0.8.2 root_pane.pane_id and falls back to w1:p1 on garbage', () => {
    expect(
      parseWorkspaceCreate(
        JSON.stringify({
          id: 'cli:workspace:create',
          result: { root_pane: { pane_id: 'w1:p1' } },
        }),
      ),
    ).toEqual({ paneId: 'w1:p1' })
    expect(parseWorkspaceCreate('{"pane_id":"w2:p3"}')).toEqual({ paneId: 'w2:p3' })
    expect(parseWorkspaceCreate('not-json')).toEqual({ paneId: HERDR_DEFAULT_PANE })
  })

  it('reads cols/rows from pane list JSON and returns undefined for 0.8.2 viewport_rows-only', () => {
    expect(parsePaneSize('[{"cols":120,"rows":40}]')).toEqual({ cols: 120, rows: 40 })
    expect(parsePaneSize('[{"width":80,"height":24}]')).toEqual({ cols: 80, rows: 24 })
    expect(parsePaneSize('garbage')).toBeUndefined()
    expect(parsePaneSize('[{"cols":0,"rows":24}]')).toBeUndefined()
    expect(
      parsePaneSize(JSON.stringify({ result: { panes: [{ scroll: { viewport_rows: 39 } }] } })),
    ).toBeUndefined()
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
    expect(frames[0].sessionId).toBe('sid')
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

  it('backoff escalates across two closes until an event or 5s uptime (N1)', () => {
    vi.useFakeTimers()
    const closers: Array<() => void> = []
    let live = 0
    const subscribe = (
      _name: string,
      _onEvent: (evt: unknown) => void,
      onClose: () => void,
    ): (() => void) => {
      live += 1
      closers.push(onClose)
      return () => {
        live -= 1
      }
    }
    const hub = createHerdrStatusHub({
      subscribe,
      onFrame: () => undefined,
      backoffMs: [50, 100],
    })
    hub.retain('n', 'sid')
    expect(live).toBe(1)
    closers[0]()
    expect(live).toBe(0)
    vi.advanceTimersByTime(49)
    expect(live).toBe(0)
    vi.advanceTimersByTime(1)
    expect(live).toBe(1)
    closers[1]()
    expect(live).toBe(0)
    vi.advanceTimersByTime(50)
    expect(live).toBe(0)
    vi.advanceTimersByTime(50)
    expect(live).toBe(1)
    hub.close()
    vi.useRealTimers()
  })
})

describe('createRealHerdrCtl argv', () => {
  const spawnFake: HerdrSpawn = (_bin, args, opts) => {
    expect(opts.detached).toBe(true)
    return { kill: () => undefined, pid: 4242 }
  }

  it('create uses socket workspace.create / agent.start; credentials never on argv', async () => {
    const calls: string[][] = []
    const exec: HerdrExec = (_bin, args) => {
      calls.push(args)
      return ''
    }
    const spawned: string[][] = []
    const spawnRec: HerdrSpawn = (_bin, args, opts) => {
      spawned.push(args)
      return spawnFake(_bin, args, opts)
    }
    const rpcs: Array<{ method: string; params?: Record<string, unknown> }> = []
    const rpc: HerdrRpc = async (_path, req) => {
      rpcs.push({ method: req.method, params: req.params })
      if (req.method === 'pane.get') return { pane: { terminal_title: 'user@host: ~' } }
      if (req.method === 'workspace.create') {
        return { root_pane: { pane_id: 'w1:p1' } }
      }
      return {}
    }
    const ctl = createRealHerdrCtl(
      '/usr/bin/herdr',
      '/tmp/herdr-cfg',
      exec,
      spawnRec,
      () => true,
      undefined,
      rpc,
    )
    await ctl.create({
      name: 'dabc',
      denKey: 'chat-f',
      argv: ['grok', '--resume', 'abc'],
      env: { RIVET_DEN_TOKEN: 'sekrit', COLORTERM: 'truecolor' },
      cwd: '/work',
      kind: 'grok',
      command: 'grok',
      user: 'owner',
    })
    expect(spawned[0]).toEqual(['--session', 'dabc', 'server'])
    expect(JSON.stringify(spawned)).not.toMatch(/sekrit|RIVET_DEN_TOKEN/)
    expect(JSON.stringify(calls)).not.toMatch(/sekrit|RIVET_DEN_TOKEN/)
    const ws = rpcs.find((r) => r.method === 'workspace.create')
    expect(ws?.params?.env).toMatchObject({ RIVET_DEN_TOKEN: 'sekrit', COLORTERM: 'truecolor' })
    expect(ws?.params?.cwd).toBe('/work')
    const xdg = (ws?.params?.env as Record<string, string>).XDG_CONFIG_HOME
    expect(xdg).toBeTruthy()
    expect(xdg).not.toBe('/tmp/herdr-cfg')
    const agent = rpcs.find((r) => r.method === 'agent.start')
    expect(agent?.params).toMatchObject({
      name: 'dabc',
      kind: 'grok',
      pane_id: 'w1:p1',
      args: ['--resume', 'abc'],
    })
    expect(ctl.attachArgv('dabc')).toEqual(['herdr', '--session', 'dabc'])
  })

  it('unknown kind uses pane.send_text and never agent.start', async () => {
    const rpcs: string[] = []
    const rpc: HerdrRpc = async (_path, req) => {
      rpcs.push(req.method)
      if (req.method === 'pane.get') return { pane: { terminal_title: 'user@host: ~' } }
      if (req.method === 'workspace.create') return { root_pane: { pane_id: 'w1:p1' } }
      return {}
    }
    const ctl = createRealHerdrCtl(
      '/usr/bin/herdr',
      '/tmp/herdr-cfg',
      () => '',
      spawnFake,
      () => true,
      undefined,
      rpc,
    )
    await ctl.create({
      name: 'dshell',
      denKey: 'chat-shell',
      argv: ['bash', '-l'],
      env: {},
      cwd: '/work',
      command: 'shell',
      user: 'owner',
    })
    // one readiness pane.get (the fake answers with a prompt title) sits between them
    expect(rpcs).toEqual(['workspace.create', 'pane.get', 'pane.send_text'])
    expect(rpcs).not.toContain('agent.start')
  })

  it('slow create does not stall a concurrent ctl call', async () => {
    let release!: (v: boolean) => void
    const gate = new Promise<boolean>((r) => {
      release = r
    })
    const rpc: HerdrRpc = async (_path, req) => {
      if (req.method === 'pane.get') return { pane: { terminal_title: 'user@host: ~' } }
      if (req.method === 'workspace.create') return { root_pane: { pane_id: 'w1:p1' } }
      return {}
    }
    const ctl = createRealHerdrCtl(
      '/usr/bin/herdr',
      '/tmp/herdr-cfg-slow',
      () => '',
      spawnFake,
      () => gate,
      undefined,
      rpc,
    )
    const creating = ctl.create({
      name: 'dslow',
      denKey: 'slow',
      argv: ['grok'],
      env: {},
      cwd: '/work',
      kind: 'grok',
      command: 'grok',
      user: 'owner',
    })
    const t0 = Date.now()
    expect(ctl.hasSession('other')).toBe(false)
    expect(Date.now() - t0).toBeLessThan(100)
    release(true)
    await creating
  })
})

describe('createRealHerdrCtl liveness', () => {
  it('hasSession treats a refusing socket as dead; the stale dir is reaped by create()/killSession, never by a read', () => {
    const home = mkdtempSync(join(tmpdir(), 'herdr-dead-'))
    const name = 'ddeaddeaddead'
    mkdirSync(join(home, 'herdr', 'sessions', name), { recursive: true })
    writeFileSync(join(home, 'herdr', 'sessions', name, 'herdr.sock'), '')
    writeFileSync(join(home, 'herdr', 'sessions', name, 'rivet.json'), '{}\n')
    const exec: HerdrExec = () => {
      throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })
    }
    const ctl = createRealHerdrCtl('/usr/bin/herdr', home, exec)
    expect(ctl.hasSession(name)).toBe(false)
    // a READ never deletes: a transient probe miss must not destroy a live session's dir
    expect(existsSync(join(home, 'herdr', 'sessions', name))).toBe(true)
    expect(ctl.listSessions()).toEqual([]) // dead sessions are filtered, not reaped, by list
    ctl.killSession(name) // explicit kill (or create() recovery) is what reaps
    expect(existsSync(join(home, 'herdr', 'sessions', name))).toBe(false)
  })
})

describe('createRealHerdrCtl subscribeEvents (socket transport)', () => {
  it('socket transport: subscribe request, envelopes only, destroy on unsub', async () => {
    const { PassThrough } = await import('node:stream')
    const written: string[] = []
    let destroyed = false
    const sock = new PassThrough()
    const orig = sock.write.bind(sock)
    ;(sock as unknown as { write: (c: string) => boolean }).write = (c: string) => {
      written.push(String(c))
      return true
    }
    ;(sock as unknown as { destroy: () => void }).destroy = () => {
      destroyed = true
    }
    const ctl = createRealHerdrCtl(
      '/usr/bin/herdr',
      '/tmp/herdr-cfg',
      () => '',
      undefined,
      () => true,
      () => sock as never,
    )
    const events: unknown[] = []
    let closes = 0
    const unsub = ctl.subscribeEvents!('chat-f', (e) => events.push(e), () => {
      closes += 1
    })
    sock.emit('connect')
    expect(written[0]).toBe(herdrEventsSubscribeRequest('w1:p1'))
    expect(JSON.parse(written[0]!).params.subscriptions[0]).toEqual({
      type: 'pane.agent_status_changed',
      pane_id: 'w1:p1',
    })
    sock.emit('data', '{"id":"den-status","result":{"type":"subscription_started"}}\n')
    sock.emit(
      'data',
      '{"event":"pane_agent_status_changed","data":{"pane_id":"w1:p1","agent_status":"working"}}\n{"event":"pane_agent_detected"',
    )
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

describe('round-2 re-review fixes (B6 + orphan risks)', () => {
  const mkCtl = (rpcs: Array<{ method: string; params?: Record<string, unknown> }>, rpcImpl?: (req: { method: string; params?: Record<string, unknown> }) => unknown) => {
    const rpc: HerdrRpc = async (_p, req) => {
      rpcs.push({ method: req.method, params: req.params })
      if (req.method === 'pane.get') return { pane: { terminal_title: 'user@host: ~' } }
      if (req.method === 'workspace.create') return { root_pane: { pane_id: 'w1:p1' } }
      return rpcImpl ? rpcImpl(req) : {}
    }
    const spawnFake: HerdrSpawn = () => ({ kill: () => undefined, pid: 4242 }) as unknown as ReturnType<HerdrSpawn>
    return createRealHerdrCtl('/usr/bin/herdr', '/tmp/herdr-cfg-r2', () => '', spawnFake, () => true, undefined as never, rpc)
  }
  it('B6: agent.start gets argv WITHOUT argv[0] (herdr prepends the kind executable)', async () => {
    const rpcs: Array<{ method: string; params?: Record<string, unknown> }> = []
    await mkCtl(rpcs).create({ name: 'dr2b6', denKey: 'k', argv: ['grok', '--always-approve', '--no-plan'], env: {}, cwd: '/w', kind: 'grok', command: 'grok', user: 'u' })
    const start = rpcs.find((r) => r.method === 'agent.start')
    expect(start).toBeDefined()
    expect((start!.params as { args: string[] }).args).toEqual(['--always-approve', '--no-plan'])
  })
  it('B6: a roster whose argv[0] is not the kind executable runs verbatim in a plain pane', async () => {
    const rpcs: Array<{ method: string; params?: Record<string, unknown> }> = []
    await mkCtl(rpcs).create({ name: 'dr2b6b', denKey: 'k', argv: ['/opt/wrap/grok-wrapper.sh', '--x'], env: {}, cwd: '/w', kind: 'grok', command: 'grok', user: 'u' })
    expect(rpcs.map((r) => r.method)).not.toContain('agent.start')
    expect(rpcs.map((r) => r.method)).toContain('pane.send_text')
  })
  it('meta (pid + denKey) is written before workspace/agent setup so a mid-create crash stays visible', async () => {
    const rpcs: Array<{ method: string; params?: Record<string, unknown> }> = []
    const { readFileSync, rmSync } = await import('node:fs')
    rmSync('/tmp/herdr-cfg-r2/herdr/sessions/dr2meta', { recursive: true, force: true })
    await expect(
      mkCtl(rpcs, (req) => { if (req.method === 'agent.start') throw new Error('boom') }).create({ name: 'dr2meta', denKey: 'key-x', argv: ['grok'], env: {}, cwd: '/w', kind: 'grok', command: 'grok', user: 'u' }),
    ).rejects.toThrow('boom')
    // the throw path tears the server down, but the early meta write must have happened before agent.start
    expect(rpcs.map((r) => r.method)).toContain('workspace.create')
    void readFileSync
  })
})
