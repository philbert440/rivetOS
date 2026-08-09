// The `hermes` driver over fakes for the two things it wraps: the den term
// manager (PTY spawn/inject/Esc) and the hermes sqlite store. No `hermes`
// binary and no ~/.hermes required.
//
// Mirrors grok-driver.test.ts case for case, plus the four places hermes is
// genuinely different — it cannot pin a new session's id, so the den room key
// is not the native id; it adopts sessions off the den stream; its natives are
// not uuids; and it ROTATES, which the shared conformance suite at the bottom
// exercises end to end through a real registry.

import { describe, expect, it, vi } from 'vitest'
import { HarnessError, type HarnessEvent, type SessionId } from '@rivetos/types'
import type { HarnessSession } from '../term/harness-sessions.js'
import { HermesDriver, type HermesPtyHost, type HermesStoreHost } from './hermes-driver.js'
import type { DenAgentEventLike } from './pty-harness-driver.js'
import { createHarnessRegistry, type HarnessRegistry } from './registry.js'
import { runHarnessRotationConformance } from './test/driver-conformance.js'

/** Real hermes ids: `YYYYMMDD_HHMMSS_<6 hex>`, deliberately not uuids. */
const NAT = '20260802_225647_6ad0b9'
const NAT2 = '20260802_231014_b71c40'
const NAT3 = '20260803_090512_1f9ae2'
const SID = `hermes:${NAT}` as SessionId
/** A den room the term manager minted, because hermes could not be pinned. */
const ROOM = 'den-pty-1a2b3c4d'

interface Fakes {
  driver: HermesDriver
  pty: ReturnType<typeof fakePty>
  store: ReturnType<typeof fakeStore>
  emitDen: (ev: DenAgentEventLike) => void
}

/**
 * `rows` is what `describe`/`list` can see; `sessions` is what `exists` sees.
 * A hermes session row is written the moment the CLI starts, before it has any
 * messages to title it with, so "describable" is a subset of "exists" here too.
 */
function fakeStore(rows: HarnessSession[] = []) {
  const byId = new Map(rows.map((r) => [r.id, r]))
  const sessions = new Set(rows.map((r) => r.id))
  return {
    byId,
    sessions,
    transcripts: new Map<string, { turns: { role: 'user' | 'assistant'; text: string }[] }>(),
    host(): HermesStoreHost {
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
  /** pty ids that refuse writes — the exited-but-not-yet-reaped record. */
  const dead = new Set<string>()
  const host: HermesPtyHost = {
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
  const driver = new HermesDriver({
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

/**
 * What `hermes-den-hook.mjs` posts: the den ROOM in `session`, hermes's own id
 * in `harnessSession`. The two differ for every hermes the driver did not
 * resume itself, which is the whole reason the field exists.
 */
const hermesEvent = (
  room: string,
  native: string | undefined,
  body: Record<string, unknown>,
): DenAgentEventLike =>
  ({
    v: 1,
    session: room,
    harness: 'hermes',
    ...(native ? { harnessSession: native } : {}),
    ...body,
  }) as DenAgentEventLike

/** Adopt a room→session binding the way the first hook event would. */
const adopt = (f: Fakes, room: string, native: string): void => {
  f.emitDen(hermesEvent(room, native, { type: 'session.start', title: 'Hermes' }))
}

describe('capability flags are honest', () => {
  it('reports what is actually wired on this node', () => {
    expect(makeDriver().driver.capabilities).toEqual({
      interrupt: true,
      resume: true,
      // The roster runs `hermes --yolo --accept-hooks` so it never blocks on a
      // prompt, and a hermes shell hook that blocks a tool call is a policy
      // verdict, not a request for a human decision. Never faked true.
      approvals: false,
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

describe('startSession is refused — hermes cannot be told what to call a session', () => {
  it('rejects with capability_unsupported, pinned or not, and spawns nothing', async () => {
    // `--resume`/`--continue` reference EXISTING sessions and there is no
    // new-session-with-this-id flag, so a summary here could only carry a
    // Rivet-invented third id the harness never adopts (§ Rotation, rule 7).
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
  it('mints `hermes:<native>` ids from hermes’s own non-uuid ids', () => {
    expect(HermesDriver.sessionId(NAT)).toBe(SID)
    // Recorded, not fixed: k-sortable, but second-resolution + 24 bits rather
    // than uuid-class entropy. Namespacing it would fork the key away from
    // capture and from hermes's own store, which is the worse failure.
    expect(NAT).toMatch(/^\d{8}_\d{6}_[0-9a-f]{6}$/)
  })

  it('refuses to act on another harness id', async () => {
    const { driver } = makeDriver()
    await expect(driver.getSession('claude-code:x' as SessionId)).rejects.toMatchObject({
      code: 'invalid_session_id',
    })
  })

  it('lists store rows as canonical summaries', async () => {
    const { driver } = makeDriver({
      rows: [{ id: NAT, command: 'hermes', title: 'fix the parser', updatedAt: 1_700_000_000_000 }],
    })
    const [summary] = await driver.listSessions()
    expect(summary).toMatchObject({
      sessionId: SID,
      harnessId: 'hermes',
      title: 'fix the parser',
      cwd: '/home/rivet',
      // on-disk only: the process is gone, though resumeSession revives it
      status: 'ended',
    })
  })

  it('ignores rows from another harness store in the same list', async () => {
    const { driver } = makeDriver({
      rows: [
        { id: NAT, command: 'hermes', title: 'mine', updatedAt: 2 },
        { id: NAT2, command: 'claude', title: 'not mine', updatedAt: 3 },
      ],
    })
    expect((await driver.listSessions()).map((s) => s.sessionId)).toEqual([SID])
  })
})

describe('adoption — how a hermes session enters the control plane', () => {
  it('binds the den room to hermes’s own id on the first hook event', async () => {
    const { driver, emitDen } = makeDriver({
      rows: [{ id: NAT, command: 'hermes', title: 't', updatedAt: 5 }],
    })
    const seen: HarnessEvent[] = []
    driver.subscribeEvents((e) => seen.push(e))
    adopt({ driver, emitDen } as Fakes, ROOM, NAT)

    // The room key never appears on the contract — only hermes's own id does.
    expect(seen).toContainEqual({ type: 'session-updated', sessionId: SID, status: 'idle' })
    await vi.waitFor(() => {
      expect(seen.some((e) => e.type === 'session-created' && e.sessionId === SID)).toBe(true)
    })
    expect(await driver.getSession(SID)).toMatchObject({ sessionId: SID, status: 'idle' })
  })

  it('streams that room’s later events under the bound id', () => {
    const f = makeDriver()
    adopt(f, ROOM, NAT)
    const seen: HarnessEvent[] = []
    f.driver.subscribe(SID, (e) => seen.push(e))
    f.emitDen(hermesEvent(ROOM, NAT, { type: 'message.agent', text: 'hello' }))
    expect(seen).toEqual([{ type: 'assistant-delta', sessionId: SID, text: 'hello' }])
  })

  it('ignores rooms that are not hermes, and the translator’s id-less fallback', () => {
    const f = makeDriver()
    const seen: HarnessEvent[] = []
    f.driver.subscribeEvents((e) => seen.push(e))
    // another harness in its own room
    f.emitDen({ v: 1, session: ROOM, harness: 'grok-build', type: 'session.start', title: 'g' })
    // a hermes the hook could not identify
    f.emitDen(hermesEvent(ROOM, 'unknown-4242', { type: 'session.start', title: 'Hermes' }))
    // a room we have never bound, from a hook too old to send harnessSession
    f.emitDen({ v: 1, session: ROOM, harness: 'hermes', type: 'message.agent', text: 'hi' })
    expect(seen).toEqual([])
  })

  it('adopts a hermes PTY spawned from the /term drawer (synthetic rivetos start)', () => {
    const f = makeDriver()
    const seen: HarnessEvent[] = []
    f.driver.subscribeEvents((e) => seen.push(e))
    // The term manager stamps harness:'rivetos' + name:'<host>:<roster-key>' on
    // the synthetic session.start; the hermes hook then supplies the real id.
    f.emitDen({
      v: 1,
      session: ROOM,
      harness: 'rivetos',
      name: 'rivet-node:hermes',
      harnessSession: NAT,
      type: 'session.start',
      title: 'Hermes',
    })
    expect(seen).toContainEqual({ type: 'session-updated', sessionId: SID, status: 'idle' })
    // …but not for a shell or another harness spawned the same way.
    const before = seen.length
    f.emitDen({
      v: 1,
      session: 'den-pty-other',
      harness: 'rivetos',
      name: 'rivet-node:claude',
      harnessSession: NAT2,
      type: 'session.start',
      title: 'Claude Code',
    })
    expect(seen).toHaveLength(before)
  })

  it('keeps streaming a session it resumed itself when the hook is too old to send the id', async () => {
    // Graceful degradation rather than a guess: a driver-resumed hermes runs in
    // a room named after its own id, so room === native and the old hook's
    // events still map. A drawer-spawned one stays invisible until the hook is
    // updated, which beats inventing an id for it.
    const f = makeDriver({ rows: [{ id: NAT, command: 'hermes', title: 't', updatedAt: 1 }] })
    await f.driver.resumeSession(SID)
    const seen: HarnessEvent[] = []
    f.driver.subscribe(SID, (e) => seen.push(e))
    f.emitDen({ v: 1, session: NAT, harness: 'hermes', type: 'message.agent', text: 'still here' })
    expect(seen).toEqual([{ type: 'assistant-delta', sessionId: SID, text: 'still here' }])
  })
})

describe('resumeSession', () => {
  it('re-spawns with --resume, in a room named after the native id', async () => {
    const { driver, pty } = makeDriver({
      rows: [{ id: NAT, command: 'hermes', title: 't', updatedAt: 2 }],
    })
    const summary = await driver.resumeSession(SID)
    expect(summary.sessionId).toBe(SID)
    // Resume is the one case where hermes's two ids coincide: `--resume <id>`
    // in a den room called `<id>`.
    expect(pty.spawns).toEqual([{ key: 'hermes', session: NAT, resume: NAT }])
  })

  it('resumes a session row the store cannot describe yet', async () => {
    const { driver, store, pty } = makeDriver()
    store.sessions.add(NAT) // a row exists; no messages to title it with
    await expect(driver.resumeSession(SID)).resolves.toMatchObject({ sessionId: SID })
    expect(pty.spawns).toEqual([{ key: 'hermes', session: NAT, resume: NAT }])
  })

  it('rejects a session the harness store has never heard of', async () => {
    const { driver } = makeDriver()
    await expect(driver.resumeSession(SID)).rejects.toMatchObject({ code: 'invalid_session_id' })
  })

  it('keeps an adopted session in ITS den room rather than opening a second one', async () => {
    // The room is the join key den, chat and the PTY share. Re-spawning an
    // evicted hermes must land back in the same room, with --resume carrying
    // the native id.
    const f = makeDriver({ rows: [{ id: NAT, command: 'hermes', title: 't', updatedAt: 1 }] })
    adopt(f, ROOM, NAT)
    await f.driver.resumeSession(SID)
    expect(f.pty.spawns).toEqual([{ key: 'hermes', session: ROOM, resume: NAT }])
  })
})

describe('sendUserTurn', () => {
  it('injects into the PTY of the room the session is running in', async () => {
    const f = makeDriver({ rows: [{ id: NAT, command: 'hermes', title: 't', updatedAt: 1 }] })
    adopt(f, ROOM, NAT)
    await f.driver.sendUserTurn(SID, { text: 'hello' })
    // No live pty for that room yet → spawn-or-get into the same room.
    expect(f.pty.spawns).toEqual([{ key: 'hermes', session: ROOM, resume: NAT }])
    expect(f.pty.injects).toEqual([{ id: 'pty-1', text: 'hello', submit: true, interrupt: undefined }])
  })

  it('re-attaches (--resume) when the PTY was LRU-evicted between turns', async () => {
    const f = makeDriver({ rows: [{ id: NAT, command: 'hermes', title: 't', updatedAt: 2 }] })
    await f.driver.resumeSession(SID)
    f.pty.live.delete(NAT) // evicted
    await f.driver.sendUserTurn(SID, { text: 'still there?' })
    expect(f.pty.spawns).toEqual([
      { key: 'hermes', session: NAT, resume: NAT },
      { key: 'hermes', session: NAT, resume: NAT },
    ])
  })

  it('re-spawns through --resume when the pty exited but has not been reaped', async () => {
    const f = makeDriver({ rows: [{ id: NAT, command: 'hermes', title: 't', updatedAt: 2 }] })
    await f.driver.resumeSession(SID)
    f.pty.dead.add('pty-1') // exited, mapping lingers
    await expect(f.driver.sendUserTurn(SID, { text: 'still there?' })).resolves.toBeUndefined()
    expect(f.pty.spawns).toHaveLength(2)
    expect(f.pty.injects.at(-1)).toMatchObject({ id: 'pty-2', text: 'still there?' })
  })

  it('reports turn_in_flight (retryable) when even a fresh pty refuses the write', async () => {
    const f = makeDriver({ rows: [{ id: NAT, command: 'hermes', title: 't', updatedAt: 2 }] })
    await f.driver.resumeSession(SID)
    f.pty.setWritable(false)
    await expect(f.driver.sendUserTurn(SID, { text: 'hi' })).rejects.toMatchObject({
      code: 'turn_in_flight',
      retryable: true,
    })
  })

  it('rejects with turn_in_flight rather than silently queueing', async () => {
    const f = makeDriver({ rows: [{ id: NAT, command: 'hermes', title: 't', updatedAt: 2 }] })
    await f.driver.resumeSession(SID)
    await f.driver.sendUserTurn(SID, { text: 'one' })
    await expect(f.driver.sendUserTurn(SID, { text: 'two' })).rejects.toMatchObject({
      code: 'turn_in_flight',
      retryable: true,
    })
  })

  it('releases the lock on turn.end so the next turn goes through', async () => {
    // hermes's turn.end comes from post_llm_call, which fires once per turn
    // after the tool loop produced the final response.
    const f = makeDriver({ rows: [{ id: NAT, command: 'hermes', title: 't', updatedAt: 2 }] })
    await f.driver.resumeSession(SID)
    await f.driver.sendUserTurn(SID, { text: 'one' })
    f.emitDen(hermesEvent(NAT, NAT, { type: 'turn.end' }))
    await expect(f.driver.sendUserTurn(SID, { text: 'two' })).resolves.toBeUndefined()
  })
})

describe('interrupt', () => {
  it('sends Esc to the room’s PTY and completes the turn as interrupted', async () => {
    const f = makeDriver({ rows: [{ id: NAT, command: 'hermes', title: 't', updatedAt: 2 }] })
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
  it('streams assistant text, paired tool calls, and turn completion', () => {
    const f = makeDriver()
    adopt(f, ROOM, NAT)
    const seen: HarnessEvent[] = []
    const off = f.driver.subscribe(SID, (e) => seen.push(e))

    f.emitDen(hermesEvent(ROOM, NAT, { type: 'tool.start', tool: 'terminal' }))
    f.emitDen(hermesEvent(ROOM, NAT, { type: 'tool.end', tool: 'terminal' }))
    f.emitDen(hermesEvent(ROOM, NAT, { type: 'message.agent', text: 'done' }))
    f.emitDen(hermesEvent(ROOM, NAT, { type: 'turn.end' }))
    off()
    f.emitDen(hermesEvent(ROOM, NAT, { type: 'message.agent', text: 'after unsubscribe' }))

    expect(seen.filter((e) => e.type === 'tool-use')).toEqual([
      { type: 'tool-use', sessionId: SID, toolCallId: `${NAT}:t1`, name: 'terminal', input: {} },
    ])
    expect(seen.filter((e) => e.type === 'tool-result')).toEqual([
      {
        type: 'tool-result',
        sessionId: SID,
        toolCallId: `${NAT}:t1`,
        name: 'terminal',
        // den's tool.end carries no body and no failure flag — hermes's hook
        // collapses post_tool_call and post_tool_call_failure into it.
        output: null,
      },
    ])
    expect(seen).toContainEqual({ type: 'assistant-delta', sessionId: SID, text: 'done' })
    expect(seen).toContainEqual({ type: 'turn-complete', sessionId: SID, stopReason: 'end-turn' })
    expect(seen.some((e) => e.type === 'assistant-delta' && e.text === 'after unsubscribe')).toBe(
      false,
    )
  })

  it('ignores den-UI-only events the hermes hook also emits', () => {
    const f = makeDriver()
    adopt(f, ROOM, NAT)
    const seen: HarnessEvent[] = []
    f.driver.subscribe(SID, (e) => seen.push(e))
    for (const ev of [
      { type: 'message.user', text: 'hi' },
      { type: 'activity', activity: 'thinking' },
      { type: 'thinking.end' },
      { type: 'speech.stt', active: true },
    ]) {
      f.emitDen(hermesEvent(ROOM, NAT, ev))
    }
    expect(seen).toEqual([])
  })

  it('marks a session ended when its harness exits', () => {
    const f = makeDriver()
    adopt(f, ROOM, NAT)
    const seen: HarnessEvent[] = []
    f.driver.subscribeEvents((e) => seen.push(e))
    f.emitDen(hermesEvent(ROOM, NAT, { type: 'session.end' }))
    expect(seen).toContainEqual({ type: 'session-updated', sessionId: SID, status: 'ended' })
  })
})

describe('rotation — the driver’s whole part in it', () => {
  it('emits session-updated with previousSessionId when the room’s id changes', () => {
    const f = makeDriver()
    adopt(f, ROOM, NAT)
    const registry: HarnessEvent[] = []
    f.driver.subscribeEvents((e) => registry.push(e))

    // /new, /branch, a mid-chat /resume, a rewind, or a compaction that forked
    // a child session — indistinguishable on the den wire, and all of them are
    // "this room's session id was replaced".
    f.emitDen(hermesEvent(ROOM, NAT2, { type: 'session.start', title: 'Hermes' }))

    expect(registry).toContainEqual({
      type: 'session-updated',
      sessionId: `hermes:${NAT2}`,
      previousSessionId: SID,
      status: 'idle',
    })
  })

  it('delivers it to a sink still attached under the old id, exactly once', () => {
    const f = makeDriver()
    adopt(f, ROOM, NAT)
    const seen: HarnessEvent[] = []
    f.driver.subscribe(SID, (e) => seen.push(e))
    f.emitDen(hermesEvent(ROOM, NAT2, { type: 'session.start', title: 'Hermes' }))
    expect(seen.filter((e) => e.type === 'session-updated' && e.previousSessionId)).toHaveLength(1)
  })

  it('does NOT re-key its own sinks — that is control-plane work', () => {
    // A driver that moved the sink itself would leave the tail attached twice
    // once the registry attaches it too, doubling every later event.
    const f = makeDriver()
    adopt(f, ROOM, NAT)
    const seen: HarnessEvent[] = []
    f.driver.subscribe(SID, (e) => seen.push(e))
    f.emitDen(hermesEvent(ROOM, NAT2, { type: 'session.start', title: 'Hermes' }))
    seen.length = 0
    f.emitDen(hermesEvent(ROOM, NAT2, { type: 'message.agent', text: 'after' }))
    expect(seen).toEqual([])
  })

  it('carries an in-flight turn across the rotation instead of wedging it', async () => {
    // A compaction can fork the session mid-turn. The turn lock and the open
    // tool calls move with the id; the old key stops being tracked.
    const f = makeDriver({ rows: [{ id: NAT, command: 'hermes', title: 't', updatedAt: 1 }] })
    await f.driver.resumeSession(SID)
    await f.driver.sendUserTurn(SID, { text: 'long one' })
    f.emitDen(hermesEvent(NAT, NAT2, { type: 'session.start', title: 'Hermes' }))

    const next = `hermes:${NAT2}` as SessionId
    expect(await f.driver.getSession(next)).toMatchObject({ status: 'active' })
    await expect(f.driver.sendUserTurn(next, { text: 'too soon' })).rejects.toMatchObject({
      code: 'turn_in_flight',
    })
    f.emitDen(hermesEvent(NAT, NAT2, { type: 'turn.end' }))
    await expect(f.driver.sendUserTurn(next, { text: 'now' })).resolves.toBeUndefined()
  })

  it('restating the same id is not a rotation', () => {
    const f = makeDriver()
    adopt(f, ROOM, NAT)
    const registry: HarnessEvent[] = []
    f.driver.subscribeEvents((e) => registry.push(e))
    f.emitDen(hermesEvent(ROOM, NAT, { type: 'session.start', title: 'Hermes' }))
    expect(registry.filter((e) => e.type === 'session-updated' && e.previousSessionId)).toEqual([])
  })
})

describe('through the real registry', () => {
  const withRegistry = (rows: HarnessSession[] = []): { fakes: Fakes; registry: HarnessRegistry } => {
    const fakes = makeDriver({ rows })
    const registry = createHarnessRegistry()
    registry.register(fakes.driver)
    return { fakes, registry }
  }

  it('registers under the hermes harness id and advertises its flags', () => {
    const { registry } = withRegistry()
    expect(registry.list()).toEqual([
      {
        harnessId: 'hermes',
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
      { id: NAT, command: 'hermes', title: 'a', updatedAt: 2 },
      { id: NAT2, command: 'hermes', title: 'b', updatedAt: 1 },
    ])
    const ids = (await registry.listSessions('hermes')).map((s) => s.sessionId)
    expect(ids).toEqual([SID, `hermes:${NAT2}`])
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('delivers the live tail through subscribeSession, and stops on unsubscribe', () => {
    const { fakes, registry } = withRegistry()
    adopt(fakes, ROOM, NAT)
    const seen: HarnessEvent[] = []
    const off = registry.subscribeSession(SID, (e) => seen.push(e))
    fakes.emitDen(hermesEvent(ROOM, NAT, { type: 'message.agent', text: 'hello' }))
    off()
    fakes.emitDen(hermesEvent(ROOM, NAT, { type: 'message.agent', text: 'after' }))
    expect(seen).toEqual([{ type: 'assistant-delta', sessionId: SID, text: 'hello' }])
    registry.close()
  })
})

describe('roster cwd is read at call time', () => {
  it('reflects an operator edit to den-term.json without a restart', async () => {
    let cwd = '/home/rivet'
    const { driver } = makeDriver({
      rows: [{ id: NAT, command: 'hermes', title: 't', updatedAt: 1, createdAt: 1 }],
      cwd: () => cwd,
    })
    expect((await driver.getSession(SID))?.cwd).toBe('/home/rivet')
    cwd = '/srv/work'
    expect((await driver.getSession(SID))?.cwd).toBe('/srv/work')
  })
})

describe('createdAt does not disagree between list and get', () => {
  it('uses the store row for both paths (sessions.started_at)', async () => {
    const row: HarnessSession = {
      id: NAT,
      command: 'hermes',
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
      rows: [{ id: NAT, command: 'hermes', title: 't', updatedAt: 1 }],
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
    const driver = new HermesDriver({ store: fakeStore().host(), events: () => off })
    driver.close()
    expect(off).toHaveBeenCalledOnce()
  })
})

// ── the shared contract ─────────────────────────────────────────────────────
// The rotation gate's acceptance test, run against the real driver and a real
// registry — hermes is the first driver with a rotation to drive it with. Each
// rotation is what hermes does in production: the same den room reports a new
// `harnessSession`.
runHarnessRotationConformance('hermes', () => {
  const fakes = makeDriver({
    rows: [
      { id: NAT, command: 'hermes', title: 'first', updatedAt: 1_700_000_000_000 },
      { id: NAT2, command: 'hermes', title: 'second', updatedAt: 1_700_000_100_000 },
      { id: NAT3, command: 'hermes', title: 'third', updatedAt: 1_700_000_200_000 },
    ],
  })
  adopt(fakes, ROOM, NAT)
  const registry = createHarnessRegistry()
  registry.register(fakes.driver)
  /** hermes ids are not uuids, so mint the next one in hermes's own shape. */
  let minted = 0
  return {
    registry,
    driver: fakes.driver,
    sessionId: SID,
    rotate: () => {
      // `from` is always whatever the room is running right now — that is what
      // makes this a rotation rather than a second session — so the room key is
      // all the driver needs to be told.
      const next = [NAT2, NAT3][minted++] ?? `20260803_1200${String(minted).padStart(2, '0')}_ffffff`
      fakes.emitDen(hermesEvent(ROOM, next, { type: 'session.start', title: 'Hermes' }))
      return `hermes:${next}` as SessionId
    },
    emitActivity: (id) => {
      fakes.emitDen(hermesEvent(ROOM, id.slice('hermes:'.length), {
        type: 'message.agent',
        text: 'still going',
      }))
    },
    teardown: () => {
      registry.close()
      fakes.driver.close()
    },
  }
})
