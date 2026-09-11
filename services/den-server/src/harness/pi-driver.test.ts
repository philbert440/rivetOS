// The `pi` driver over fakes for the two things it wraps: the den term
// manager (PTY spawn/inject/Esc) and the pi on-disk store. No `pi` binary
// and no ~/.pi required.
//
// Pinning driver (like grok/claude): `--session-id` creates a new session,
// UUID natives (any version), no rotation.

import { describe, expect, it, vi } from 'vitest'
import { HarnessError, type HarnessEvent, type SessionId } from '@rivetos/types'
import type { HarnessSession } from '../term/harness-sessions.js'
import { PiDriver, type PiPtyHost, type PiStoreHost } from './pi-driver.js'
import type { DenAgentEventLike } from './pty-harness-driver.js'
import type { SheetReaders } from './model-sheets.js'
import { createHarnessRegistry, type HarnessRegistry } from './registry.js'
import { FIVE_FLAGS, pick } from './test/driver-conformance.js'

const UUID = '01a090db-c402-71cb-a954-6066b9493630'
const UUID2 = '42accb06-524a-47a6-b4b3-0991552914d7'
const SID = `pi:${UUID}` as SessionId

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

/** Force the fallback sheet — tests do not depend on ~/.pi/agent/settings.json. */
const missingPiFiles: SheetReaders = {
  readJson: (): never => {
    throw new Error('ENOENT')
  },
}

function makeDriver(
  opts: {
    rows?: HarnessSession[]
    withPty?: boolean
    withEvents?: boolean
    cwd?: () => string | undefined
    sheetReaders?: SheetReaders
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
    sheetReaders: opts.sheetReaders ?? missingPiFiles,
  })
  return { driver, pty, store, emitDen: (ev) => emit(ev) }
}

const piEvent = (session: string, body: Record<string, unknown>): DenAgentEventLike =>
  ({
    v: 1,
    session,
    harness: 'pi',
    ...body,
  }) as DenAgentEventLike

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

  it('advertises --model / --thinking with the fleet default when settings.json is missing', () => {
    const caps = makeDriver().driver.capabilities
    expect(caps.modelFlag).toBe('--model')
    expect(caps.effortFlag).toBe('--thinking')
    expect(caps.models?.[0]?.id).toBe('deepseek/deepseek-v4-flash')
    expect(caps.efforts?.map((e) => e.id)).toEqual(['low', 'medium', 'high', 'max'])
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

  it('rejects start/resume/turn when terminals are disabled', async () => {
    const { driver } = makeDriver({ withPty: false })
    await expectUnsupported(() => driver.startSession())
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

  it('rejects roster-owned start options rather than silently ignoring them', async () => {
    const { driver } = makeDriver()
    await expectUnsupported(() => driver.startSession({ cwd: '/elsewhere' }))
    await expectUnsupported(() => driver.startSession({ model: 'deepseek/deepseek-v4-flash' }))
  })
})

describe('identity + canonicalization', () => {
  it('mints `pi:<uuid>` ids from pi’s own ids', () => {
    expect(PiDriver.sessionId(UUID)).toBe(SID)
    expect(UUID).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  })

  it('refuses to act on another harness id', async () => {
    const { driver } = makeDriver()
    await expect(driver.getSession('hermes:x' as SessionId)).rejects.toMatchObject({
      code: 'invalid_session_id',
    })
  })

  it('lists store rows as canonical summaries', async () => {
    const { driver } = makeDriver({
      rows: [{ id: UUID, command: 'pi', title: 'review the PR', updatedAt: 1_700_000_000_000 }],
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
        { id: UUID, command: 'pi', title: 'mine', updatedAt: 2 },
        { id: UUID2, command: 'grok', title: 'not mine', updatedAt: 3 },
      ],
    })
    expect((await driver.listSessions()).map((s) => s.sessionId)).toEqual([SID])
  })
})

describe('startSession', () => {
  it('pins the native id and spawns the `pi` roster entry', async () => {
    const { driver, pty } = makeDriver()
    const summary = await driver.startSession({ nativeSessionId: UUID })
    expect(summary.sessionId).toBe(SID)
    expect(summary.status).toBe('idle')
    expect(pty.spawns).toEqual([{ key: 'pi', session: UUID, resume: undefined }])
  })

  it('mints a uuid when the caller does not pin one', async () => {
    const { driver, pty } = makeDriver()
    const summary = await driver.startSession()
    expect(summary.sessionId).toMatch(/^pi:[0-9a-f-]{36}$/)
    expect(pty.spawns[0].resume).toBeUndefined()
  })

  it('never attaches: a pinned id already in the store is a collision', async () => {
    const { driver } = makeDriver({
      rows: [{ id: UUID, command: 'pi', title: UUID, updatedAt: 1 }],
    })
    await expect(driver.startSession({ nativeSessionId: UUID })).rejects.toMatchObject({
      code: 'session_id_collision',
    })
  })

  it('collides on a session file the store cannot describe yet', async () => {
    const { driver, store, pty } = makeDriver()
    store.sessions.add(UUID)
    await expect(driver.startSession({ nativeSessionId: UUID })).rejects.toMatchObject({
      code: 'session_id_collision',
    })
    expect(pty.spawns).toEqual([])
  })

  it('rejects a non-uuid pin — `pi --session-id` cannot honor it', async () => {
    const { driver } = makeDriver()
    await expect(driver.startSession({ nativeSessionId: 'thread-42' })).rejects.toMatchObject({
      code: 'invalid_session_id',
    })
  })

  it('announces session-created on the registry stream', async () => {
    const { driver } = makeDriver()
    const seen: HarnessEvent[] = []
    driver.subscribeEvents((e) => seen.push(e))
    const summary = await driver.startSession({ nativeSessionId: UUID })
    expect(seen).toContainEqual({ type: 'session-created', sessionId: SID, summary })
  })
})

describe('resumeSession', () => {
  it('re-spawns with --session, in a room named after the native id', async () => {
    const { driver, pty } = makeDriver({
      rows: [{ id: UUID, command: 'pi', title: 't', updatedAt: 2 }],
    })
    const summary = await driver.resumeSession(SID)
    expect(summary.sessionId).toBe(SID)
    expect(pty.spawns).toEqual([{ key: 'pi', session: UUID, resume: UUID }])
  })

  it('resumes a session the store cannot describe yet', async () => {
    const { driver, store, pty } = makeDriver()
    store.sessions.add(UUID)
    await expect(driver.resumeSession(SID)).resolves.toMatchObject({ sessionId: SID })
    expect(pty.spawns).toEqual([{ key: 'pi', session: UUID, resume: UUID }])
  })

  it('rejects a session the harness store has never heard of', async () => {
    const { driver } = makeDriver()
    await expect(driver.resumeSession(SID)).rejects.toMatchObject({ code: 'invalid_session_id' })
  })
})

describe('sendUserTurn', () => {
  it('injects the turn into the live PTY', async () => {
    const { driver, pty } = makeDriver()
    await driver.startSession({ nativeSessionId: UUID })
    await driver.sendUserTurn(SID, { text: 'hello' })
    expect(pty.injects).toEqual([
      { id: 'pty-1', text: 'hello', submit: true, interrupt: undefined },
    ])
  })

  it('re-attaches (--session) when the PTY was LRU-evicted between turns', async () => {
    const { driver, pty } = makeDriver({
      rows: [{ id: UUID, command: 'pi', title: 't', updatedAt: 2 }],
    })
    await driver.resumeSession(SID)
    pty.live.delete(UUID)
    await driver.sendUserTurn(SID, { text: 'still there?' })
    expect(pty.spawns).toEqual([
      { key: 'pi', session: UUID, resume: UUID },
      { key: 'pi', session: UUID, resume: UUID },
    ])
  })

  it('re-spawns through --session when the pty exited but has not been reaped', async () => {
    const { driver, pty } = makeDriver({
      rows: [{ id: UUID, command: 'pi', title: 't', updatedAt: 2 }],
    })
    await driver.resumeSession(SID)
    pty.dead.add('pty-1')
    await expect(driver.sendUserTurn(SID, { text: 'still there?' })).resolves.toBeUndefined()
    expect(pty.spawns).toHaveLength(2)
    expect(pty.injects.at(-1)).toMatchObject({ id: 'pty-2', text: 'still there?' })
  })

  it('reports turn_in_flight (retryable) when even a fresh pty refuses the write', async () => {
    const { driver, pty } = makeDriver()
    await driver.startSession({ nativeSessionId: UUID })
    pty.setWritable(false)
    await expect(driver.sendUserTurn(SID, { text: 'hi' })).rejects.toMatchObject({
      code: 'turn_in_flight',
      retryable: true,
    })
  })

  it('rejects with turn_in_flight rather than silently queueing', async () => {
    const { driver } = makeDriver()
    await driver.startSession({ nativeSessionId: UUID })
    await driver.sendUserTurn(SID, { text: 'one' })
    await expect(driver.sendUserTurn(SID, { text: 'two' })).rejects.toMatchObject({
      code: 'turn_in_flight',
      retryable: true,
    })
  })

  it('releases the lock on turn.end so the next turn goes through', async () => {
    const { driver, emitDen } = makeDriver()
    await driver.startSession({ nativeSessionId: UUID })
    await driver.sendUserTurn(SID, { text: 'one' })
    emitDen(piEvent(UUID, { type: 'turn.end' }))
    await expect(driver.sendUserTurn(SID, { text: 'two' })).resolves.toBeUndefined()
  })
})

describe('interrupt', () => {
  it('sends Esc to the live PTY and completes the turn as interrupted', async () => {
    const { driver, pty } = makeDriver()
    await driver.startSession({ nativeSessionId: UUID })
    const seen: HarnessEvent[] = []
    driver.subscribe(SID, (e) => seen.push(e))
    await driver.sendUserTurn(SID, { text: 'go' })
    await driver.interrupt(SID)
    expect(pty.injects.at(-1)).toEqual({ id: 'pty-1', text: '', submit: false, interrupt: true })
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
  it('streams paired tool calls and turn completion', async () => {
    const { driver, emitDen } = makeDriver()
    await driver.startSession({ nativeSessionId: UUID })
    const seen: HarnessEvent[] = []
    const off = driver.subscribe(SID, (e) => seen.push(e))

    emitDen(piEvent(UUID, { type: 'tool.start', tool: 'Bash', args: { command: 'ls' } }))
    emitDen(piEvent(UUID, { type: 'tool.end', tool: 'Bash' }))
    emitDen(piEvent(UUID, { type: 'turn.end' }))
    off()
    emitDen(piEvent(UUID, { type: 'tool.start', tool: 'Read' }))

    expect(seen.filter((e) => e.type === 'tool-use')).toEqual([
      {
        type: 'tool-use',
        sessionId: SID,
        toolCallId: `${UUID}:t1`,
        name: 'Bash',
        input: { command: 'ls' },
      },
    ])
    expect(seen.filter((e) => e.type === 'tool-result')).toEqual([
      {
        type: 'tool-result',
        sessionId: SID,
        toolCallId: `${UUID}:t1`,
        name: 'Bash',
        output: null,
      },
    ])
    expect(seen).toContainEqual({ type: 'turn-complete', sessionId: SID, stopReason: 'end-turn' })
    expect(seen.some((e) => e.type === 'tool-use' && e.name === 'Read')).toBe(false)
  })

  it('ignores den rooms that are not pi', () => {
    const { driver, emitDen } = makeDriver()
    const seen: HarnessEvent[] = []
    driver.subscribeEvents((e) => seen.push(e))
    emitDen({ v: 1, session: UUID2, harness: 'hermes', type: 'session.start', title: 'h' })
    expect(seen).toEqual([])
  })

  it('ignores the translator’s id-less fallback room (`unknown-<ppid>`)', () => {
    const { driver, emitDen } = makeDriver()
    const seen: HarnessEvent[] = []
    driver.subscribeEvents((e) => seen.push(e))
    emitDen({ v: 1, session: 'unknown-4242', harness: 'pi', type: 'session.start' })
    expect(seen).toEqual([])
  })

  it('adopts a pi PTY spawned from the /term drawer (synthetic rivetos start)', () => {
    const { driver, emitDen } = makeDriver()
    const seen: HarnessEvent[] = []
    driver.subscribeEvents((e) => seen.push(e))
    emitDen({
      v: 1,
      session: UUID,
      harness: 'rivetos',
      name: 'rivet-node:pi',
      type: 'session.start',
      title: 'Pi',
    })
    expect(seen).toContainEqual({ type: 'session-updated', sessionId: SID, status: 'idle' })
    const before = seen.length
    emitDen({
      v: 1,
      session: UUID2,
      harness: 'rivetos',
      name: 'rivet-node:hermes',
      type: 'session.start',
      title: 'Hermes',
    })
    expect(seen).toHaveLength(before)
  })

  it('marks a session ended when its harness exits', async () => {
    const { driver, emitDen } = makeDriver()
    await driver.startSession({ nativeSessionId: UUID })
    const seen: HarnessEvent[] = []
    driver.subscribeEvents((e) => seen.push(e))
    emitDen(piEvent(UUID, { type: 'session.end' }))
    expect(seen).toContainEqual({ type: 'session-updated', sessionId: SID, status: 'ended' })
  })
})

describe('native session ids do not rotate on the den path', () => {
  it('never emits session-updated with previousSessionId', async () => {
    const { driver, emitDen } = makeDriver()
    await driver.startSession({ nativeSessionId: UUID })
    const registry: HarnessEvent[] = []
    driver.subscribeEvents((e) => registry.push(e))
    emitDen(piEvent(UUID, { type: 'session.start', title: 'fresh' }))
    emitDen(piEvent(UUID, { type: 'turn.end' }))
    for (const e of registry) {
      expect(e.type === 'session-updated' && e.previousSessionId).toBeFalsy()
      expect(e.sessionId).toBe(SID)
    }
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
      { id: UUID, command: 'pi', title: 'a', updatedAt: 2 },
      { id: UUID2, command: 'pi', title: 'b', updatedAt: 1 },
    ])
    const ids = (await registry.listSessions('pi')).map((s) => s.sessionId)
    expect(ids).toEqual([SID, `pi:${UUID2}`])
    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe('transcript', () => {
  it('serves the hard-resync source for a canonical id', async () => {
    const { driver, store } = makeDriver({
      rows: [{ id: UUID, command: 'pi', title: 't', updatedAt: 1 }],
    })
    store.transcripts.set(UUID, { turns: [{ role: 'user', text: 'hi' }] })
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
