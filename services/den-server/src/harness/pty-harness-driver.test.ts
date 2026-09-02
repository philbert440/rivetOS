// Contract tests for the shared `PtyHarnessDriver` base, run against ALL FIVE
// real drivers rather than a stand-in subclass — the point is that every driver
// inherits the behaviour, so every driver is asserted.
//
// This file exists because of a class of bug the per-driver suites structurally
// cannot see: they drive one call at a time, so an `await` opening a window
// between a check and the state change it guards looks identical to correct
// code. Concurrency pins go here.

import { describe, expect, it } from 'vitest'
import { HarnessError, type SessionId } from '@rivetos/types'
import type { HarnessSession } from '../term/harness-sessions.js'
import { ClaudeCodeDriver } from './claude-driver.js'
import { GrokBuildDriver } from './grok-driver.js'
import { HermesDriver } from './hermes-driver.js'
import { KimiCodeDriver } from './kimi-driver.js'
import { DeepseekHarnessDriver } from './deepseek-driver.js'
import type { HarnessCapabilityEvent } from './capabilities.js'
import type { HarnessPtyHost, PtyHarnessDriver } from './pty-harness-driver.js'

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
