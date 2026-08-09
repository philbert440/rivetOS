// Harness control-plane gateway surface, end to end over a real den server
// with a fake HarnessDriver — no `claude` binary, no ~/.claude, no PTY.
//
// Covers the pieces the design doc calls out explicitly: enc() round-trip for
// native ids containing `:` and `/`, legacy bare-uuid + path-fallback aliasing,
// capability-false → 501, and the HarnessError → HTTP status table.

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { WebSocket } from 'ws'
import { afterEach, describe, expect, it } from 'vitest'
import {
  HarnessError,
  encodeSessionIdSegment,
  type HarnessCapabilities,
  type HarnessDriver,
  type HarnessEvent,
  type HarnessSessionSummary,
  type SessionId,
  type StartSessionOpts,
  type UserTurn,
} from '@rivetos/types'
import { createDenServer, type DenServer } from '../server.js'
import type { DenConfig } from '../config.js'
import { FakeRotatingDriver } from './test/fake-rotating-driver.js'

const UUID = 'a1b2c3d4-1111-4222-8333-444455556666'
const SID = `claude-code:${UUID}` as SessionId
const enc = (id: string): string => encodeSessionIdSegment(id)

const FULL_CAPS: HarnessCapabilities = {
  interrupt: true,
  resume: true,
  approvals: false,
  liveStream: true,
  listSessions: true,
}

interface FakeCalls {
  started: StartSessionOpts[]
  resumed: SessionId[]
  turns: { sessionId: SessionId; turn: UserTurn }[]
  interrupted: SessionId[]
}

class FakeDriver implements HarnessDriver {
  readonly harnessId = 'claude-code' as const
  readonly calls: FakeCalls = { started: [], resumed: [], turns: [], interrupted: [] }
  readonly sessions = new Map<SessionId, HarnessSessionSummary>()
  private readonly sinks = new Set<(e: HarnessEvent) => void>()
  private readonly registrySinks = new Set<(e: HarnessEvent) => void>()
  /** Thrown by the next mutating call, if set. */
  next?: HarnessError

  constructor(readonly capabilities: HarnessCapabilities = FULL_CAPS) {}

  add(sessionId: SessionId, extra: Partial<HarnessSessionSummary> = {}): HarnessSessionSummary {
    const summary: HarnessSessionSummary = {
      sessionId,
      harnessId: 'claude-code',
      createdAt: '2026-08-08T00:00:00.000Z',
      updatedAt: '2026-08-08T00:00:00.000Z',
      status: 'idle',
      ...extra,
    }
    this.sessions.set(sessionId, summary)
    return summary
  }

  private throwIfArmed(): void {
    const err = this.next
    if (err) {
      this.next = undefined
      throw err
    }
  }

  startSession(opts: StartSessionOpts = {}): Promise<HarnessSessionSummary> {
    this.calls.started.push(opts)
    this.throwIfArmed()
    return Promise.resolve(this.add(`claude-code:${opts.nativeSessionId ?? 'minted'}` as SessionId))
  }
  resumeSession(sessionId: SessionId): Promise<HarnessSessionSummary> {
    this.calls.resumed.push(sessionId)
    this.throwIfArmed()
    return Promise.resolve(this.sessions.get(sessionId) ?? this.add(sessionId))
  }
  interrupt(sessionId: SessionId): Promise<void> {
    this.calls.interrupted.push(sessionId)
    this.throwIfArmed()
    return Promise.resolve()
  }
  sendUserTurn(sessionId: SessionId, turn: UserTurn): Promise<void> {
    this.calls.turns.push({ sessionId, turn })
    this.throwIfArmed()
    return Promise.resolve()
  }
  resolveApproval(): Promise<void> {
    return Promise.reject(new HarnessError('unknown_approval', 'no such approval'))
  }
  subscribe(_sessionId: SessionId, sink: (e: HarnessEvent) => void): () => void {
    this.sinks.add(sink)
    return () => this.sinks.delete(sink)
  }
  subscribeEvents(sink: (e: HarnessEvent) => void): () => void {
    this.registrySinks.add(sink)
    return () => this.registrySinks.delete(sink)
  }
  listSessions(): Promise<HarnessSessionSummary[]> {
    return Promise.resolve([...this.sessions.values()])
  }
  getSession(sessionId: SessionId): Promise<HarnessSessionSummary | null> {
    return Promise.resolve(this.sessions.get(sessionId) ?? null)
  }
  transcript(sessionId: SessionId): Promise<{ turns: { role: 'user'; text: string }[] }> {
    return Promise.resolve({ turns: [{ role: 'user', text: `transcript of ${sessionId}` }] })
  }
  emitSession(e: HarnessEvent): void {
    for (const sink of this.sinks) sink(e)
  }
  emitRegistry(e: HarnessEvent): void {
    for (const sink of this.registrySinks) sink(e)
  }
}

const servers: DenServer[] = []
const dirs: string[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()))
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }))
})

function denConfig(stateDir: string): DenConfig {
  return {
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
      enabled: false,
      open: false,
      configFile: join(stateDir, 'den-term.json'),
      maxPtys: 4,
      scrollbackBytes: 262_144,
      detachedTtlMs: 1_800_000,
      idleTtlMs: 1_800_000,
      exitLingerMs: 60_000,
      injectReadyMs: 10,
    },
    audio: {
      enabled: false,
      open: false,
      dir: '',
      deviceName: 'RivetHub Mic',
      sampleRate: 16_000,
    },
  }
}

async function start(driver: HarnessDriver): Promise<{ base: string; den: DenServer }> {
  const stateDir = mkdtempSync(join(tmpdir(), 'den-harness-'))
  dirs.push(stateDir)
  const den = createDenServer(denConfig(stateDir), {
    ptySpawn: null,
    // The real claude-code driver would scan the developer's ~/.claude here.
    skipClaudeHarnessDriver: true,
    harnessDrivers: [driver],
  })
  servers.push(den)
  await new Promise<void>((r) => den.server.listen(0, '127.0.0.1', r))
  const port = (den.server.address() as AddressInfo).port
  return { base: `http://127.0.0.1:${String(port)}`, den }
}

const post = (base: string, path: string, body?: unknown): Promise<Response> =>
  fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  })

describe('GET /api/harnesses', () => {
  it('lists registered drivers with their capability flags', async () => {
    const { base } = await start(new FakeDriver())
    const res = await fetch(`${base}/api/harnesses`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      harnesses: [{ harnessId: 'claude-code', capabilities: FULL_CAPS }],
    })
  })

  it('404s an unregistered (but valid) harness id and an unknown token alike', async () => {
    const { base } = await start(new FakeDriver())
    expect((await fetch(`${base}/api/harnesses/grok-build`)).status).toBe(404)
    expect((await fetch(`${base}/api/harnesses/codex`)).status).toBe(404)
  })

  it('serves one driver capability sheet and its session list', async () => {
    const driver = new FakeDriver()
    driver.add(SID, { title: 'a session' })
    const { base } = await start(driver)
    expect(await (await fetch(`${base}/api/harnesses/claude-code`)).json()).toEqual({
      harnessId: 'claude-code',
      capabilities: FULL_CAPS,
    })
    const list = (await (await fetch(`${base}/api/harnesses/claude-code/sessions`)).json()) as {
      sessions: HarnessSessionSummary[]
    }
    expect(list.sessions.map((s) => s.sessionId)).toEqual([SID])
  })
})

describe('POST /api/harnesses/:id/sessions', () => {
  it('starts a session and echoes the summary', async () => {
    const driver = new FakeDriver()
    const { base } = await start(driver)
    const res = await post(base, '/api/harnesses/claude-code/sessions', {
      nativeSessionId: UUID,
    })
    expect(res.status).toBe(201)
    expect((await res.json()) as HarnessSessionSummary).toMatchObject({ sessionId: SID })
    expect(driver.calls.started).toEqual([{ nativeSessionId: UUID }])
  })

  it('validates the body before touching the driver', async () => {
    const driver = new FakeDriver()
    const { base } = await start(driver)
    expect((await post(base, '/api/harnesses/claude-code/sessions', { cwd: 7 })).status).toBe(400)
    expect(driver.calls.started).toEqual([])
  })

  it('409s a pinned id that already lives in an alias chain', async () => {
    const driver = new FakeDriver()
    const { base, den } = await start(driver)
    den.harnesses.alias(SID, 'claude-code:rotated' as SessionId)
    const res = await post(base, '/api/harnesses/claude-code/sessions', { nativeSessionId: UUID })
    expect(res.status).toBe(409)
    expect(((await res.json()) as { code: string }).code).toBe('session_id_collision')
    expect(driver.calls.started).toEqual([])
  })
})

describe(':sessionId params use enc()', () => {
  it('round-trips a native id containing both ":" and "/"', async () => {
    const gnarly = 'claude-code:-home-rivet-repo/a1b2:c3d4' as SessionId
    const driver = new FakeDriver()
    driver.add(gnarly)
    const { base } = await start(driver)
    const res = await fetch(`${base}/api/harness-sessions/${enc(gnarly)}`)
    expect(res.status).toBe(200)
    expect(((await res.json()) as HarnessSessionSummary).sessionId).toBe(gnarly)
  })

  it('rejects a segment that is not enc() with 400 invalid_session_id', async () => {
    const { base } = await start(new FakeDriver())
    const res = await fetch(`${base}/api/harness-sessions/not%20base64url`)
    expect(res.status).toBe(400)
    expect(((await res.json()) as { code: string }).code).toBe('invalid_session_id')
  })

  it('rejects a task key — it is a parallel namespace, not a SessionId', async () => {
    const { base } = await start(new FakeDriver())
    const segment = Buffer.from('task:abc123', 'utf8').toString('base64url')
    const res = await fetch(`${base}/api/harness-sessions/${segment}`)
    expect(res.status).toBe(400)
  })

  it('404s a well-formed id no driver knows', async () => {
    const { base } = await start(new FakeDriver())
    expect((await fetch(`${base}/api/harness-sessions/${enc(SID)}`)).status).toBe(404)
  })
})

describe('legacy key aliasing (alias, never dual-write)', () => {
  it('accepts a bare native uuid and answers with the canonical id', async () => {
    const driver = new FakeDriver()
    driver.add(SID)
    const { base } = await start(driver)
    const res = await fetch(`${base}/api/harness-sessions/${UUID}`)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ sessionId: SID, redirectedTo: SID })
  })

  it('collapses the capture path fallback onto the uuid form', async () => {
    const driver = new FakeDriver()
    driver.add(SID)
    const { base } = await start(driver)
    const legacy = `claude-code:-home-rivet-repo/${UUID}`
    const res = await fetch(`${base}/api/harness-sessions/${enc(legacy)}`)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ sessionId: SID, redirectedTo: SID })
  })

  it('follows a rotation alias recorded from the driver registry stream', async () => {
    const driver = new FakeDriver()
    const rotated = 'claude-code:rotated-0001' as SessionId
    driver.add(rotated)
    const { base } = await start(driver)
    driver.emitRegistry({
      type: 'session-updated',
      sessionId: rotated,
      previousSessionId: SID,
      status: 'active',
    })
    const res = await fetch(`${base}/api/harness-sessions/${enc(SID)}`)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ sessionId: rotated, redirectedTo: rotated })
  })
})

describe('session-scoped actions', () => {
  it('resumes, sends turns, and interrupts through the driver', async () => {
    const driver = new FakeDriver()
    driver.add(SID)
    const { base } = await start(driver)
    expect((await post(base, `/api/harness-sessions/${enc(SID)}/resume`)).status).toBe(200)
    expect((await post(base, `/api/harness-sessions/${enc(SID)}/turns`, { text: 'hi' })).status).toBe(
      202,
    )
    expect((await post(base, `/api/harness-sessions/${enc(SID)}/interrupt`)).status).toBe(202)
    expect(driver.calls.resumed).toEqual([SID])
    expect(driver.calls.turns).toEqual([{ sessionId: SID, turn: { text: 'hi' } }])
    expect(driver.calls.interrupted).toEqual([SID])
  })

  it('requires a non-empty turn text', async () => {
    const driver = new FakeDriver()
    driver.add(SID)
    const { base } = await start(driver)
    expect((await post(base, `/api/harness-sessions/${enc(SID)}/turns`, { text: '' })).status).toBe(
      400,
    )
  })

  it('serves the transcript hard-resync source', async () => {
    const driver = new FakeDriver()
    driver.add(SID)
    const { base } = await start(driver)
    const res = await fetch(`${base}/api/harness-sessions/${enc(SID)}/transcript`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      sessionId: SID,
      harnessId: 'claude-code',
      turns: [{ role: 'user', text: `transcript of ${SID}` }],
    })
  })

  it('405s the wrong method instead of falling through', async () => {
    const driver = new FakeDriver()
    driver.add(SID)
    const { base } = await start(driver)
    expect((await fetch(`${base}/api/harness-sessions/${enc(SID)}/turns`)).status).toBe(405)
  })
})

describe('capability flags gate the surface (501, non-fatal)', () => {
  const noCaps: HarnessCapabilities = {
    interrupt: false,
    resume: false,
    approvals: false,
    liveStream: false,
    listSessions: false,
  }

  it('501s resume / interrupt / approvals / listSessions when the flag is false', async () => {
    const driver = new FakeDriver(noCaps)
    driver.add(SID)
    const { base } = await start(driver)
    for (const [method, path] of [
      ['GET', '/api/harnesses/claude-code/sessions'],
      ['POST', `/api/harness-sessions/${enc(SID)}/resume`],
      ['POST', `/api/harness-sessions/${enc(SID)}/interrupt`],
      ['POST', `/api/harness-sessions/${enc(SID)}/approvals/req-1`],
    ] as const) {
      const res =
        method === 'GET' ? await fetch(`${base}${path}`) : await post(base, path, { decision: 'allow' })
      expect(`${method} ${path} → ${String(res.status)}`).toBe(`${method} ${path} → 501`)
      expect(((await res.json()) as { code: string }).code).toBe('capability_unsupported')
    }
    // never dispatched to the driver
    expect(driver.calls.resumed).toEqual([])
    expect(driver.calls.interrupted).toEqual([])
  })

  it('closes the session WS with a typed error when liveStream is false', async () => {
    const driver = new FakeDriver({ ...FULL_CAPS, liveStream: false })
    driver.add(SID)
    // The driver still has to reject; the route only gates HTTP verbs.
    driver.subscribe = (): never => {
      throw new HarnessError('capability_unsupported', 'no live stream')
    }
    const { base } = await start(driver)
    const ws = new WebSocket(`${base.replace('http', 'ws')}/api/harness-sessions/ws?session=${enc(SID)}`)
    const frame = await new Promise<string>((resolve, reject) => {
      ws.on('message', (d) => resolve(String(d)))
      ws.on('error', reject)
    })
    expect(JSON.parse(frame)).toMatchObject({ code: 'capability_unsupported' })
    ws.close()
  })
})

describe('HarnessError → HTTP status mapping', () => {
  it.each([
    ['invalid_session_id', 400],
    ['session_id_collision', 409],
    ['capability_unsupported', 501],
    ['unknown_approval', 404],
    ['turn_in_flight', 409],
  ] as const)('%s → %i', async (code, status) => {
    const driver = new FakeDriver()
    driver.add(SID)
    const { base } = await start(driver)
    driver.next = new HarnessError(code, `boom: ${code}`)
    const res = await post(base, `/api/harness-sessions/${enc(SID)}/turns`, { text: 'x' })
    expect(res.status).toBe(status)
    expect(await res.json()).toMatchObject({ code, error: `boom: ${code}` })
  })

  it('500s a non-contract driver failure', async () => {
    const driver = new FakeDriver()
    driver.add(SID)
    const { base } = await start(driver)
    driver.next = new Error('disk on fire') as HarnessError
    const res = await post(base, `/api/harness-sessions/${enc(SID)}/turns`, { text: 'x' })
    expect(res.status).toBe(500)
  })
})

describe('WS streams', () => {
  it('fans the driver registry stream to /api/harnesses/ws', async () => {
    const driver = new FakeDriver()
    const { base } = await start(driver)
    const ws = new WebSocket(`${base.replace('http', 'ws')}/api/harnesses/ws`)
    await new Promise<void>((r) => ws.on('open', () => r()))
    const got = new Promise<string>((resolve) => ws.on('message', (d) => resolve(String(d))))
    const summary = driver.add(SID)
    driver.emitRegistry({ type: 'session-created', sessionId: SID, summary })
    expect(JSON.parse(await got)).toMatchObject({ type: 'session-created', sessionId: SID })
    ws.close()
  })

  it('streams one session on /api/harness-sessions/ws?session=<enc>', async () => {
    const driver = new FakeDriver()
    driver.add(SID)
    const { base } = await start(driver)
    const ws = new WebSocket(
      `${base.replace('http', 'ws')}/api/harness-sessions/ws?session=${enc(SID)}`,
    )
    await new Promise<void>((r) => ws.on('open', () => r()))
    const got = new Promise<string>((resolve) => ws.on('message', (d) => resolve(String(d))))
    // Give the async resolve() inside the upgrade a tick to attach.
    await new Promise((r) => setTimeout(r, 20))
    driver.emitSession({ type: 'assistant-delta', sessionId: SID, text: 'hello' })
    expect(JSON.parse(await got)).toEqual({
      type: 'assistant-delta',
      sessionId: SID,
      text: 'hello',
    })
    ws.close()
  })

  it('keeps a session socket across a rotation, with no re-subscribe', async () => {
    // The whole client-visible contract for rotation, over the real wire: one
    // subscribe under the old id, then the rotation and everything after it
    // arrive on that same socket.
    const driver = new FakeRotatingDriver({ rotationDelivery: 'registry-first' })
    const before = driver.seed()
    const { base } = await start(driver)
    const ws = new WebSocket(
      `${base.replace('http', 'ws')}/api/harness-sessions/ws?session=${enc(before)}`,
    )
    await new Promise<void>((r) => ws.on('open', () => r()))
    const frames: HarnessEvent[] = []
    ws.on('message', (d) => frames.push(JSON.parse(String(d)) as HarnessEvent))
    await new Promise((r) => setTimeout(r, 20))

    const after = driver.rotate(before)
    driver.activity(after, 'post-rotation')
    await new Promise((r) => setTimeout(r, 20))

    expect(frames).toEqual([
      { type: 'session-updated', sessionId: after, previousSessionId: before, status: 'active' },
      { type: 'assistant-delta', sessionId: after, text: 'post-rotation' },
    ])
    // The old id is gone from the listing, and still redirects on a read.
    const list = (await (await fetch(`${base}/api/harnesses/hermes/sessions`)).json()) as {
      sessions: HarnessSessionSummary[]
    }
    expect(list.sessions.map((s) => s.sessionId)).toEqual([after])
    expect(await (await fetch(`${base}/api/harness-sessions/${enc(before)}`)).json()).toMatchObject(
      { sessionId: after, redirectedTo: after },
    )
    ws.close()
  })

  it('426s a plain GET on a WS path', async () => {
    const { base } = await start(new FakeDriver())
    expect((await fetch(`${base}/api/harnesses/ws`)).status).toBe(426)
  })
})

describe('legacy /term/harness-sessions is untouched', () => {
  it('still answers alongside the new surface (Phase 5 prunes it, not Phase 2)', async () => {
    const { base } = await start(new FakeDriver())
    // terminals are disabled in this config, so den answers 503 — the point is
    // that the route still belongs to den and was not shadowed or removed.
    const res = await fetch(`${base}/term/harness-sessions`)
    expect([200, 503]).toContain(res.status)
    expect((await fetch(`${base}/api/harnesses`)).status).toBe(200)
  })
})
