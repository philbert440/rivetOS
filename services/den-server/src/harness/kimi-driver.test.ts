// The `kimi-code` driver over fakes for the two things it wraps: the den term
// manager (PTY spawn/inject/Esc) and the kimi on-disk store. No `kimi` binary
// and no ~/.kimi-code required.
//
// Mirrors hermes-driver.test.ts case for case — the two harnesses share the
// "cannot pin a new session's id" shape — plus the three places kimi is its own
// thing: its natives are `session_<uuid>` rather than a timestamp, a kimi
// running outside den announces itself through the ROOM KEY (its hook posts
// under the canonical id when nothing pins a room), and its live stream carries
// no assistant text and no thinking, which is asserted here rather than papered
// over.

import { describe, expect, it, vi } from 'vitest'
import { HarnessError, type HarnessEvent, type SessionId } from '@rivetos/types'
import type { HarnessSession } from '../term/harness-sessions.js'
import { KimiCodeDriver, type KimiPtyHost, type KimiStoreHost } from './kimi-driver.js'
import type { DenAgentEventLike } from './pty-harness-driver.js'
import { createHarnessRegistry, type HarnessRegistry } from './registry.js'
import { runHarnessRotationConformance } from './test/driver-conformance.js'

/** Real kimi ids: `session_<uuidv4>` — the store DIR name, verbatim. */
const NAT = 'session_89965427-b96f-4d5e-8ad5-c3dd138e33dc'
const NAT2 = 'session_42accb06-524a-47a6-b4b3-0991552914d7'
const NAT3 = 'session_15cb936c-3364-49d6-8769-21f0c635f160'
const SID = `kimi-code:${NAT}` as SessionId
/** A den room the term manager minted, because kimi could not be pinned. */
const ROOM = 'den-pty-1a2b3c4d'

interface Fakes {
  driver: KimiCodeDriver
  pty: ReturnType<typeof fakePty>
  store: ReturnType<typeof fakeStore>
  emitDen: (ev: DenAgentEventLike) => void
}

/**
 * `rows` is what `describe`/`list` can see; `sessions` is what `exists` sees.
 * kimi creates the session DIR, then writes `state.json`, so "describable" is a
 * strict subset of "exists" here too.
 */
function fakeStore(rows: HarnessSession[] = []) {
  const byId = new Map(rows.map((r) => [r.id, r]))
  const sessions = new Set(rows.map((r) => r.id))
  return {
    byId,
    sessions,
    transcripts: new Map<string, { turns: { role: 'user' | 'assistant'; text: string }[] }>(),
    host(): KimiStoreHost {
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
  const host: KimiPtyHost = {
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
  const driver = new KimiCodeDriver({
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
 * What `kimi-den-hook.mjs` posts: the den ROOM in `session`, kimi's own id in
 * `harnessSession`. The two differ for every kimi the driver did not resume
 * itself, which is why the hook reports both.
 */
const kimiEvent = (
  room: string,
  native: string | undefined,
  body: Record<string, unknown>,
): DenAgentEventLike =>
  ({
    v: 1,
    session: room,
    harness: 'kimi-code',
    ...(native ? { harnessSession: native } : {}),
    ...body,
  }) as DenAgentEventLike

/** Adopt a room→session binding the way the first hook event would. */
const adopt = (f: Fakes, room: string, native: string): void => {
  f.emitDen(kimiEvent(room, native, { type: 'session.start', title: 'kimi session' }))
}

describe('capability flags are honest', () => {
  it('reports what is actually wired on this node', () => {
    expect(makeDriver().driver.capabilities).toEqual({
      // Esc is kimi's own documented interrupt key ("Close dialogs / interrupt
      // streaming"), which is exactly what the term manager injects.
      interrupt: true,
      // `kimi --session <id>` through the term manager's spawn-or-get. Note it
      // is RESUME-only: an unknown id fails with `Session "…" not found`, which
      // is why this driver cannot start one.
      resume: true,
      // kimi owns permission prompts inside its TUI, its den translator leaves
      // PermissionRequest/PermissionResult unmapped, and the roster runs
      // `kimi --yolo` so ordinary tool calls never prompt. Never faked true.
      approvals: false,
      // True for what the stream really carries — session lifecycle, tools,
      // turn boundaries. kimi contributes no assistant or thinking text (see
      // the "what the live stream does not carry" suite below), and that is a
      // gap in the harness's hooks, not in the tap.
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

describe('startSession is refused — kimi cannot be told what to call a session', () => {
  it('rejects with capability_unsupported, pinned or not, and spawns nothing', async () => {
    // `-S/--session` and `--continue` reference EXISTING sessions and there is
    // no `--session-id`, so a summary here could only carry a Rivet-invented
    // third id the harness never adopts (§ Rotation, rule 7).
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
  it('mints `kimi-code:session_<uuid>` ids from kimi’s own prefixed ids', () => {
    expect(KimiCodeDriver.sessionId(NAT)).toBe(SID)
    // uuid-class entropy behind a fixed prefix: namespacing is enough for the
    // collision rule, and the prefix is why the registry's bare-uuid probe
    // never resolves a kimi id — clients send the canonical form.
    expect(NAT).toMatch(/^session_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  })

  it('refuses to act on another harness id', async () => {
    const { driver } = makeDriver()
    await expect(driver.getSession('hermes:x' as SessionId)).rejects.toMatchObject({
      code: 'invalid_session_id',
    })
  })

  it('lists store rows as canonical summaries', async () => {
    const { driver } = makeDriver({
      rows: [{ id: NAT, command: 'kimi', title: 'review the PR', updatedAt: 1_700_000_000_000 }],
    })
    const [summary] = await driver.listSessions()
    expect(summary).toMatchObject({
      sessionId: SID,
      harnessId: 'kimi-code',
      title: 'review the PR',
      cwd: '/home/rivet',
      // on-disk only: the process is gone, though resumeSession revives it
      status: 'ended',
    })
  })

  it('ignores rows from another harness store in the same list', async () => {
    const { driver } = makeDriver({
      rows: [
        { id: NAT, command: 'kimi', title: 'mine', updatedAt: 2 },
        { id: NAT2, command: 'grok', title: 'not mine', updatedAt: 3 },
      ],
    })
    expect((await driver.listSessions()).map((s) => s.sessionId)).toEqual([SID])
  })
})

describe('adoption — how a kimi session enters the control plane', () => {
  it('binds the den room to kimi’s own id on the first hook event', async () => {
    const { driver, emitDen } = makeDriver({
      rows: [{ id: NAT, command: 'kimi', title: 't', updatedAt: 5 }],
    })
    const seen: HarnessEvent[] = []
    driver.subscribeEvents((e) => seen.push(e))
    adopt({ driver, emitDen } as Fakes, ROOM, NAT)

    // The room key never appears on the contract — only kimi's own id does.
    expect(seen).toContainEqual({ type: 'session-updated', sessionId: SID, status: 'idle' })
    await vi.waitFor(() => {
      expect(seen.some((e) => e.type === 'session-created' && e.sessionId === SID)).toBe(true)
    })
    expect(await driver.getSession(SID)).toMatchObject({ sessionId: SID, status: 'idle' })
  })

  it('adopts a kimi running OUTSIDE den, whose room key IS its canonical id', () => {
    // With no RIVET_DEN_SESSION to pin a room, kimi's hook posts under
    // `kimi-code:<native>` — the same key its rivet-memory capture writes. That
    // room announces its own native id, so the driver adopts it even from a
    // hook too old to send `harnessSession`.
    const f = makeDriver()
    const seen: HarnessEvent[] = []
    f.driver.subscribeEvents((e) => seen.push(e))
    f.emitDen({ v: 1, session: SID, harness: 'kimi-code', type: 'session.start', title: 'kimi' })
    expect(seen).toContainEqual({ type: 'session-updated', sessionId: SID, status: 'idle' })
  })

  it('does not mistake an arbitrary colon-bearing room key for a canonical id', () => {
    const f = makeDriver()
    const seen: HarnessEvent[] = []
    f.driver.subscribeEvents((e) => seen.push(e))
    f.emitDen({ v: 1, session: 'kimi-code:nope', harness: 'kimi-code', type: 'tool.start', tool: 'Bash' })
    f.emitDen({ v: 1, session: 'host:kimi', harness: 'kimi-code', type: 'tool.start', tool: 'Bash' })
    expect(seen).toEqual([])
  })

  it('streams that room’s later events under the bound id', () => {
    const f = makeDriver()
    adopt(f, ROOM, NAT)
    const seen: HarnessEvent[] = []
    f.driver.subscribe(SID, (e) => seen.push(e))
    f.emitDen(kimiEvent(ROOM, NAT, { type: 'tool.start', tool: 'Bash' }))
    expect(seen).toEqual([
      { type: 'tool-use', sessionId: SID, toolCallId: `${NAT}:t1`, name: 'Bash', input: {} },
    ])
  })

  it('ignores rooms that are not kimi, and the translator’s id-less fallback', () => {
    const f = makeDriver()
    const seen: HarnessEvent[] = []
    f.driver.subscribeEvents((e) => seen.push(e))
    // another harness in its own room
    f.emitDen({ v: 1, session: ROOM, harness: 'hermes', type: 'session.start', title: 'h' })
    // a kimi the hook could not identify: `unknown-<hex>` is a room key the
    // translator invented, never a store id, and resuming one would ask the CLI
    // for a session that does not exist.
    f.emitDen(kimiEvent(ROOM, 'unknown-4242abcd4242abcd', { type: 'session.start', title: 'kimi' }))
    // a room we have never bound, from a hook too old to send harnessSession
    f.emitDen({ v: 1, session: ROOM, harness: 'kimi-code', type: 'tool.start', tool: 'Bash' })
    expect(seen).toEqual([])
  })

  it('adopts a kimi PTY spawned from the /term drawer (synthetic rivetos start)', () => {
    const f = makeDriver()
    const seen: HarnessEvent[] = []
    f.driver.subscribeEvents((e) => seen.push(e))
    // The term manager stamps harness:'rivetos' + name:'<host>:<roster-key>' on
    // the synthetic session.start; the kimi hook then supplies the real id.
    f.emitDen({
      v: 1,
      session: ROOM,
      harness: 'rivetos',
      name: 'rivet-node:kimi',
      harnessSession: NAT,
      type: 'session.start',
      title: 'Kimi Code',
    })
    expect(seen).toContainEqual({ type: 'session-updated', sessionId: SID, status: 'idle' })
    // …but not for a shell or another harness spawned the same way.
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
    // Graceful degradation rather than a guess: a driver-resumed kimi runs in a
    // room named after its own id, so room === native and the old hook's events
    // still map.
    const f = makeDriver({ rows: [{ id: NAT, command: 'kimi', title: 't', updatedAt: 1 }] })
    await f.driver.resumeSession(SID)
    const seen: HarnessEvent[] = []
    f.driver.subscribe(SID, (e) => seen.push(e))
    f.emitDen({ v: 1, session: NAT, harness: 'kimi-code', type: 'tool.start', tool: 'Read' })
    expect(seen).toEqual([
      { type: 'tool-use', sessionId: SID, toolCallId: `${NAT}:t1`, name: 'Read', input: {} },
    ])
  })
})

describe('resumeSession', () => {
  it('re-spawns with --session, in a room named after the native id', async () => {
    const { driver, pty } = makeDriver({
      rows: [{ id: NAT, command: 'kimi', title: 't', updatedAt: 2 }],
    })
    const summary = await driver.resumeSession(SID)
    expect(summary.sessionId).toBe(SID)
    // Resume is the one case where kimi's two ids coincide: the term manager
    // spawns `kimi --session <id>` into a den room called `<id>`.
    expect(pty.spawns).toEqual([{ key: 'kimi', session: NAT, resume: NAT }])
  })

  it('resumes a session dir the store cannot describe yet', async () => {
    const { driver, store, pty } = makeDriver()
    store.sessions.add(NAT) // dir exists; state.json not written yet
    await expect(driver.resumeSession(SID)).resolves.toMatchObject({ sessionId: SID })
    expect(pty.spawns).toEqual([{ key: 'kimi', session: NAT, resume: NAT }])
  })

  it('rejects a session the harness store has never heard of', async () => {
    const { driver } = makeDriver()
    await expect(driver.resumeSession(SID)).rejects.toMatchObject({ code: 'invalid_session_id' })
  })

  it('keeps an adopted session in ITS den room rather than opening a second one', async () => {
    const f = makeDriver({ rows: [{ id: NAT, command: 'kimi', title: 't', updatedAt: 1 }] })
    adopt(f, ROOM, NAT)
    await f.driver.resumeSession(SID)
    expect(f.pty.spawns).toEqual([{ key: 'kimi', session: ROOM, resume: NAT }])
  })
})

describe('sendUserTurn', () => {
  it('injects into the PTY of the room the session is running in', async () => {
    const f = makeDriver({ rows: [{ id: NAT, command: 'kimi', title: 't', updatedAt: 1 }] })
    adopt(f, ROOM, NAT)
    await f.driver.sendUserTurn(SID, { text: 'hello' })
    expect(f.pty.spawns).toEqual([{ key: 'kimi', session: ROOM, resume: NAT }])
    expect(f.pty.injects).toEqual([
      { id: 'pty-1', text: 'hello', submit: true, interrupt: undefined },
    ])
  })

  it('re-attaches (--session) when the PTY was LRU-evicted between turns', async () => {
    const f = makeDriver({ rows: [{ id: NAT, command: 'kimi', title: 't', updatedAt: 2 }] })
    await f.driver.resumeSession(SID)
    f.pty.live.delete(NAT) // evicted
    await f.driver.sendUserTurn(SID, { text: 'still there?' })
    expect(f.pty.spawns).toEqual([
      { key: 'kimi', session: NAT, resume: NAT },
      { key: 'kimi', session: NAT, resume: NAT },
    ])
  })

  it('re-spawns through --session when the pty exited but has not been reaped', async () => {
    const f = makeDriver({ rows: [{ id: NAT, command: 'kimi', title: 't', updatedAt: 2 }] })
    await f.driver.resumeSession(SID)
    f.pty.dead.add('pty-1')
    await expect(f.driver.sendUserTurn(SID, { text: 'still there?' })).resolves.toBeUndefined()
    expect(f.pty.spawns).toHaveLength(2)
    expect(f.pty.injects.at(-1)).toMatchObject({ id: 'pty-2', text: 'still there?' })
  })

  it('reports turn_in_flight (retryable) when even a fresh pty refuses the write', async () => {
    const f = makeDriver({ rows: [{ id: NAT, command: 'kimi', title: 't', updatedAt: 2 }] })
    await f.driver.resumeSession(SID)
    f.pty.setWritable(false)
    await expect(f.driver.sendUserTurn(SID, { text: 'hi' })).rejects.toMatchObject({
      code: 'turn_in_flight',
      retryable: true,
    })
  })

  it('rejects with turn_in_flight rather than silently queueing', async () => {
    const f = makeDriver({ rows: [{ id: NAT, command: 'kimi', title: 't', updatedAt: 2 }] })
    await f.driver.resumeSession(SID)
    await f.driver.sendUserTurn(SID, { text: 'one' })
    await expect(f.driver.sendUserTurn(SID, { text: 'two' })).rejects.toMatchObject({
      code: 'turn_in_flight',
      retryable: true,
    })
  })

  it('releases the lock on turn.end so the next turn goes through', async () => {
    // kimi routes a finished turn to exactly ONE of Stop / StopFailure /
    // Interrupt, and the translator emits turn.end from whichever fired.
    const f = makeDriver({ rows: [{ id: NAT, command: 'kimi', title: 't', updatedAt: 2 }] })
    await f.driver.resumeSession(SID)
    await f.driver.sendUserTurn(SID, { text: 'one' })
    f.emitDen(kimiEvent(NAT, NAT, { type: 'turn.end' }))
    await expect(f.driver.sendUserTurn(SID, { text: 'two' })).resolves.toBeUndefined()
  })
})

describe('interrupt', () => {
  it('sends Esc to the room’s PTY and completes the turn as interrupted', async () => {
    const f = makeDriver({ rows: [{ id: NAT, command: 'kimi', title: 't', updatedAt: 2 }] })
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

    f.emitDen(kimiEvent(ROOM, NAT, { type: 'tool.start', tool: 'Bash', args: { command: 'ls' } }))
    f.emitDen(kimiEvent(ROOM, NAT, { type: 'tool.end', tool: 'Bash' }))
    f.emitDen(kimiEvent(ROOM, NAT, { type: 'turn.end' }))
    off()
    f.emitDen(kimiEvent(ROOM, NAT, { type: 'tool.start', tool: 'Read' }))

    expect(seen.filter((e) => e.type === 'tool-use')).toEqual([
      {
        type: 'tool-use',
        sessionId: SID,
        toolCallId: `${NAT}:t1`,
        // kimi's own tool vocabulary, passed through — never renamed to
        // Claude's.
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
        // den's tool.end carries no body and no failure flag — kimi's hook
        // collapses PostToolUse and PostToolUseFailure into it. The `isError`
        // kimi records in wire.jsonl surfaces on `transcript()` instead.
        output: null,
      },
    ])
    expect(seen).toContainEqual({ type: 'turn-complete', sessionId: SID, stopReason: 'end-turn' })
    expect(seen.some((e) => e.type === 'tool-use' && e.name === 'Read')).toBe(false)
  })

  it('ignores den-UI-only events the kimi hook also emits', () => {
    const f = makeDriver()
    adopt(f, ROOM, NAT)
    const seen: HarnessEvent[] = []
    f.driver.subscribe(SID, (e) => seen.push(e))
    for (const ev of [
      { type: 'message.user', text: 'hi' },
      { type: 'activity', activity: 'thinking' },
      { type: 'thinking.end' },
      { type: 'speech.stt', active: true },
      { type: 'task.plan', tasks: ['a', 'b'] },
      { type: 'task.check', index: 0 },
      { type: 'term.line', text: '$ ls' },
    ]) {
      f.emitDen(kimiEvent(ROOM, NAT, ev))
    }
    expect(seen).toEqual([])
  })

  it('marks a session ended when its harness exits', () => {
    const f = makeDriver()
    adopt(f, ROOM, NAT)
    const seen: HarnessEvent[] = []
    f.driver.subscribeEvents((e) => seen.push(e))
    f.emitDen(kimiEvent(ROOM, NAT, { type: 'session.end' }))
    expect(seen).toContainEqual({ type: 'session-updated', sessionId: SID, status: 'ended' })
  })
})

describe('what the live stream does NOT carry — stated, not faked', () => {
  it('emits no assistant-delta and no reasoning-delta, because kimi emits neither source', () => {
    // kimi's `Stop` payload is `{ stop_hook_active }` — no reply text — and no
    // kimi hook is given thinking text at all, so its den translator emits
    // neither `message.agent` nor `thinking.delta`. This pins the honest
    // consequence: a kimi conversation's assistant text and thoughts come from
    // `transcript()` (wire.jsonl `content.part` text/think parts), not the tap.
    const f = makeDriver()
    adopt(f, ROOM, NAT)
    const seen: HarnessEvent[] = []
    f.driver.subscribe(SID, (e) => seen.push(e))
    f.emitDen(kimiEvent(ROOM, NAT, { type: 'tool.start', tool: 'Bash' }))
    f.emitDen(kimiEvent(ROOM, NAT, { type: 'thinking.end' }))
    f.emitDen(kimiEvent(ROOM, NAT, { type: 'turn.end' }))
    expect(seen.some((e) => e.type === 'assistant-delta')).toBe(false)
    expect(seen.some((e) => e.type === 'reasoning-delta')).toBe(false)
  })

  it('still folds both the day kimi’s hooks learn to send them', () => {
    // The mapping is the base's and is not conditioned on the harness — this is
    // a gap in kimi's hooks, not a hole in the driver, and the follow-up that
    // closes it needs no driver change.
    const f = makeDriver()
    adopt(f, ROOM, NAT)
    const seen: HarnessEvent[] = []
    f.driver.subscribe(SID, (e) => seen.push(e))
    f.emitDen(kimiEvent(ROOM, NAT, { type: 'message.agent', text: 'done' }))
    f.emitDen(kimiEvent(ROOM, NAT, { type: 'thinking.delta', text: 'hmm' }))
    expect(seen).toEqual([
      { type: 'assistant-delta', sessionId: SID, text: 'done' },
      { type: 'reasoning-delta', sessionId: SID, text: 'hmm' },
    ])
  })
})

describe('kimi never renames its own session — the non-rotation pin', () => {
  /**
   * Verified against kimi 0.34.0 rather than assumed:
   *   - `/clear` is `clearContext({ sessionId })` — an RPC scoped to the
   *     RUNNING session, which appends a `context.clear` record to the same
   *     `wire.jsonl`.
   *   - compaction likewise appends `context.apply_compaction` in place.
   *   - `kimi --session <id>` replays the same session dir under the same id.
   *   - a native id is minted in exactly one place, `createSession` at process
   *     start.
   * None of those is observable on the den wire as a previous→new pair, and
   * none of them is one.
   */
  it('emits no rotation across a compaction (PreCompact/PostCompact carry no ids)', () => {
    const f = makeDriver()
    adopt(f, ROOM, NAT)
    const seen: HarnessEvent[] = []
    f.driver.subscribeEvents((e) => seen.push(e))
    // What the kimi translator actually posts for PreCompact / PostCompact.
    f.emitDen(kimiEvent(ROOM, NAT, { type: 'thinking.end' }))
    f.emitDen(kimiEvent(ROOM, NAT, { type: 'activity', activity: 'sleeping' }))
    f.emitDen(kimiEvent(ROOM, NAT, { type: 'activity', activity: 'thinking' }))
    expect(seen.filter((e) => e.type === 'session-updated' && e.previousSessionId)).toEqual([])
  })

  it('restating the same id is a status update, not a rotation', () => {
    const f = makeDriver()
    adopt(f, ROOM, NAT)
    const seen: HarnessEvent[] = []
    f.driver.subscribeEvents((e) => seen.push(e))
    f.emitDen(kimiEvent(ROOM, NAT, { type: 'session.start', title: 'kimi session' }))
    expect(seen.filter((e) => e.type === 'session-updated' && e.previousSessionId)).toEqual([])
  })

  it('a resume keeps the id it was asked for', async () => {
    const f = makeDriver({ rows: [{ id: NAT, command: 'kimi', title: 't', updatedAt: 1 }] })
    const seen: HarnessEvent[] = []
    f.driver.subscribeEvents((e) => seen.push(e))
    expect((await f.driver.resumeSession(SID)).sessionId).toBe(SID)
    f.emitDen(kimiEvent(NAT, NAT, { type: 'session.start', title: 'kimi session' }))
    expect(seen.filter((e) => e.type === 'session-updated' && e.previousSessionId)).toEqual([])
  })
})

describe('a den room CAN change which kimi it runs — that is the rotation', () => {
  // The narrow case that remains: a room whose PTY was reaped and re-spawned
  // fresh is running a different kimi than it was, and the room is the
  // conversation every attached client is watching. So the native id behind
  // this session id has been replaced, which is exactly what
  // `previousSessionId` means.
  it('emits session-updated with previousSessionId when the room’s id changes', () => {
    const f = makeDriver()
    adopt(f, ROOM, NAT)
    const registry: HarnessEvent[] = []
    f.driver.subscribeEvents((e) => registry.push(e))
    f.emitDen(kimiEvent(ROOM, NAT2, { type: 'session.start', title: 'kimi session' }))
    expect(registry).toContainEqual({
      type: 'session-updated',
      sessionId: `kimi-code:${NAT2}`,
      previousSessionId: SID,
      status: 'idle',
    })
  })

  it('delivers it to a sink still attached under the old id, exactly once', () => {
    const f = makeDriver()
    adopt(f, ROOM, NAT)
    const seen: HarnessEvent[] = []
    f.driver.subscribe(SID, (e) => seen.push(e))
    f.emitDen(kimiEvent(ROOM, NAT2, { type: 'session.start', title: 'kimi session' }))
    expect(seen.filter((e) => e.type === 'session-updated' && e.previousSessionId)).toHaveLength(1)
  })

  it('does NOT re-key its own sinks — that is control-plane work', () => {
    const f = makeDriver()
    adopt(f, ROOM, NAT)
    const seen: HarnessEvent[] = []
    f.driver.subscribe(SID, (e) => seen.push(e))
    f.emitDen(kimiEvent(ROOM, NAT2, { type: 'session.start', title: 'kimi session' }))
    seen.length = 0
    f.emitDen(kimiEvent(ROOM, NAT2, { type: 'tool.start', tool: 'Bash' }))
    expect(seen).toEqual([])
  })

  it('carries an in-flight turn across the rotation instead of wedging it', async () => {
    const f = makeDriver({ rows: [{ id: NAT, command: 'kimi', title: 't', updatedAt: 1 }] })
    await f.driver.resumeSession(SID)
    await f.driver.sendUserTurn(SID, { text: 'long one' })
    f.emitDen(kimiEvent(NAT, NAT2, { type: 'session.start', title: 'kimi session' }))

    const next = `kimi-code:${NAT2}` as SessionId
    expect(await f.driver.getSession(next)).toMatchObject({ status: 'active' })
    await expect(f.driver.sendUserTurn(next, { text: 'too soon' })).rejects.toMatchObject({
      code: 'turn_in_flight',
    })
    f.emitDen(kimiEvent(NAT, NAT2, { type: 'turn.end' }))
    await expect(f.driver.sendUserTurn(next, { text: 'now' })).resolves.toBeUndefined()
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

  it('registers under the kimi-code harness id and advertises its flags', () => {
    const { registry } = withRegistry()
    expect(registry.list()).toEqual([
      {
        harnessId: 'kimi-code',
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
      { id: NAT, command: 'kimi', title: 'a', updatedAt: 2 },
      { id: NAT2, command: 'kimi', title: 'b', updatedAt: 1 },
    ])
    const ids = (await registry.listSessions('kimi-code')).map((s) => s.sessionId)
    expect(ids).toEqual([SID, `kimi-code:${NAT2}`])
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('delivers the live tail through subscribeSession, and stops on unsubscribe', () => {
    const { fakes, registry } = withRegistry()
    adopt(fakes, ROOM, NAT)
    const seen: HarnessEvent[] = []
    const off = registry.subscribeSession(SID, (e) => seen.push(e))
    fakes.emitDen(kimiEvent(ROOM, NAT, { type: 'tool.start', tool: 'Bash' }))
    off()
    fakes.emitDen(kimiEvent(ROOM, NAT, { type: 'tool.start', tool: 'Read' }))
    expect(seen).toEqual([
      { type: 'tool-use', sessionId: SID, toolCallId: `${NAT}:t1`, name: 'Bash', input: {} },
    ])
    registry.close()
  })
})

describe('roster cwd is read at call time', () => {
  it('reflects an operator edit to den-term.json without a restart', async () => {
    let cwd = '/home/rivet'
    const { driver } = makeDriver({
      rows: [{ id: NAT, command: 'kimi', title: 't', updatedAt: 1, createdAt: 1 }],
      cwd: () => cwd,
    })
    expect((await driver.getSession(SID))?.cwd).toBe('/home/rivet')
    cwd = '/srv/work'
    expect((await driver.getSession(SID))?.cwd).toBe('/srv/work')
  })
})

describe('createdAt does not disagree between list and get', () => {
  it('uses the store row for both paths (state.json createdAt)', async () => {
    const row: HarnessSession = {
      id: NAT,
      command: 'kimi',
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
      rows: [{ id: NAT, command: 'kimi', title: 't', updatedAt: 1 }],
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
    const driver = new KimiCodeDriver({ store: fakeStore().host(), events: () => off })
    driver.close()
    expect(off).toHaveBeenCalledOnce()
  })
})

// ── the shared contract ─────────────────────────────────────────────────────
// The rotation gate's acceptance test, run against the real driver and a real
// registry. Each rotation here is the one kimi rotation that exists: the same
// den room reports a different `harnessSession`, because the room was
// re-spawned into a fresh kimi. `emitActivity` is a `tool.start` rather than a
// `message.agent` deliberately — a kimi hook never sends the latter, and the
// suite should be driven by an event this harness really produces.
runHarnessRotationConformance('kimi-code', () => {
  const fakes = makeDriver({
    rows: [
      { id: NAT, command: 'kimi', title: 'first', updatedAt: 1_700_000_000_000 },
      { id: NAT2, command: 'kimi', title: 'second', updatedAt: 1_700_000_100_000 },
      { id: NAT3, command: 'kimi', title: 'third', updatedAt: 1_700_000_200_000 },
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
      // `from` is always whatever the room is running right now — that is what
      // makes this a rotation rather than a second session — so the room key is
      // all the driver needs to be told.
      const next =
        [NAT2, NAT3][minted++] ?? `session_00000000-0000-4000-8000-00000000000${String(minted)}`
      fakes.emitDen(kimiEvent(ROOM, next, { type: 'session.start', title: 'kimi session' }))
      return `kimi-code:${next}` as SessionId
    },
    emitActivity: (id) => {
      fakes.emitDen(
        kimiEvent(ROOM, id.slice('kimi-code:'.length), { type: 'tool.start', tool: 'Bash' }),
      )
    },
    teardown: () => {
      registry.close()
      fakes.driver.close()
    },
  }
})
