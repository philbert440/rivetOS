// The `deepseek-harness` driver over fakes for the two things it wraps: the
// den term manager (PTY spawn/inject/Esc) and the dsh on-disk store. No `dsh`
// binary and no ~/.dsh required.
//
// Same adopting shape as kimi-code (no --session-id pin) minus hook-fed
// capture: dsh has none. liveStream is the den tap, not an assistant stream.

import { describe, expect, it, vi } from 'vitest'
import { HarnessError, type HarnessEvent, type SessionId } from '@rivetos/types'
import type { HarnessSession } from '../term/harness-sessions.js'
import {
  DeepseekHarnessDriver,
  type DeepseekPtyHost,
  type DeepseekStoreHost,
} from './deepseek-driver.js'
import type { DenAgentEventLike } from './pty-harness-driver.js'
import { createHarnessRegistry, type HarnessRegistry } from './registry.js'

/** Real dsh ids: `session-<uuidv4>` — the store DIR name, verbatim. */
const NAT = 'session-86ffe759-cd7b-49a7-955d-c282631a935d'
const NAT2 = 'session-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const SID = `deepseek-harness:${NAT}` as SessionId
const ROOM = 'den-pty-1a2b3c4d'

interface Fakes {
  driver: DeepseekHarnessDriver
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
    host(): DeepseekStoreHost {
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
  const host: DeepseekPtyHost = {
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
  const driver = new DeepseekHarnessDriver({
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

const dshEvent = (
  room: string,
  native: string | undefined,
  body: Record<string, unknown>,
): DenAgentEventLike =>
  ({
    v: 1,
    session: room,
    harness: 'deepseek-harness',
    ...(native ? { harnessSession: native } : {}),
    ...body,
  }) as DenAgentEventLike

const adopt = (f: Fakes, room: string, native: string): void => {
  f.emitDen(dshEvent(room, native, { type: 'session.start', title: 'dsh session' }))
}

describe('capability flags are honest', () => {
  it('reports what is actually wired on this node', () => {
    expect(makeDriver().driver.capabilities).toEqual({
      interrupt: true,
      resume: true,
      approvals: false,
      // Tap is wired; dsh itself emits no assistant/tool hooks today.
      liveStream: true,
      listSessions: true,
    })
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

  it('rejects subscribe with no event tap', () => {
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

describe('startSession is refused — dsh cannot be told what to call a session', () => {
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
  it('mints `deepseek-harness:session-<uuid>` ids from dsh’s own prefixed ids', () => {
    expect(DeepseekHarnessDriver.sessionId(NAT)).toBe(SID)
    expect(NAT).toMatch(/^session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  })

  it('refuses to act on another harness id', async () => {
    const { driver } = makeDriver()
    await expect(driver.getSession('kimi-code:x' as SessionId)).rejects.toMatchObject({
      code: 'invalid_session_id',
    })
  })

  it('lists store rows as canonical summaries', async () => {
    const { driver } = makeDriver({
      rows: [{ id: NAT, command: 'dsh', title: 'review the PR', updatedAt: 1_700_000_000_000 }],
    })
    const [summary] = await driver.listSessions()
    expect(summary).toMatchObject({
      sessionId: SID,
      harnessId: 'deepseek-harness',
      title: 'review the PR',
      cwd: '/home/rivet',
      status: 'ended',
    })
  })

  it('ignores rows from another harness store in the same list', async () => {
    const { driver } = makeDriver({
      rows: [
        { id: NAT, command: 'dsh', title: 'mine', updatedAt: 2 },
        { id: NAT2, command: 'kimi', title: 'not mine', updatedAt: 3 },
      ],
    })
    expect((await driver.listSessions()).map((s) => s.sessionId)).toEqual([SID])
  })
})

describe('adoption — how a dsh session enters the control plane', () => {
  it('binds the den room to dsh’s own id when harnessSession is stamped', async () => {
    const { driver, emitDen } = makeDriver({
      rows: [{ id: NAT, command: 'dsh', title: 't', updatedAt: 5 }],
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

  it('adopts a dsh whose room key IS its canonical id', () => {
    const f = makeDriver()
    const seen: HarnessEvent[] = []
    f.driver.subscribeEvents((e) => seen.push(e))
    f.emitDen({
      v: 1,
      session: SID,
      harness: 'deepseek-harness',
      type: 'session.start',
      title: 'dsh',
    })
    expect(seen).toContainEqual({ type: 'session-updated', sessionId: SID, status: 'idle' })
  })

  it('does not mistake kimi’s underscore id or a junk colon room for a dsh id', () => {
    const f = makeDriver()
    const seen: HarnessEvent[] = []
    f.driver.subscribeEvents((e) => seen.push(e))
    f.emitDen(
      dshEvent(ROOM, 'session_86ffe759-cd7b-49a7-955d-c282631a935d', {
        type: 'session.start',
        title: 'nope',
      }),
    )
    f.emitDen({
      v: 1,
      session: 'deepseek-harness:nope',
      harness: 'deepseek-harness',
      type: 'tool.start',
      tool: 'Bash',
    })
    expect(seen).toEqual([])
  })

  it('adopts a dsh PTY spawned from the /term drawer (synthetic rivetos start)', () => {
    const f = makeDriver()
    const seen: HarnessEvent[] = []
    f.driver.subscribeEvents((e) => seen.push(e))
    f.emitDen({
      v: 1,
      session: ROOM,
      harness: 'rivetos',
      name: 'rivet-node:dsh',
      harnessSession: NAT,
      type: 'session.start',
      title: 'DeepSeek Harness',
    })
    expect(seen).toContainEqual({ type: 'session-updated', sessionId: SID, status: 'idle' })
    const before = seen.length
    f.emitDen({
      v: 1,
      session: 'den-pty-other',
      harness: 'rivetos',
      name: 'rivet-node:kimi',
      harnessSession: NAT2,
      type: 'session.start',
      title: 'Kimi Code',
    })
    expect(seen).toHaveLength(before)
  })
})

describe('resumeSession', () => {
  it('re-spawns with --resume, in a room named after the native id', async () => {
    const { driver, pty } = makeDriver({
      rows: [{ id: NAT, command: 'dsh', title: 't', updatedAt: 2 }],
    })
    const summary = await driver.resumeSession(SID)
    expect(summary.sessionId).toBe(SID)
    expect(pty.spawns).toEqual([{ key: 'dsh', session: NAT, resume: NAT }])
  })

  it('resumes a session dir the store cannot describe yet', async () => {
    const { driver, store, pty } = makeDriver()
    store.sessions.add(NAT)
    await expect(driver.resumeSession(SID)).resolves.toMatchObject({ sessionId: SID })
    expect(pty.spawns).toEqual([{ key: 'dsh', session: NAT, resume: NAT }])
  })

  it('rejects a session the harness store has never heard of', async () => {
    const { driver } = makeDriver()
    await expect(driver.resumeSession(SID)).rejects.toMatchObject({ code: 'invalid_session_id' })
  })

  it('keeps an adopted session in ITS den room rather than opening a second one', async () => {
    const f = makeDriver({ rows: [{ id: NAT, command: 'dsh', title: 't', updatedAt: 1 }] })
    adopt(f, ROOM, NAT)
    await f.driver.resumeSession(SID)
    expect(f.pty.spawns).toEqual([{ key: 'dsh', session: ROOM, resume: NAT }])
  })
})

describe('sendUserTurn', () => {
  it('injects into the PTY of the room the session is running in', async () => {
    const f = makeDriver({ rows: [{ id: NAT, command: 'dsh', title: 't', updatedAt: 1 }] })
    adopt(f, ROOM, NAT)
    await f.driver.sendUserTurn(SID, { text: 'hello' })
    expect(f.pty.spawns).toEqual([{ key: 'dsh', session: ROOM, resume: NAT }])
    expect(f.pty.injects).toEqual([
      { id: 'pty-1', text: 'hello', submit: true, interrupt: undefined },
    ])
  })

  it('re-attaches (--resume) when the PTY was LRU-evicted between turns', async () => {
    const f = makeDriver({ rows: [{ id: NAT, command: 'dsh', title: 't', updatedAt: 2 }] })
    await f.driver.resumeSession(SID)
    f.pty.live.delete(NAT)
    await f.driver.sendUserTurn(SID, { text: 'still there?' })
    expect(f.pty.spawns).toEqual([
      { key: 'dsh', session: NAT, resume: NAT },
      { key: 'dsh', session: NAT, resume: NAT },
    ])
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

  it('registers under the deepseek-harness id and advertises its flags', () => {
    const { registry } = withRegistry()
    expect(registry.list()).toEqual([
      {
        harnessId: 'deepseek-harness',
        capabilities: {
          interrupt: true,
          resume: true,
          approvals: false,
          liveStream: true,
          listSessions: true,
        },
      },
    ])
  })

  it('lists canonical ids, exactly once each', async () => {
    const { registry } = withRegistry([
      { id: NAT, command: 'dsh', title: 'a', updatedAt: 2 },
      { id: NAT2, command: 'dsh', title: 'b', updatedAt: 1 },
    ])
    const ids = (await registry.listSessions('deepseek-harness')).map((s) => s.sessionId)
    expect(ids).toEqual([SID, `deepseek-harness:${NAT2}`])
    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe('roster cwd is read at call time', () => {
  it('reflects an operator edit to den-term.json without a restart', async () => {
    let cwd = '/home/rivet'
    const { driver } = makeDriver({
      rows: [{ id: NAT, command: 'dsh', title: 't', updatedAt: 1, createdAt: 1 }],
      cwd: () => cwd,
    })
    expect((await driver.getSession(SID))?.cwd).toBe('/home/rivet')
    cwd = '/srv/work'
    expect((await driver.getSession(SID))?.cwd).toBe('/srv/work')
  })
})

describe('createdAt does not disagree between list and get', () => {
  it('uses the store row for both paths', async () => {
    const row: HarnessSession = {
      id: NAT,
      command: 'dsh',
      title: 't',
      updatedAt: 1_700_000_100_000,
      createdAt: 1_700_000_000_000,
    }
    const { driver } = makeDriver({ rows: [row] })
    const [listed] = await driver.listSessions()
    const fetched = await driver.getSession(SID)
    expect(listed.createdAt).toBe(new Date(1_700_000_000_000).toISOString())
    expect(fetched?.createdAt).toBe(listed.createdAt)
    expect(fetched?.updatedAt).toBe(listed.updatedAt)
  })
})

describe('transcript', () => {
  it('serves the hard-resync source for a canonical id', async () => {
    const { driver, store } = makeDriver({
      rows: [{ id: NAT, command: 'dsh', title: 't', updatedAt: 1 }],
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
    const driver = new DeepseekHarnessDriver({ store: fakeStore().host(), events: () => off })
    driver.close()
    expect(off).toHaveBeenCalledOnce()
  })
})
