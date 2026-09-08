// The `codex` driver over fakes for the two things it wraps: the den term
// manager (PTY spawn/inject/Esc) and the Codex on-disk store. No `codex`
// binary and no ~/.codex required.
//
// Mirrors kimi-driver.test.ts: Codex cannot pin a new session id, natives
// are a BARE uuid (no `session_` prefix), and the live stream carries no
// assistant text (Codex has no den hooks).

import { describe, expect, it, vi } from 'vitest'
import { HarnessError, type HarnessEvent, type SessionId } from '@rivetos/types'
import type { HarnessSession } from '../term/harness-sessions.js'
import { CodexDriver, type CodexPtyHost, type CodexStoreHost } from './codex-driver.js'
import type { DenAgentEventLike } from './pty-harness-driver.js'
import { createHarnessRegistry, type HarnessRegistry } from './registry.js'
import { FIVE_FLAGS, pick, runHarnessRotationConformance } from './test/driver-conformance.js'

/** Real Codex ids: a bare rollout UUID. */
const NAT = '89965427-b96f-4d5e-8ad5-c3dd138e33dc'
const NAT2 = '42accb06-524a-47a6-b4b3-0991552914d7'
const NAT3 = '15cb936c-3364-49d6-8769-21f0c635f160'
const SID = `codex:${NAT}` as SessionId
const ROOM = 'den-pty-1a2b3c4d'

interface Fakes {
  driver: CodexDriver
  pty: ReturnType<typeof fakePty>
  store: ReturnType<typeof fakeStore>
  emitDen: (ev: DenAgentEventLike) => void
}

function fakeStore(rows: HarnessSession[] = []) {
  const byId = new Map(rows.map((r) => [r.id, r]))
  const sessions = new Set(rows.map((r) => r.id))
  return {
    byId,
    sessions,
    transcripts: new Map<string, { turns: { role: 'user' | 'assistant'; text: string }[] }>(),
    host(): CodexStoreHost {
      return {
        list: () => Promise.resolve([...byId.values()]),
        describe: (id) => Promise.resolve(byId.get(id)),
        exists: (id) => sessions.has(id),
        transcript: (id) => Promise.resolve(this.transcripts.get(id) ?? { turns: [] }),
      }
    },
  }
}

function fakePty() {
  const spawns: { key?: string; session?: string; resume?: string }[] = []
  const injects: { id: string; text: string; submit: boolean; interrupt?: boolean }[] = []
  const live = new Map<string, string>()
  let writable = true
  const dead = new Set<string>()
  const host: CodexPtyHost = {
    spawn: (key, _cols, _rows, _remote, session, resume) => {
      spawns.push({ key, session, resume })
      const id = `pty-${String(spawns.length)}`
      if (session) live.set(session, id)
      return { id, denSession: session ?? id }
    },
    ptyForSession: (denSession) => live.get(denSession),
    inject: (id, text, submit, interrupt) => {
      injects.push({ id, text, submit, interrupt })
      return writable && !dead.has(id)
    },
  }
  return {
    host,
    spawns,
    injects,
    live,
    dead,
    setWritable: (v: boolean): void => {
      writable = v
    },
  }
}

function makeDriver(
  opts: {
    rows?: HarnessSession[]
    withPty?: boolean
    withEvents?: boolean
    cwd?: () => string | undefined
    herdrStatus?: boolean | (() => boolean)
    screen?: () => Promise<string>
  } = {},
): Fakes {
  const { rows = [], withPty = true, withEvents = true } = opts
  const store = fakeStore(rows)
  const pty = fakePty()
  let emit: (ev: DenAgentEventLike) => void = () => undefined
  const driver = new CodexDriver({
    store: store.host(),
    pty: withPty ? () => Promise.resolve(pty.host) : undefined,
    events: withEvents
      ? (sink) => {
          emit = sink
          return () => {
            emit = () => undefined
          }
        }
      : undefined,
    cwd: opts.cwd ?? ((): string => '/home/rivet'),
    turnQuietMs: 0,
    herdrStatus: opts.herdrStatus,
    screen: opts.screen,
  })
  return { driver, pty, store, emitDen: (ev) => emit(ev) }
}

const codexEvent = (
  room: string,
  native: string | undefined,
  body: Record<string, unknown>,
): DenAgentEventLike =>
  ({
    v: 1,
    session: room,
    harness: 'codex',
    ...(native ? { harnessSession: native } : {}),
    ...body,
  }) as DenAgentEventLike

const adopt = (f: Fakes, room: string, native: string): void => {
  f.emitDen(codexEvent(room, native, { type: 'session.start', title: 'codex session' }))
}

describe('capability flags are honest', () => {
  it('reports what is actually wired on this node', () => {
    const caps = makeDriver().driver.capabilities
    expect(pick(caps, FIVE_FLAGS)).toEqual({
      interrupt: true,
      resume: true,
      // No herdrStatus in the default fake — approvals need pty+herdr.
      approvals: false,
      liveStream: true,
      listSessions: true,
    })
  })

  it('advertises the static default model and #719 efforts, with no spawn flags', () => {
    const caps = makeDriver().driver.capabilities
    expect(caps.modelFlag).toBeUndefined()
    expect(caps.effortFlag).toBeUndefined()
    expect(caps.models?.map((m) => m.id)).toEqual(['default'])
    expect(caps.efforts?.map((e) => e.id)).toEqual(['low', 'medium', 'high', 'xhigh'])
    expect(caps.efforts?.find((e) => e.default)?.id).toBe('medium')
  })

  it('approvals is true only with pty + herdr', () => {
    expect(makeDriver({ herdrStatus: () => true }).driver.capabilities.approvals).toBe(true)
    expect(
      makeDriver({ withPty: false, herdrStatus: () => true }).driver.capabilities.approvals,
    ).toBe(false)
  })

  it('drops interrupt/resume when den terminals are off', () => {
    const { driver } = makeDriver({ withPty: false })
    expect(driver.capabilities.interrupt).toBe(false)
    expect(driver.capabilities.resume).toBe(false)
    expect(driver.capabilities.listSessions).toBe(true)
  })

  it('drops liveStream without a den event tap', () => {
    expect(makeDriver({ withEvents: false }).driver.capabilities.liveStream).toBe(false)
  })
})

describe('capability-false paths reject with capability_unsupported', () => {
  const expectUnsupported = async (run: () => Promise<unknown>): Promise<void> => {
    await expect(run()).rejects.toMatchObject({ code: 'capability_unsupported' })
  }

  it('resolveApproval rejects without herdr (approvals: false)', async () => {
    const { driver } = makeDriver()
    await expectUnsupported(() => driver.resolveApproval(SID, 'req-1', 'allow'))
  })

  it('rejects resume/turn when terminals are disabled', async () => {
    const { driver } = makeDriver({ withPty: false })
    await expectUnsupported(() => driver.resumeSession(SID))
    await expectUnsupported(() => driver.sendUserTurn(SID, { text: 'hi' }))
  })

  it('rejects subscribe with no event tap (synchronously — subscribe is not async)', () => {
    const { driver } = makeDriver({ withEvents: false })
    expect(() => driver.subscribe(SID, () => undefined)).toThrowError(HarnessError)
  })

  it('rejects attachments even when the URI is a staged node-local path', async () => {
    const { driver } = makeDriver()
    await expectUnsupported(() =>
      driver.sendUserTurn(SID, {
        text: 'look',
        attachments: [{ mime: 'image/png', pathOrUri: '/home/rivet/.rivetos/den/uploads/x.png' }],
      }),
    )
  })
})

describe('startSession is refused — Codex cannot be told what to call a session', () => {
  it('rejects with capability_unsupported, pinned or not, and spawns nothing', async () => {
    const { driver, pty } = makeDriver()
    await expect(driver.startSession()).rejects.toMatchObject({
      code: 'capability_unsupported',
    })
    await expect(driver.startSession({ nativeSessionId: NAT })).rejects.toMatchObject({
      code: 'capability_unsupported',
    })
    await expect(driver.startSession({ cwd: '/elsewhere' })).rejects.toMatchObject({
      code: 'capability_unsupported',
    })
    expect(pty.spawns).toEqual([])
  })
})

describe('identity + canonicalization', () => {
  it('mints `codex:<uuid>` ids from Codex’s own bare uuids', () => {
    expect(CodexDriver.sessionId(NAT)).toBe(SID)
    expect(NAT).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
    expect(NAT.startsWith('session_')).toBe(false)
  })

  it('refuses to act on another harness id', async () => {
    const { driver } = makeDriver()
    await expect(driver.getSession('hermes:x' as SessionId)).rejects.toMatchObject({
      code: 'invalid_session_id',
    })
  })

  it('lists store rows as canonical summaries', async () => {
    const { driver } = makeDriver({
      rows: [{ id: NAT, command: 'codex', title: 'review the PR', updatedAt: 1_700_000_000_000 }],
    })
    const [summary] = await driver.listSessions()
    expect(summary).toMatchObject({
      sessionId: SID,
      harnessId: 'codex',
      title: 'review the PR',
      cwd: '/home/rivet',
      status: 'ended',
    })
  })

  it('ignores rows from another harness store in the same list', async () => {
    const { driver } = makeDriver({
      rows: [
        { id: NAT, command: 'codex', title: 'mine', updatedAt: 2 },
        { id: NAT2, command: 'kimi', title: 'not mine', updatedAt: 3 },
      ],
    })
    expect((await driver.listSessions()).map((s) => s.sessionId)).toEqual([SID])
  })
})

describe('adoption — how a Codex session enters the control plane', () => {
  it('binds the den room to Codex’s own id on the first hook event', async () => {
    const { driver, emitDen } = makeDriver({
      rows: [{ id: NAT, command: 'codex', title: 't', updatedAt: 5 }],
    })
    const seen: HarnessEvent[] = []
    driver.subscribeEvents((e) => seen.push(e))
    adopt({ driver, emitDen } as Fakes, ROOM, NAT)

    expect(seen).toContainEqual({ type: 'session-updated', sessionId: SID, status: 'idle' })
    await vi.waitFor(() => {
      expect(seen.some((e) => e.type === 'session-created' && e.sessionId === SID)).toBe(true)
    })
    expect(await driver.getSession(SID)).toMatchObject({ sessionId: SID, status: 'idle' })
  })

  it('adopts a Codex running OUTSIDE den, whose room key IS its canonical id', () => {
    const f = makeDriver()
    const seen: HarnessEvent[] = []
    f.driver.subscribeEvents((e) => seen.push(e))
    f.emitDen({ v: 1, session: SID, harness: 'codex', type: 'session.start', title: 'codex' })
    expect(seen).toContainEqual({ type: 'session-updated', sessionId: SID, status: 'idle' })
  })

  it('does not mistake an arbitrary colon-bearing room key for a canonical id', () => {
    const f = makeDriver()
    const seen: HarnessEvent[] = []
    f.driver.subscribeEvents((e) => seen.push(e))
    f.emitDen({
      v: 1,
      session: 'codex:nope',
      harness: 'codex',
      type: 'tool.start',
      tool: 'shell',
    })
    f.emitDen({
      v: 1,
      session: 'host:codex',
      harness: 'codex',
      type: 'tool.start',
      tool: 'shell',
    })
    expect(seen).toEqual([])
  })

  it('streams that room’s later events under the bound id', () => {
    const f = makeDriver()
    adopt(f, ROOM, NAT)
    const seen: HarnessEvent[] = []
    f.driver.subscribe(SID, (e) => seen.push(e))
    f.emitDen(codexEvent(ROOM, NAT, { type: 'tool.start', tool: 'shell' }))
    expect(seen).toEqual([
      { type: 'tool-use', sessionId: SID, toolCallId: `${NAT}:t1`, name: 'shell', input: {} },
    ])
  })

  it('ignores rooms that are not Codex, and a non-uuid harnessSession', () => {
    const f = makeDriver()
    const seen: HarnessEvent[] = []
    f.driver.subscribeEvents((e) => seen.push(e))
    f.emitDen({ v: 1, session: ROOM, harness: 'hermes', type: 'session.start', title: 'h' })
    f.emitDen(
      codexEvent(ROOM, 'unknown-4242abcd4242abcd', { type: 'session.start', title: 'codex' }),
    )
    f.emitDen(codexEvent(ROOM, 'session_' + NAT, { type: 'session.start', title: 'codex' }))
    f.emitDen({ v: 1, session: ROOM, harness: 'codex', type: 'tool.start', tool: 'shell' })
    expect(seen).toEqual([])
  })

  it('adopts a Codex PTY spawned from the /term drawer (synthetic rivetos start)', () => {
    const f = makeDriver()
    const seen: HarnessEvent[] = []
    f.driver.subscribeEvents((e) => seen.push(e))
    f.emitDen({
      v: 1,
      session: ROOM,
      harness: 'rivetos',
      name: 'rivet-node:codex',
      harnessSession: NAT,
      type: 'session.start',
      title: 'Codex',
    })
    expect(seen).toContainEqual({ type: 'session-updated', sessionId: SID, status: 'idle' })
    const before = seen.length
    f.emitDen({
      v: 1,
      session: 'den-pty-other',
      harness: 'rivetos',
      name: 'rivet-node:hermes',
      harnessSession: NAT2,
      type: 'session.start',
      title: 'Hermes',
    })
    expect(seen).toHaveLength(before)
  })

  it('keeps streaming a session it resumed itself when the hook is too old to send the id', async () => {
    const f = makeDriver({ rows: [{ id: NAT, command: 'codex', title: 't', updatedAt: 1 }] })
    await f.driver.resumeSession(SID)
    const seen: HarnessEvent[] = []
    f.driver.subscribe(SID, (e) => seen.push(e))
    f.emitDen({ v: 1, session: NAT, harness: 'codex', type: 'tool.start', tool: 'Read' })
    expect(seen).toEqual([
      { type: 'tool-use', sessionId: SID, toolCallId: `${NAT}:t1`, name: 'Read', input: {} },
    ])
  })
})

describe('resumeSession', () => {
  it('re-spawns with resume, in a room named after the native id', async () => {
    const { driver, pty } = makeDriver({
      rows: [{ id: NAT, command: 'codex', title: 't', updatedAt: 2 }],
    })
    const summary = await driver.resumeSession(SID)
    expect(summary.sessionId).toBe(SID)
    expect(pty.spawns).toEqual([{ key: 'codex', session: NAT, resume: NAT }])
  })

  it('resumes a session the store cannot describe yet', async () => {
    const { driver, store, pty } = makeDriver()
    store.sessions.add(NAT)
    await expect(driver.resumeSession(SID)).resolves.toMatchObject({ sessionId: SID })
    expect(pty.spawns).toEqual([{ key: 'codex', session: NAT, resume: NAT }])
  })

  it('rejects a session the harness store has never heard of', async () => {
    const { driver } = makeDriver()
    await expect(driver.resumeSession(SID)).rejects.toMatchObject({ code: 'invalid_session_id' })
  })

  it('keeps an adopted session in ITS den room rather than opening a second one', async () => {
    const f = makeDriver({ rows: [{ id: NAT, command: 'codex', title: 't', updatedAt: 1 }] })
    adopt(f, ROOM, NAT)
    await f.driver.resumeSession(SID)
    expect(f.pty.spawns).toEqual([{ key: 'codex', session: ROOM, resume: NAT }])
  })
})

describe('codex never renames its own session — the non-rotation pin', () => {
  it('restating the same id is a status update, not a rotation', () => {
    const f = makeDriver()
    adopt(f, ROOM, NAT)
    const seen: HarnessEvent[] = []
    f.driver.subscribeEvents((e) => seen.push(e))
    f.emitDen(codexEvent(ROOM, NAT, { type: 'session.start', title: 'codex session' }))
    expect(seen.filter((e) => e.type === 'session-updated' && e.previousSessionId)).toEqual([])
  })

  it('a resume keeps the id it was asked for', async () => {
    const f = makeDriver({ rows: [{ id: NAT, command: 'codex', title: 't', updatedAt: 1 }] })
    const seen: HarnessEvent[] = []
    f.driver.subscribeEvents((e) => seen.push(e))
    expect((await f.driver.resumeSession(SID)).sessionId).toBe(SID)
    f.emitDen(codexEvent(NAT, NAT, { type: 'session.start', title: 'codex session' }))
    expect(seen.filter((e) => e.type === 'session-updated' && e.previousSessionId)).toEqual([])
  })
})

describe('a den room CAN change which Codex it runs — that is the rotation', () => {
  it('emits session-updated with previousSessionId when the room’s id changes', () => {
    const f = makeDriver()
    adopt(f, ROOM, NAT)
    const registry: HarnessEvent[] = []
    f.driver.subscribeEvents((e) => registry.push(e))
    f.emitDen(codexEvent(ROOM, NAT2, { type: 'session.start', title: 'codex session' }))
    expect(registry).toContainEqual({
      type: 'session-updated',
      sessionId: `codex:${NAT2}`,
      previousSessionId: SID,
      status: 'idle',
    })
  })
})

describe('what the live stream does NOT carry — stated, not faked', () => {
  it('emits no assistant-delta and no reasoning-delta unless the wire actually sends them', () => {
    const f = makeDriver()
    adopt(f, ROOM, NAT)
    const seen: HarnessEvent[] = []
    f.driver.subscribe(SID, (e) => seen.push(e))
    f.emitDen(codexEvent(ROOM, NAT, { type: 'tool.start', tool: 'shell' }))
    f.emitDen(codexEvent(ROOM, NAT, { type: 'turn.end' }))
    expect(seen.some((e) => e.type === 'assistant-delta')).toBe(false)
    expect(seen.some((e) => e.type === 'reasoning-delta')).toBe(false)
  })
})

describe('through the real registry', () => {
  const withRegistry = (
    rows: HarnessSession[] = [],
  ): { fakes: Fakes; registry: HarnessRegistry } => {
    const fakes = makeDriver({ rows })
    const registry = createHarnessRegistry()
    registry.register(fakes.driver)
    return { fakes, registry }
  }

  it('registers under the codex harness id and advertises its flags', () => {
    const { registry } = withRegistry()
    const [desc] = registry.list()
    expect(registry.list()).toHaveLength(1)
    expect(desc.harnessId).toBe('codex')
    expect(pick(desc.capabilities, FIVE_FLAGS)).toEqual({
      interrupt: true,
      resume: true,
      approvals: false,
      liveStream: true,
      listSessions: true,
    })
  })

  it('lists canonical ids, exactly once each', async () => {
    const { registry } = withRegistry([
      { id: NAT, command: 'codex', title: 'a', updatedAt: 2 },
      { id: NAT2, command: 'codex', title: 'b', updatedAt: 1 },
    ])
    const ids = (await registry.listSessions('codex')).map((s) => s.sessionId)
    expect(ids).toEqual([SID, `codex:${NAT2}`])
    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe('transcript', () => {
  it('serves the hard-resync source for a canonical id', async () => {
    const { driver, store } = makeDriver({
      rows: [{ id: NAT, command: 'codex', title: 't', updatedAt: 1 }],
    })
    store.transcripts.set(NAT, { turns: [{ role: 'user', text: 'hi' }] })
    await expect(driver.transcript(SID)).resolves.toEqual({
      turns: [{ role: 'user', text: 'hi' }],
    })
  })
})

describe('close', () => {
  it('detaches the den tap', () => {
    const off = vi.fn()
    const driver = new CodexDriver({ store: fakeStore().host(), events: () => off })
    driver.close()
    expect(off).toHaveBeenCalledOnce()
  })
})

runHarnessRotationConformance('codex', () => {
  const fakes = makeDriver({
    rows: [
      { id: NAT, command: 'codex', title: 'first', updatedAt: 1_700_000_000_000 },
      { id: NAT2, command: 'codex', title: 'second', updatedAt: 1_700_000_100_000 },
      { id: NAT3, command: 'codex', title: 'third', updatedAt: 1_700_000_200_000 },
    ],
  })
  adopt(fakes, ROOM, NAT)
  const registry = createHarnessRegistry()
  registry.register(fakes.driver)
  let minted = 0
  return {
    registry,
    driver: fakes.driver,
    sessionId: SID,
    rotate: () => {
      const next =
        [NAT2, NAT3][minted++] ?? `00000000-0000-4000-8000-${String(minted).padStart(12, '0')}`
      fakes.emitDen(codexEvent(ROOM, next, { type: 'session.start', title: 'codex session' }))
      return `codex:${next}` as SessionId
    },
    emitActivity: (id) => {
      fakes.emitDen(
        codexEvent(ROOM, id.slice('codex:'.length), { type: 'tool.start', tool: 'shell' }),
      )
    },
    teardown: () => {
      registry.close()
      fakes.driver.close()
    },
  }
})

describe('Codex screen approvals', () => {
  const screen = async () => `Would you like to run the following command?
  Reason: Approval UI smoke test
  $ touch /tmp/rivetos-codex-approval-smoke
› 1. Yes, proceed (y)
  2. Yes, and don't ask again for commands that start with touch (p)
  3. No, and tell Codex what to do differently (esc)
  Press enter to confirm or esc to cancel`

  it.each([
    ['allow', 'y'],
    ['deny', '\x1b'],
  ] as const)(
    'routes %s from a blocked screen to the actual TUI shortcut',
    async (decision, key) => {
      const f = makeDriver({ herdrStatus: true, screen })
      const seen: HarnessEvent[] = []
      f.driver.subscribeEvents((e) => seen.push(e))
      f.driver.subscribe(SID, (e) => seen.push(e))
      adopt(f, ROOM, NAT)
      await vi.waitFor(() => expect(seen.some((e) => e.type === 'session-created')).toBe(true))
      f.driver.applyHerdrStatus(ROOM, {
        type: 'status',
        sessionId: SID,
        status: 'blocked',
        since: Date.now(),
        source: 'herdr',
      })
      await vi.waitFor(() => expect(seen.some((e) => e.type === 'approval-request')).toBe(true))
      const request = seen.find((e) => e.type === 'approval-request')!
      if (request.type !== 'approval-request') throw new Error('missing approval')
      await expect(
        f.driver.resolveApproval(SID, request.requestId, 'allow-session'),
      ).rejects.toMatchObject({ code: 'bad_request' })
      expect(seen.some((e) => e.type === 'approval-resolved')).toBe(false)
      await f.driver.resolveApproval(SID, request.requestId, decision)
      expect(f.pty.injects.at(-1)).toMatchObject({ text: key, submit: false })
      expect(seen.some((e) => e.type === 'approval-resolved')).toBe(true)
      f.driver.close()
    },
  )
})
