// Contract tests for the shared `PtyHarnessDriver` base, run against ALL FIVE
// real drivers rather than a stand-in subclass — the point is that every driver
// inherits the behaviour, so every driver is asserted.
//
// This file exists because of a class of bug the per-driver suites structurally
// cannot see: they drive one call at a time, so an `await` opening a window
// between a check and the state change it guards looks identical to correct
// code. Concurrency pins go here.

import { describe, expect, it, vi } from 'vitest'
import {
  HarnessError,
  type HarnessEvent,
  type SessionId,
  type TranscriptWsFrame,
} from '@rivetos/types'
import type { HarnessSession } from '../term/harness-sessions.js'
import { ClaudeCodeDriver } from './claude-driver.js'
import { GrokBuildDriver } from './grok-driver.js'
import { HermesDriver } from './hermes-driver.js'
import { KimiCodeDriver } from './kimi-driver.js'
import { DeepseekHarnessDriver } from './deepseek-driver.js'
import type { HarnessCapabilityEvent } from './capabilities.js'
import { composePromptText, type HarnessPtyHost, type PtyHarnessDriver } from './pty-harness-driver.js'

const UUID = 'a1b2c3d4-1111-4222-8333-444455556666'
/** hermes mints its own, and they are not uuids. */
const HERMES_NATIVE = '20260802_225647_6ad0b9'
/** kimi's are uuid-class, behind a fixed `session_` prefix. */
const KIMI_NATIVE = 'session_89965427-b96f-4d5e-8ad5-c3dd138e33dc'
/** dsh's are uuid-class, behind a fixed `session-` prefix (hyphen). */
const DSH_NATIVE = 'session-86ffe759-cd7b-49a7-955d-c282631a935d'

interface Injected {
  id: string
  text: string
  submit: boolean
  interrupt?: boolean
}

function fakePty(): { host: HarnessPtyHost; injects: Injected[]; spawns: number } {
  const injects: Injected[] = []
  const live = new Map<string, string>()
  const state = { spawns: 0 }
  const host: HarnessPtyHost = {
    spawn: (_key, _cols, _rows, _remote, session) => {
      state.spawns += 1
      const id = `pty-${String(state.spawns)}`
      if (session) live.set(session, id)
      return { id, denSession: session ?? id }
    },
    ptyForSession: (denSession) => live.get(denSession),
    inject: (id, text, submit, interrupt) => {
      injects.push({ id, text, submit, interrupt })
      return true
    },
  }
  return {
    host,
    injects,
    get spawns() {
      return state.spawns
    },
  }
}

/**
 * A store whose reads RESOLVE ASYNCHRONOUSLY, like the real ones (a directory
 * walk, a sqlite open). A store that answered synchronously would hide the very
 * window these tests are for.
 */
function fakeStore(rows: HarnessSession[]) {
  const byId = new Map(rows.map((r) => [r.id, r]))
  return {
    list: () => Promise.resolve([...byId.values()]),
    describe: (id: string) => Promise.resolve(byId.get(id)),
    exists: (id: string) => byId.has(id),
    transcript: () => Promise.resolve({ turns: [] }),
  }
}

interface Subject {
  driver: PtyHarnessDriver
  sessionId: SessionId
  injects: Injected[]
  /** Bring the session into the driver's live map, as production would. */
  activate(): Promise<void>
}

const subjects: [name: string, make: () => Subject][] = [
  [
    'claude-code',
    (): Subject => {
      const pty = fakePty()
      const store = fakeStore([])
      const driver = new ClaudeCodeDriver({
        store,
        pty: () => Promise.resolve(pty.host),
        turnQuietMs: 0,
      })
      return {
        driver,
        sessionId: ClaudeCodeDriver.sessionId(UUID),
        injects: pty.injects,
        activate: async () => {
          await driver.startSession({ nativeSessionId: UUID })
        },
      }
    },
  ],
  [
    'grok-build',
    (): Subject => {
      const pty = fakePty()
      const store = fakeStore([])
      const driver = new GrokBuildDriver({
        store,
        pty: () => Promise.resolve(pty.host),
        turnQuietMs: 0,
      })
      return {
        driver,
        sessionId: GrokBuildDriver.sessionId(UUID),
        injects: pty.injects,
        activate: async () => {
          await driver.startSession({ nativeSessionId: UUID })
        },
      }
    },
  ],
  [
    'hermes',
    (): Subject => {
      const pty = fakePty()
      // hermes refuses startSession (it cannot pin an id), so a session exists
      // in its store first and is resumed.
      const store = fakeStore([{ id: HERMES_NATIVE, command: 'hermes', title: 't', updatedAt: 1 }])
      const driver = new HermesDriver({
        store,
        pty: () => Promise.resolve(pty.host),
        turnQuietMs: 0,
      })
      return {
        driver,
        sessionId: HermesDriver.sessionId(HERMES_NATIVE),
        injects: pty.injects,
        activate: async () => {
          await driver.resumeSession(HermesDriver.sessionId(HERMES_NATIVE))
        },
      }
    },
  ],
  [
    'kimi-code',
    (): Subject => {
      const pty = fakePty()
      // kimi refuses startSession for the same reason hermes does (no flag to
      // pin a new session's id), so it too is reached through resume.
      const store = fakeStore([{ id: KIMI_NATIVE, command: 'kimi', title: 't', updatedAt: 1 }])
      const driver = new KimiCodeDriver({
        store,
        pty: () => Promise.resolve(pty.host),
        turnQuietMs: 0,
      })
      return {
        driver,
        sessionId: KimiCodeDriver.sessionId(KIMI_NATIVE),
        injects: pty.injects,
        activate: async () => {
          await driver.resumeSession(KimiCodeDriver.sessionId(KIMI_NATIVE))
        },
      }
    },
  ],
  [
    'deepseek-harness',
    (): Subject => {
      const pty = fakePty()
      const store = fakeStore([{ id: DSH_NATIVE, command: 'dsh', title: 't', updatedAt: 1 }])
      const driver = new DeepseekHarnessDriver({
        store,
        pty: () => Promise.resolve(pty.host),
        turnQuietMs: 0,
      })
      return {
        driver,
        sessionId: DeepseekHarnessDriver.sessionId(DSH_NATIVE),
        injects: pty.injects,
        activate: async () => {
          await driver.resumeSession(DeepseekHarnessDriver.sessionId(DSH_NATIVE))
        },
      }
    },
  ],
]

describe.each(subjects)('%s: the in-flight turn lock is not racy', (_name, make) => {
  it('lets exactly ONE of two simultaneous turns through', async () => {
    const s = make()
    await s.activate()

    // Both calls are made before either can settle — a hub with two tabs, or a
    // client that retried without waiting. The lock must be claimed in the same
    // tick it is checked, or both pass the check and both paste into the TUI.
    const settled = await Promise.allSettled([
      s.driver.sendUserTurn(s.sessionId, { text: 'one' }),
      s.driver.sendUserTurn(s.sessionId, { text: 'two' }),
    ])

    expect(settled.map((r) => r.status)).toEqual(['fulfilled', 'rejected'])
    const rejection = settled[1] as PromiseRejectedResult
    expect(rejection.reason).toBeInstanceOf(HarnessError)
    expect((rejection.reason as HarnessError).code).toBe('turn_in_flight')
    expect((rejection.reason as HarnessError).retryable).toBe(true)
    // The harness saw one turn, not two.
    expect(s.injects.map((i) => i.text)).toEqual(['one'])
  })

  it('holds the lock across the whole burst, not just the first pair', async () => {
    const s = make()
    await s.activate()
    const settled = await Promise.allSettled(
      ['a', 'b', 'c', 'd'].map((text) => s.driver.sendUserTurn(s.sessionId, { text })),
    )
    expect(settled.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    expect(s.injects).toHaveLength(1)
  })

  it('releases the claim when the turn never lands, so the next one can', async () => {
    // A failed inject must not wedge the session on 409 until the quiet window
    // expires — the claim is given back on every throw path.
    const s = make()
    await s.activate()
    let refuse = true
    const host = s.driver as unknown as {
      deps: { pty: () => Promise<HarnessPtyHost> }
    }
    const real = await host.deps.pty()
    const gated: HarnessPtyHost = {
      spawn: real.spawn.bind(real),
      ptyForSession: real.ptyForSession.bind(real),
      inject: (id, text, submit, interrupt) =>
        refuse ? false : real.inject(id, text, submit, interrupt),
    }
    host.deps.pty = () => Promise.resolve(gated)

    await expect(s.driver.sendUserTurn(s.sessionId, { text: 'lost' })).rejects.toMatchObject({
      code: 'turn_in_flight',
    })
    refuse = false
    await expect(s.driver.sendUserTurn(s.sessionId, { text: 'landed' })).resolves.toBeUndefined()
    expect(s.injects.map((i) => i.text)).toContain('landed')
  })
})

// -- capability runtime truthing ---------------------------------------------
//
// The gap (docs/ARCHITECTURE.md § Gateway surface (as built)):
// `interrupt`/`resume` were `!!deps.pty`, i.e. "are den terminals ENABLED" —
// a config question standing in for a runtime one. A node whose `node-pty`
// import failed advertised `true` on `GET /api/harnesses` and answered 501.
// What every test below asserts is one invariant: **advertised == actual**.

/** Build one driver of each kind against a caller-supplied PTY dep. */
const capabilitySubjects: [
  name: string,
  make: (pty?: () => Promise<HarnessPtyHost | null>) => PtyHarnessDriver,
][] = [
  ['claude-code', (pty) => new ClaudeCodeDriver({ store: fakeStore([]), ...(pty ? { pty } : {}) })],
  ['grok-build', (pty) => new GrokBuildDriver({ store: fakeStore([]), ...(pty ? { pty } : {}) })],
  [
    'hermes',
    (pty) =>
      new HermesDriver({
        store: fakeStore([{ id: HERMES_NATIVE, command: 'hermes', title: 't', updatedAt: 1 }]),
        ...(pty ? { pty } : {}),
      }),
  ],
  [
    'kimi-code',
    (pty) =>
      new KimiCodeDriver({
        store: fakeStore([{ id: KIMI_NATIVE, command: 'kimi', title: 't', updatedAt: 1 }]),
        ...(pty ? { pty } : {}),
      }),
  ],
  [
    'deepseek-harness',
    (pty) =>
      new DeepseekHarnessDriver({
        store: fakeStore([{ id: DSH_NATIVE, command: 'dsh', title: 't', updatedAt: 1 }]),
        ...(pty ? { pty } : {}),
      }),
  ],
]

/** A PTY dep that resolves null — den terminals enabled, `node-pty` absent. */
const failedPtyLoad = (): (() => Promise<HarnessPtyHost | null>) => () => Promise.resolve(null)

describe.each(capabilitySubjects)('%s: capabilities are runtime-truthed', (name, make) => {
  const resumable = (driver: PtyHarnessDriver): SessionId =>
    name === 'hermes'
      ? (`hermes:${HERMES_NATIVE}` as SessionId)
      : name === 'kimi-code'
        ? (`kimi-code:${KIMI_NATIVE}` as SessionId)
        : name === 'deepseek-harness'
          ? (`deepseek-harness:${DSH_NATIVE}` as SessionId)
          : (`${driver.harnessId}:${UUID}` as SessionId)

  it('advertises interrupt/resume false once the probe finds no PTY backend', async () => {
    const driver = make(failedPtyLoad())
    // Construction can only know the config: terminals are enabled.
    expect(driver.capabilities).toMatchObject({ interrupt: true, resume: true })

    expect(await driver.verifyCapabilities()).toMatchObject({ interrupt: false, resume: false })
    expect(driver.capabilities).toMatchObject({ interrupt: false, resume: false })

    // …and that is exactly what the methods do, which is the whole point.
    await expect(driver.resumeSession(resumable(driver))).rejects.toMatchObject({
      code: 'capability_unsupported',
    })
    await expect(driver.interrupt(resumable(driver))).rejects.toMatchObject({
      code: 'capability_unsupported',
    })
  })

  it('keeps the flags true when the PTY backend is really there', async () => {
    const driver = make(() => Promise.resolve(fakePty().host))
    const flips: unknown[] = []
    driver.subscribeCapabilities((e) => flips.push(e))
    expect(await driver.verifyCapabilities()).toMatchObject({ interrupt: true, resume: true })
    // Nothing changed, so nothing is announced — a flip stream that reported
    // every probe would train clients to ignore it.
    expect(flips).toEqual([])
  })

  it('surfaces the flip to capability subscribers, once', async () => {
    const driver = make(failedPtyLoad())
    const flips: HarnessCapabilityEvent[] = []
    driver.subscribeCapabilities((e) => flips.push(e))

    await driver.verifyCapabilities()
    // A second probe and a real method call both re-observe the same verdict.
    await driver.verifyCapabilities()
    await driver.interrupt(resumable(driver)).catch(() => undefined)

    expect(flips).toHaveLength(1)
    expect(flips[0]).toMatchObject({
      type: 'harness-capabilities',
      harnessId: driver.harnessId,
      changed: { interrupt: false, resume: false },
      capabilities: { interrupt: false, resume: false, approvals: false, listSessions: true },
    })
    expect(flips[0]?.reason).toContain('PTY backend is unavailable')
  })

  it('corrects the sheet lazily, from the first method that needed a PTY', async () => {
    // Nobody read `GET /api/harnesses` on this node. The truth still lands.
    const driver = make(failedPtyLoad())
    const flips: HarnessCapabilityEvent[] = []
    driver.subscribeCapabilities((e) => flips.push(e))

    await expect(driver.resumeSession(resumable(driver))).rejects.toMatchObject({
      code: 'capability_unsupported',
    })
    expect(driver.capabilities).toMatchObject({ interrupt: false, resume: false })
    expect(flips).toHaveLength(1)
  })

  it('treats a PTY host that THROWS exactly like one that is missing', async () => {
    const driver = make(() => Promise.reject(new Error('node-pty: no such module')))
    expect(await driver.verifyCapabilities()).toMatchObject({ interrupt: false, resume: false })
    await expect(driver.resumeSession(resumable(driver))).rejects.toMatchObject({
      code: 'capability_unsupported',
    })
  })

  it('probes at most once — the PTY host resolution is not re-paid per read', async () => {
    let calls = 0
    const driver = make(() => {
      calls += 1
      return Promise.resolve(fakePty().host)
    })
    await Promise.all([driver.verifyCapabilities(), driver.verifyCapabilities()])
    await driver.verifyCapabilities()
    expect(calls).toBe(1)
  })

  it('probes nothing when den terminals are disabled — there is nothing to ask', async () => {
    const driver = make()
    const flips: HarnessCapabilityEvent[] = []
    driver.subscribeCapabilities((e) => flips.push(e))
    expect(driver.capabilities).toMatchObject({ interrupt: false, resume: false })
    expect(await driver.verifyCapabilities()).toMatchObject({ interrupt: false, resume: false })
    expect(flips).toEqual([])
  })

  it('hands out a snapshot, not the driver’s own flags', () => {
    const driver = make(failedPtyLoad())
    const sheet = driver.capabilities
    sheet.approvals = true
    expect(driver.capabilities.approvals).toBe(false)
  })
})

describe('model/effort sheet on capabilities', () => {
  it('claude advertises fable default and --effort', () => {
    const driver = new ClaudeCodeDriver({ store: fakeStore([]) })
    expect(driver.capabilities.modelFlag).toBe('--model')
    expect(driver.capabilities.effortFlag).toBe('--effort')
    expect(driver.capabilities.models?.find((m) => m.default)?.id).toBe('fable')
  })

  it('config override replaces the sheet lists', () => {
    const driver = new ClaudeCodeDriver({
      store: fakeStore([]),
      sheetOverride: {
        models: [{ id: 'only', label: 'Only' }],
        efforts: [{ id: 'max', label: 'Max' }],
      },
    })
    expect(driver.capabilities.models).toEqual([{ id: 'only', label: 'Only' }])
    expect(driver.capabilities.efforts).toEqual([{ id: 'max', label: 'Max' }])
    expect(driver.capabilities.modelFlag).toBe('--model')
  })

  it('memoizes the sheet for 60s and emits when a re-read after TTL differs', async () => {
    let t = 0
    let reads = 0
    let models = [{ id: 'a', label: 'A' }]
    const flips: HarnessCapabilityEvent[] = []
    const driver = new ClaudeCodeDriver({
      store: fakeStore([]),
      now: () => t,
      sheet: () => {
        reads += 1
        return { models: [...models], modelFlag: '--model' }
      },
    })
    driver.subscribeCapabilities((e) => flips.push(e))
    expect(reads).toBe(1)
    await driver.verifyCapabilities()
    await driver.verifyCapabilities()
    expect(reads).toBe(1)
    expect(flips).toEqual([])

    t = 60_000
    models = [{ id: 'b', label: 'B' }]
    await driver.verifyCapabilities()
    expect(reads).toBe(2)
    expect(flips).toHaveLength(1)
    expect(flips[0]).toMatchObject({
      type: 'harness-capabilities',
      harnessId: 'claude-code',
      changed: { models: [{ id: 'b', label: 'B' }] },
    })
    expect(flips[0]?.reason).toContain('model/effort sheet changed')
  })
})

describe('pty-harness-driver herdr status mapping', () => {
  it('prefers herdr working/blocked/idle over the activity clock and surfaces blocked', async () => {
    const pty = fakePty()
    const driver = new ClaudeCodeDriver({
      store: fakeStore([]),
      pty: () => Promise.resolve(pty.host),
      turnQuietMs: 0,
      // no den event tap on purpose: herdr status must subscribe without hooks
      herdrStatus: true,
    })
    await driver.startSession({ nativeSessionId: UUID })
    const seen: { type: string; status?: string; blocked?: boolean }[] = []
    driver.subscribe(ClaudeCodeDriver.sessionId(UUID), (e) => {
      seen.push({
        type: e.type,
        status: 'status' in e ? String((e as { status?: unknown }).status) : undefined,
        blocked: 'blocked' in e ? Boolean((e as { blocked?: unknown }).blocked) : undefined,
      })
    })

    driver.applyHerdrStatus(UUID, {
      type: 'status',
      sessionId: ClaudeCodeDriver.sessionId(UUID),
      status: 'working',
      since: 1,
    })
    expect(await driver.getSession(ClaudeCodeDriver.sessionId(UUID))).toMatchObject({
      status: 'active',
    })
    expect(seen.some((e) => e.type === 'status' && e.status === 'working')).toBe(true)

    driver.applyHerdrStatus(UUID, {
      type: 'status',
      sessionId: ClaudeCodeDriver.sessionId(UUID),
      status: 'blocked',
      since: 2,
    })
    const blocked = await driver.getSession(ClaudeCodeDriver.sessionId(UUID))
    expect(blocked).toMatchObject({ status: 'active', blocked: true })
    expect(seen.some((e) => e.type === 'session-updated' && e.blocked)).toBe(true)
    expect(seen.some((e) => e.type === 'status' && e.status === 'blocked')).toBe(true)

    driver.applyHerdrStatus(UUID, {
      type: 'status',
      sessionId: ClaudeCodeDriver.sessionId(UUID),
      status: 'idle',
      since: 3,
    })
    expect(await driver.getSession(ClaudeCodeDriver.sessionId(UUID))).toMatchObject({
      status: 'idle',
    })
  })

  it('does not mint a ghost LiveState for an unknown room (N2); registry still gets the frame', async () => {
    const driver = new ClaudeCodeDriver({
      store: fakeStore([]),
      turnQuietMs: 0,
      herdrStatus: true,
    })
    const seen: { type: string; status?: string }[] = []
    driver.subscribeEvents((e) => {
      seen.push({
        type: e.type,
        status: 'status' in e ? String((e as { status?: unknown }).status) : undefined,
      })
    })
    driver.applyHerdrStatus('ghost-room', {
      type: 'status',
      sessionId: ClaudeCodeDriver.sessionId('ghost-room'),
      status: 'working',
      since: 1,
    })
    expect(seen).toEqual([{ type: 'status', status: 'working' }])
    expect(await driver.getSession(ClaudeCodeDriver.sessionId('ghost-room'))).toBeNull()
  })

  it('clears herdrStatus in endTurn so list matches the idle stream (N3)', async () => {
    vi.useFakeTimers()
    const pty = fakePty()
    const driver = new ClaudeCodeDriver({
      store: fakeStore([]),
      pty: () => Promise.resolve(pty.host),
      turnQuietMs: 50,
      herdrStatus: true,
    })
    await driver.startSession({ nativeSessionId: UUID })
    driver.applyHerdrStatus(UUID, {
      type: 'status',
      sessionId: ClaudeCodeDriver.sessionId(UUID),
      status: 'working',
      since: Date.now(),
    })
    expect(await driver.getSession(ClaudeCodeDriver.sessionId(UUID))).toMatchObject({
      status: 'active',
    })
    vi.advanceTimersByTime(50)
    expect(await driver.getSession(ClaudeCodeDriver.sessionId(UUID))).toMatchObject({
      status: 'idle',
    })
    vi.useRealTimers()
  })
})

function fakeTranscript(): {
  subscribe: (session: string, sink: (f: TranscriptWsFrame) => void) => () => void
  sync: (session: string) => void
  emit: (session: string, frame: TranscriptWsFrame) => void
  synced: string[]
  subscribed: (session: string) => boolean
} {
  const bySession = new Map<string, Set<(f: TranscriptWsFrame) => void>>()
  const synced: string[] = []
  return {
    synced,
    subscribed: (session) => (bySession.get(session)?.size ?? 0) > 0,
    subscribe(session, sink) {
      let set = bySession.get(session)
      if (!set) {
        set = new Set()
        bySession.set(session, set)
      }
      set.add(sink)
      return () => {
        set!.delete(sink)
      }
    },
    sync(session) {
      synced.push(session)
    },
    emit(session, frame) {
      for (const s of bySession.get(session) ?? []) s(frame)
    },
  }
}

const ASK_INPUT = {
  questions: [
    {
      question: 'Which auth?',
      header: 'Auth',
      multiSelect: false,
      options: [
        { label: 'OAuth', description: 'browser' },
        { label: 'API key', description: 'token' },
      ],
    },
  ],
}

describe('pty-harness-driver transcript tracker', () => {
  const sid = ClaudeCodeDriver.sessionId(UUID)

  function frame(
    partial: Pick<TranscriptWsFrame, 'from' | 'total' | 'turns'> & Partial<TranscriptWsFrame>,
  ): TranscriptWsFrame {
    return {
      kind: 'transcript',
      session: sid,
      rev: 1,
      command: 'claude',
      ...partial,
    }
  }

  it('liveStream is honest: true with a transcript dep on a live-turn store, even without a hook tap', () => {
    const tx = fakeTranscript()
    const driver = new ClaudeCodeDriver({ store: fakeStore([]), transcript: tx, turnQuietMs: 0 })
    expect(driver.capabilities.liveStream).toBe(true)
    driver.close()
    const noTx = new ClaudeCodeDriver({ store: fakeStore([]), turnQuietMs: 0 })
    expect(noTx.capabilities.liveStream).toBe(false)
    noTx.close()
  })

  it('a rotation re-subscribes the transcript watcher under the successor id', () => {
    class Rotating extends ClaudeCodeDriver {
      doRotate(from: string, to: string): void {
        this.rotate(from, to)
      }
      nativeOf(s: SessionId): string {
        return this.native(s)
      }
      sidOf(n: string): SessionId {
        return this.sid(n)
      }
    }
    const tx = fakeTranscript()
    const driver = new Rotating({ store: fakeStore([]), transcript: tx, turnQuietMs: 0 })
    driver.subscribe(sid, () => undefined)
    expect(tx.subscribed(sid)).toBe(true)
    const next = 'bbbbbbbb-0000-4000-8000-0000000000b2'
    driver.doRotate(driver.nativeOf(sid), next)
    expect(tx.subscribed(sid)).toBe(false)
    expect(tx.subscribed(driver.sidOf(next))).toBe(true)
    driver.close()
  })

  it('subscribe succeeds with only a transcript dep', () => {
    const tx = fakeTranscript()
    const driver = new ClaudeCodeDriver({ store: fakeStore([]), transcript: tx, turnQuietMs: 0 })
    const off = driver.subscribe(sid, () => undefined)
    expect(typeof off).toBe('function')
    off()
    driver.close()
  })

  it('forwards a transcript snapshot with the canonical id and ctx; deltas omit ctx', () => {
    const tx = fakeTranscript()
    const driver = new ClaudeCodeDriver({ store: fakeStore([]), transcript: tx, turnQuietMs: 0 })
    const seen: HarnessEvent[] = []
    driver.subscribe(sid, (e) => seen.push(e))
    tx.emit(
      sid,
      frame({
        from: 0,
        total: 1,
        rev: 1,
        turns: [{ role: 'user', text: 'hi' }],
      }),
    )
    const snap = seen.find((e) => e.type === 'transcript')
    expect(snap).toMatchObject({
      type: 'transcript',
      sessionId: sid,
      from: 0,
      total: 1,
      command: 'claude',
    })
    expect(snap && 'contextWindow' in snap && typeof snap.contextWindow === 'number').toBe(true)
    seen.length = 0
    tx.emit(
      sid,
      frame({
        from: 1,
        total: 2,
        rev: 2,
        turns: [
          {
            role: 'assistant',
            text: 'ok',
            lastBlock: 'text',
            stopReason: 'end_turn',
            complete: true,
          },
        ],
      }),
    )
    const delta = seen.find((e) => e.type === 'transcript')
    expect(delta).toMatchObject({ type: 'transcript', from: 1, total: 2, sessionId: sid })
    expect(delta && 'contextWindow' in delta ? delta.contextWindow : undefined).toBeUndefined()
    driver.close()
  })

  it('emits status once per change with source transcript', () => {
    const tx = fakeTranscript()
    const driver = new ClaudeCodeDriver({ store: fakeStore([]), transcript: tx, turnQuietMs: 0 })
    const status: HarnessEvent[] = []
    driver.subscribe(sid, (e) => {
      if (e.type === 'status') status.push(e)
    })
    const working = frame({
      from: 0,
      total: 1,
      turns: [{ role: 'user', text: 'hi' }],
    })
    tx.emit(sid, working)
    tx.emit(sid, working)
    expect(status).toHaveLength(1)
    expect(status[0]).toMatchObject({
      type: 'status',
      source: 'transcript',
      status: 'working',
      phase: 'thinking',
      sessionId: sid,
    })
    driver.close()
  })

  it('emits turn-complete from a complete trailing turn and sendUserTurn no longer 409s', async () => {
    const tx = fakeTranscript()
    const pty = fakePty()
    const driver = new ClaudeCodeDriver({
      store: fakeStore([]),
      pty: () => Promise.resolve(pty.host),
      transcript: tx,
      turnQuietMs: 0,
    })
    await driver.startSession({ nativeSessionId: UUID })
    const seen: string[] = []
    driver.subscribe(sid, (e) => seen.push(e.type))
    tx.emit(
      sid,
      frame({
        from: 0,
        total: 2,
        turns: [
          { role: 'user', text: 'hi' },
          {
            role: 'assistant',
            text: '',
            lastBlock: 'tool_use',
            stopReason: 'tool_use',
            tools: [{ name: 'Bash', status: 'running', id: 't1' }],
          },
        ],
      }),
    )
    tx.emit(
      sid,
      frame({
        from: 1,
        total: 2,
        rev: 2,
        turns: [
          {
            role: 'assistant',
            text: 'done',
            lastBlock: 'text',
            stopReason: 'end_turn',
            complete: true,
          },
        ],
      }),
    )
    expect(seen.filter((t) => t === 'turn-complete')).toEqual(['turn-complete'])
    await expect(driver.sendUserTurn(sid, { text: 'next' })).resolves.toBeUndefined()
    driver.close()
  })

  it('emits prompt open then resolve', () => {
    const tx = fakeTranscript()
    const driver = new ClaudeCodeDriver({ store: fakeStore([]), transcript: tx, turnQuietMs: 0 })
    const prompts: HarnessEvent[] = []
    driver.subscribe(sid, (e) => {
      if (e.type === 'prompt') prompts.push(e)
    })
    tx.emit(
      sid,
      frame({
        from: 0,
        total: 2,
        turns: [
          { role: 'user', text: 'ask' },
          {
            role: 'assistant',
            text: '',
            lastBlock: 'tool_use',
            stopReason: 'tool_use',
            tools: [
              { name: 'AskUserQuestion', status: 'running', id: 'ask_1', input: ASK_INPUT },
            ],
          },
        ],
      }),
    )
    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toMatchObject({
      type: 'prompt',
      promptId: 'ask_1',
      kind: 'ask-user',
      toolName: 'AskUserQuestion',
      sessionId: sid,
    })
    tx.emit(
      sid,
      frame({
        from: 1,
        total: 2,
        rev: 2,
        turns: [
          {
            role: 'assistant',
            text: '',
            lastBlock: 'tool_result',
            stopReason: 'tool_use',
            tools: [
              {
                name: 'AskUserQuestion',
                status: 'done',
                id: 'ask_1',
                input: ASK_INPUT,
                resultText: 'Auth: API key',
              },
            ],
          },
        ],
      }),
    )
    expect(prompts).toHaveLength(2)
    expect(prompts[1]).toMatchObject({
      type: 'prompt',
      promptId: 'ask_1',
      resolved: { answerText: 'Auth: API key' },
    })
    driver.close()
  })

  it('answerPrompt uses answerKeys for claude and injects the digit sequence', async () => {
    const tx = fakeTranscript()
    const pty = fakePty()
    const driver = new ClaudeCodeDriver({
      store: fakeStore([]),
      pty: () => Promise.resolve(pty.host),
      transcript: tx,
      turnQuietMs: 0,
    })
    await driver.startSession({ nativeSessionId: UUID })
    driver.subscribe(sid, () => undefined)
    tx.emit(
      sid,
      frame({
        from: 0,
        total: 2,
        turns: [
          { role: 'user', text: 'ask' },
          {
            role: 'assistant',
            text: '',
            lastBlock: 'tool_use',
            stopReason: 'tool_use',
            tools: [
              { name: 'AskUserQuestion', status: 'running', id: 'ask_1', input: ASK_INPUT },
            ],
          },
        ],
      }),
    )
    await driver.answerPrompt(sid, 'ask_1', [{ question: 0, labels: ['API key'] }])
    expect(pty.injects.some((i) => i.text === '2' && i.submit === false)).toBe(true)
    await expect(
      driver.answerPrompt(sid, 'nope', [{ question: 0, labels: ['x'] }]),
    ).rejects.toMatchObject({
      code: 'unknown_prompt',
    })
    driver.close()
  })

  it('stale timer idles an in-flight turn with no running tool', () => {
    vi.useFakeTimers()
    const tx = fakeTranscript()
    const driver = new ClaudeCodeDriver({
      store: fakeStore([]),
      transcript: tx,
      turnQuietMs: 0,
      now: () => Date.now(),
    })
    const seen: HarnessEvent[] = []
    driver.subscribe(sid, (e) => seen.push(e))
    tx.emit(
      sid,
      frame({
        from: 0,
        total: 2,
        turns: [
          { role: 'user', text: 'hi' },
          { role: 'assistant', text: 'draft', lastBlock: 'text', stopReason: 'end_turn' },
        ],
      }),
    )
    vi.advanceTimersByTime(119_000)
    expect(seen.some((e) => e.type === 'turn-complete')).toBe(false)
    vi.advanceTimersByTime(1_000)
    expect(
      seen.some((e) => e.type === 'status' && e.status === 'idle' && e.source === 'transcript'),
    ).toBe(true)
    expect(seen.some((e) => e.type === 'turn-complete' && e.stopReason === 'stale')).toBe(true)
    driver.close()
    vi.useRealTimers()
  })

  it('herdr blocked + pending prompt stamps promptId and phase prompt', async () => {
    const tx = fakeTranscript()
    const pty = fakePty()
    const driver = new ClaudeCodeDriver({
      store: fakeStore([]),
      pty: () => Promise.resolve(pty.host),
      transcript: tx,
      herdrStatus: true,
      turnQuietMs: 0,
    })
    await driver.startSession({ nativeSessionId: UUID })
    const seen: HarnessEvent[] = []
    driver.subscribe(sid, (e) => seen.push(e))
    tx.emit(
      sid,
      frame({
        from: 0,
        total: 2,
        turns: [
          { role: 'user', text: 'ask' },
          {
            role: 'assistant',
            text: '',
            lastBlock: 'tool_use',
            stopReason: 'tool_use',
            tools: [
              { name: 'AskUserQuestion', status: 'running', id: 'ask_1', input: ASK_INPUT },
            ],
          },
        ],
      }),
    )
    driver.applyHerdrStatus(UUID, {
      type: 'status',
      sessionId: sid,
      status: 'blocked',
      since: 1,
    })
    expect(
      seen.find((e) => e.type === 'status' && e.status === 'blocked'),
    ).toMatchObject({
      source: 'herdr',
      promptId: 'ask_1',
      phase: 'prompt',
    })
    driver.close()
  })
})

const CLAUDE_PERM_SCREEN = `\
 Bash command
   mkdir -p zz && rm -r zz && echo done
 Do you want to proceed?
 ❯ 1. Yes
   2. Yes, and don't ask again for mkdir
   3. No
 Esc to cancel · Tab to amend
`

describe('pty-harness-driver permission prompts', () => {
  const sid = ClaudeCodeDriver.sessionId(UUID)

  it('blocked → screen → approval-request with options', async () => {
    const pty = fakePty()
    const driver = new ClaudeCodeDriver({
      store: fakeStore([]),
      pty: () => Promise.resolve(pty.host),
      herdrStatus: true,
      turnQuietMs: 0,
      screen: () => CLAUDE_PERM_SCREEN,
    })
    await driver.startSession({ nativeSessionId: UUID })
    const seen: HarnessEvent[] = []
    driver.subscribe(sid, (e) => seen.push(e))
    driver.applyHerdrStatus(UUID, { type: 'status', sessionId: sid, status: 'blocked', since: 1 })
    await Promise.resolve()
    await Promise.resolve()
    const req = seen.find((e) => e.type === 'approval-request')
    expect(req).toMatchObject({
      type: 'approval-request',
      sessionId: sid,
      requestId: `perm:${UUID}:1`,
      name: 'Bash command',
      input: { text: 'mkdir -p zz && rm -r zz && echo done' },
      reason: 'mkdir -p zz && rm -r zz && echo done',
      options: [
        { key: '1', label: 'Yes' },
        { key: '2', label: "Yes, and don't ask again for mkdir" },
        { key: '3', label: 'No' },
      ],
    })
    driver.applyHerdrStatus(UUID, { type: 'status', sessionId: sid, status: 'working', since: 2 })
    expect(
      seen.some(
        (e) =>
          e.type === 'approval-resolved' &&
          e.requestId === `perm:${UUID}:1` &&
          e.decision === 'external',
      ),
    ).toBe(true)
    driver.close()
  })

  it('resolveApproval injects the adapter key and emits approval-resolved', async () => {
    const pty = fakePty()
    const driver = new ClaudeCodeDriver({
      store: fakeStore([]),
      pty: () => Promise.resolve(pty.host),
      herdrStatus: true,
      turnQuietMs: 0,
      screen: () => CLAUDE_PERM_SCREEN,
    })
    await driver.startSession({ nativeSessionId: UUID })
    const seen: HarnessEvent[] = []
    driver.subscribe(sid, (e) => seen.push(e))
    driver.applyHerdrStatus(UUID, { type: 'status', sessionId: sid, status: 'blocked', since: 1 })
    await Promise.resolve()
    await Promise.resolve()
    const reqId = `perm:${UUID}:1`
    await driver.resolveApproval(sid, reqId, 'allow')
    expect(pty.injects.some((i) => i.text === '1' && i.submit === false)).toBe(true)
    expect(seen.some((e) => e.type === 'approval-resolved' && e.requestId === reqId && e.decision === 'allow')).toBe(
      true,
    )
    await expect(driver.resolveApproval(sid, reqId, 'allow')).rejects.toMatchObject({
      code: 'unknown_approval',
    })
    driver.close()
  })

  it('blocked while an ask-user prompt is pending does not emit approval-request', async () => {
    const tx = fakeTranscript()
    const pty = fakePty()
    const driver = new ClaudeCodeDriver({
      store: fakeStore([]),
      pty: () => Promise.resolve(pty.host),
      transcript: tx,
      herdrStatus: true,
      turnQuietMs: 0,
      screen: () => CLAUDE_PERM_SCREEN,
    })
    await driver.startSession({ nativeSessionId: UUID })
    const seen: HarnessEvent[] = []
    driver.subscribe(sid, (e) => seen.push(e))
    tx.emit(sid, {
      kind: 'transcript',
      session: sid,
      rev: 1,
      command: 'claude',
      from: 0,
      total: 2,
      turns: [
        { role: 'user', text: 'ask' },
        {
          role: 'assistant',
          text: '',
          lastBlock: 'tool_use',
          stopReason: 'tool_use',
          tools: [{ name: 'AskUserQuestion', status: 'running', id: 'ask_1', input: ASK_INPUT }],
        },
      ],
    })
    driver.applyHerdrStatus(UUID, { type: 'status', sessionId: sid, status: 'blocked', since: 1 })
    await Promise.resolve()
    await Promise.resolve()
    expect(seen.filter((e) => e.type === 'approval-request')).toEqual([])
    driver.close()
  })

  it('approvals is true only with pty + herdr + adapter.approvals', () => {
    const withBoth = new ClaudeCodeDriver({
      store: fakeStore([]),
      pty: () => Promise.resolve(fakePty().host),
      herdrStatus: true,
    })
    expect(withBoth.capabilities.approvals).toBe(true)
    const noHerdr = new ClaudeCodeDriver({
      store: fakeStore([]),
      pty: () => Promise.resolve(fakePty().host),
    })
    expect(noHerdr.capabilities.approvals).toBe(false)
    const grok = new GrokBuildDriver({
      store: fakeStore([]),
      pty: () => Promise.resolve(fakePty().host),
      herdrStatus: true,
    })
    expect(grok.capabilities.approvals).toBe(true)
    const kimi = new KimiCodeDriver({
      store: fakeStore([{ id: KIMI_NATIVE, command: 'kimi', title: 't', updatedAt: 1 }]),
      pty: () => Promise.resolve(fakePty().host),
      herdrStatus: true,
    })
    expect(kimi.capabilities.approvals).toBe(true)
    const hermes = new HermesDriver({
      store: fakeStore([{ id: HERMES_NATIVE, command: 'hermes', title: 't', updatedAt: 1 }]),
      pty: () => Promise.resolve(fakePty().host),
      herdrStatus: true,
    })
    expect(hermes.capabilities.approvals).toBe(false)
    withBoth.close()
    noHerdr.close()
    grok.close()
    kimi.close()
    hermes.close()
  })
})

describe('composePromptText fallback', () => {
  it('joins labels and appends other', () => {
    expect(
      composePromptText(
        [{ question: 'Q', header: 'Auth', multiSelect: false, options: [{ label: 'API key' }] }],
        [{ question: 0, labels: ['API key'] }],
      ),
    ).toBe('API key')
  })
})

