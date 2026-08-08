// The `claude-code` reference driver over fakes for the two things it wraps:
// the den term manager (PTY spawn/inject/Esc) and the on-disk Claude store.
// No `claude` binary and no ~/.claude required.

import { describe, expect, it, vi } from 'vitest'
import { HarnessError, type HarnessEvent, type SessionId } from '@rivetos/types'
import type { HarnessSession } from '../term/harness-sessions.js'
import {
  ClaudeCodeDriver,
  type ClaudePtyHost,
  type ClaudeStoreHost,
  type DenAgentEventLike,
} from './claude-driver.js'

const UUID = 'a1b2c3d4-1111-4222-8333-444455556666'
const UUID2 = 'b2c3d4e5-2222-4333-8444-555566667777'
const SID = `claude-code:${UUID}` as SessionId

interface Fakes {
  driver: ClaudeCodeDriver
  pty: ReturnType<typeof fakePty>
  store: ReturnType<typeof fakeStore>
  emitDen: (ev: DenAgentEventLike) => void
}

function fakeStore(rows: HarnessSession[] = []) {
  const byId = new Map(rows.map((r) => [r.id, r]))
  return {
    byId,
    transcripts: new Map<string, { turns: { role: 'user' | 'assistant'; text: string }[] }>(),
    host(): ClaudeStoreHost {
      return {
        list: () => Promise.resolve([...byId.values()]),
        describe: (id) => Promise.resolve(byId.get(id)),
        transcript: (id) =>
          Promise.resolve(this.transcripts.get(id) ?? { turns: [] }),
      }
    },
  }
}

function fakePty() {
  const spawns: { session?: string; resume?: string }[] = []
  const injects: { id: string; text: string; submit: boolean; interrupt?: boolean }[] = []
  const live = new Map<string, string>()
  let writable = true
  /** pty ids that refuse writes — the exited-but-not-yet-reaped record. */
  const dead = new Set<string>()
  const host: ClaudePtyHost = {
    spawn: (_key, _cols, _rows, _remote, session, resume) => {
      spawns.push({ session, resume })
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
  const driver = new ClaudeCodeDriver({
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

const claudeEvent = (session: string, body: Record<string, unknown>): DenAgentEventLike => ({
  v: 1,
  session,
  harness: 'claude-code',
  ...body,
}) as DenAgentEventLike

describe('capability flags are honest', () => {
  it('reports what is actually wired on this node', () => {
    expect(makeDriver().driver.capabilities).toEqual({
      interrupt: true,
      resume: true,
      // Claude's permission prompts live inside its TUI — never faked true.
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

  it('rejects attachments — there is no node-local staging path into the TUI', async () => {
    const { driver } = makeDriver()
    await expectUnsupported(() =>
      driver.sendUserTurn(SID, {
        text: 'look',
        attachments: [{ mime: 'image/png', pathOrUri: '/tmp/x.png' }],
      }),
    )
  })

  it('rejects roster-owned start options rather than silently ignoring them', async () => {
    const { driver } = makeDriver()
    await expectUnsupported(() => driver.startSession({ cwd: '/elsewhere' }))
    await expectUnsupported(() => driver.startSession({ model: 'opus' }))
  })
})

describe('identity + canonicalization', () => {
  it('mints `claude-code:<native>` ids', () => {
    expect(ClaudeCodeDriver.sessionId(UUID)).toBe(SID)
  })

  it('refuses to act on another harness id', async () => {
    const { driver } = makeDriver()
    await expect(driver.getSession('grok-build:x' as SessionId)).rejects.toMatchObject({
      code: 'invalid_session_id',
    })
  })

  it('lists store rows as canonical summaries', async () => {
    const { driver } = makeDriver({
      rows: [{ id: UUID, command: 'claude', title: 'a plan', updatedAt: 1_700_000_000_000 }],
    })
    const [summary] = await driver.listSessions()
    expect(summary).toMatchObject({
      sessionId: SID,
      harnessId: 'claude-code',
      title: 'a plan',
      cwd: '/home/rivet',
      // on-disk only: the process is gone, though resumeSession revives it
      status: 'ended',
    })
  })
})

describe('startSession', () => {
  it('pins the native id and spawns through the term manager', async () => {
    const { driver, pty } = makeDriver()
    const summary = await driver.startSession({ nativeSessionId: UUID })
    expect(summary.sessionId).toBe(SID)
    expect(summary.status).toBe('idle')
    expect(pty.spawns).toEqual([{ session: UUID, resume: undefined }])
  })

  it('mints a uuid when the caller does not pin one', async () => {
    const { driver, pty } = makeDriver()
    const summary = await driver.startSession()
    expect(summary.sessionId).toMatch(/^claude-code:[0-9a-f-]{36}$/)
    expect(pty.spawns[0].resume).toBeUndefined()
  })

  it('never attaches: a pinned id already in the store is a collision', async () => {
    const { driver } = makeDriver({
      rows: [{ id: UUID, command: 'claude', title: UUID, updatedAt: 1 }],
    })
    await expect(driver.startSession({ nativeSessionId: UUID })).rejects.toMatchObject({
      code: 'session_id_collision',
    })
  })

  it('rejects a non-uuid pin — `claude --session-id` cannot honor it', async () => {
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
      rows: [{ id: UUID, command: 'claude', title: 't', updatedAt: 2 }],
    })
    const summary = await driver.resumeSession(SID)
    expect(summary.sessionId).toBe(SID)
    expect(pty.spawns).toEqual([{ session: UUID, resume: UUID }])
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
    expect(pty.injects).toEqual([{ id: 'pty-1', text: 'hello', submit: true, interrupt: undefined }])
  })

  it('re-attaches (--resume) when the PTY was LRU-evicted between turns', async () => {
    const { driver, pty } = makeDriver({
      rows: [{ id: UUID, command: 'claude', title: 't', updatedAt: 2 }],
    })
    await driver.resumeSession(SID)
    pty.live.delete(UUID) // evicted
    await driver.sendUserTurn(SID, { text: 'still there?' })
    expect(pty.spawns).toEqual([
      { session: UUID, resume: UUID },
      { session: UUID, resume: UUID },
    ])
  })

  it('re-spawns through --resume when the pty exited but has not been reaped', async () => {
    // The term manager keeps session→pty until exitLingerMs elapses, so a dead
    // harness still resolves to an unwritable pty. That must not read as
    // "this node cannot do turns" (501) — it is a retry, not a capability gap.
    const { driver, pty } = makeDriver({
      rows: [{ id: UUID, command: 'claude', title: 't', updatedAt: 2 }],
    })
    await driver.resumeSession(SID)
    pty.dead.add('pty-1') // exited, mapping lingers
    await expect(driver.sendUserTurn(SID, { text: 'still there?' })).resolves.toBeUndefined()
    expect(pty.spawns).toHaveLength(2)
    expect(pty.spawns[1]).toEqual({ session: UUID, resume: UUID })
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
    emitDen(claudeEvent(UUID, { type: 'turn.end' }))
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
    expect(seen).toContainEqual({ type: 'turn-complete', sessionId: SID, stopReason: 'interrupted' })
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

    emitDen(claudeEvent(UUID, { type: 'tool.start', tool: 'Bash', args: { command: 'ls' } }))
    emitDen(claudeEvent(UUID, { type: 'tool.end', tool: 'Bash' }))
    emitDen(claudeEvent(UUID, { type: 'message.agent', text: 'done' }))
    emitDen(claudeEvent(UUID, { type: 'turn.end' }))
    off()
    emitDen(claudeEvent(UUID, { type: 'message.agent', text: 'after unsubscribe' }))

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
      { type: 'tool-result', sessionId: SID, toolCallId: `${UUID}:t1`, name: 'Bash', output: null },
    ])
    expect(seen).toContainEqual({ type: 'assistant-delta', sessionId: SID, text: 'done' })
    expect(seen).toContainEqual({ type: 'turn-complete', sessionId: SID, stopReason: 'end-turn' })
    expect(seen.some((e) => e.type === 'assistant-delta' && e.text === 'after unsubscribe')).toBe(
      false,
    )
  })

  it('ignores den rooms that are not Claude (grok pins uuid keys too)', async () => {
    const { driver, emitDen } = makeDriver()
    const seen: HarnessEvent[] = []
    driver.subscribeEvents((e) => seen.push(e))
    emitDen({ v: 1, session: UUID2, harness: 'grok-build', type: 'session.start', title: 'x' })
    expect(seen).toEqual([])
  })

  it('adopts a claude PTY spawned from the /term drawer (synthetic rivetos start)', async () => {
    const { driver, emitDen } = makeDriver()
    const seen: HarnessEvent[] = []
    driver.subscribeEvents((e) => seen.push(e))
    // The term manager stamps harness:'rivetos' and name:'<host>:<roster-key>'
    // on the synthetic session.start it emits for every room:true spawn.
    emitDen({
      v: 1,
      session: UUID,
      harness: 'rivetos',
      name: 'rivet-node:claude',
      type: 'session.start',
      title: 'Claude Code',
    })
    expect(seen).toContainEqual({ type: 'session-updated', sessionId: SID, status: 'idle' })
    // …but not for a shell or another harness spawned the same way.
    const before = seen.length
    emitDen({
      v: 1,
      session: UUID2,
      harness: 'rivetos',
      name: 'rivet-node:grok',
      type: 'session.start',
      title: 'Grok Build',
    })
    expect(seen).toHaveLength(before)
  })

  it('marks a session ended when its harness exits', async () => {
    const { driver, emitDen } = makeDriver()
    await driver.startSession({ nativeSessionId: UUID })
    const seen: HarnessEvent[] = []
    driver.subscribeEvents((e) => seen.push(e))
    emitDen(claudeEvent(UUID, { type: 'session.end' }))
    expect(seen).toContainEqual({ type: 'session-updated', sessionId: SID, status: 'ended' })
  })
})

describe('roster cwd is read at call time', () => {
  it('reflects an operator edit to den-term.json without a restart', async () => {
    let cwd = '/home/rivet'
    const { driver } = makeDriver({
      rows: [{ id: UUID, command: 'claude', title: 't', updatedAt: 1, createdAt: 1 }],
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
      id: UUID,
      command: 'claude',
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
      rows: [{ id: UUID, command: 'claude', title: 't', updatedAt: 1 }],
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
    const driver = new ClaudeCodeDriver({
      store: fakeStore().host(),
      events: () => off,
    })
    driver.close()
    expect(off).toHaveBeenCalledOnce()
  })
})
