/**
 * Tenancy route inventory — real TLS, an enrolled routed device vs the owner.
 *
 * The listing filters are only half of isolation; this suite asserts that
 * EVERY session-scoped route enforces ownership for a routed user. It exists
 * because the first cut filtered the lists but left transcript read, inject,
 * PTY kill, room state and the WS attach paths ungated (#565 review). When a
 * new session-scoped route is added, add it here.
 *
 * Certs are generated at runtime with the system openssl (nothing PEM in the
 * repo — secret-scan). Suite skips without openssl or a non-loopback IPv4:
 * loopback always resolves to the node owner, so cert identity can only be
 * exercised by dialing ourselves on the LAN IP.
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { request, type RequestOptions } from 'node:https'
import { connect } from 'node:tls'
import { networkInterfaces, tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import { WebSocket } from 'ws'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  encodeSessionIdSegment,
  parseUsersRegistry,
  type HarnessCapabilities,
  type HarnessDriver,
  type HarnessEvent,
  type HarnessSessionSummary,
  type SessionId,
  type StartSessionOpts,
  type UserTurn,
} from '@rivetos/types'
import { createDenServer, type DenServer } from './server.js'
import { baseTestDenConfig } from './test-config.js'
import type { PtyProc } from './term/pty.js'

const fakeProcs: FakeProc[] = []
class FakeProc extends EventEmitter implements PtyProc {
  writes: string[] = []
  constructor(public readonly pid: number) {
    super()
    fakeProcs.push(this)
  }
  write(data: string | Buffer): void {
    this.writes.push(data.toString())
  }
  resize(): void {}
  kill(): void {}
  onData(cb: (data: string | Buffer) => void): void {
    this.on('data', cb)
  }
  onExit(cb: (code: number | null) => void): void {
    this.on('exit', cb)
  }
}

function haveOpenssl(): boolean {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

function lanIp(): string | null {
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === 'IPv4' && !a.internal) return a.address
    }
  }
  return null
}

interface TenancyPki {
  dir: string
  ca: string
  serverCert: string
  serverKey: string
  /** device:win-coco — enrolled, mapped to user coco */
  cocoCert: string
  cocoKey: string
  /** device:stranger — enrolled (same CA) but in NO user's device list */
  strangerCert: string
  strangerKey: string
}

function makePki(extraIp: string | null): TenancyPki {
  const dir = mkdtempSync(join(tmpdir(), 'rivet-tenancy-e2e-'))
  const o = (args: string[]): void => {
    execFileSync(args[0], args.slice(1), { cwd: dir, stdio: 'ignore' })
  }
  const ssl = (args: string[]): void => o(['openssl', ...args])
  ssl([
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    'ca.key',
    '-out',
    'ca.crt',
    '-days',
    '2',
    '-subj',
    '/O=Rivet Test/CN=Rivet Test CA',
  ])
  const sans = `IP:127.0.0.1${extraIp ? `,IP:${extraIp}` : ''}`
  writeFileSync(join(dir, 'srv.ext'), `subjectAltName=${sans}\nextendedKeyUsage=serverAuth\n`)
  ssl([
    'req',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    'srv.key',
    '-out',
    'srv.csr',
    '-subj',
    '/O=Rivet Test/CN=testnode.mesh',
  ])
  ssl([
    'x509',
    '-req',
    '-in',
    'srv.csr',
    '-CA',
    'ca.crt',
    '-CAkey',
    'ca.key',
    '-CAcreateserial',
    '-days',
    '2',
    '-extfile',
    'srv.ext',
    '-out',
    'srv.crt',
  ])
  writeFileSync(join(dir, 'dev.ext'), 'extendedKeyUsage=clientAuth\n')
  const issueDevice = (file: string, cn: string): void => {
    ssl([
      'req',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      `${file}.key`,
      '-out',
      `${file}.csr`,
      '-subj',
      `/O=Rivet Test/OU=client/CN=${cn}`,
    ])
    ssl([
      'x509',
      '-req',
      '-in',
      `${file}.csr`,
      '-CA',
      'ca.crt',
      '-CAkey',
      'ca.key',
      '-CAcreateserial',
      '-days',
      '2',
      '-extfile',
      'dev.ext',
      '-out',
      `${file}.crt`,
    ])
  }
  issueDevice('coco', 'device:win-coco')
  issueDevice('stranger', 'device:stranger')
  return {
    dir,
    ca: readFileSync(join(dir, 'ca.crt'), 'utf8'),
    serverCert: join(dir, 'srv.crt'),
    serverKey: join(dir, 'srv.key'),
    cocoCert: readFileSync(join(dir, 'coco.crt'), 'utf8'),
    cocoKey: readFileSync(join(dir, 'coco.key'), 'utf8'),
    strangerCert: readFileSync(join(dir, 'stranger.crt'), 'utf8'),
    strangerKey: readFileSync(join(dir, 'stranger.key'), 'utf8'),
  }
}

interface Tls {
  ca: string
  cert?: string
  key?: string
}

function call(
  method: string,
  url: string,
  tls: Tls,
  body?: unknown,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body)
    const opts: RequestOptions = {
      ca: tls.ca,
      cert: tls.cert,
      key: tls.key,
      method,
      headers: payload
        ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }
        : {},
    }
    const req = request(url, opts, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () =>
        resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }),
      )
      res.on('error', reject)
    })
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

/** Raw upgrade attempt: resolves to whatever the server sent back (empty =
 *  destroyed pre-handshake). */
function rawUpgrade(url: string, tls: Tls): Promise<string> {
  return new Promise((resolve) => {
    const u = new URL(url)
    const sock = connect(
      { host: u.hostname, port: Number(u.port), ca: tls.ca, cert: tls.cert, key: tls.key },
      () => {
        sock.write(
          `GET ${u.pathname}${u.search} HTTP/1.1\r\nHost: ${u.host}\r\nConnection: Upgrade\r\n` +
            `Upgrade: websocket\r\nSec-WebSocket-Version: 13\r\n` +
            `Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n`,
        )
      },
    )
    let buf = ''
    sock.on('data', (c: Buffer) => {
      buf += c.toString('utf8')
    })
    sock.on('close', () => resolve(buf))
    sock.on('error', () => resolve(buf))
    setTimeout(() => {
      sock.destroy()
      resolve(buf.length > 0 ? buf : 'TIMEOUT-NO-CLOSE')
    }, 3000)
  })
}

const remoteIp = lanIp()
const PHIL_EV = {
  v: 1,
  session: 'phil-room',
  name: 'phi',
  ts: 100,
  type: 'session.start',
  title: 'phil',
}
const COCO_EV = {
  v: 1,
  session: 'coco-room',
  name: 'coco',
  ts: 101,
  type: 'session.start',
  title: 'coco',
}


/** Minimal control-plane driver: the harness routes surface (#565's untested
 *  sibling) needs a registered driver to exercise its tenancy fence e2e. */
const CP_CAPS: HarnessCapabilities = {
  interrupt: false,
  resume: true,
  approvals: false,
  liveStream: false,
  listSessions: true,
}
class CpFakeDriver implements HarnessDriver {
  readonly harnessId = 'claude-code' as const
  readonly capabilities = CP_CAPS
  readonly sessions = new Map<SessionId, HarnessSessionSummary>()
  add(sessionId: SessionId): HarnessSessionSummary {
    const summary: HarnessSessionSummary = {
      sessionId,
      harnessId: this.harnessId,
      createdAt: '2026-08-29T00:00:00.000Z',
      updatedAt: '2026-08-29T00:00:00.000Z',
      status: 'idle',
    }
    this.sessions.set(sessionId, summary)
    return summary
  }
  startSession(opts: StartSessionOpts = {}): Promise<HarnessSessionSummary> {
    return Promise.resolve(this.add(`${this.harnessId}:${opts.nativeSessionId ?? 'minted'}` as SessionId))
  }
  resumeSession(sessionId: SessionId): Promise<HarnessSessionSummary> {
    return Promise.resolve(this.sessions.get(sessionId) ?? this.add(sessionId))
  }
  interrupt(): Promise<void> {
    return Promise.resolve()
  }
  sendUserTurn(_sessionId: SessionId, _turn: UserTurn): Promise<void> {
    return Promise.resolve()
  }
  resolveApproval(): Promise<void> {
    return Promise.resolve()
  }
  subscribe(_sessionId: SessionId, _sink: (e: HarnessEvent) => void): () => void {
    return () => undefined
  }
  subscribeEvents(_sink: (e: HarnessEvent) => void): () => void {
    return () => undefined
  }
  listSessions(): Promise<HarnessSessionSummary[]> {
    return Promise.resolve([...this.sessions.values()])
  }
  getSession(sessionId: SessionId): Promise<HarnessSessionSummary | null> {
    return Promise.resolve(this.sessions.get(sessionId) ?? null)
  }
}
const cpDriver = new CpFakeDriver()

describe.skipIf(!haveOpenssl() || !remoteIp)('tenancy route inventory (real TLS)', () => {
  let pki: TenancyPki
  let den: DenServer
  let stateDir: string
  let loopback: string // certless loopback = the node owner (phil)
  let remote: string // LAN IP — cert identity is only resolved off-loopback
  let coco: Tls
  let stranger: Tls
  let philPtyId: string
  let philPtyId2: string

  beforeAll(async () => {
    pki = makePki(remoteIp)
    stateDir = mkdtempSync(join(tmpdir(), 'rivet-tenancy-state-'))
    const config = baseTestDenConfig(stateDir, {
      host: '0.0.0.0',
      tls: {
        certPath: pki.serverCert,
        keyPath: pki.serverKey,
        caPath: join(pki.dir, 'ca.crt'),
        requireClientCert: true,
      },
      term: {
        enabled: true,
        open: true,
        configFile: join(stateDir, 'den-term.json'),
        maxPtys: 8,
        scrollbackBytes: 262_144,
        detachedTtlMs: 1_800_000,
        idleTtlMs: 1_800_000,
        exitLingerMs: 60_000,
        injectReadyMs: 10,
      },
    })
    config.usersRegistry = parseUsersRegistry(
      JSON.stringify({
        ownerUserId: 'phil',
        unmappedIsOwner: false,
        users: {
          phil: { devices: [], pgUrl: 'postgres://phil@db/phil_memory' },
          coco: { devices: ['win-coco'], pgUrl: 'postgres://coco@db/coco_memory' },
        },
      }),
    )
    let pid = 9000
    den = createDenServer(config, {
      ptySpawn: () => new FakeProc(++pid),
      // real builtins would collide with the fake claude-code driver (and
      // scan real on-disk stores) — this suite exercises the ROUTE fence
      skipBuiltinHarnessDrivers: true,
      harnessDrivers: [cpDriver],
    })
    await new Promise<void>((resolve) => den.server.listen(0, '0.0.0.0', resolve))
    const addr = den.server.address()
    if (addr === null || typeof addr === 'string') throw new Error('no address')
    loopback = `https://127.0.0.1:${String(addr.port)}`
    remote = `https://${remoteIp ?? ''}:${String(addr.port)}`
    coco = { ca: pki.ca, cert: pki.cocoCert, key: pki.cocoKey }
    stranger = { ca: pki.ca, cert: pki.strangerCert, key: pki.strangerKey }

    // Seed: the owner (loopback) opens phil-room with a live PTY; coco opens
    // coco-room with hers. Ownership is tagged at spawn by the bound ctx.
    await call('POST', `${loopback}/event`, { ca: pki.ca }, PHIL_EV)
    await call('POST', `${loopback}/event`, { ca: pki.ca }, COCO_EV)
    const spawn1 = await call(
      'POST',
      `${loopback}/term`,
      { ca: pki.ca },
      { command: 'shell', session: 'phil-room' },
    )
    expect(spawn1.status).toBe(201)
    philPtyId = (JSON.parse(spawn1.body) as { id: string }).id
    const spawn2 = await call(
      'POST',
      `${loopback}/term`,
      { ca: pki.ca },
      { command: 'shell', session: 'phil-room-2' },
    )
    expect(spawn2.status).toBe(201)
    philPtyId2 = (JSON.parse(spawn2.body) as { id: string }).id
    const spawn3 = await call('POST', `${remote}/term`, coco, {
      command: 'shell',
      session: 'coco-room',
    })
    expect(spawn3.status).toBe(201)
    // inject ready-gate: phil's harness must emit before injects flush
    fakeProcs[0].emit('data', Buffer.from('welcome'))
    await new Promise((r) => setTimeout(r, 30))
  })

  afterAll(async () => {
    await den.close()
    rmSync(pki.dir, { recursive: true, force: true })
    rmSync(stateDir, { recursive: true, force: true })
  })

  it('fails closed: an enrolled device in NO user list gets 403 everywhere', async () => {
    const res = await call('GET', `${remote}/sessions`, stranger)
    expect(res.status).toBe(403)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'unroutable identity' })
  })

  it("GET /sessions hides the other user's sessions", async () => {
    const res = await call('GET', `${remote}/sessions`, coco)
    expect(res.status).toBe(200)
    const ids = (JSON.parse(res.body) as { sessions: { id: string }[] }).sessions.map((s) => s.id)
    expect(ids).toContain('coco-room')
    expect(ids).not.toContain('phil-room')
  })

  it("GET /state refuses another user's room", async () => {
    expect((await call('GET', `${remote}/state?session=phil-room`, coco)).status).toBe(403)
    expect((await call('GET', `${remote}/state?session=coco-room`, coco)).status).toBe(200)
    expect((await call('GET', `${loopback}/state?session=phil-room`, { ca: pki.ca })).status).toBe(
      200,
    )
  })

  it("GET transcript refuses another user's session by id", async () => {
    expect(
      (await call('GET', `${remote}/term/harness-sessions/phil-room/transcript`, coco)).status,
    ).toBe(403)
    // the owner is never 403 on his own (unknown store → whatever the reader
    // answers, just not refused)
    expect(
      (await call('GET', `${loopback}/term/harness-sessions/phil-room/transcript`, { ca: pki.ca }))
        .status,
    ).not.toBe(403)
  })

  it("POST /term/inject refuses to write into another user's live harness", async () => {
    expect(
      (await call('POST', `${remote}/term/inject`, coco, { session: 'phil-room', text: 'pwned' }))
        .status,
    ).toBe(403)
    // and nothing was written
    expect(fakeProcs[0].writes.join('')).not.toContain('pwned')
    // the owner CAN inject into his own
    expect(
      (
        await call(
          'POST',
          `${loopback}/term/inject`,
          { ca: pki.ca },
          { session: 'phil-room', text: 'ok' },
        )
      ).status,
    ).toBe(202)
  })

  it("DELETE /term refuses to kill another user's PTY", async () => {
    expect((await call('DELETE', `${remote}/term?id=${philPtyId}`, coco)).status).toBe(403)
    // still alive: the owner sees it, then kills his SECOND pty fine
    const list = await call('GET', `${loopback}/term/list`, { ca: pki.ca })
    expect(list.body).toContain(philPtyId)
    expect((await call('DELETE', `${loopback}/term?id=${philPtyId2}`, { ca: pki.ca })).status).toBe(
      200,
    )
  })

  it('GET /term/list shows a routed user only their own PTYs', async () => {
    const res = await call('GET', `${remote}/term/list`, coco)
    expect(res.status).toBe(200)
    expect(res.body).toContain('coco-room')
    expect(res.body).not.toContain('phil-room')
  })

  it("POST /term refuses to claim or resume another user's session", async () => {
    expect(
      (await call('POST', `${remote}/term`, coco, { command: 'shell', session: 'phil-room' }))
        .status,
    ).toBe(403)
    expect(
      (await call('POST', `${remote}/term`, coco, { command: 'shell', resume: 'phil-room' }))
        .status,
    ).toBe(403)
    // but an untagged key is a new room she may claim
    expect(
      (await call('POST', `${remote}/term`, coco, { command: 'shell', session: 'coco-new' }))
        .status,
    ).toBe(201)
  })

  it("DELETE /session refuses another user's room", async () => {
    expect((await call('DELETE', `${remote}/session?session=phil-room`, coco)).status).toBe(403)
    // room survives
    expect((await call('GET', `${loopback}/state?session=phil-room`, { ca: pki.ca })).status).toBe(
      200,
    )
  })

  it("WS /ws attach to another user's session closes 4403", async () => {
    const ws = new WebSocket(
      `wss://${remoteIp ?? ''}:${new URL(remote).port}/ws?session=phil-room`,
      {
        ca: pki.ca,
        cert: pki.cocoCert,
        key: pki.cocoKey,
      },
    )
    const code = await new Promise<number>((resolve) => {
      ws.on('close', (c) => resolve(c))
      ws.on('error', () => resolve(-1))
    })
    expect(code).toBe(4403)
  })

  it("WS /ws snapshot contains only the viewer's own rooms", async () => {
    const ws = new WebSocket(`wss://${remoteIp ?? ''}:${new URL(remote).port}/ws`, {
      ca: pki.ca,
      cert: pki.cocoCert,
      key: pki.cocoKey,
    })
    const snapshot = await new Promise<Record<string, unknown>>((resolve, reject) => {
      ws.on('message', (d: Buffer) => resolve(JSON.parse(d.toString()) as Record<string, unknown>))
      ws.on('error', reject)
    })
    ws.close()
    expect(snapshot.type).toBe('snapshot')
    const rooms = Object.keys(snapshot.rooms as Record<string, unknown>)
    expect(rooms).toContain('coco-room')
    expect(rooms).not.toContain('phil-room')
    const ids = (snapshot.sessions as { id: string }[]).map((s) => s.id)
    expect(ids).not.toContain('phil-room')
  })

  it("WS /term attach to another user's PTY is destroyed pre-handshake", async () => {
    const outcome = await rawUpgrade(`${remote}/term?id=${philPtyId}`, coco)
    expect(outcome).not.toContain('101')
    expect(outcome).not.toBe('TIMEOUT-NO-CLOSE')
  })


  it('control plane: listing hides sessions owned by the other user', async () => {
    const philStart = await call('POST', `${loopback}/api/harnesses/claude-code/sessions`, {
      ca: pki.ca,
    }, { nativeSessionId: 'list-phil' })
    expect(philStart.status).toBe(201)
    const cocoStart = await call('POST', `${remote}/api/harnesses/claude-code/sessions`, coco, {
      nativeSessionId: 'list-coco',
    })
    expect(cocoStart.status).toBe(201)
    cpDriver.add('claude-code:list-legacy' as SessionId)

    const cocoList = await call('GET', `${remote}/api/harnesses/claude-code/sessions`, coco)
    const cocoIds = (JSON.parse(cocoList.body) as { sessions: { sessionId: string }[] }).sessions
      .map((x) => x.sessionId)
    expect(cocoIds).toContain('claude-code:list-coco')
    expect(cocoIds).not.toContain('claude-code:list-phil')
    // unowned rows are invisible to a routed user…
    expect(cocoIds).not.toContain('claude-code:list-legacy')

    const philList = await call('GET', `${loopback}/api/harnesses/claude-code/sessions`, {
      ca: pki.ca,
    })
    const philIds = (JSON.parse(philList.body) as { sessions: { sessionId: string }[] }).sessions
      .map((x) => x.sessionId)
    expect(philIds).toContain('claude-code:list-phil')
    expect(philIds).not.toContain('claude-code:list-coco')
    // …and fall to the node owner
    expect(philIds).toContain('claude-code:list-legacy')
  })

  it("control plane: get/transcript/turns/interrupt refuse another user's session", async () => {
    const start = await call('POST', `${loopback}/api/harnesses/claude-code/sessions`, {
      ca: pki.ca,
    }, { nativeSessionId: 'fence-phil' })
    expect(start.status).toBe(201)
    const philEnc = encodeSessionIdSegment('claude-code:fence-phil')
    expect((await call('GET', `${remote}/api/harness-sessions/${philEnc}`, coco)).status).toBe(403)
    expect(
      (await call('GET', `${remote}/api/harness-sessions/${philEnc}/transcript`, coco)).status,
    ).toBe(403)
    expect(
      (await call('POST', `${remote}/api/harness-sessions/${philEnc}/turns`, coco, {
        text: 'hi',
      })).status,
    ).toBe(403)
    expect(
      (await call('POST', `${remote}/api/harness-sessions/${philEnc}/interrupt`, coco)).status,
    ).toBe(403)
  })

  it('control plane: starting over an existing foreign native id is refused', async () => {
    const first = await call('POST', `${loopback}/api/harnesses/claude-code/sessions`, {
      ca: pki.ca,
    }, { nativeSessionId: 'start-steal' })
    expect(first.status).toBe(201)
    // the fake driver get-or-creates on native id: without the claim check
    // this 201'd the owner's summary to coco
    const steal = await call('POST', `${remote}/api/harnesses/claude-code/sessions`, coco, {
      nativeSessionId: 'start-steal',
    })
    expect(steal.status).toBe(403)
  })

  it('control plane: resume claims an unowned session for the resumer, then fences it', async () => {
    cpDriver.add('claude-code:claim-legacy' as SessionId)
    const legacyEnc = encodeSessionIdSegment('claude-code:claim-legacy')
    // coco resumes the pre-fence legacy row — allowed, and claims it
    expect(
      (await call('POST', `${remote}/api/harness-sessions/${legacyEnc}/resume`, coco)).status,
    ).toBe(200)
    // now even the node owner is fenced off it
    expect(
      (await call('GET', `${loopback}/api/harness-sessions/${legacyEnc}/transcript`, {
        ca: pki.ca,
      })).status,
    ).toBe(403)
    // and a foreign resume is refused rather than re-claimed
    expect(
      (await call('POST', `${loopback}/api/harness-sessions/${legacyEnc}/resume`, {
        ca: pki.ca,
      })).status,
    ).toBe(403)
  })

  it('WS /term attach to her own PTY completes', async () => {
    const outcome = await rawUpgrade(`${remote}/term?session=coco-room`, coco)
    expect(outcome).toContain('101')
  })
})
