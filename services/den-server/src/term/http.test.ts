// HTTP surface of the terminal core: /term/config, POST /term, /term/list,
// DELETE /term, the DELETE /session PTY linkage, the pty decoration on
// /sessions + WS snapshots, and the startup security gate.

import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { WebSocket } from 'ws'
import { afterEach, describe, expect, it } from 'vitest'
import { parseUsersRegistry } from '@rivetos/types'
import { createDenServer, type DenServer, type DenServerOptions } from '../server.js'
import type { DenConfig, DenTermConfig } from '../config.js'
import type { PtyProc, PtySpawn, PtySpawnOpts } from './pty.js'
import { encodeTmuxName, tmuxSocketName, type TmuxCtl, type TmuxSessionInfo } from './tmux.js'

class FakeProc extends EventEmitter implements PtyProc {
  kills: (string | undefined)[] = []
  constructor(public pid: number) {
    super()
  }
  write(): void {}
  resize(): void {}
  kill(signal?: string): void {
    this.kills.push(signal)
  }
  onData(cb: (data: string | Buffer) => void): void {
    this.on('data', cb)
  }
  onExit(cb: (code: number | null) => void): void {
    this.on('exit', cb)
  }
  emitExit(code: number | null): void {
    this.emit('exit', code)
  }
}

const servers: DenServer[] = []
const dirs: string[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()))
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }))
})

interface StartResult {
  den: DenServer
  base: string
  port: number
  stateDir: string
  procs: FakeProc[]
  spawns: { argv: string[]; opts: PtySpawnOpts }[]
}

async function start(
  overrides: Partial<DenConfig> = {},
  term: Partial<DenTermConfig> = {},
  serverOpts?: DenServerOptions,
): Promise<StartResult> {
  const stateDir = mkdtempSync(join(tmpdir(), 'den-term-http-'))
  dirs.push(stateDir)
  const config: DenConfig = {
    port: 0,
    host: '127.0.0.1',
    token: '',
    tls: { certPath: '', keyPath: '', caPath: '', requireClientCert: true },
    stateDir,
    staticDir: '',
    evictTtlMs: 60_000,
    meshFile: '',
    meshCacheMs: 10_000,
    term: {
      enabled: true,
      open: false,
      configFile: join(stateDir, 'den-term.json'),
      maxPtys: 4,
      scrollbackBytes: 262_144,
      detachedTtlMs: 1_800_000,
      idleTtlMs: 1_800_000,
      exitLingerMs: 60_000,
      injectReadyMs: 10,
      // Pinned: these tests assert the pre-T1 behavior byte-for-byte; the
      // tmux paths have their own test below.
      mux: 'none',
      ...term,
    },
    audio: {
      enabled: false,
      open: false,
      dir: '',
      deviceName: 'RivetHub Mic',
      sampleRate: 16_000,
    },
    ...overrides,
  }
  const procs: FakeProc[] = []
  const spawns: { argv: string[]; opts: PtySpawnOpts }[] = []
  let pid = 4000
  const fakeSpawn: PtySpawn = (argv, opts) => {
    const proc = new FakeProc(++pid)
    procs.push(proc)
    spawns.push({ argv, opts })
    return proc
  }
  const den = createDenServer(config, { ptySpawn: fakeSpawn, ...serverOpts })
  servers.push(den)
  await new Promise<void>((r) => den.server.listen(0, '127.0.0.1', r))
  const port = (den.server.address() as AddressInfo).port
  return { den, base: `http://127.0.0.1:${port}`, port, stateDir, procs, spawns }
}

const post = (base: string, path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })

interface SpawnedPty {
  id: string
  denSession: string
  command: string
  pid: number
  createdAt: number
}

describe('term endpoints', () => {
  it('POST /term appends model/effort flags for listed ids and omits unknown', async () => {
    const { base, spawns } = await start()
    expect(
      (await post(base, '/term', { command: 'claude', model: 'fable', effort: 'high' })).status,
    ).toBe(201)
    expect(spawns[0].argv).toEqual(['claude', '--model', 'fable', '--effort', 'high'])

    expect(
      (await post(base, '/term', { command: 'claude', model: 'not-a-model', effort: 'nope' }))
        .status,
    ).toBe(201)
    expect(spawns[1].argv).toEqual(['claude'])

    expect((await post(base, '/term', { command: 'claude', model: 'bad token!' })).status).toBe(400)
    expect(
      (await post(base, '/term', { command: 'claude', model: 'moonshotai/kimi-k3' })).status,
    ).toBe(201)
    expect((await post(base, '/term', { command: 'claude', effort: 'a/b' })).status).toBe(400)
    expect((await post(base, '/term', { command: 'claude', model: '../x' })).status).toBe(400)
    expect((await post(base, '/term', { command: 'claude', model: 'a b' })).status).toBe(400)
  })

  it('POST /term spawns the roster default and returns the pty descriptor', async () => {
    const { base, stateDir, spawns } = await start()
    const res = await post(base, '/term', {})
    expect(res.status).toBe(201)
    const pty = (await res.json()) as SpawnedPty
    expect(pty.id).toMatch(/^pty-[0-9a-f]{8}$/)
    expect(pty.denSession).toBe(`den-${pty.id}`)
    expect(pty.command).toBe('claude') // built-in roster default
    expect(typeof pty.pid).toBe('number')
    expect(typeof pty.createdAt).toBe('number')
    expect(pty).not.toHaveProperty('attach')
    expect(spawns[0].argv).toEqual(['claude'])
    // cols/rows defaulted
    expect(spawns[0].opts).toMatchObject({ cols: 80, rows: 24 })
    // audit line hit the state dir
    const audit = readFileSync(join(stateDir, 'term-audit.log'), 'utf8').trim()
    expect(JSON.parse(audit)).toMatchObject({ action: 'spawn', id: pty.id })
  })

  it('clamps cols/rows into sane terminal bounds', async () => {
    const { base, spawns } = await start()
    await post(base, '/term', { command: 'shell', cols: 10_000, rows: 1 })
    expect(spawns[0].opts).toMatchObject({ cols: 500, rows: 5 })
    await post(base, '/term', { command: 'shell', cols: 19, rows: 'weird' })
    expect(spawns[1].opts).toMatchObject({ cols: 20, rows: 24 })
  })

  it('404s unknown roster keys; LRU-evicts an idle unattached pty at the cap (5g)', async () => {
    const { base, procs } = await start({}, { maxPtys: 1 })
    expect((await post(base, '/term', { command: 'not-a-key' })).status).toBe(404)
    expect((await post(base, '/term', { command: 'shell' })).status).toBe(201)
    // a booting pty (no output yet) is NOT evictable → the cap is real
    expect((await post(base, '/term', { command: 'shell' })).status).toBe(409)
    // once ready (first output settled) it becomes LRU-evictable → 201
    procs[0].emit('data', Buffer.from('booted'))
    await new Promise((r) => setTimeout(r, 30)) // injectReadyMs:10 settle
    expect((await post(base, '/term', { command: 'shell' })).status).toBe(201)
  })

  it('GET /term/config lists roster keys but NEVER argv/cwd/env', async () => {
    const { base } = await start()
    const res = await fetch(`${base}/term/config`)
    expect(res.status).toBe(200)
    const text = await res.text()
    const body = JSON.parse(text) as {
      enabled: boolean
      default: string
      maxPtys: number
      active: number
      commands: { id: string; label: string; room: boolean }[]
    }
    expect(body).toMatchObject({ enabled: true, default: 'claude', maxPtys: 4, active: 0 })
    expect(body.commands.map((c) => c.id).sort()).toEqual([
      'claude',
      'dsh',
      'grok',
      'hermes',
      'kimi',
      'shell',
    ])
    expect(body.commands.find((c) => c.id === 'shell')).toEqual({
      id: 'shell',
      label: 'Shell',
      room: false,
    })
    // the wire body must not leak how commands are executed
    for (const secret of ['cmd', 'argv', 'cwd', 'env', 'bash']) {
      expect(text).not.toContain(secret)
    }
    // active reflects running ptys
    await post(base, '/term', { command: 'shell' })
    const after = (await (await fetch(`${base}/term/config`)).json()) as { active: number }
    expect(after.active).toBe(1)
  })

  it('GET /term/list reports live ptys; DELETE /term kills them', async () => {
    const { base, procs } = await start()
    const pty = (await (await post(base, '/term', { command: 'shell' })).json()) as SpawnedPty
    const list = (await (await fetch(`${base}/term/list`)).json()) as { ptys: unknown[] }
    expect(list.ptys).toHaveLength(1)
    expect(list.ptys[0]).toMatchObject({
      id: pty.id,
      denSession: pty.denSession,
      command: 'shell',
      pid: pty.pid,
      attached: 0,
      state: 'running',
    })
    expect(list.ptys[0]).not.toHaveProperty('attach')
    expect((await fetch(`${base}/term?id=nope`, { method: 'DELETE' })).status).toBe(404)
    const del = await fetch(`${base}/term?id=${pty.id}`, { method: 'DELETE' })
    expect(del.status).toBe(200)
    expect(procs[0].kills).toEqual(['SIGHUP'])
    procs[0].emitExit(null)
    const after = (await (await fetch(`${base}/term/list`)).json()) as {
      ptys: { state: string; exitCode: number | null }[]
    }
    expect(after.ptys[0]).toMatchObject({ state: 'exited', exitCode: null })
  })

  it('DELETE /session kills the linked pty and leaves other sessions alone', async () => {
    const { den, base, procs } = await start()
    const pty = (await (await post(base, '/term', { command: 'shell' })).json()) as SpawnedPty
    await post(base, '/event', {
      v: 1,
      session: pty.denSession,
      type: 'session.start',
      title: 'terminal',
      ts: 2,
    })
    await post(base, '/event', {
      v: 1,
      session: 'external',
      type: 'session.start',
      title: 'unrelated',
      ts: 1,
    })
    const res = await fetch(`${base}/session?session=${pty.denSession}`, { method: 'DELETE' })
    expect(res.status).toBe(200)
    expect(procs[0].kills).toEqual(['SIGHUP']) // pty went down with the room
    expect(den.state().rooms[pty.denSession]).toBeUndefined()
    expect(den.state().rooms.external).toBeDefined() // untouched
    // removing a session with no pty still behaves as before
    expect((await fetch(`${base}/session?session=external`, { method: 'DELETE' })).status).toBe(200)
    expect((await fetch(`${base}/session?session=ghost`, { method: 'DELETE' })).status).toBe(404)
  })

  it('decorates /sessions and WS snapshots with the linked pty id', async () => {
    const { base, port } = await start()
    const pty = (await (await post(base, '/term', { command: 'claude' })).json()) as SpawnedPty
    await post(base, '/event', {
      v: 1,
      session: pty.denSession,
      type: 'session.start',
      title: 'linked',
      ts: 2,
    })
    await post(base, '/event', { v: 1, session: 'plain', type: 'session.start', title: 'p', ts: 1 })

    const sessions = (await (await fetch(`${base}/sessions`)).json()) as {
      sessions: { id: string; pty?: string }[]
    }
    const linked = sessions.sessions.find((s) => s.id === pty.denSession)!
    const plain = sessions.sessions.find((s) => s.id === 'plain')!
    expect(linked.pty).toBe(pty.id)
    expect('pty' in plain).toBe(false) // extra field only where it applies

    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
    const first = await new Promise<Record<string, unknown>>((resolve) => {
      ws.once('message', (d: Buffer) =>
        resolve(JSON.parse(d.toString()) as Record<string, unknown>),
      )
    })
    ws.close()
    expect(first.type).toBe('snapshot')
    const snapSessions = first.sessions as { id: string; pty?: string }[]
    expect(snapSessions.find((s) => s.id === pty.denSession)?.pty).toBe(pty.id)
    expect('pty' in snapSessions.find((s) => s.id === 'plain')!).toBe(false)
  })

  it('exits: a room:true pty that dies without session.end gets a synthetic one', async () => {
    const { den, base, procs } = await start()
    const pty = (await (await post(base, '/term', { command: 'claude' })).json()) as SpawnedPty
    await post(base, '/event', {
      v: 1,
      session: pty.denSession,
      type: 'session.start',
      title: 'will crash',
    })
    procs[0].emitExit(137)
    expect(den.state().rooms[pty.denSession].ended).toBe(true)
  })

  it('answers 503 with a clear error when node-pty is unavailable', async () => {
    // ptySpawn: null simulates the optionalDependency having failed to install
    const { base } = await start({}, {}, { ptySpawn: null })
    for (const req of [
      post(base, '/term', {}),
      fetch(`${base}/term/list`),
      fetch(`${base}/term?id=x`, { method: 'DELETE' }),
    ]) {
      const res = await req
      expect(res.status).toBe(503)
      expect(((await res.json()) as { error: string }).error).toBe('node-pty unavailable')
    }
    // the relay itself is unaffected
    expect((await fetch(`${base}/healthz`)).status).toBe(200)
  })

  it('security gate: non-loopback without TLS refuses to construct the server', async () => {
    // Off-loopback plain HTTP is a hard fail — never serves Hub/API unauthenticated.
    await expect(start({ host: '0.0.0.0' })).rejects.toThrow(/TLS is required off-loopback/)

    // loopback → fine
    const loopback = await start({ host: '127.0.0.1' })
    expect((await post(loopback.base, '/term', { command: 'shell' })).status).toBe(201)

    // term disabled → 503 for actions, config reports enabled:false
    const disabled = await start({}, { enabled: false })
    expect((await post(disabled.base, '/term', {})).status).toBe(503)
    expect(
      ((await (await post(disabled.base, '/term', {})).json()) as { error: string }).error,
    ).toBe('terminal disabled')
    expect((await fetch(`${disabled.base}/term/list`)).status).toBe(503)
    const cfg = (await (await fetch(`${disabled.base}/term/config`)).json()) as { enabled: boolean }
    expect(cfg.enabled).toBe(false)
  })

  it('term endpoints work on loopback without a client cert', async () => {
    const { base } = await start()
    expect((await fetch(`${base}/term/config`)).status).toBe(200)
    expect((await post(base, '/term', { command: 'shell' })).status).toBe(201)
  })

  it('tmux mux: reattach skips --resume, /term/list shows persisted rows without duplicates', async () => {
    // the helper's third param is DenServerOptions — this call really does
    // run with mux:'tmux' and the scripted ctl (review: verify the wiring)
    const ctl: TmuxCtl & { sessions: Map<string, TmuxSessionInfo>; kills: string[] } = {
      sessions: new Map(),
      kills: [],
      hasSession(name) {
        return this.sessions.has(name)
      },
      killSession(name) {
        this.kills.push(name)
        this.sessions.delete(name)
      },
      listSessions() {
        return [...this.sessions.values()]
      },
    }
    const { base, procs, spawns } = await start({}, { mux: 'tmux' }, { tmuxCtl: ctl })

    // fresh spawn: tmux session created server-side afterwards
    const first = (await (
      await post(base, '/term', { command: 'claude', session: 'chat-p1' })
    ).json()) as SpawnedPty & { mux?: string; reattached?: boolean }
    expect(first.mux).toBe('tmux')
    expect(first.reattached).toBeUndefined()
    ctl.sessions.set(encodeTmuxName('chat-p1'), {
      name: encodeTmuxName('chat-p1'),
      activity: 1_800_000_000,
      created: 1_799_999_000,
      pid: 4321,
      command: 'claude',
      user: 'owner',
    })

    // while den's client is alive, /term/list has exactly the live row
    const whileLive = (await (await fetch(`${base}/term/list`)).json()) as {
      ptys: { id: string; persisted?: boolean }[]
    }
    expect(whileLive.ptys).toHaveLength(1)
    expect(whileLive.ptys[0].persisted).toBeUndefined()

    // den's client dies (browser detach / den restart); the tmux session
    // lives → a persisted row appears (and the exited record is reaped
    // immediately — exactly ONE row for the denSession)
    procs[0].emitExit(null)
    const persisted = (await (await fetch(`${base}/term/list`)).json()) as {
      ptys: Record<string, unknown>[]
    }
    expect(persisted.ptys).toHaveLength(1)
    const orphan = persisted.ptys.find((p) => p.persisted === true)!
    expect(orphan).toMatchObject({
      denSession: 'chat-p1',
      command: 'claude',
      state: 'running',
      mux: 'tmux',
      pid: 4321,
      attached: 0,
    })

    // re-POST the same session: attach-session without --resume/--session-id
    const again = (await (
      await post(base, '/term', { command: 'claude', session: 'chat-p1' })
    ).json()) as SpawnedPty & { reattached?: boolean; persisted?: boolean }
    expect(again.reattached).toBe(true)
    expect(again.persisted).toBeUndefined() // persisted is for client-less rows only
    expect(again.id).not.toBe(first.id)
    expect(spawns[1].argv).toContain('attach-session')
    expect(spawns[1].argv).not.toContain('--resume')
    expect(spawns[1].argv).not.toContain('-A')
    // and the reattached client claims the session — exactly one running
    // row for it, and no persisted (client-less) row anymore.
    const after = (await (await fetch(`${base}/term/list`)).json()) as {
      ptys: Record<string, unknown>[]
    }
    const running = after.ptys.filter((p) => p.denSession === 'chat-p1' && p.state === 'running')
    expect(running).toHaveLength(1)
    expect(running[0]).toMatchObject({ id: again.id, reattached: true })
    // no client-less tmux row anymore — the new den client claimed it
    expect(after.ptys.some((p) => String(p.id).startsWith('tmux-'))).toBe(false)
  })

  it('tmux mux: attach is present only for tmux PTYs, local is loopback, no argv/env leak', async () => {
    const ctl: TmuxCtl & { sessions: Map<string, TmuxSessionInfo> } = {
      sessions: new Map(),
      hasSession(name) {
        return this.sessions.has(name)
      },
      killSession(name) {
        this.sessions.delete(name)
      },
      listSessions() {
        return [...this.sessions.values()]
      },
    }
    const meshDir = mkdtempSync(join(tmpdir(), 'den-term-mesh-'))
    dirs.push(meshDir)
    const meshFile = join(meshDir, 'mesh.json')
    writeFileSync(
      meshFile,
      JSON.stringify({
        version: 1,
        updatedAt: 1,
        nodes: {
          ct116: {
            id: 'ct116',
            name: 'ct116',
            host: '192.0.2.116',
            sshUser: 'philip',
            port: 3000,
            agents: [],
            providers: [],
            capabilities: ['den'],
            status: 'online',
            lastSeen: 0,
          },
        },
      }),
    )
    const { base, stateDir, procs } = await start(
      { meshFile },
      { mux: 'tmux' },
      { tmuxCtl: ctl, localNodeId: 'ct116' },
    )
    const sock = tmuxSocketName(stateDir, 0)
    const first = (await (
      await post(base, '/term', { command: 'claude', session: 'chat-p1' })
    ).json()) as SpawnedPty & {
      mux?: string
      attach?: {
        socket: string
        session: string
        host: string
        sshUser: string
        local: boolean
        argv?: unknown
        env?: unknown
      }
    }
    expect(first.mux).toBe('tmux')
    expect(first.attach).toEqual({
      socket: sock,
      session: encodeTmuxName('chat-p1'),
      host: '192.0.2.116',
      sshUser: 'philip',
      local: true,
    })
    expect(first.attach).not.toHaveProperty('argv')
    expect(first.attach).not.toHaveProperty('env')
    const spawnText = JSON.stringify(first)
    expect(spawnText).not.toMatch(/"argv"/)
    expect(spawnText).not.toMatch(/"env"/)

    ctl.sessions.set(encodeTmuxName('chat-p1'), {
      name: encodeTmuxName('chat-p1'),
      activity: 1_800_000_000,
      created: 1_799_999_000,
      pid: 4321,
      command: 'claude',
      user: 'owner',
    })
    const whileLive = (await (await fetch(`${base}/term/list`)).json()) as {
      ptys: Record<string, unknown>[]
    }
    expect(whileLive.ptys).toHaveLength(1)
    expect(whileLive.ptys[0].attach).toEqual(first.attach)
    expect(whileLive.ptys[0]).not.toHaveProperty('socket')
    expect(whileLive.ptys[0]).not.toHaveProperty('session')
    expect(JSON.stringify(whileLive)).not.toMatch(/"argv"/)

    procs[0].emitExit(null)
    const persisted = (await (await fetch(`${base}/term/list`)).json()) as {
      ptys: Record<string, unknown>[]
    }
    const orphan = persisted.ptys.find((p) => p.persisted === true)!
    expect(orphan.attach).toEqual(first.attach)
  })

  it('malformed mesh.json does not 500 POST /term or GET /term/list', async () => {
    const meshDir = mkdtempSync(join(tmpdir(), 'den-term-badmesh-'))
    dirs.push(meshDir)
    const meshFile = join(meshDir, 'mesh.json')
    writeFileSync(
      meshFile,
      JSON.stringify({
        nodes: [{ name: 'legacy-node', ip: '192.0.2.1' }],
        updatedAt: 99,
      }),
    )
    const ctl: TmuxCtl & { sessions: Map<string, TmuxSessionInfo> } = {
      sessions: new Map(),
      hasSession(name) {
        return this.sessions.has(name)
      },
      killSession(name) {
        this.sessions.delete(name)
      },
      listSessions() {
        return [...this.sessions.values()]
      },
    }
    const { base } = await start(
      { meshFile },
      { mux: 'tmux' },
      { tmuxCtl: ctl, localNodeId: 'ct116' },
    )
    const listed = await fetch(`${base}/term/list`)
    expect(listed.status).toBe(200)
    const spawned = await post(base, '/term', { command: 'claude', session: 'chat-badmesh' })
    expect(spawned.status).toBe(201)
    const body = (await spawned.json()) as { attach?: { host: string; sshUser: string } }
    expect(body.attach?.host).toBe(hostname())
    expect(body.attach?.sshUser).toBe('rivet')
  })

  it("DELETE /term?id=<A's denSession> is 403 for another user; unknown id is 404 and does not kill", async () => {
    // Loopback HTTP always resolves as the node owner, so this suite cannot
    // present a routed device cert. Equivalent fence: tenancy on, session
    // owned by alice, loopback owner DELETE by bare denSession → 403, and
    // kill() is never reached (ctl.kills stays empty).
    const stateDir = mkdtempSync(join(tmpdir(), 'den-term-http-tenancy-'))
    dirs.push(stateDir)
    writeFileSync(
      join(stateDir, 'session-owners.json'),
      JSON.stringify({ 'chat-a': 'alice' }) + '\n',
    )
    const usersRegistry = parseUsersRegistry(
      JSON.stringify({
        ownerUserId: 'phil',
        unmappedIsOwner: false,
        users: {
          phil: { devices: [], pgUrl: 'postgres://phil@db/phil' },
          alice: { devices: ['win-alice'], pgUrl: 'postgres://alice@db/alice' },
        },
      }),
    )
    expect(usersRegistry).toBeDefined()
    const ctl: TmuxCtl & { sessions: Map<string, TmuxSessionInfo>; kills: string[] } = {
      sessions: new Map(),
      kills: [],
      hasSession(name) {
        return this.sessions.has(name)
      },
      killSession(name) {
        this.kills.push(name)
        this.sessions.delete(name)
      },
      listSessions() {
        return [...this.sessions.values()]
      },
    }
    const name = encodeTmuxName('chat-a')
    ctl.sessions.set(name, {
      name,
      activity: 1_800_000_000,
      created: 1_799_999_000,
      pid: 4321,
      command: 'claude',
      user: 'alice',
    })
    const { base } = await start({ stateDir, usersRegistry }, { mux: 'tmux' }, { tmuxCtl: ctl })

    const forbidden = await fetch(`${base}/term?id=chat-a`, { method: 'DELETE' })
    expect(forbidden.status).toBe(403)
    expect(ctl.kills).toEqual([])

    const missing = await fetch(`${base}/term?id=chat-nope`, { method: 'DELETE' })
    expect(missing.status).toBe(404)
    expect(ctl.kills).toEqual([])
  })
})
