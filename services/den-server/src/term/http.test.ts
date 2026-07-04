// HTTP surface of the terminal core: /term/config, POST /term, /term/list,
// DELETE /term, the DELETE /session PTY linkage, the pty decoration on
// /sessions + WS snapshots, and the startup security gate.

import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { WebSocket } from 'ws'
import { afterEach, describe, expect, it } from 'vitest'
import { createDenServer, type DenServer, type DenServerOptions } from '../server.js'
import type { DenConfig, DenTermConfig } from '../config.js'
import type { PtyProc, PtySpawn, PtySpawnOpts } from './pty.js'

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
    stateDir,
    staticDir: '',
    packsDir: '',
    evictTtlMs: 60_000,
    meshFile: '',
    meshCacheMs: 10_000,
    term: {
      enabled: true,
      configFile: join(stateDir, 'den-term.json'),
      maxPtys: 4,
      scrollbackBytes: 262_144,
      detachedTtlMs: 1_800_000,
      exitLingerMs: 60_000,
      ...term,
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
  const den = createDenServer(config, serverOpts ?? { ptySpawn: fakeSpawn })
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

  it('404s unknown roster keys and 409s at the pty cap', async () => {
    const { base } = await start({}, { maxPtys: 1 })
    expect((await post(base, '/term', { command: 'not-a-key' })).status).toBe(404)
    expect((await post(base, '/term', { command: 'shell' })).status).toBe(201)
    expect((await post(base, '/term', { command: 'shell' })).status).toBe(409)
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
    expect(body.commands.map((c) => c.id).sort()).toEqual(['claude', 'grok', 'hermes', 'shell'])
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
      ws.once('message', (d: Buffer) => resolve(JSON.parse(d.toString()) as Record<string, unknown>))
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

  it('security gate: no token + non-loopback host forces terminals off (503), never a crash', async () => {
    // enabled + token + 0.0.0.0 → allowed
    const withToken = await start({ host: '0.0.0.0', token: 'sekrit' })
    const auth = { authorization: 'Bearer sekrit' }
    expect((await post(withToken.base, '/term', { command: 'shell' }, auth)).status).toBe(201)

    // enabled + NO token + 0.0.0.0 → hard 503 on every term endpoint
    const exposed = await start({ host: '0.0.0.0', token: '' })
    for (const req of [
      post(exposed.base, '/term', {}),
      fetch(`${exposed.base}/term/config`),
      fetch(`${exposed.base}/term/list`),
      fetch(`${exposed.base}/term?id=x`, { method: 'DELETE' }),
    ]) {
      const res = await req
      expect(res.status).toBe(503)
      expect(((await res.json()) as { error: string }).error).toBe(
        'terminal disabled: RIVETOS_DEN_TOKEN required when host is not loopback',
      )
    }
    // the event relay keeps working — the gate only takes terminals down
    expect((await post(exposed.base, '/event', { v: 1, session: 's', type: 'session.end' })).status).toBe(200)

    // enabled + no token + loopback → fine (mesh-internal default posture)
    const loopback = await start({ host: '127.0.0.1', token: '' })
    expect((await post(loopback.base, '/term', { command: 'shell' })).status).toBe(201)

    // term disabled → 503 for actions, config reports enabled:false
    const disabled = await start({}, { enabled: false })
    expect((await post(disabled.base, '/term', {})).status).toBe(503)
    expect(((await (await post(disabled.base, '/term', {})).json()) as { error: string }).error).toBe(
      'terminal disabled',
    )
    expect((await fetch(`${disabled.base}/term/list`)).status).toBe(503)
    const cfg = (await (await fetch(`${disabled.base}/term/config`)).json()) as { enabled: boolean }
    expect(cfg.enabled).toBe(false)
  })

  it('term endpoints sit behind the bearer-auth gate', async () => {
    const { base } = await start({ token: 'sekrit' })
    expect((await fetch(`${base}/term/config`)).status).toBe(401)
    expect((await post(base, '/term', {})).status).toBe(401)
    expect(
      (await fetch(`${base}/term/config`, { headers: { authorization: 'Bearer sekrit' } })).status,
    ).toBe(200)
  })
})
