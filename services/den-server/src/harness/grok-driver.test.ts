// The `grok-build` driver over fakes for the two things it wraps: the den term
// manager (PTY spawn/inject/Esc) and the on-disk grok store. No `grok` binary
// and no ~/.grok required.
//
// Mirrors claude-driver.test.ts case for case, plus the three places grok is
// genuinely different: session-DIR existence as the collision/resume ground
// truth, real reasoning text on `thinking.delta`, and an explicit pin that this
// driver never rotates its native id.

import { describe, expect, it, vi } from 'vitest'
import { HarnessError, type HarnessEvent, type SessionId } from '@rivetos/types'
import type { HarnessSession } from '../term/harness-sessions.js'
import type { DenAgentEventLike } from './claude-driver.js'
import { GrokBuildDriver, type GrokPtyHost, type GrokStoreHost } from './grok-driver.js'
import { createHarnessRegistry, type HarnessRegistry } from './registry.js'

/** A real grok id: UUIDv7, as `grok --session-id` mints and requires. */
const UUID = '019e5f82-f0e5-7d41-a38c-4eefced7e570'
const UUID2 = '019e5f83-1111-7222-8333-444455556666'
const SID = `grok-build:${UUID}` as SessionId

interface Fakes {
  driver: GrokBuildDriver
  pty: ReturnType<typeof fakePty>
  store: ReturnType<typeof fakeStore>
  emitDen: (ev: DenAgentEventLike) => void
}

/**
 * `dirs` is deliberately separate from `byId`: grok creates the session
 * directory before it writes summary.json, so "describable" is a subset of
 * "exists" and the driver must not conflate them.
 */
function fakeStore(rows: HarnessSession[] = []) {
  const byId = new Map(rows.map((r) => [r.id, r]))
  const dirs = new Set(rows.map((r) => r.id))
  return {
    byId,
    dirs,
    transcripts: new Map<string, { turns: { role: 'user' | 'assistant'; text: string }[] }>(),
    host(): GrokStoreHost {
      return {
        list: () => Promise.resolve([...byId.values()]),
        describe: (id) => Promise.resolve(byId.get(id)),
        exists: (id) => dirs.has(id),
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
  const host: GrokPtyHost = {
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
  const driver = new GrokBuildDriver({
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

/** What `grok-den-hook.sh` → `den-hook.mjs --harness grok-build` posts. */
const grokEvent = (session: string, body: Record<string, unknown>): DenAgentEventLike =>
  ({
    v: 1,
    session,
    harness: 'grok-build',
    ...body,
  }) as DenAgentEventLike

describe('capability flags are honest', () => {
  it('reports what is actually wired on this node', () => {
    expect(makeDriver().driver.capabilities).toEqual({
      interrupt: true,
      resume: true,
      // Grok's permission prompts live inside its TUI (and the roster runs it
      // in bypassPermissions) — never faked true.
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
    await expectUnsupported(() => driver.startSession({ model: 'grok-build-fast' }))
  })
})

describe('identity + canonicalization', () => {
  it('mints `grok-build:<native>` ids — grok natives are already UUIDv7', () => {
    expect(GrokBuildDriver.sessionId(UUID)).toBe(SID)
    // version nibble 7: no namespacing needed, the native half is uuid-class.
    expect(UUID[14]).toBe('7')
  })

  it('refuses to act on another harness id', async () => {
    const { driver } = makeDriver()
    await expect(driver.getSession('claude-code:x' as SessionId)).rejects.toMatchObject({
      code: 'invalid_session_id',
    })
  })

  it('lists store rows as canonical summaries', async () => {
    const { driver } = makeDriver({
      rows: [{ id: UUID, command: 'grok', title: 'a plan', updatedAt: 1_700_000_000_000 }],
    })
    const [summary] = await driver.listSessions()
    expect(summary).toMatchObject({
      sessionId: SID,
      harnessId: 'grok-build',
      title: 'a plan',
      cwd: '/home/rivet',
      // on-disk only: the process is gone, though resumeSession revives it
      status: 'ended',
    })
  })

  it('ignores rows from another harness store in the same list', async () => {
    const { driver } = makeDriver({
      rows: [
        { id: UUID, command: 'grok', title: 'mine', updatedAt: 2 },
        { id: UUID2, command: 'claude', title: 'not mine', updatedAt: 3 },
      ],
    })
    expect((await driver.listSessions()).map((s) => s.sessionId)).toEqual([SID])
  })
})

describe('startSession', () => {
  it('pins the native id and spawns the `grok` roster entry', async () => {
    const { driver, pty } = makeDriver()
    const summary = await driver.startSession({ nativeSessionId: UUID })
    expect(summary.sessionId).toBe(SID)
    expect(summary.status).toBe('idle')
    expect(pty.spawns).toEqual([{ key: 'grok', session: UUID, resume: undefined }])
  })

  it('mints a uuid when the caller does not pin one', async () => {
    const { driver, pty } = makeDriver()
    const summary = await driver.startSession()
    expect(summary.sessionId).toMatch(/^grok-build:[0-9a-f-]{36}$/)
    expect(pty.spawns[0].resume).toBeUndefined()
  })

  it('never attaches: a pinned id already in the store is a collision', async () => {
    const { driver } = makeDriver({
      rows: [{ id: UUID, command: 'grok', title: UUID, updatedAt: 1 }],
    })
    await expect(driver.startSession({ nativeSessionId: UUID })).rejects.toMatchObject({
      code: 'session_id_collision',
    })
  })

  it('collides on a session DIR with no summary.json yet — `--session-id` would error', async () => {
    // The whole reason this driver has an `exists` port: grok writes the dir
    // before the summary, so a describe-only check would let a doomed spawn
    // through in exactly the window right after a fresh session starts.
    const { driver, store, pty } = makeDriver()
    store.dirs.add(UUID)
    await expect(driver.startSession({ nativeSessionId: UUID })).rejects.toMatchObject({
      code: 'session_id_collision',
    })
    expect(pty.spawns).toEqual([])
  })

  it('rejects a non-uuid pin — `grok --session-id` cannot honor it', async () => {
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
  it('re-spawns with --resume for a store-only session', async () => {
    const { driver, pty } = makeDriver({
      rows: [{ id: UUID, command: 'grok', title: 't', updatedAt: 2 }],
    })
    const summary = await driver.resumeSession(SID)
    expect(summary.sessionId).toBe(SID)
    expect(pty.spawns).toEqual([{ key: 'grok', session: UUID, resume: UUID }])
  })

  it('resumes a session whose dir exists but whose summary has not landed', async () => {
    const { driver, store, pty } = makeDriver()
    store.dirs.add(UUID)
    await expect(driver.resumeSession(SID)).resolves.toMatchObject({ sessionId: SID })
    expect(pty.spawns).toEqual([{ key: 'grok', session: UUID, resume: UUID }])
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

  it('re-attaches (--resume) when the PTY was LRU-evicted between turns', async () => {
    const { driver, pty } = makeDriver({
      rows: [{ id: UUID, command: 'grok', title: 't', updatedAt: 2 }],
    })
    await driver.resumeSession(SID)
    pty.live.delete(UUID) // evicted
    await driver.sendUserTurn(SID, { text: 'still there?' })
    expect(pty.spawns).toEqual([
      { key: 'grok', session: UUID, resume: UUID },
      { key: 'grok', session: UUID, resume: UUID },
    ])
  })

  it('re-spawns through --resume when the pty exited but has not been reaped', async () => {
    const { driver, pty } = makeDriver({
      rows: [{ id: UUID, command: 'grok', title: 't', updatedAt: 2 }],
    })
    await driver.resumeSession(SID)
    pty.dead.add('pty-1') // exited, mapping lingers
    await expect(driver.sendUserTurn(SID, { text: 'still there?' })).resolves.toBeUndefined()
    expect(pty.spawns).toHaveLength(2)
    expect(pty.spawns[1]).toEqual({ key: 'grok', session: UUID, resume: UUID })
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
    // grok's turn.end arrives from Stop, or from the detached flush pass when
    // the final chunk lands after the hook exits — the driver cannot tell them
    // apart and does not need to.
    const { driver, emitDen } = makeDriver()
    await driver.startSession({ nativeSessionId: UUID })
    await driver.sendUserTurn(SID, { text: 'one' })
    emitDen(grokEvent(UUID, { type: 'turn.end' }))
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

  it('stays best-effort against a dead pty — no re-spawn just to send Esc', async () => {
    const { driver, pty } = makeDriver()
    await driver.startSession({ nativeSessionId: UUID })
    pty.dead.add('pty-1')
    await expect(driver.interrupt(SID)).resolves.toBeUndefined()
    expect(pty.spawns).toHaveLength(1)
  })
})

describe('subscribe maps den AgentEvents onto the contract', () => {
  it('streams assistant text, paired tool calls, and turn completion', async () => {
    const { driver, emitDen } = makeDriver()
    await driver.startSession({ nativeSessionId: UUID })
    const seen: HarnessEvent[] = []
    const off = driver.subscribe(SID, (e) => seen.push(e))

    // grok's own tool names, passed through rather than renamed to Claude's.
    emitDen(
      grokEvent(UUID, { type: 'tool.start', tool: 'run_terminal_cmd', args: { command: 'ls' } }),
    )
    emitDen(grokEvent(UUID, { type: 'tool.end', tool: 'run_terminal_cmd' }))
    emitDen(grokEvent(UUID, { type: 'message.agent', text: 'done' }))
    emitDen(grokEvent(UUID, { type: 'turn.end' }))
    off()
    emitDen(grokEvent(UUID, { type: 'message.agent', text: 'after unsubscribe' }))

    expect(seen.filter((e) => e.type === 'tool-use')).toEqual([
      {
        type: 'tool-use',
        sessionId: SID,
        toolCallId: `${UUID}:t1`,
        name: 'run_terminal_cmd',
        input: { command: 'ls' },
      },
    ])
    expect(seen.filter((e) => e.type === 'tool-result')).toEqual([
      {
        type: 'tool-result',
        sessionId: SID,
        toolCallId: `${UUID}:t1`,
        name: 'run_terminal_cmd',
        // den's tool.end carries no body and no failure flag (PostToolUse and
        // PostToolUseFailure collapse into it), so neither is invented here.
        output: null,
      },
    ])
    expect(seen).toContainEqual({ type: 'assistant-delta', sessionId: SID, text: 'done' })
    expect(seen).toContainEqual({ type: 'turn-complete', sessionId: SID, stopReason: 'end-turn' })
    expect(seen.some((e) => e.type === 'assistant-delta' && e.text === 'after unsubscribe')).toBe(
      false,
    )
  })

  it('streams grok thinking as reasoning-delta — real thought text, not a spinner', async () => {
    const { driver, emitDen } = makeDriver()
    await driver.startSession({ nativeSessionId: UUID })
    const seen: HarnessEvent[] = []
    driver.subscribe(SID, (e) => seen.push(e))

    // The shared translator tails grok's ACP agent_thought_chunks, so what
    // lands on thinking.delta is the tail of the actual thought.
    emitDen(grokEvent(UUID, { type: 'thinking.delta', text: 'the roster cwd is operator-owned' }))
    emitDen(grokEvent(UUID, { type: 'thinking.delta', text: 'so a per-request override is a lie' }))
    // Empty text is not an event worth waking every subscriber for.
    emitDen(grokEvent(UUID, { type: 'thinking.delta', text: '' }))
    // Structure beyond text stays off the contract.
    emitDen(grokEvent(UUID, { type: 'thinking.end' }))
    emitDen(grokEvent(UUID, { type: 'message.agent', text: 'answer' }))

    expect(seen.filter((e) => e.type === 'reasoning-delta')).toEqual([
      { type: 'reasoning-delta', sessionId: SID, text: 'the roster cwd is operator-owned' },
      { type: 'reasoning-delta', sessionId: SID, text: 'so a per-request override is a lie' },
    ])
    expect(seen.map((e) => e.type)).toEqual([
      'reasoning-delta',
      'reasoning-delta',
      'assistant-delta',
    ])
  })

  it('ignores den-UI-only events the grok hooks also emit', async () => {
    const { driver, emitDen } = makeDriver()
    await driver.startSession({ nativeSessionId: UUID })
    const seen: HarnessEvent[] = []
    driver.subscribe(SID, (e) => seen.push(e))
    for (const ev of [
      { type: 'message.user', text: 'hi' },
      { type: 'speech.stt', active: true },
      { type: 'activity', activity: 'sleeping' },
      { type: 'task.plan', tasks: ['a'] },
      { type: 'task.check', index: 0 },
      { type: 'term.line', text: '$ ls' },
    ]) {
      emitDen(grokEvent(UUID, ev))
    }
    expect(seen).toEqual([])
  })

  it('ignores den rooms that are not grok (claude pins uuid keys too)', () => {
    const { driver, emitDen } = makeDriver()
    const seen: HarnessEvent[] = []
    driver.subscribeEvents((e) => seen.push(e))
    emitDen({ v: 1, session: UUID2, harness: 'claude-code', type: 'session.start', title: 'x' })
    emitDen({ v: 1, session: UUID2, harness: 'claude-code', type: 'thinking.delta', text: 'hmm' })
    expect(seen).toEqual([])
  })

  it('ignores the translator’s id-less fallback room (`unknown-<ppid>`)', () => {
    const { driver, emitDen } = makeDriver()
    const seen: HarnessEvent[] = []
    driver.subscribeEvents((e) => seen.push(e))
    emitDen({ v: 1, session: 'unknown-4242', harness: 'grok-build', type: 'session.start' })
    expect(seen).toEqual([])
  })

  it('adopts a grok PTY spawned from the /term drawer (synthetic rivetos start)', () => {
    const { driver, emitDen } = makeDriver()
    const seen: HarnessEvent[] = []
    driver.subscribeEvents((e) => seen.push(e))
    // The term manager stamps harness:'rivetos' and name:'<host>:<roster-key>'
    // on the synthetic session.start it emits for every room:true spawn.
    emitDen({
      v: 1,
      session: UUID,
      harness: 'rivetos',
      name: 'rivet-node:grok',
      type: 'session.start',
      title: 'Grok Build',
    })
    expect(seen).toContainEqual({ type: 'session-updated', sessionId: SID, status: 'idle' })
    // …but not for a shell or another harness spawned the same way.
    const before = seen.length
    emitDen({
      v: 1,
      session: UUID2,
      harness: 'rivetos',
      name: 'rivet-node:claude',
      type: 'session.start',
      title: 'Claude Code',
    })
    expect(seen).toHaveLength(before)
  })

  it('marks a session ended when its harness exits', async () => {
    const { driver, emitDen } = makeDriver()
    await driver.startSession({ nativeSessionId: UUID })
    const seen: HarnessEvent[] = []
    driver.subscribeEvents((e) => seen.push(e))
    emitDen(grokEvent(UUID, { type: 'session.end' }))
    expect(seen).toContainEqual({ type: 'session-updated', sessionId: SID, status: 'ended' })
  })
})

describe('native session ids do not rotate on the den path', () => {
  // Why the shared rotation conformance suite (harness/test/driver-conformance)
  // is not run for this driver: it requires a `rotate()` that makes the harness
  // emit `session-updated` with `previousSessionId`, and there is no such thing
  // to drive. grok CAN mint a new id (`--fork-session`), but nothing on the den
  // wire carries a previous→new pair — the rivet-den hook set wires PreCompact
  // to `thinking.end` + `activity`, and no other event names two ids. If grok
  // ever surfaces a fork/compact signal, the suite is the acceptance test for
  // wiring it: nothing else about this driver has to change, because the
  // registry owns re-keying.
  const ROTATION_ADJACENT: Record<string, unknown>[] = [
    { type: 'session.start', title: 'fresh' },
    { type: 'activity', activity: 'sleeping' }, // PreCompact
    { type: 'thinking.end' },
    { type: 'turn.end' },
    { type: 'session.end' },
  ]

  it('never emits session-updated with previousSessionId', async () => {
    const { driver, emitDen } = makeDriver()
    await driver.startSession({ nativeSessionId: UUID })
    const registry: HarnessEvent[] = []
    const session: HarnessEvent[] = []
    driver.subscribeEvents((e) => registry.push(e))
    driver.subscribe(SID, (e) => session.push(e))
    for (const ev of ROTATION_ADJACENT) emitDen(grokEvent(UUID, ev))
    for (const e of [...registry, ...session]) {
      expect(e.type === 'session-updated' && e.previousSessionId).toBeFalsy()
      expect(e.sessionId).toBe(SID)
    }
  })
})

describe('through the real registry (the non-rotating half of the conformance suite)', () => {
  // Everything the shared suite asserts that does not need a rotation to
  // happen: canonical dispatch, canonical-only listings, and a per-session tail
  // attached through `subscribeSession` rather than `driver.subscribe`.
  const withRegistry = async (
    rows: HarnessSession[] = [],
  ): Promise<{ fakes: Fakes; registry: HarnessRegistry }> => {
    const fakes = makeDriver({ rows })
    const registry = createHarnessRegistry()
    registry.register(fakes.driver)
    return Promise.resolve({ fakes, registry })
  }

  it('registers under the grok-build harness id and advertises its flags', async () => {
    const { registry } = await withRegistry()
    expect(registry.list()).toEqual([
      {
        harnessId: 'grok-build',
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

  it('resolves a bare uuid to the canonical grok-build id', async () => {
    const { fakes, registry } = await withRegistry()
    await fakes.driver.startSession({ nativeSessionId: UUID })
    const resolved = await registry.resolve(UUID)
    expect(resolved.sessionId).toBe(SID)
    expect(resolved.requestedId).toBe(UUID)
    expect(resolved.driver).toBe(fakes.driver)
  })

  it('lists canonical ids, exactly once each', async () => {
    const { registry } = await withRegistry([
      { id: UUID, command: 'grok', title: 'a', updatedAt: 2 },
      { id: UUID2, command: 'grok', title: 'b', updatedAt: 1 },
    ])
    const ids = (await registry.listSessions('grok-build')).map((s) => s.sessionId)
    expect(ids).toEqual([SID, `grok-build:${UUID2}`])
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('delivers the live tail through subscribeSession, and stops on unsubscribe', async () => {
    const { fakes, registry } = await withRegistry()
    await fakes.driver.startSession({ nativeSessionId: UUID })
    const seen: HarnessEvent[] = []
    const off = registry.subscribeSession(SID, (e) => seen.push(e))
    fakes.emitDen(grokEvent(UUID, { type: 'message.agent', text: 'hello' }))
    off()
    fakes.emitDen(grokEvent(UUID, { type: 'message.agent', text: 'after' }))
    expect(seen).toEqual([{ type: 'assistant-delta', sessionId: SID, text: 'hello' }])
    registry.close()
  })
})

describe('roster cwd is read at call time', () => {
  it('reflects an operator edit to den-term.json without a restart', async () => {
    let cwd = '/home/rivet'
    const { driver } = makeDriver({
      rows: [{ id: UUID, command: 'grok', title: 't', updatedAt: 1, createdAt: 1 }],
      cwd: () => cwd,
    })
    expect((await driver.getSession(SID))?.cwd).toBe('/home/rivet')
    cwd = '/srv/work'
    expect((await driver.getSession(SID))?.cwd).toBe('/srv/work')
  })
})

describe('createdAt does not disagree between list and get', () => {
  it('uses the store row for both paths (summary.json created_at)', async () => {
    const row: HarnessSession = {
      id: UUID,
      command: 'grok',
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

  it('falls back to updatedAt for a store written without created_at', async () => {
    const { driver } = makeDriver({
      rows: [{ id: UUID, command: 'grok', title: 't', updatedAt: 1_700_000_100_000 }],
    })
    const [listed] = await driver.listSessions()
    expect(listed.createdAt).toBe(new Date(1_700_000_100_000).toISOString())
  })
})

describe('transcript', () => {
  it('serves the hard-resync source for a canonical id', async () => {
    const { driver, store } = makeDriver({
      rows: [{ id: UUID, command: 'grok', title: 't', updatedAt: 1 }],
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
    const driver = new GrokBuildDriver({
      store: fakeStore().host(),
      events: () => off,
    })
    driver.close()
    expect(off).toHaveBeenCalledOnce()
  })
})
