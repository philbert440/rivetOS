// The `pi` driver over fakes for the two things it wraps: the den term
// manager (PTY spawn/inject/Esc) and the pi on-disk store. No `pi` binary
// and no ~/.pi required.
//
// Mirrors kimi-driver.test.ts — adopting harness, refused startSession,
// UUID natives (no prefix; REVIEWER-CONFIRM), room rotation.

import { describe, expect, it, vi } from 'vitest'
import { HarnessError, type HarnessEvent, type SessionId } from '@rivetos/types'
import type { HarnessSession } from '../term/harness-sessions.js'
import { PiDriver, type PiPtyHost, type PiStoreHost } from './pi-driver.js'
import type { DenAgentEventLike } from './pty-harness-driver.js'
import { createHarnessRegistry, type HarnessRegistry } from './registry.js'
import { FIVE_FLAGS, pick, runHarnessRotationConformance } from './test/driver-conformance.js'

const NAT = '89965427-b96f-4d5e-8ad5-c3dd138e33dc'
const NAT2 = '42accb06-524a-47a6-b4b3-0991552914d7'
const NAT3 = '15cb936c-3364-49d6-8769-21f0c635f160'
const SID = `pi:${NAT}` as SessionId
const ROOM = 'den-pty-1a2b3c4d'

interface Fakes {
  driver: PiDriver
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
    host(): PiStoreHost {
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
  const host: PiPtyHost = {
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
  } = {},
): Fakes {
  const { rows = [], withPty = true, withEvents = true } = opts
  const store = fakeStore(rows)
  const pty = fakePty()
  let emit: (ev: DenAgentEventLike) => void = () => undefined
  const driver = new PiDriver({
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
  })
  return { driver, pty, store, emitDen: (ev) => emit(ev) }
}

const piEvent = (
  room: string,
  native: string | undefined,
  body: Record<string, unknown>,
): DenAgentEventLike =>
  ({
    v: 1,
    session: room,
    harness: 'pi',
    ...(native ? { harnessSession: native } : {}),
    ...body,
  }) as DenAgentEventLike

const adopt = (f: Fakes, room: string, native: string): void => {
  f.emitDen(piEvent(room, native, { type: 'session.start', title: 'pi session' }))
}

describe('capability flags are honest', () => {
  it('reports what is actually wired on this node', () => {
    const caps = makeDriver().driver.capabilities
    expect(pick(caps, FIVE_FLAGS)).toEqual({
      interrupt: true,
      resume: true,
      approvals: false,
      liveStream: true,
      listSessions: true,
    })
  })

  it('advertises --model with an empty list until a config override fills it', () => {
    const caps = makeDriver().driver.capabilities
    expect(caps.modelFlag).toBe('--model')
    expect(caps.effortFlag).toBeUndefined()
    expect(caps.models).toEqual([])
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

  it('resolveApproval always rejects — approvals: false', async () => {
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

describe('startSession is refused — pi cannot be told what to call a session', () => {
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
  it('mints `pi:<uuid>` ids from pi’s own ids', () => {
    expect(PiDriver.sessionId(NAT)).toBe(SID)
    expect(NAT).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  })

  it('refuses to act on another harness id', async () => {
    const { driver } = makeDriver()
    await expect(driver.getSession('hermes:x' as SessionId)).rejects.toMatchObject({
      code: 'invalid_session_id',
    })
  })

  it('lists store rows as canonical summaries', async () => {
    const { driver } = makeDriver({
      rows: [{ id: NAT, command: 'pi', title: 'review the PR', updatedAt: 1_700_000_000_000 }],
    })
    const [summary] = await driver.listSessions()
    expect(summary).toMatchObject({
      sessionId: SID,
      harnessId: 'pi',
      title: 'review the PR',
      cwd: '/home/rivet',
      status: 'ended',
    })
  })

  it('ignores rows from another harness store in the same list', async () => {
    const { driver } = makeDriver({
      rows: [
        { id: NAT, command: 'pi', title: 'mine', updatedAt: 2 },
        { id: NAT2, command: 'grok', title: 'not mine', updatedAt: 3 },
      ],
    })
    expect((await driver.listSessions()).map((s) => s.sessionId)).toEqual([SID])
  })
})

describe('adoption — how a pi session enters the control plane', () => {
  it('binds the den room to pi’s own id on the first hook event', async () => {
    const { driver, emitDen } = makeDriver({
      rows: [{ id: NAT, command: 'pi', title: 't', updatedAt: 5 }],
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

  it('adopts a pi running OUTSIDE den, whose room key IS its canonical id', () => {
    const f = makeDriver()
    const seen: HarnessEvent[] = []
    f.driver.subscribeEvents((e) => seen.push(e))
    f.emitDen({ v: 1, session: SID, harness: 'pi', type: 'session.start', title: 'pi' })
    expect(seen).toContainEqual({ type: 'session-updated', sessionId: SID, status: 'idle' })
  })

  it('does not mistake an arbitrary colon-bearing room key for a canonical id', () => {
    const f = makeDriver()
    const seen: HarnessEvent[] = []
    f.driver.subscribeEvents((e) => seen.push(e))
    f.emitDen({
      v: 1,
      session: 'pi:nope',
      harness: 'pi',
      type: 'tool.start',
      tool: 'Bash',
    })
    f.emitDen({
      v: 1,
      session: 'host:pi',
      harness: 'pi',
      type: 'tool.start',
      tool: 'Bash',
    })
    expect(seen).toEqual([])
  })

  it('streams that room’s later events under the bound id', () => {
    const f = makeDriver()
    adopt(f, ROOM, NAT)
    const seen: HarnessEvent[] = []
    f.driver.subscribe(SID, (e) => seen.push(e))
    f.emitDen(piEvent(ROOM, NAT, { type: 'tool.start', tool: 'Bash' }))
    expect(seen).toEqual([
      { type: 'tool-use', sessionId: SID, toolCallId: `${NAT}:t1`, name: 'Bash', input: {} },
    ])
  })

  it('ignores rooms that are not pi, and the translator’s id-less fallback', () => {
    const f = makeDriver()
    const seen: HarnessEvent[] = []
    f.driver.subscribeEvents((e) => seen.push(e))
    f.emitDen({ v: 1, session: ROOM, harness: 'hermes', type: 'session.start', title: 'h' })
    f.emitDen(piEvent(ROOM, 'unknown-4242abcd4242abcd', { type: 'session.start', title: 'pi' }))
    f.emitDen({ v: 1, session: ROOM, harness: 'pi', type: 'tool.start', tool: 'Bash' })
    expect(seen).toEqual([])
  })

  it('adopts a pi PTY spawned from the /term drawer (synthetic rivetos start)', () => {
    const f = makeDriver()
    const seen: HarnessEvent[] = []
    f.driver.subscribeEvents((e) => seen.push(e))
    f.emitDen({
      v: 1,
      session: ROOM,
      harness: 'rivetos',
      name: 'rivet-node:pi',
      harnessSession: NAT,
      type: 'session.start',
      title: 'Pi',
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
    const f = makeDriver({ rows: [{ id: NAT, command: 'pi', title: 't', updatedAt: 1 }] })
    await f.driver.resumeSession(SID)
    const seen: HarnessEvent[] = []
    f.driver.subscribe(SID, (e) => seen.push(e))
    f.emitDen({ v: 1, session: NAT, harness: 'pi', type: 'tool.start', tool: 'Read' })
    expect(seen).toEqual([
      { type: 'tool-use', sessionId: SID, toolCallId: `${NAT}:t1`, name: 'Read', input: {} },
    ])
  })
})

describe('resumeSession', () => {
  it('re-spawns with --session, in a room named after the native id', async () => {
    const { driver, pty } = makeDriver({
      rows: [{ id: NAT, command: 'pi', title: 't', updatedAt: 2 }],
    })
    const summary = await driver.resumeSession(SID)
    expect(summary.sessionId).toBe(SID)
    expect(pty.spawns).toEqual([{ key: 'pi', session: NAT, resume: NAT }])
  })

  it('resumes a session dir the store cannot describe yet', async () => {
    const { driver, store, pty } = makeDriver()
    store.sessions.add(NAT)
    await expect(driver.resumeSession(SID)).resolves.toMatchObject({ sessionId: SID })
    expect(pty.spawns).toEqual([{ key: 'pi', session: NAT, resume: NAT }])
  })

  it('rejects a session the harness store has never heard of', async () => {
    const { driver } = makeDriver()
    await expect(driver.resumeSession(SID)).rejects.toMatchObject({ code: 'invalid_session_id' })
  })

  it('keeps an adopted session in ITS den room rather than opening a second one', async () => {
    const f = makeDriver({ rows: [{ id: NAT, command: 'pi', title: 't', updatedAt: 1 }] })
    adopt(f, ROOM, NAT)
    await f.driver.resumeSession(SID)
    expect(f.pty.spawns).toEqual([{ key: 'pi', session: ROOM, resume: NAT }])
  })
})

describe('sendUserTurn', () => {
  it('injects into the PTY of the room the session is running in', async () => {
    const f = makeDriver({ rows: [{ id: NAT, command: 'pi', title: 't', updatedAt: 1 }] })
    adopt(f, ROOM, NAT)
    await f.driver.sendUserTurn(SID, { text: 'hello' })
    expect(f.pty.spawns).toEqual([{ key: 'pi', session: ROOM, resume: NAT }])
    expect(f.pty.injects).toEqual([
      { id: 'pty-1', text: 'hello', submit: true, interrupt: undefined },
    ])
  })

  it('re-attaches (--session) when the PTY was LRU-evicted between turns', async () => {
    const f = makeDriver({ rows: [{ id: NAT, command: 'pi', title: 't', updatedAt: 2 }] })
    await f.driver.resumeSession(SID)
    f.pty.live.delete(NAT)
    await f.driver.sendUserTurn(SID, { text: 'still there?' })
    expect(f.pty.spawns).toEqual([
      { key: 'pi', session: NAT, resume: NAT },
      { key: 'pi', session: NAT, resume: NAT },
    ])
  })

  it('re-spawns through --session when the pty exited but has not been reaped', async () => {
    const f = makeDriver({ rows: [{ id: NAT, command: 'pi', title: 't', updatedAt: 2 }] })
    await f.driver.resumeSession(SID)
    f.pty.dead.add('pty-1')
    await expect(f.driver.sendUserTurn(SID, { text: 'still there?' })).resolves.toBeUndefined()
    expect(f.pty.spawns).toHaveLength(2)
    expect(f.pty.injects.at(-1)).toMatchObject({ id: 'pty-2', text: 'still there?' })
  })

  it('reports turn_in_flight (retryable) when even a fresh pty refuses the write', async () => {
    const f = makeDriver({ rows: [{ id: NAT, command: 'pi', title: 't', updatedAt: 2 }] })
    await f.driver.resumeSession(SID)
    f.pty.setWritable(false)
    await expect(f.driver.sendUserTurn(SID, { text: 'hi' })).rejects.toMatchObject({
      code: 'turn_in_flight',
      retryable: true,
    })
  })

  it('rejects with turn_in_flight rather than silently queueing', async () => {
    const f = makeDriver({ rows: [{ id: NAT, command: 'pi', title: 't', updatedAt: 2 }] })
    await f.driver.resumeSession(SID)
    await f.driver.sendUserTurn(SID, { text: 'one' })
    await expect(f.driver.sendUserTurn(SID, { text: 'two' })).rejects.toMatchObject({
      code: 'turn_in_flight',
      retryable: true,
    })
  })

  it('releases the lock on turn.end so the next turn goes through', async () => {
    const f = makeDriver({ rows: [{ id: NAT, command: 'pi', title: 't', updatedAt: 2 }] })
    await f.driver.resumeSession(SID)
    await f.driver.sendUserTurn(SID, { text: 'one' })
    f.emitDen(piEvent(NAT, NAT, { type: 'turn.end' }))
    await expect(f.driver.sendUserTurn(SID, { text: 'two' })).resolves.toBeUndefined()
  })
})

describe('interrupt', () => {
  it('sends Esc to the room’s PTY and completes the turn as interrupted', async () => {
    const f = makeDriver({ rows: [{ id: NAT, command: 'pi', title: 't', updatedAt: 2 }] })
    await f.driver.resumeSession(SID)
    const seen: HarnessEvent[] = []
    f.driver.subscribe(SID, (e) => seen.push(e))
    await f.driver.sendUserTurn(SID, { text: 'go' })
    await f.driver.interrupt(SID)
    expect(f.pty.injects.at(-1)).toEqual({ id: 'pty-1', text: '', submit: false, interrupt: true })
    expect(seen).toContainEqual({
      type: 'turn-complete',
      sessionId: SID,
      stopReason: 'interrupted',
    })
  })

  it('is a no-op with no live harness — there is no turn to cancel', async () => {
    const { driver, pty } = makeDriver()
    await expect(driver.interrupt(SID)).resolves.toBeUndefined()
    expect(pty.injects).toEqual([])
  })
})

describe('subscribe maps den AgentEvents onto the contract', () => {
  it('streams paired tool calls and turn completion', () => {
    const f = makeDriver()
    adopt(f, ROOM, NAT)
    const seen: HarnessEvent[] = []
    const off = f.driver.subscribe(SID, (e) => seen.push(e))

    f.emitDen(piEvent(ROOM, NAT, { type: 'tool.start', tool: 'Bash', args: { command: 'ls' } }))
    f.emitDen(piEvent(ROOM, NAT, { type: 'tool.end', tool: 'Bash' }))
    f.emitDen(piEvent(ROOM, NAT, { type: 'turn.end' }))
    off()
    f.emitDen(piEvent(ROOM, NAT, { type: 'tool.start', tool: 'Read' }))

    expect(seen.filter((e) => e.type === 'tool-use')).toEqual([
      {
        type: 'tool-use',
        sessionId: SID,
        toolCallId: `${NAT}:t1`,
        name: 'Bash',
        input: { command: 'ls' },
      },
    ])
    expect(seen.filter((e) => e.type === 'tool-result')).toEqual([
      {
        type: 'tool-result',
        sessionId: SID,
        toolCallId: `${NAT}:t1`,
        name: 'Bash',
        output: null,
      },
    ])
    expect(seen).toContainEqual({ type: 'turn-complete', sessionId: SID, stopReason: 'end-turn' })
    expect(seen.some((e) => e.type === 'tool-use' && e.name === 'Read')).toBe(false)
  })

  it('marks a session ended when its harness exits', () => {
    const f = makeDriver()
    adopt(f, ROOM, NAT)
    const seen: HarnessEvent[] = []
    f.driver.subscribeEvents((e) => seen.push(e))
    f.emitDen(piEvent(ROOM, NAT, { type: 'session.end' }))
    expect(seen).toContainEqual({ type: 'session-updated', sessionId: SID, status: 'ended' })
  })
})

describe('a den room CAN change which pi it runs — that is the rotation', () => {
  it('emits session-updated with previousSessionId when the room’s id changes', () => {
    const f = makeDriver()
    adopt(f, ROOM, NAT)
    const registry: HarnessEvent[] = []
    f.driver.subscribeEvents((e) => registry.push(e))
    f.emitDen(piEvent(ROOM, NAT2, { type: 'session.start', title: 'pi session' }))
    expect(registry).toContainEqual({
      type: 'session-updated',
      sessionId: `pi:${NAT2}`,
      previousSessionId: SID,
      status: 'idle',
    })
  })

  it('does NOT re-key its own sinks — that is control-plane work', () => {
    const f = makeDriver()
    adopt(f, ROOM, NAT)
    const seen: HarnessEvent[] = []
    f.driver.subscribe(SID, (e) => seen.push(e))
    f.emitDen(piEvent(ROOM, NAT2, { type: 'session.start', title: 'pi session' }))
    seen.length = 0
    f.emitDen(piEvent(ROOM, NAT2, { type: 'tool.start', tool: 'Bash' }))
    expect(seen).toEqual([])
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

  it('registers under the pi harness id and advertises its flags', () => {
    const { fakes, registry } = withRegistry()
    const [desc] = registry.list()
    expect(registry.list()).toHaveLength(1)
    expect(desc.harnessId).toBe('pi')
    expect(pick(desc.capabilities, FIVE_FLAGS)).toEqual({
      interrupt: true,
      resume: true,
      approvals: false,
      liveStream: true,
      listSessions: true,
    })
    expect(desc.capabilities.modelFlag).toBe(fakes.driver.capabilities.modelFlag)
  })

  it('lists canonical ids, exactly once each', async () => {
    const { registry } = withRegistry([
      { id: NAT, command: 'pi', title: 'a', updatedAt: 2 },
      { id: NAT2, command: 'pi', title: 'b', updatedAt: 1 },
    ])
    const ids = (await registry.listSessions('pi')).map((s) => s.sessionId)
    expect(ids).toEqual([SID, `pi:${NAT2}`])
    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe('transcript', () => {
  it('serves the hard-resync source for a canonical id', async () => {
    const { driver, store } = makeDriver({
      rows: [{ id: NAT, command: 'pi', title: 't', updatedAt: 1 }],
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
    const driver = new PiDriver({ store: fakeStore().host(), events: () => off })
    driver.close()
    expect(off).toHaveBeenCalledOnce()
  })
})

runHarnessRotationConformance('pi', () => {
  const fakes = makeDriver({
    rows: [
      { id: NAT, command: 'pi', title: 'first', updatedAt: 1_700_000_000_000 },
      { id: NAT2, command: 'pi', title: 'second', updatedAt: 1_700_000_100_000 },
      { id: NAT3, command: 'pi', title: 'third', updatedAt: 1_700_000_200_000 },
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
        [NAT2, NAT3][minted++] ?? `00000000-0000-4000-8000-00000000000${String(minted)}`
      fakes.emitDen(piEvent(ROOM, next, { type: 'session.start', title: 'pi session' }))
      return `pi:${next}` as SessionId
    },
    emitActivity: (id) => {
      fakes.emitDen(piEvent(ROOM, id.slice('pi:'.length), { type: 'tool.start', tool: 'Bash' }))
    },
    teardown: () => {
      registry.close()
      fakes.driver.close()
    },
  }
})
