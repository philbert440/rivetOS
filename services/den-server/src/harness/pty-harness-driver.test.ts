// Contract tests for the shared `PtyHarnessDriver` base, run against ALL EIGHT
// real drivers rather than a stand-in subclass — the point is that every driver
// inherits the behaviour, so every driver is asserted.
//
// This file exists because of a class of bug the per-driver suites structurally
// cannot see: they drive one call at a time, so an `await` opening a window
// between a check and the state change it guards looks identical to correct
// code. Concurrency pins go here.

import { afterEach, describe, expect, it, vi } from 'vitest'
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
import { CodexDriver } from './codex-driver.js'
import { OpencodeDriver } from './opencode-driver.js'
import { PiDriver } from './pi-driver.js'
import { QwenCodeDriver } from './qwen-code-driver.js'
import type { HarnessCapabilityEvent } from './capabilities.js'
import {
  composePromptText,
  type HarnessPtyHost,
  type PtyHarnessDriver,
} from './pty-harness-driver.js'
import {
  AUTO_MODE_DIALOG_SCREEN,
  CLAUDE_PERM_SCREEN,
  CLAUDE_PICKER_SCREEN,
  FRESH_CLAUDE_PROMPT_SCREEN,
  IDLE_HARNESS_SCREEN,
  MODEL_PICKER_SCREEN,
  OLD_DIALOG_SCROLLBACK_SCREEN,
  SLASH_DRAFT_SCREEN,
} from '../term/tui-screen-fixtures.js'

const UUID = 'a1b2c3d4-1111-4222-8333-444455556666'
/** hermes mints its own, and they are not uuids. */
const HERMES_NATIVE = '20260802_225647_6ad0b9'
/** kimi's are uuid-class, behind a fixed `session_` prefix. */
const KIMI_NATIVE = 'session_89965427-b96f-4d5e-8ad5-c3dd138e33dc'
/** Codex natives are a bare rollout UUID. */
const CODEX_NATIVE = '89965427-b96f-4d5e-8ad5-c3dd138e33dc'
/** OpenCode natives are `ses_` + alphanumerics. */
const OPENCODE_NATIVE = 'ses_01K8ABCDEFGHIJKLMNOPQRSTUV'
const PI_NATIVE = '15cb936c-3364-49d6-8769-21f0c635f160'
const QWEN_NATIVE = '11111111-2222-4333-8444-555555555555'

interface Injected {
  id: string
  text: string
  submit: boolean
  interrupt?: boolean
}

/** Mirrors the term manager's default ceiling. The driver must read it off the host. */
const FAKE_INJECT_READY_MAX_MS = 15_000

interface FakePtyOpts {
  /** Ready-gate. Default true so existing tests stay on the warm path. */
  ready?: boolean
  /** First inject returns false so sendUserTurn takes the dead-pty respawn. */
  deadOnce?: boolean
  injectReadyMaxMs?: number
}

function fakePty(opts: FakePtyOpts = {}): {
  host: HarnessPtyHost
  injects: Injected[]
  /** Accepted while the record was not ready — buffered, not written. */
  buffered: Injected[]
  spawns: number
  setReady(): void
} {
  const injects: Injected[] = []
  const buffered: Injected[] = []
  const live = new Map<string, string>()
  const state = { spawns: 0, ready: opts.ready ?? true, deadOnce: opts.deadOnce ?? false }
  const readyMax = opts.injectReadyMaxMs ?? FAKE_INJECT_READY_MAX_MS
  const host: HarnessPtyHost = {
    spawn: (_key, _cols, _rows, _remote, session) => {
      state.spawns += 1
      const id = `pty-${String(state.spawns)}`
      if (session) live.set(session, id)
      return { id, denSession: session ?? id }
    },
    ptyForSession: (denSession) => live.get(denSession),
    injectReady: (denSession) => (live.has(denSession) ? state.ready : undefined),
    injectReadyMaxMs: () => readyMax,
    inject: (id, text, submit, interrupt) => {
      if (state.deadOnce) {
        state.deadOnce = false
        state.ready = false
        return false
      }
      const row = { id, text, submit, interrupt }
      if (!state.ready) {
        buffered.push(row)
        return true
      }
      injects.push(row)
      return true
    },
  }
  return {
    host,
    injects,
    buffered,
    setReady() {
      state.ready = true
      injects.push(...buffered.splice(0))
    },
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
    'codex',
    (): Subject => {
      const pty = fakePty()
      const store = fakeStore([{ id: CODEX_NATIVE, command: 'codex', title: 't', updatedAt: 1 }])
      const driver = new CodexDriver({
        store,
        pty: () => Promise.resolve(pty.host),
        turnQuietMs: 0,
      })
      return {
        driver,
        sessionId: CodexDriver.sessionId(CODEX_NATIVE),
        injects: pty.injects,
        activate: async () => {
          await driver.resumeSession(CodexDriver.sessionId(CODEX_NATIVE))
        },
      }
    },
  ],
  [
    'opencode',
    (): Subject => {
      const pty = fakePty()
      const store = fakeStore([
        { id: OPENCODE_NATIVE, command: 'opencode', title: 't', updatedAt: 1 },
      ])
      const driver = new OpencodeDriver({
        store,
        pty: () => Promise.resolve(pty.host),
        turnQuietMs: 0,
      })
      return {
        driver,
        sessionId: OpencodeDriver.sessionId(OPENCODE_NATIVE),
        injects: pty.injects,
        activate: async () => {
          await driver.resumeSession(OpencodeDriver.sessionId(OPENCODE_NATIVE))
        },
      }
    },
  ],
  [
    'pi',
    (): Subject => {
      const pty = fakePty()
      const store = fakeStore([{ id: PI_NATIVE, command: 'pi', title: 't', updatedAt: 1 }])
      const driver = new PiDriver({
        store,
        pty: () => Promise.resolve(pty.host),
        turnQuietMs: 0,
      })
      return {
        driver,
        sessionId: PiDriver.sessionId(PI_NATIVE),
        injects: pty.injects,
        activate: async () => {
          await driver.resumeSession(PiDriver.sessionId(PI_NATIVE))
        },
      }
    },
  ],
  [
    'qwen-code',
    (): Subject => {
      const pty = fakePty()
      const store = fakeStore([{ id: QWEN_NATIVE, command: 'qwen', title: 't', updatedAt: 1 }])
      const driver = new QwenCodeDriver({
        store,
        pty: () => Promise.resolve(pty.host),
        turnQuietMs: 0,
      })
      return {
        driver,
        sessionId: QwenCodeDriver.sessionId(QWEN_NATIVE),
        injects: pty.injects,
        activate: async () => {
          await driver.resumeSession(QwenCodeDriver.sessionId(QWEN_NATIVE))
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
    'codex',
    (pty) =>
      new CodexDriver({
        store: fakeStore([{ id: CODEX_NATIVE, command: 'codex', title: 't', updatedAt: 1 }]),
        ...(pty ? { pty } : {}),
      }),
  ],
  [
    'opencode',
    (pty) =>
      new OpencodeDriver({
        store: fakeStore([{ id: OPENCODE_NATIVE, command: 'opencode', title: 't', updatedAt: 1 }]),
        ...(pty ? { pty } : {}),
      }),
  ],
  [
    'pi',
    (pty) =>
      new PiDriver({
        store: fakeStore([{ id: PI_NATIVE, command: 'pi', title: 't', updatedAt: 1 }]),
        ...(pty ? { pty } : {}),
      }),
  ],
  [
    'qwen-code',
    (pty) =>
      new QwenCodeDriver({
        store: fakeStore([{ id: QWEN_NATIVE, command: 'qwen', title: 't', updatedAt: 1 }]),
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
        : name === 'codex'
          ? (`codex:${CODEX_NATIVE}` as SessionId)
          : name === 'opencode'
            ? (`opencode:${OPENCODE_NATIVE}` as SessionId)
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

  it('stamps launchModel from the sheet and drops it when the sheet does not carry it', () => {
    // claudeSheet() declares launchModel → the advertised flag follows.
    expect(new ClaudeCodeDriver({ store: fakeStore([]) }).capabilities.launchModel).toBe(true)
    const custom = new ClaudeCodeDriver({
      store: fakeStore([]),
      sheet: () => ({ models: [{ id: 'a', label: 'A' }], modelFlag: '--model' }),
    })
    expect(custom.capabilities.launchModel).toBeUndefined()
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

  it('a later subscriber gets the current status straight away (the first one gets it from the snapshot)', async () => {
    const tx = fakeTranscript()
    const driver = new ClaudeCodeDriver({ store: fakeStore([]), transcript: tx, turnQuietMs: 0 })
    const first: HarnessEvent[] = []
    driver.subscribe(sid, (e) => first.push(e))
    tx.emit(sid, {
      kind: 'transcript',
      session: sid,
      rev: 1,
      from: 0,
      total: 2,
      command: 'claude',
      turns: [
        { role: 'user', text: 'go' },
        {
          role: 'assistant',
          text: 'done',
          lastBlock: 'text',
          stopReason: 'end_turn',
          complete: true,
        },
      ],
    })
    expect(first.some((e) => e.type === 'status' && e.status === 'idle')).toBe(true)
    const later: HarnessEvent[] = []
    driver.subscribe(sid, (e) => later.push(e))
    expect(later[0]).toMatchObject({
      type: 'status',
      sessionId: sid,
      status: 'idle',
      source: 'transcript',
    })
    driver.close()
  })

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

  it('releases an echoed claim when consecutive snapshots are both already complete', async () => {
    // Debounce can coalesce the incomplete intermediate; tracker stays idle
    // with wasComplete already true and emits no completion edge.
    const tx = fakeTranscript()
    const pty = fakePty()
    const driver = new ClaudeCodeDriver({
      store: fakeStore([]),
      pty: () => Promise.resolve(pty.host),
      transcript: tx,
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
          { role: 'user', text: 'hi' },
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
    await driver.sendUserTurn(sid, { text: 'next' })
    tx.emit(
      sid,
      frame({
        from: 0,
        total: 4,
        rev: 2,
        turns: [
          { role: 'user', text: 'hi' },
          {
            role: 'assistant',
            text: 'ok',
            lastBlock: 'text',
            stopReason: 'end_turn',
            complete: true,
          },
          { role: 'user', text: 'next' },
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
    const live = (driver as unknown as { live: Map<string, { turnInFlight: boolean }> }).live
    expect(live.get(UUID)?.turnInFlight).toBe(false)
    expect(seen.filter((e) => e.type === 'turn-complete')).toEqual([
      { type: 'turn-complete', sessionId: sid, stopReason: 'end-turn' },
    ])
    await expect(driver.sendUserTurn(sid, { text: 'again' })).resolves.toBeUndefined()
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
            tools: [{ name: 'AskUserQuestion', status: 'running', id: 'ask_1', input: ASK_INPUT }],
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
            tools: [{ name: 'AskUserQuestion', status: 'running', id: 'ask_1', input: ASK_INPUT }],
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
            tools: [{ name: 'AskUserQuestion', status: 'running', id: 'ask_1', input: ASK_INPUT }],
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
    expect(seen.find((e) => e.type === 'status' && e.status === 'blocked')).toMatchObject({
      source: 'herdr',
      promptId: 'ask_1',
      phase: 'prompt',
    })
    driver.close()
  })
})

describe('pty-harness-driver permission prompts', () => {
  const sid = ClaudeCodeDriver.sessionId(UUID)

  it('an already-answered AskUserQuestion in the store does NOT resolve a new screen picker; a newer one does', async () => {
    const pty = fakePty()
    const tx = fakeTranscript()
    const driver = new ClaudeCodeDriver({
      store: fakeStore([]),
      pty: () => Promise.resolve(pty.host),
      herdrStatus: true,
      transcript: tx,
      turnQuietMs: 0,
      screen: () => CLAUDE_PICKER_SCREEN,
    })
    await driver.startSession({ nativeSessionId: UUID })
    const seen: HarnessEvent[] = []
    driver.subscribe(sid, (e) => seen.push(e))
    const answered = (id: string, text: string) => ({
      role: 'assistant' as const,
      text: '',
      lastBlock: 'tool_result' as const,
      stopReason: 'tool_use',
      tools: [
        {
          id,
          name: 'AskUserQuestion',
          status: 'done' as const,
          resultText: text,
          input: { questions: [] },
        },
      ],
    })
    tx.emit(sid, {
      kind: 'transcript',
      session: sid,
      rev: 1,
      from: 0,
      total: 2,
      command: 'claude',
      turns: [{ role: 'user', text: 'go' }, answered('q-old', 'Red')],
    })
    driver.applyHerdrStatus(UUID, { type: 'status', sessionId: sid, status: 'blocked', since: 1 })
    await Promise.resolve()
    await Promise.resolve()
    const opened = seen.find((e) => e.type === 'prompt' && !e.resolved)
    expect(opened).toBeDefined()
    // a sync re-snapshot carrying the OLD answer again
    tx.emit(sid, {
      kind: 'transcript',
      session: sid,
      rev: 2,
      from: 0,
      total: 2,
      command: 'claude',
      turns: [{ role: 'user', text: 'go' }, answered('q-old', 'Red')],
    })
    expect(seen.some((e) => e.type === 'prompt' && e.resolved)).toBe(false)
    // the NEW question's answer lands
    tx.emit(sid, {
      kind: 'transcript',
      session: sid,
      rev: 3,
      from: 2,
      total: 3,
      command: 'claude',
      turns: [answered('q-new', 'Green')],
    })
    const resolved = seen.find((e) => e.type === 'prompt' && e.resolved)
    expect(resolved && resolved.resolved?.answerText).toBe('Green')
    driver.close()
  })

  it('a later subscriber gets the open screen prompt replayed (status first, then the prompt)', async () => {
    const pty = fakePty()
    const driver = new ClaudeCodeDriver({
      store: fakeStore([]),
      pty: () => Promise.resolve(pty.host),
      herdrStatus: true,
      turnQuietMs: 0,
      screen: () => CLAUDE_PICKER_SCREEN,
    })
    await driver.startSession({ nativeSessionId: UUID })
    driver.subscribe(sid, () => undefined)
    driver.applyHerdrStatus(UUID, { type: 'status', sessionId: sid, status: 'blocked', since: 1 })
    await Promise.resolve()
    await Promise.resolve()
    const later: HarnessEvent[] = []
    driver.subscribe(sid, (e) => later.push(e))
    expect(later[0]).toMatchObject({ type: 'status', status: 'blocked', phase: 'prompt' })
    expect(later[1]).toMatchObject({
      type: 'prompt',
      kind: 'ask-user',
      promptId: `screen:${UUID}:1`,
    })
    driver.close()
  })

  it('a multi-question picker emits only the current question with its position; answering a non-last single-select presses the digit and resolves it', async () => {
    const pty = fakePty()
    const driver = new ClaudeCodeDriver({
      store: fakeStore([]),
      pty: () => Promise.resolve(pty.host),
      herdrStatus: true,
      turnQuietMs: 0,
      screen: () => CLAUDE_PICKER_MULTI_SCREEN,
    })
    await driver.startSession({ nativeSessionId: UUID })
    const seen: HarnessEvent[] = []
    driver.subscribe(sid, (e) => seen.push(e))
    driver.applyHerdrStatus(UUID, { type: 'status', sessionId: sid, status: 'blocked', since: 1 })
    await Promise.resolve()
    await Promise.resolve()
    const p = seen.find((e) => e.type === 'prompt' && !e.resolved)
    expect(p && p.questions.length).toBe(1)
    expect(p && p.screen).toEqual({ current: 0, total: 2 })
    await driver.answerPrompt(sid, `screen:${UUID}:1`, [{ question: 0, labels: ['Green'] }])
    expect(pty.injects.some((i) => i.text === '2' && i.submit === false)).toBe(true)
    expect(
      seen.some((e) => e.type === 'prompt' && e.resolved && e.promptId === `screen:${UUID}:1`),
    ).toBe(true)
    driver.close()
  })

  it('a later subscriber gets a pending permission dialog replayed as approval-request', async () => {
    const pty = fakePty()
    const driver = new ClaudeCodeDriver({
      store: fakeStore([]),
      pty: () => Promise.resolve(pty.host),
      herdrStatus: true,
      turnQuietMs: 0,
      screen: () => CLAUDE_PERM_SCREEN,
    })
    await driver.startSession({ nativeSessionId: UUID })
    driver.subscribe(sid, () => undefined)
    driver.applyHerdrStatus(UUID, { type: 'status', sessionId: sid, status: 'blocked', since: 1 })
    await Promise.resolve()
    await Promise.resolve()
    const later: HarnessEvent[] = []
    driver.subscribe(sid, (e) => later.push(e))
    const replayed = later.find((e) => e.type === 'approval-request')
    expect(replayed).toMatchObject({
      type: 'approval-request',
      requestId: `perm:${UUID}:1`,
      name: 'Bash',
      reason: expect.stringContaining('mkdir -p zz'),
      options: [
        { key: '1', label: 'Yes' },
        { key: '2', label: expect.any(String) },
        { key: '3', label: 'No' },
      ],
    })
    driver.close()
  })

  it('a finished picker lingering above a live permission dialog yields the dialog, not a prompt', async () => {
    const pty = fakePty()
    const driver = new ClaudeCodeDriver({
      store: fakeStore([]),
      pty: () => Promise.resolve(pty.host),
      herdrStatus: true,
      turnQuietMs: 0,
      screen: () => PICKER_ABOVE_DIALOG_SCREEN,
    })
    await driver.startSession({ nativeSessionId: UUID })
    const seen: HarnessEvent[] = []
    driver.subscribe(sid, (e) => seen.push(e))
    driver.applyHerdrStatus(UUID, { type: 'status', sessionId: sid, status: 'blocked', since: 1 })
    await Promise.resolve()
    await Promise.resolve()
    expect(seen.some((e) => e.type === 'approval-request')).toBe(true)
    expect(seen.some((e) => e.type === 'prompt')).toBe(false)
    driver.close()
  })

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
      name: 'Bash',
      input: { text: expect.stringContaining('mkdir -p zz && rm -r zz && echo done') },
      reason: expect.stringContaining('mkdir -p zz && rm -r zz && echo done'),
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
    expect(
      seen.some(
        (e) => e.type === 'approval-resolved' && e.requestId === reqId && e.decision === 'allow',
      ),
    ).toBe(true)
    await expect(driver.resolveApproval(sid, reqId, 'allow')).rejects.toMatchObject({
      code: 'unknown_approval',
    })
    driver.close()
  })

  it('a chatty blocked stream reads the screen once per cooldown', async () => {
    const pty = fakePty()
    let reads = 0
    const driver = new ClaudeCodeDriver({
      store: fakeStore([]),
      pty: () => Promise.resolve(pty.host),
      herdrStatus: true,
      turnQuietMs: 0,
      screen: () => {
        reads += 1
        return 'nothing that parses'
      },
    })
    await driver.startSession({ nativeSessionId: UUID })
    driver.subscribe(sid, () => undefined)
    for (let i = 1; i <= 4; i++) {
      driver.applyHerdrStatus(UUID, { type: 'status', sessionId: sid, status: 'blocked', since: i })
      await Promise.resolve()
      await Promise.resolve()
    }
    expect(reads).toBe(1)
    driver.close()
  })

  it('answering a prompt resets the capture cooldown so a second prompt right after is read', async () => {
    const pty = fakePty()
    let reads = 0
    const driver = new ClaudeCodeDriver({
      store: fakeStore([]),
      pty: () => Promise.resolve(pty.host),
      herdrStatus: true,
      turnQuietMs: 0,
      screen: () => {
        reads += 1
        return CLAUDE_PERM_SCREEN
      },
    })
    await driver.startSession({ nativeSessionId: UUID })
    driver.subscribe(sid, () => undefined)
    driver.applyHerdrStatus(UUID, { type: 'status', sessionId: sid, status: 'blocked', since: 1 })
    await Promise.resolve()
    await Promise.resolve()
    await driver.resolveApproval(sid, `perm:${UUID}:1`, 'allow')
    driver.applyHerdrStatus(UUID, { type: 'status', sessionId: sid, status: 'blocked', since: 2 })
    await Promise.resolve()
    await Promise.resolve()
    expect(reads).toBe(2)
    driver.close()
  })

  it('a screen read that lands after herdr left blocked mints no card (race re-check)', async () => {
    const pty = fakePty()
    let release: (s: string) => void = () => undefined
    const driver = new ClaudeCodeDriver({
      store: fakeStore([]),
      pty: () => Promise.resolve(pty.host),
      herdrStatus: true,
      turnQuietMs: 0,
      screen: () =>
        new Promise<string>((resolve) => {
          release = resolve
        }),
    })
    await driver.startSession({ nativeSessionId: UUID })
    const seen: HarnessEvent[] = []
    driver.subscribe(sid, (e) => seen.push(e))
    driver.applyHerdrStatus(UUID, { type: 'status', sessionId: sid, status: 'blocked', since: 1 })
    driver.applyHerdrStatus(UUID, { type: 'status', sessionId: sid, status: 'working', since: 2 })
    release(CLAUDE_PERM_SCREEN)
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(seen.some((e) => e.type === 'approval-request')).toBe(false)
    driver.close()
  })

  it('the blocked tool finishing in the transcript resolves the card as external', async () => {
    const pty = fakePty()
    const tx = fakeTranscript()
    const driver = new ClaudeCodeDriver({
      store: fakeStore([]),
      pty: () => Promise.resolve(pty.host),
      herdrStatus: true,
      transcript: tx,
      turnQuietMs: 0,
      screen: () => CLAUDE_PERM_SCREEN,
    })
    await driver.startSession({ nativeSessionId: UUID })
    const seen: HarnessEvent[] = []
    driver.subscribe(sid, (e) => seen.push(e))
    driver.applyHerdrStatus(UUID, { type: 'status', sessionId: sid, status: 'blocked', since: 1 })
    await Promise.resolve()
    await Promise.resolve()
    expect(seen.some((e) => e.type === 'approval-request')).toBe(true)
    tx.emit(sid, {
      kind: 'transcript',
      session: sid,
      rev: 1,
      from: 0,
      total: 2,
      command: 'claude',
      turns: [
        { role: 'user', text: 'go' },
        {
          role: 'assistant',
          text: '',
          lastBlock: 'tool_result',
          stopReason: 'tool_use',
          tools: [{ id: 't1', name: 'Bash', status: 'done' }],
        },
      ],
    })
    expect(seen.some((e) => e.type === 'approval-resolved' && e.decision === 'external')).toBe(true)
    driver.close()
  })

  it('resolveApproval presses the key the SCREEN labels, not the adapter default (grok order)', async () => {
    const pty = fakePty()
    const driver = new ClaudeCodeDriver({
      store: fakeStore([]),
      pty: () => Promise.resolve(pty.host),
      herdrStatus: true,
      turnQuietMs: 0,
      screen: () =>
        [
          "┃  1 (●) Yes, and don't ask again for this command",
          '┃  2 (○) Yes, proceed',
          '┃  3 (○) No, reject',
        ].join('\n'),
    })
    await driver.startSession({ nativeSessionId: UUID })
    driver.subscribe(sid, () => undefined)
    driver.applyHerdrStatus(UUID, { type: 'status', sessionId: sid, status: 'blocked', since: 1 })
    await Promise.resolve()
    await Promise.resolve()
    await driver.resolveApproval(sid, `perm:${UUID}:1`, 'allow')
    expect(pty.injects.some((i) => i.text === '2' && i.submit === false)).toBe(true)
    expect(pty.injects.some((i) => i.text === '1')).toBe(false)
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

const CLAUDE_PICKER_MULTI_SCREEN = `\
←  ☐ Color  ☐ Toppings  ✔ Submit  →
What color would you like?
❯ 1. Red
     The color red
  2. Green
     The color green
  3. Blue
     The color blue
  4. Type something.
────────────────────────────────────────────
  5. Chat about this
Enter to select · Tab/Arrow keys to navigate · Esc to cancel
`

const PICKER_ABOVE_DIALOG_SCREEN = `\
Which color would you like?
❯ 1. Red
  2. Green
  3. Type something.
Enter to select · ↑/↓ to navigate · Esc to cancel
 Bash command
   mkdir -p zz && rm -r zz && echo done
 Do you want to proceed?
 ❯ 1. Yes
   2. Yes, and don't ask again for mkdir
   3. No
 Esc to cancel · Tab to amend
`

describe('pty-harness-driver screen AskUserQuestion picker', () => {
  const sid = ClaudeCodeDriver.sessionId(UUID)

  it('blocked → screen picker → prompt event', async () => {
    const pty = fakePty()
    const driver = new ClaudeCodeDriver({
      store: fakeStore([]),
      pty: () => Promise.resolve(pty.host),
      herdrStatus: true,
      turnQuietMs: 0,
      screen: () => CLAUDE_PICKER_SCREEN,
    })
    await driver.startSession({ nativeSessionId: UUID })
    const seen: HarnessEvent[] = []
    driver.subscribe(sid, (e) => seen.push(e))
    driver.applyHerdrStatus(UUID, { type: 'status', sessionId: sid, status: 'blocked', since: 1 })
    await Promise.resolve()
    await Promise.resolve()
    expect(seen.find((e) => e.type === 'prompt')).toMatchObject({
      type: 'prompt',
      sessionId: sid,
      promptId: `screen:${UUID}:1`,
      kind: 'ask-user',
      toolName: 'AskUserQuestion',
      questions: [
        {
          question: 'Which color would you like?',
          multiSelect: false,
          options: [
            { label: 'Red', description: 'The color red' },
            { label: 'Green', description: 'The color green' },
            { label: 'Blue', description: 'The color blue' },
          ],
        },
      ],
    })
    expect(seen.filter((e) => e.type === 'approval-request')).toEqual([])
    driver.close()
  })

  it('answerPrompt on a screen id injects the expected keys', async () => {
    const pty = fakePty()
    const driver = new ClaudeCodeDriver({
      store: fakeStore([]),
      pty: () => Promise.resolve(pty.host),
      herdrStatus: true,
      turnQuietMs: 0,
      screen: () => CLAUDE_PICKER_SCREEN,
    })
    await driver.startSession({ nativeSessionId: UUID })
    driver.subscribe(sid, () => undefined)
    driver.applyHerdrStatus(UUID, { type: 'status', sessionId: sid, status: 'blocked', since: 1 })
    await Promise.resolve()
    await Promise.resolve()
    await driver.answerPrompt(sid, `screen:${UUID}:1`, [{ question: 0, labels: ['Green'] }])
    expect(pty.injects.some((i) => i.text === '2' && i.submit === false)).toBe(true)
    driver.close()
  })

  it('leaving blocked resolves the screen prompt', async () => {
    const pty = fakePty()
    const driver = new ClaudeCodeDriver({
      store: fakeStore([]),
      pty: () => Promise.resolve(pty.host),
      herdrStatus: true,
      turnQuietMs: 0,
      screen: () => CLAUDE_PICKER_SCREEN,
    })
    await driver.startSession({ nativeSessionId: UUID })
    const seen: HarnessEvent[] = []
    driver.subscribe(sid, (e) => seen.push(e))
    driver.applyHerdrStatus(UUID, { type: 'status', sessionId: sid, status: 'blocked', since: 1 })
    await Promise.resolve()
    await Promise.resolve()
    driver.applyHerdrStatus(UUID, { type: 'status', sessionId: sid, status: 'working', since: 2 })
    const resolved = seen.filter((e) => e.type === 'prompt')
    expect(resolved).toHaveLength(2)
    expect(resolved[1]).toMatchObject({
      type: 'prompt',
      promptId: `screen:${UUID}:1`,
      resolved: { at: expect.any(Number) },
    })
    expect(
      resolved[1] && 'resolved' in resolved[1] ? resolved[1].resolved?.answerText : 'missing',
    ).toBeUndefined()
    driver.close()
  })

  it('a later transcript resultText does not emit a second resolved', async () => {
    const pty = fakePty()
    const tx = fakeTranscript()
    const driver = new ClaudeCodeDriver({
      store: fakeStore([]),
      pty: () => Promise.resolve(pty.host),
      herdrStatus: true,
      transcript: tx,
      turnQuietMs: 0,
      screen: () => CLAUDE_PICKER_SCREEN,
    })
    await driver.startSession({ nativeSessionId: UUID })
    const seen: HarnessEvent[] = []
    driver.subscribe(sid, (e) => seen.push(e))
    driver.applyHerdrStatus(UUID, { type: 'status', sessionId: sid, status: 'blocked', since: 1 })
    await Promise.resolve()
    await Promise.resolve()
    driver.applyHerdrStatus(UUID, { type: 'status', sessionId: sid, status: 'working', since: 2 })
    tx.emit(sid, {
      kind: 'transcript',
      session: sid,
      rev: 1,
      from: 0,
      total: 2,
      command: 'claude',
      turns: [
        { role: 'user', text: 'ask' },
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
              resultText: 'Color: Green',
            },
          ],
        },
      ],
    })
    expect(seen.filter((e) => e.type === 'prompt' && 'resolved' in e && e.resolved)).toHaveLength(1)
    driver.close()
  })

  it('blocked while a screen picker is pending stamps promptId and skips approval', async () => {
    const pty = fakePty()
    let screen = CLAUDE_PICKER_SCREEN
    const driver = new ClaudeCodeDriver({
      store: fakeStore([]),
      pty: () => Promise.resolve(pty.host),
      herdrStatus: true,
      turnQuietMs: 0,
      screen: () => screen,
    })
    await driver.startSession({ nativeSessionId: UUID })
    const seen: HarnessEvent[] = []
    driver.subscribe(sid, (e) => seen.push(e))
    driver.applyHerdrStatus(UUID, { type: 'status', sessionId: sid, status: 'blocked', since: 1 })
    await Promise.resolve()
    await Promise.resolve()
    screen = CLAUDE_PERM_SCREEN
    driver.applyHerdrStatus(UUID, { type: 'status', sessionId: sid, status: 'blocked', since: 2 })
    await Promise.resolve()
    await Promise.resolve()
    expect(
      seen.find((e) => e.type === 'status' && e.status === 'blocked' && e.since === 2),
    ).toMatchObject({
      source: 'herdr',
      promptId: `screen:${UUID}:1`,
      phase: 'prompt',
    })
    expect(seen.filter((e) => e.type === 'approval-request')).toEqual([])
    driver.close()
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

describe('sendUserTurn gates on an open blocking dialog', () => {
  const sid = ClaudeCodeDriver.sessionId(UUID)

  it('rejects without injecting when a live dialog is on screen', async () => {
    const pty = fakePty()
    const driver = new ClaudeCodeDriver({
      store: fakeStore([]),
      pty: () => Promise.resolve(pty.host),
      turnQuietMs: 0,
      screen: () => AUTO_MODE_DIALOG_SCREEN,
    })
    await driver.startSession({ nativeSessionId: UUID })
    await expect(driver.sendUserTurn(sid, { text: 'hello' })).rejects.toMatchObject({
      code: 'turn_in_flight',
      context: { reason: 'harness_dialog' },
    })
    expect(pty.injects).toEqual([])
    driver.close()
  })

  it('rejects while the /model picker is open, so the paste cannot pick a model', async () => {
    const pty = fakePty()
    const driver = new ClaudeCodeDriver({
      store: fakeStore([]),
      pty: () => Promise.resolve(pty.host),
      turnQuietMs: 0,
      screen: () => MODEL_PICKER_SCREEN,
    })
    await driver.startSession({ nativeSessionId: UUID })
    await expect(driver.sendUserTurn(sid, { text: 'test 1' })).rejects.toMatchObject({
      code: 'turn_in_flight',
      context: { reason: 'harness_dialog', dialog: { title: 'Select model' } },
    })
    expect(pty.injects).toEqual([])
    driver.close()
  })

  it('rejects without injecting when the input box holds unsent text', async () => {
    const pty = fakePty()
    const driver = new ClaudeCodeDriver({
      store: fakeStore([]),
      pty: () => Promise.resolve(pty.host),
      turnQuietMs: 0,
      screen: () => SLASH_DRAFT_SCREEN,
    })
    await driver.startSession({ nativeSessionId: UUID })
    await expect(driver.sendUserTurn(sid, { text: 'test 1' })).rejects.toMatchObject({
      code: 'turn_in_flight',
      context: { reason: 'harness_draft' },
    })
    // Never `/modeltest 1`.
    expect(pty.injects).toEqual([])
    driver.close()
  })

  it('refuses a typed Try "…" that is not a placeholder template', async () => {
    const pty = fakePty()
    const screen = FRESH_CLAUDE_PROMPT_SCREEN.replace('Try "refactor <filepath>"', 'Try "foo"')
    const driver = new ClaudeCodeDriver({
      store: fakeStore([]),
      pty: () => Promise.resolve(pty.host),
      turnQuietMs: 0,
      screen: () => screen,
    })
    await driver.startSession({ nativeSessionId: UUID })
    await expect(driver.sendUserTurn(sid, { text: 'test 1' })).rejects.toMatchObject({
      code: 'turn_in_flight',
      context: { reason: 'harness_draft' },
    })
    expect(pty.injects).toEqual([])
    driver.close()
  })

  it('refuses a draft even on the inject button, and never sends Esc over it', async () => {
    const pty = fakePty()
    const driver = new ClaudeCodeDriver({
      store: fakeStore([]),
      pty: () => Promise.resolve(pty.host),
      turnQuietMs: 0,
      screen: () => SLASH_DRAFT_SCREEN,
    })
    await driver.startSession({ nativeSessionId: UUID })
    await expect(
      driver.sendUserTurn(sid, { text: 'test 1', bypassDialogGate: true }),
    ).rejects.toMatchObject({ context: { reason: 'harness_draft' } })
    expect(pty.injects).toEqual([])
    driver.close()
  })

  it("sends normally over a fresh session's placeholder prompt", async () => {
    const pty = fakePty()
    const driver = new ClaudeCodeDriver({
      store: fakeStore([]),
      pty: () => Promise.resolve(pty.host),
      turnQuietMs: 0,
      screen: () => FRESH_CLAUDE_PROMPT_SCREEN,
    })
    await driver.startSession({ nativeSessionId: UUID })
    await driver.sendUserTurn(sid, { text: 'hello' })
    expect(pty.injects.map((i) => i.text)).toEqual(['hello'])
    driver.close()
  })

  it('releases the in-flight lock so a later send succeeds', async () => {
    const pty = fakePty()
    let screen = AUTO_MODE_DIALOG_SCREEN
    const driver = new ClaudeCodeDriver({
      store: fakeStore([]),
      pty: () => Promise.resolve(pty.host),
      turnQuietMs: 0,
      screen: () => screen,
    })
    await driver.startSession({ nativeSessionId: UUID })
    await expect(driver.sendUserTurn(sid, { text: 'hello' })).rejects.toMatchObject({
      code: 'turn_in_flight',
    })
    screen = IDLE_HARNESS_SCREEN
    await driver.sendUserTurn(sid, { text: 'hello' })
    expect(pty.injects).toHaveLength(1)
    driver.close()
  })

  it('fails open when screen capture throws', async () => {
    const pty = fakePty()
    const driver = new ClaudeCodeDriver({
      store: fakeStore([]),
      pty: () => Promise.resolve(pty.host),
      turnQuietMs: 0,
      screen: () => {
        throw new Error('boom')
      },
    })
    await driver.startSession({ nativeSessionId: UUID })
    await driver.sendUserTurn(sid, { text: 'hello' })
    expect(pty.injects).toHaveLength(1)
    driver.close()
  })

  it('fails open with no screen dep', async () => {
    const pty = fakePty()
    const driver = new ClaudeCodeDriver({
      store: fakeStore([]),
      pty: () => Promise.resolve(pty.host),
      turnQuietMs: 0,
    })
    await driver.startSession({ nativeSessionId: UUID })
    await driver.sendUserTurn(sid, { text: 'hello' })
    expect(pty.injects).toHaveLength(1)
    driver.close()
  })

  it('does not gate a non-Claude PTY driver on unsent input text', async () => {
    const pty = fakePty()
    const driver = new GrokBuildDriver({
      store: fakeStore([]),
      pty: () => Promise.resolve(pty.host),
      turnQuietMs: 0,
      screen: () => SLASH_DRAFT_SCREEN,
    })
    await driver.startSession({ nativeSessionId: UUID })
    await driver.sendUserTurn(GrokBuildDriver.sessionId(UUID), { text: 'hello' })
    expect(pty.injects.map((i) => i.text)).toEqual(['hello'])
    driver.close()
  })

  it('does not gate a non-Claude PTY driver on a numbered-menu screen', async () => {
    const pty = fakePty()
    const driver = new GrokBuildDriver({
      store: fakeStore([]),
      pty: () => Promise.resolve(pty.host),
      turnQuietMs: 0,
      screen: () => AUTO_MODE_DIALOG_SCREEN,
    })
    await driver.startSession({ nativeSessionId: UUID })
    await driver.sendUserTurn(GrokBuildDriver.sessionId(UUID), { text: 'hello' })
    expect(pty.injects.map((i) => i.text)).toEqual(['hello'])
    driver.close()
  })

  it('re-checks for a draft before the dead-PTY respawn retry and does not paste', async () => {
    const pty = fakePty()
    let injectAttempts = 0
    pty.host.inject = (id, text, submit, interrupt) => {
      injectAttempts += 1
      if (injectAttempts === 1) return false
      pty.injects.push({ id, text, submit, interrupt })
      return true
    }
    const driver = new ClaudeCodeDriver({
      store: fakeStore([]),
      pty: () => Promise.resolve(pty.host),
      turnQuietMs: 0,
      screen: () => (injectAttempts === 0 ? IDLE_HARNESS_SCREEN : SLASH_DRAFT_SCREEN),
    })
    await driver.startSession({ nativeSessionId: UUID })
    await expect(driver.sendUserTurn(sid, { text: 'hello' })).rejects.toMatchObject({
      code: 'turn_in_flight',
      context: { reason: 'harness_draft' },
    })
    expect(injectAttempts).toBe(1)
    expect(pty.injects).toEqual([])
    driver.close()
  })

  it('re-checks for a dialog before the dead-PTY respawn retry', async () => {
    const pty = fakePty()
    let injectAttempts = 0
    pty.host.inject = (id, text, submit, interrupt) => {
      injectAttempts += 1
      if (injectAttempts === 1) return false
      pty.injects.push({ id, text, submit, interrupt })
      return true
    }
    const driver = new ClaudeCodeDriver({
      store: fakeStore([]),
      pty: () => Promise.resolve(pty.host),
      turnQuietMs: 0,
      screen: () => (injectAttempts === 0 ? IDLE_HARNESS_SCREEN : AUTO_MODE_DIALOG_SCREEN),
    })
    await driver.startSession({ nativeSessionId: UUID })
    await expect(driver.sendUserTurn(sid, { text: 'hello' })).rejects.toMatchObject({
      code: 'turn_in_flight',
      context: { reason: 'harness_dialog' },
    })
    expect(injectAttempts).toBe(1)
    expect(pty.injects).toEqual([])
    driver.close()
  })

  it('dismisses a live permission dialog with Esc before a forced inject', async () => {
    const pty = fakePty()
    const driver = new ClaudeCodeDriver({
      store: fakeStore([]),
      pty: () => Promise.resolve(pty.host),
      turnQuietMs: 0,
      screen: () => CLAUDE_PERM_SCREEN,
    })
    await driver.startSession({ nativeSessionId: UUID })
    // The caller learns a dialog was cancelled, so the UI can say so (#868).
    expect(await driver.sendUserTurn(sid, { text: 'hello', bypassDialogGate: true })).toEqual({
      dismissedDialog: true,
    })
    // interrupt is the term manager's Esc-then-paste. The text is the turn,
    // never the highlighted option 1.
    expect(pty.injects).toEqual([{ id: 'pty-1', text: 'hello', submit: true, interrupt: true }])
    expect(pty.injects.some((i) => i.text === '1')).toBe(false)
    driver.close()
  })

  it('pastes a forced inject normally when no dialog is on screen', async () => {
    const pty = fakePty()
    const driver = new ClaudeCodeDriver({
      store: fakeStore([]),
      pty: () => Promise.resolve(pty.host),
      turnQuietMs: 0,
      screen: () => IDLE_HARNESS_SCREEN,
    })
    await driver.startSession({ nativeSessionId: UUID })
    expect(
      await driver.sendUserTurn(sid, { text: 'hello', bypassDialogGate: true }),
    ).toBeUndefined()
    expect(pty.injects).toEqual([
      { id: 'pty-1', text: 'hello', submit: true, interrupt: undefined },
    ])
    driver.close()
  })

  it('Esc-dismisses a dialog on the dead-PTY retry when the user forced the inject', async () => {
    const pty = fakePty()
    let injectAttempts = 0
    const seen: Injected[] = []
    pty.host.inject = (id, text, submit, interrupt) => {
      injectAttempts += 1
      seen.push({ id, text, submit, interrupt })
      if (injectAttempts === 1) return false
      pty.injects.push({ id, text, submit, interrupt })
      return true
    }
    const driver = new ClaudeCodeDriver({
      store: fakeStore([]),
      pty: () => Promise.resolve(pty.host),
      turnQuietMs: 0,
      screen: () => CLAUDE_PERM_SCREEN,
    })
    await driver.startSession({ nativeSessionId: UUID })
    expect(await driver.sendUserTurn(sid, { text: 'hello', bypassDialogGate: true })).toEqual({
      dismissedDialog: true,
    })
    expect(injectAttempts).toBe(2)
    expect(seen.every((i) => i.interrupt === true && i.text === 'hello')).toBe(true)
    expect(pty.injects.map((i) => i.text)).toEqual(['hello'])
    expect(seen.some((i) => i.text === '1')).toBe(false)
    driver.close()
  })

  it('drops dismissedDialog when the dead-PTY retry sees a clean screen', async () => {
    const pty = fakePty()
    let injectAttempts = 0
    const seen: Injected[] = []
    pty.host.inject = (id, text, submit, interrupt) => {
      injectAttempts += 1
      seen.push({ id, text, submit, interrupt })
      if (injectAttempts === 1) return false
      pty.injects.push({ id, text, submit, interrupt })
      return true
    }
    const driver = new ClaudeCodeDriver({
      store: fakeStore([]),
      pty: () => Promise.resolve(pty.host),
      turnQuietMs: 0,
      // Dialog on the first read; the respawn re-check is idle, so the flag
      // taken from the failed attempt must not survive.
      screen: () => (injectAttempts === 0 ? CLAUDE_PERM_SCREEN : IDLE_HARNESS_SCREEN),
    })
    await driver.startSession({ nativeSessionId: UUID })
    await expect(
      driver.sendUserTurn(sid, { text: 'hello', bypassDialogGate: true }),
    ).resolves.toBeUndefined()
    expect(injectAttempts).toBe(2)
    expect(seen[0]).toMatchObject({ text: 'hello', interrupt: true })
    expect(seen[1]).toMatchObject({ text: 'hello', interrupt: undefined })
    driver.close()
  })

  it('does not block on an old dialog in scrollback', async () => {
    const pty = fakePty()
    const driver = new ClaudeCodeDriver({
      store: fakeStore([]),
      pty: () => Promise.resolve(pty.host),
      turnQuietMs: 0,
      screen: () => OLD_DIALOG_SCROLLBACK_SCREEN,
    })
    await driver.startSession({ nativeSessionId: UUID })
    await driver.sendUserTurn(sid, { text: 'hello' })
    expect(pty.injects).toHaveLength(1)
    driver.close()
  })
})

describe('sendUserTurn delivery confirm', () => {
  const sid = ClaudeCodeDriver.sessionId(UUID)
  const TURN = 'hello there friend'
  const DELIVERY = {
    deliveryConfirmMs: 4000,
    deliveryFallbackMs: 10000,
    deliveryPeekMs: 1500,
    turnQuietMs: 0,
  } as const

  function composerScreen(draft: string): string {
    return `\
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
❯ ${draft}
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents
`
  }

  afterEach(() => {
    vi.useRealTimers()
  })

  /** The screen is idle when the turn is sent (the pre-send check passes) and
   *  shows `after` once the paste has landed: `pasted()` flips it. */
  function screenAfterPaste(after: string): { screen: () => string; pasted: () => void } {
    let current = IDLE_HARNESS_SCREEN
    return { screen: () => current, pasted: () => void (current = after) }
  }

  async function warm(opts: {
    screen?: () => string | Promise<string>
    events?: (
      sink: (ev: { session: string; type: string; text?: string; ts?: number }) => void,
    ) => () => void
    transcript?: ReturnType<typeof fakeTranscript>
    herdrStatus?: boolean
  }): Promise<{
    driver: ClaudeCodeDriver
    pty: ReturnType<typeof fakePty>
    seen: HarnessEvent[]
  }> {
    const pty = fakePty()
    const driver = new ClaudeCodeDriver({
      store: fakeStore([]),
      pty: () => Promise.resolve(pty.host),
      herdrStatus: opts.herdrStatus ?? true,
      ...DELIVERY,
      screen: opts.screen ?? (() => IDLE_HARNESS_SCREEN),
      events: opts.events,
      transcript: opts.transcript,
    })
    await driver.startSession({ nativeSessionId: UUID })
    const seen: HarnessEvent[] = []
    driver.subscribe(sid, (e) => seen.push(e))
    return { driver, pty, seen }
  }

  function undelivered(seen: HarnessEvent[]): HarnessEvent[] {
    return seen.filter((e) => e.type === 'error' && e.code === 'turn_undelivered')
  }

  it('message.user with matching text is delivery', async () => {
    vi.useFakeTimers()
    let emit!: (ev: { session: string; type: string; text?: string }) => void
    const { driver, seen } = await warm({
      events: (sink) => {
        emit = sink
        return () => undefined
      },
    })
    await driver.sendUserTurn(sid, { text: TURN })
    emit({ session: UUID, type: 'message.user', text: TURN })
    await vi.advanceTimersByTimeAsync(20_000)
    expect(undelivered(seen)).toEqual([])
    driver.close()
  })

  it('message.user with pasted_content wrapper matches', async () => {
    vi.useFakeTimers()
    let emit!: (ev: { session: string; type: string; text?: string }) => void
    const { driver, seen } = await warm({
      events: (sink) => {
        emit = sink
        return () => undefined
      },
    })
    await driver.sendUserTurn(sid, { text: TURN })
    emit({
      session: UUID,
      type: 'message.user',
      text: `<pasted_content id="x">\n${TURN}\n</pasted_content id="x">`,
    })
    await vi.advanceTimersByTimeAsync(20_000)
    expect(undelivered(seen)).toEqual([])
    driver.close()
  })

  it('message.user with a system-prompt prefix matches', async () => {
    vi.useFakeTimers()
    let emit!: (ev: { session: string; type: string; text?: string }) => void
    const { driver, seen } = await warm({
      events: (sink) => {
        emit = sink
        return () => undefined
      },
    })
    await driver.sendUserTurn(sid, { text: TURN, systemPrompt: 'be terse' })
    emit({
      session: UUID,
      type: 'message.user',
      text: `[System instructions]\nbe terse\n\n${TURN}`,
    })
    await vi.advanceTimersByTimeAsync(20_000)
    expect(undelivered(seen)).toEqual([])
    driver.close()
  })

  it('herdr working is delivery', async () => {
    vi.useFakeTimers()
    const { driver, seen } = await warm({})
    await driver.sendUserTurn(sid, { text: TURN })
    driver.applyHerdrStatus(UUID, {
      type: 'status',
      sessionId: sid,
      status: 'working',
      since: Date.now(),
    })
    await vi.advanceTimersByTimeAsync(20_000)
    expect(undelivered(seen)).toEqual([])
    driver.close()
  })

  it('herdr blocked is delivery', async () => {
    vi.useFakeTimers()
    const { driver, seen } = await warm({})
    await driver.sendUserTurn(sid, { text: TURN })
    driver.applyHerdrStatus(UUID, {
      type: 'status',
      sessionId: sid,
      status: 'blocked',
      since: Date.now(),
    })
    await vi.advanceTimersByTimeAsync(20_000)
    expect(undelivered(seen)).toEqual([])
    driver.close()
  })

  it('transcript working edge is delivery', async () => {
    vi.useFakeTimers()
    const tx = fakeTranscript()
    const { driver, seen } = await warm({ transcript: tx })
    await driver.sendUserTurn(sid, { text: TURN })
    tx.emit(sid, {
      kind: 'transcript',
      session: sid,
      rev: 1,
      command: 'claude',
      from: 0,
      total: 1,
      turns: [{ role: 'user', text: TURN }],
    })
    await vi.advanceTimersByTimeAsync(20_000)
    expect(undelivered(seen)).toEqual([])
    driver.close()
  })

  it('message.user with different text still fails at the deadline', async () => {
    vi.useFakeTimers()
    let emit!: (ev: { session: string; type: string; text?: string }) => void
    const { driver, seen } = await warm({
      events: (sink) => {
        emit = sink
        return () => undefined
      },
    })
    await driver.sendUserTurn(sid, { text: TURN, deliveryId: 'client-attempt-1' })
    emit({ session: UUID, type: 'message.user', text: 'something else entirely' })
    await vi.advanceTimersByTimeAsync(9_999)
    expect(undelivered(seen)).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(undelivered(seen)).toHaveLength(1)
    expect(undelivered(seen)[0]).toMatchObject({ deliveryId: 'client-attempt-1' })
    driver.close()
  })

  it('a non-message.user den event is not delivery and does not shorten the deadline', async () => {
    vi.useFakeTimers()
    let emit!: (ev: { session: string; type: string; text?: string }) => void
    const { driver, seen } = await warm({
      events: (sink) => {
        emit = sink
        return () => undefined
      },
    })
    await driver.sendUserTurn(sid, { text: TURN })
    emit({ session: UUID, type: 'thinking.delta', text: '…' })
    await vi.advanceTimersByTimeAsync(9_999)
    expect(undelivered(seen)).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(undelivered(seen)).toHaveLength(1)
    expect(undelivered(seen)[0]?.message).toMatch(/10s/)
    seen.length = 0
    await driver.sendUserTurn(sid, { text: 'second' })
    await vi.advanceTimersByTimeAsync(9_999)
    expect(undelivered(seen)).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(undelivered(seen)).toHaveLength(1)
    expect(undelivered(seen)[0]?.message).toMatch(/10s/)
    driver.close()
  })

  it('message.user selects the short deadline for the next turn', async () => {
    vi.useFakeTimers()
    let emit!: (ev: { session: string; type: string; text?: string }) => void
    const { driver, seen } = await warm({
      events: (sink) => {
        emit = sink
        return () => undefined
      },
    })
    emit({ session: UUID, type: 'session.start' })
    await driver.sendUserTurn(sid, { text: TURN })
    // A non-matching echo still proves the delivery hook is installed, but the
    // deadline for THIS turn was already armed at the long fallback.
    emit({ session: UUID, type: 'message.user', text: 'not the turn' })
    await vi.advanceTimersByTimeAsync(9_999)
    expect(undelivered(seen)).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(undelivered(seen)[0]?.message).toMatch(/10s/)
    seen.length = 0
    await driver.sendUserTurn(sid, { text: 'second' })
    await vi.advanceTimersByTimeAsync(3_999)
    expect(undelivered(seen)).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(undelivered(seen)[0]?.message).toMatch(/4s/)
    driver.close()
  })

  it('fails at the screen check when a dialog is open', async () => {
    vi.useFakeTimers()
    let live = false
    const { driver, seen, pty } = await warm({
      screen: () => (live ? AUTO_MODE_DIALOG_SCREEN : IDLE_HARNESS_SCREEN),
    })
    await driver.sendUserTurn(sid, { text: TURN })
    live = true
    await vi.advanceTimersByTimeAsync(1_499)
    expect(undelivered(seen)).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(undelivered(seen)[0]?.message).toMatch(/Teach auto mode/)
    expect(pty.injects).toHaveLength(1)
    driver.close()
  })

  it('fails at 2500ms when the turn is stuck in the input twice', async () => {
    vi.useFakeTimers()
    const stuck = screenAfterPaste(composerScreen(TURN))
    const { driver, seen, pty } = await warm({ screen: stuck.screen })
    await driver.sendUserTurn(sid, { text: TURN })
    stuck.pasted()
    await vi.advanceTimersByTimeAsync(1_500)
    expect(undelivered(seen)).toEqual([])
    await vi.advanceTimersByTimeAsync(999)
    expect(undelivered(seen)).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(undelivered(seen)[0]?.message).toMatch(/input box/)
    expect(pty.injects).toHaveLength(1)
    driver.close()
  })

  it('does not fail early when the input is empty on the second peek', async () => {
    vi.useFakeTimers()
    let n = 0
    const { driver, seen } = await warm({
      screen: () => {
        n += 1
        // 1: pre-send check (idle), 2: first peek (stuck), 3: second peek (clear).
        return n === 2 ? composerScreen(TURN) : IDLE_HARNESS_SCREEN
      },
    })
    await driver.sendUserTurn(sid, { text: TURN })
    await vi.advanceTimersByTimeAsync(2_500)
    expect(undelivered(seen)).toEqual([])
    driver.close()
  })

  it('deadline with hooks seen is 4000ms', async () => {
    vi.useFakeTimers()
    let emit!: (ev: { session: string; type: string; text?: string }) => void
    const { driver, seen } = await warm({
      events: (sink) => {
        emit = sink
        return () => undefined
      },
    })
    emit({ session: UUID, type: 'message.user', text: 'earlier hook' })
    await driver.sendUserTurn(sid, { text: TURN })
    await vi.advanceTimersByTimeAsync(3_999)
    expect(undelivered(seen)).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(undelivered(seen)[0]?.message).toMatch(/4s/)
    driver.close()
  })

  it('deadline with no hooks is 10000ms', async () => {
    vi.useFakeTimers()
    const { driver, seen } = await warm({})
    await driver.sendUserTurn(sid, { text: TURN })
    await vi.advanceTimersByTimeAsync(9_999)
    expect(undelivered(seen)).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(undelivered(seen)[0]?.message).toMatch(/10s/)
    driver.close()
  })

  it('cold pty skips the screen check and uses the long deadline', async () => {
    vi.useFakeTimers()
    const pty = fakePty()
    let screens = 0
    const driver = new ClaudeCodeDriver({
      store: fakeStore([]),
      pty: () => Promise.resolve(pty.host),
      ...DELIVERY,
      events: () => () => undefined,
      screen: () => {
        screens += 1
        return IDLE_HARNESS_SCREEN
      },
    })
    const seen: HarnessEvent[] = []
    driver.subscribe(sid, (e) => seen.push(e))
    await driver.sendUserTurn(sid, { text: TURN })
    const afterSend = screens
    await vi.advanceTimersByTimeAsync(1_500)
    expect(screens).toBe(afterSend)
    await vi.advanceTimersByTimeAsync(23_499)
    expect(undelivered(seen)).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(undelivered(seen)).toHaveLength(1)
    driver.close()
  })

  it('emits error before turn-complete and releases the lock', async () => {
    vi.useFakeTimers()
    const { driver, seen } = await warm({})
    await driver.sendUserTurn(sid, { text: TURN })
    await vi.advanceTimersByTimeAsync(10_000)
    const types = seen
      .filter((e) => e.type === 'error' || e.type === 'turn-complete')
      .map((e) => e.type)
    expect(types.slice(0, 2)).toEqual(['error', 'turn-complete'])
    expect(seen.find((e) => e.type === 'turn-complete')).toMatchObject({
      stopReason: 'undelivered',
    })
    await driver.sendUserTurn(sid, { text: 'again' })
    driver.close()
  })

  it('interrupt before the deadline emits no undelivered error', async () => {
    vi.useFakeTimers()
    const { driver, seen } = await warm({})
    await driver.sendUserTurn(sid, { text: TURN })
    await driver.interrupt(sid)
    await vi.advanceTimersByTimeAsync(20_000)
    expect(undelivered(seen)).toEqual([])
    expect(seen.filter((e) => e.type === 'turn-complete').map((e) => e.stopReason)).toEqual([
      'interrupted',
    ])
    driver.close()
  })

  it('screen throw does not fail early', async () => {
    vi.useFakeTimers()
    const { driver, seen } = await warm({
      screen: () => {
        throw new Error('boom')
      },
    })
    await driver.sendUserTurn(sid, { text: TURN })
    await vi.advanceTimersByTimeAsync(1_500)
    expect(undelivered(seen)).toEqual([])
    await vi.advanceTimersByTimeAsync(8_500)
    expect(undelivered(seen)).toHaveLength(1)
    driver.close()
  })

  it('a not-ready record is cold even when the pty already exists', async () => {
    vi.useFakeTimers()
    const pty = fakePty({ ready: false, injectReadyMaxMs: 20_000 })
    let screens = 0
    const driver = new ClaudeCodeDriver({
      store: fakeStore([]),
      pty: () => Promise.resolve(pty.host),
      ...DELIVERY,
      events: () => () => undefined,
      screen: () => {
        screens += 1
        return IDLE_HARNESS_SCREEN
      },
    })
    await driver.startSession({ nativeSessionId: UUID })
    const seen: HarnessEvent[] = []
    driver.subscribe(sid, (e) => seen.push(e))
    await driver.sendUserTurn(sid, { text: TURN })
    expect(pty.buffered).toHaveLength(1)
    expect(pty.injects).toEqual([])
    const afterSend = screens
    await vi.advanceTimersByTimeAsync(1_500)
    expect(screens).toBe(afterSend)
    await vi.advanceTimersByTimeAsync(28_499)
    expect(undelivered(seen)).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(undelivered(seen)).toHaveLength(1)
    expect(undelivered(seen)[0]?.message).toMatch(/30s/)
    driver.close()
  })

  it('a dead-pty respawn is cold', async () => {
    vi.useFakeTimers()
    const pty = fakePty({ deadOnce: true, injectReadyMaxMs: 12_000 })
    let screens = 0
    const driver = new ClaudeCodeDriver({
      store: fakeStore([]),
      pty: () => Promise.resolve(pty.host),
      ...DELIVERY,
      events: () => () => undefined,
      screen: () => {
        screens += 1
        return IDLE_HARNESS_SCREEN
      },
    })
    await driver.startSession({ nativeSessionId: UUID })
    const seen: HarnessEvent[] = []
    driver.subscribe(sid, (e) => seen.push(e))
    await driver.sendUserTurn(sid, { text: TURN })
    expect(pty.spawns).toBe(2)
    expect(pty.injects).toEqual([])
    expect(pty.buffered).toHaveLength(1)
    const afterSend = screens
    await vi.advanceTimersByTimeAsync(1_500)
    expect(screens).toBe(afterSend)
    await vi.advanceTimersByTimeAsync(20_499)
    expect(undelivered(seen)).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(undelivered(seen)).toHaveLength(1)
    expect(undelivered(seen)[0]?.message).toMatch(/22s/)
    driver.close()
  })

  it('a message quoting pasted_content still matches its wrapped echo', async () => {
    vi.useFakeTimers()
    let emit!: (ev: { session: string; type: string; text?: string; ts?: number }) => void
    const { driver, seen } = await warm({
      events: (sink) => {
        emit = sink
        return () => undefined
      },
    })
    const quoted = 'see <pasted_content id="x">\ncode\n</pasted_content id="x"> please'
    await driver.sendUserTurn(sid, { text: quoted })
    emit({
      session: UUID,
      type: 'message.user',
      ts: Date.now(),
      text: `<pasted_content id="y">\n${quoted}\n</pasted_content id="y">`,
    })
    await vi.advanceTimersByTimeAsync(20_000)
    expect(undelivered(seen)).toEqual([])
    driver.close()
  })

  it('matches on the first 80 characters, not the tail', async () => {
    vi.useFakeTimers()
    let emit!: (ev: { session: string; type: string; text?: string; ts?: number }) => void
    const { driver, seen } = await warm({
      events: (sink) => {
        emit = sink
        return () => undefined
      },
    })
    const head = 'a'.repeat(80)
    const turn = `${head}${' UNIQUE'.repeat(20)}`
    await driver.sendUserTurn(sid, { text: turn })
    emit({
      session: UUID,
      type: 'message.user',
      ts: Date.now(),
      text: `${'b'.repeat(80)}${' UNIQUE'.repeat(20)}`,
    })
    await vi.advanceTimersByTimeAsync(9_999)
    expect(undelivered(seen)).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(undelivered(seen)).toHaveLength(1)
    driver.close()
  })

  it('an identical resend is not proved by the previous echo', async () => {
    vi.useFakeTimers()
    let emit!: (ev: { session: string; type: string; text?: string; ts?: number }) => void
    const { driver, seen } = await warm({
      events: (sink) => {
        emit = sink
        return () => undefined
      },
    })
    const turn = `${'c'.repeat(80)} ONE ${'pad'.repeat(30)}`
    await driver.sendUserTurn(sid, { text: turn })
    const firstTs = Date.now()
    emit({ session: UUID, type: 'message.user', text: turn, ts: firstTs })
    emit({ session: UUID, type: 'turn.end' })
    await vi.advanceTimersByTimeAsync(50)
    await driver.sendUserTurn(sid, { text: turn })
    emit({ session: UUID, type: 'message.user', text: turn, ts: firstTs })
    await vi.advanceTimersByTimeAsync(3_999)
    expect(undelivered(seen)).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(undelivered(seen)).toHaveLength(1)
    expect(undelivered(seen)[0]?.message).toMatch(/4s/)
    driver.close()
  })

  it('a same-prefix resend needs its own echo', async () => {
    vi.useFakeTimers()
    let emit!: (ev: { session: string; type: string; text?: string; ts?: number }) => void
    const { driver, seen } = await warm({
      events: (sink) => {
        emit = sink
        return () => undefined
      },
    })
    const head = 'd'.repeat(80)
    const first = `${head} ALPHA`
    const second = `${head} BETA`
    await driver.sendUserTurn(sid, { text: first })
    const firstTs = Date.now()
    emit({ session: UUID, type: 'message.user', text: first, ts: firstTs })
    emit({ session: UUID, type: 'turn.end' })
    await vi.advanceTimersByTimeAsync(50)
    await driver.sendUserTurn(sid, { text: second })
    // Same 80-char prefix as this turn, but it is the previous turn's echo.
    emit({ session: UUID, type: 'message.user', text: first, ts: firstTs })
    await vi.advanceTimersByTimeAsync(3_999)
    expect(undelivered(seen)).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(undelivered(seen)).toHaveLength(1)
    driver.close()
  })

  it('proves two turns in a row', async () => {
    vi.useFakeTimers()
    let emit!: (ev: { session: string; type: string; text?: string; ts?: number }) => void
    const { driver, seen } = await warm({
      events: (sink) => {
        emit = sink
        return () => undefined
      },
    })
    await driver.sendUserTurn(sid, { text: 'one' })
    emit({ session: UUID, type: 'message.user', text: 'one', ts: Date.now() })
    emit({ session: UUID, type: 'turn.end' })
    await driver.sendUserTurn(sid, { text: 'two' })
    emit({ session: UUID, type: 'message.user', text: 'two', ts: Date.now() })
    emit({ session: UUID, type: 'turn.end' })
    await vi.advanceTimersByTimeAsync(20_000)
    expect(undelivered(seen)).toEqual([])
    expect(seen.filter((e) => e.type === 'turn-complete').map((e) => e.stopReason)).toEqual([
      'end-turn',
      'end-turn',
    ])
    driver.close()
  })

  it('transcript working while the claim is un-echoed is not delivery', async () => {
    vi.useFakeTimers()
    const tx = fakeTranscript()
    const { driver, seen } = await warm({ transcript: tx })
    tx.emit(sid, {
      kind: 'transcript',
      session: sid,
      rev: 1,
      command: 'claude',
      from: 0,
      total: 1,
      turns: [{ role: 'assistant', text: 'done', complete: true }],
    })
    await driver.sendUserTurn(sid, { text: TURN })
    tx.emit(sid, {
      kind: 'transcript',
      session: sid,
      rev: 2,
      command: 'claude',
      from: 0,
      total: 1,
      turns: [{ role: 'user', text: 'previous question still the only row' }],
    })
    expect(
      seen.some((e) => e.type === 'status' && e.status === 'working' && e.source === 'transcript'),
    ).toBe(true)
    await vi.advanceTimersByTimeAsync(9_999)
    expect(undelivered(seen)).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(undelivered(seen)).toHaveLength(1)
    driver.close()
  })

  it('a herdr sample from before this inject is not delivery', async () => {
    vi.useFakeTimers()
    const { driver, seen } = await warm({})
    await driver.sendUserTurn(sid, { text: TURN })
    driver.applyHerdrStatus(UUID, {
      type: 'status',
      sessionId: sid,
      status: 'working',
      since: Date.now() - 5_000,
    })
    await vi.advanceTimersByTimeAsync(9_999)
    expect(undelivered(seen)).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(undelivered(seen)).toHaveLength(1)
    driver.close()
  })

  it('close clears a pending delivery check', async () => {
    vi.useFakeTimers()
    const { driver, seen } = await warm({})
    await driver.sendUserTurn(sid, { text: TURN })
    expect(vi.getTimerCount()).toBeGreaterThan(0)
    driver.close()
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(20_000)
    expect(undelivered(seen)).toEqual([])
  })

  it('late proof after undelivered does not emit a second turn-complete', async () => {
    vi.useFakeTimers()
    let emit!: (ev: { session: string; type: string; text?: string; ts?: number }) => void
    const tx = fakeTranscript()
    const { driver, seen } = await warm({
      transcript: tx,
      events: (sink) => {
        emit = sink
        return () => undefined
      },
    })
    await driver.sendUserTurn(sid, { text: TURN })
    await vi.advanceTimersByTimeAsync(10_000)
    const completes = (): HarnessEvent[] => seen.filter((e) => e.type === 'turn-complete')
    expect(completes()).toHaveLength(1)
    expect(completes()[0]).toMatchObject({ stopReason: 'undelivered' })
    emit({ session: UUID, type: 'message.user', text: TURN, ts: Date.now() })
    driver.applyHerdrStatus(UUID, {
      type: 'status',
      sessionId: sid,
      status: 'working',
      since: Date.now(),
    })
    emit({ session: UUID, type: 'turn.end' })
    tx.emit(sid, {
      kind: 'transcript',
      session: sid,
      rev: 1,
      command: 'claude',
      from: 0,
      total: 1,
      turns: [{ role: 'user', text: TURN }],
    })
    await vi.advanceTimersByTimeAsync(1_000)
    expect(completes()).toHaveLength(1)
    await driver.sendUserTurn(sid, { text: 'next' })
    driver.close()
  })

  it('a short turn does not own a pasted-text placeholder', async () => {
    vi.useFakeTimers()
    const stuck = screenAfterPaste(composerScreen('[Pasted text #1 +12 lines]'))
    const { driver, seen } = await warm({ screen: stuck.screen })
    await driver.sendUserTurn(sid, { text: TURN })
    stuck.pasted()
    await vi.advanceTimersByTimeAsync(2_500)
    expect(undelivered(seen)).toEqual([])
    await vi.advanceTimersByTimeAsync(7_500)
    expect(undelivered(seen)).toHaveLength(1)
    expect(undelivered(seen)[0]?.message).toMatch(/10s/)
    driver.close()
  })

  it('a collapsed paste of this turn fails as stuck input', async () => {
    vi.useFakeTimers()
    const long = `${'line of the paste\n'.repeat(5)}tail`
    const stuck = screenAfterPaste(composerScreen('[Pasted text #1 +12 lines]'))
    const { driver, seen } = await warm({ screen: stuck.screen })
    await driver.sendUserTurn(sid, { text: long })
    stuck.pasted()
    await vi.advanceTimersByTimeAsync(1_500)
    expect(undelivered(seen)).toEqual([])
    await vi.advanceTimersByTimeAsync(999)
    expect(undelivered(seen)).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(undelivered(seen)[0]?.message).toMatch(/input box/)
    driver.close()
  })

  it('two pasted-text placeholders fall back to the deadline', async () => {
    vi.useFakeTimers()
    const long = 'x'.repeat(200)
    const stuck = screenAfterPaste(
      composerScreen('[Pasted text #1 +12 lines] [Pasted text #2 +4 lines]'),
    )
    const { driver, seen } = await warm({ screen: stuck.screen })
    await driver.sendUserTurn(sid, { text: long })
    stuck.pasted()
    await vi.advanceTimersByTimeAsync(2_500)
    expect(undelivered(seen)).toEqual([])
    await vi.advanceTimersByTimeAsync(7_500)
    expect(undelivered(seen)).toHaveLength(1)
    expect(undelivered(seen)[0]?.message).toMatch(/10s/)
    driver.close()
  })

  it('an untimestamped replay cannot prove an identical resend', async () => {
    vi.useFakeTimers()
    let emit!: (ev: { session: string; type: string; text?: string }) => void
    const { driver, seen } = await warm({
      events: (sink) => {
        emit = sink
        return () => undefined
      },
    })
    await driver.sendUserTurn(sid, { text: TURN })
    emit({ session: UUID, type: 'message.user', text: TURN })
    emit({ session: UUID, type: 'turn.end' })
    await driver.sendUserTurn(sid, { text: TURN })
    emit({ session: UUID, type: 'message.user', text: TURN })
    await vi.advanceTimersByTimeAsync(4_000)
    expect(undelivered(seen)).toHaveLength(1)
    driver.close()
  })

  it('a repeated herdr status after inject is not an edge', async () => {
    vi.useFakeTimers()
    const { driver, seen } = await warm({})
    driver.applyHerdrStatus(UUID, {
      type: 'status',
      sessionId: sid,
      status: 'idle',
      since: Date.now(),
    })
    await driver.sendUserTurn(sid, { text: TURN })
    driver.applyHerdrStatus(UUID, {
      type: 'status',
      sessionId: sid,
      status: 'working',
      since: Date.now() - 100,
    })
    driver.applyHerdrStatus(UUID, {
      type: 'status',
      sessionId: sid,
      status: 'working',
      since: Date.now(),
    })
    await vi.advanceTimersByTimeAsync(10_000)
    expect(undelivered(seen)).toHaveLength(1)
    driver.close()
  })

  it('a buffered paste flushes once and can prove delivery after the warm deadline', async () => {
    vi.useFakeTimers()
    const pty = fakePty({ ready: false, injectReadyMaxMs: 20_000 })
    let emit!: (ev: { session: string; type: string; text?: string; ts?: number }) => void
    const driver = new ClaudeCodeDriver({
      store: fakeStore([]),
      pty: () => Promise.resolve(pty.host),
      ...DELIVERY,
      events: (sink) => {
        emit = sink
        return () => undefined
      },
    })
    await driver.startSession({ nativeSessionId: UUID })
    const seen: HarnessEvent[] = []
    driver.subscribe(sid, (e) => seen.push(e))
    await driver.sendUserTurn(sid, { text: TURN })
    await vi.advanceTimersByTimeAsync(20_000)
    expect(undelivered(seen)).toEqual([])
    await expect(driver.sendUserTurn(sid, { text: TURN })).rejects.toMatchObject({
      code: 'turn_in_flight',
    })
    pty.setReady()
    expect(pty.injects).toHaveLength(1)
    expect(pty.buffered).toEqual([])
    emit({ session: UUID, type: 'message.user', text: TURN, ts: Date.now() })
    await vi.advanceTimersByTimeAsync(20_000)
    expect(undelivered(seen)).toEqual([])
    driver.close()
  })

  it('rotation preserves the remaining cold deadline', async () => {
    vi.useFakeTimers()
    class RotatingDriver extends ClaudeCodeDriver {
      rekey(from: string, to: string): void {
        this.rotate(from, to)
      }
    }
    const pty = fakePty({ ready: false, injectReadyMaxMs: 20_000 })
    const driver = new RotatingDriver({
      events: () => () => undefined,
      store: fakeStore([]),
      pty: () => Promise.resolve(pty.host),
      ...DELIVERY,
    })
    await driver.startSession({ nativeSessionId: UUID })
    await driver.sendUserTurn(sid, { text: TURN })
    await vi.advanceTimersByTimeAsync(5_000)
    const next = 'b1b2c3d4-1111-4222-8333-444455556666'
    driver.rekey(UUID, next)
    const seen: HarnessEvent[] = []
    driver.subscribe(ClaudeCodeDriver.sessionId(next), (e) => seen.push(e))
    await vi.advanceTimersByTimeAsync(24_999)
    expect(undelivered(seen)).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(undelivered(seen)).toHaveLength(1)
    driver.close()
  })

  it('close suppresses a delivery capture already awaiting its screen', async () => {
    vi.useFakeTimers()
    let resolve!: (screen: string) => void
    let pending = false
    const { driver, seen } = await warm({
      screen: () =>
        pending
          ? new Promise<string>((done) => {
              resolve = done
            })
          : IDLE_HARNESS_SCREEN,
    })
    await driver.sendUserTurn(sid, { text: TURN })
    pending = true
    await vi.advanceTimersByTimeAsync(1_500)
    driver.close()
    resolve(AUTO_MODE_DIALOG_SCREEN)
    await vi.advanceTimersByTimeAsync(20_000)
    expect(vi.getTimerCount()).toBe(0)
    expect(undelivered(seen)).toEqual([])
  })

  it('deliveryConfirmMs 0 does not arm', async () => {
    vi.useFakeTimers()
    const pty = fakePty()
    const driver = new ClaudeCodeDriver({
      store: fakeStore([]),
      pty: () => Promise.resolve(pty.host),
      turnQuietMs: 0,
      deliveryConfirmMs: 0,
      events: () => () => undefined,
      screen: () => IDLE_HARNESS_SCREEN,
    })
    await driver.startSession({ nativeSessionId: UUID })
    const seen: HarnessEvent[] = []
    driver.subscribe(sid, (e) => seen.push(e))
    await driver.sendUserTurn(sid, { text: TURN })
    await vi.advanceTimersByTimeAsync(20_000)
    expect(undelivered(seen)).toEqual([])
    driver.close()
  })
})

describe('session cwd on summaries', () => {
  it('uses sessionCwd when present and falls back to the roster cwd', async () => {
    const recorded = new ClaudeCodeDriver({
      store: fakeStore([{ id: UUID, command: 'claude', title: 't', updatedAt: 1 }]),
      cwd: () => '/home/roster',
      sessionCwd: (command, id) => (command === 'claude' && id === UUID ? '/srv/agent' : undefined),
    })
    const [summary] = await recorded.listSessions()
    expect(summary.cwd).toBe('/srv/agent')

    const rosterOnly = new ClaudeCodeDriver({
      store: fakeStore([{ id: UUID, command: 'claude', title: 't', updatedAt: 1 }]),
      cwd: () => '/home/roster',
      sessionCwd: () => undefined,
    })
    expect((await rosterOnly.listSessions())[0].cwd).toBe('/home/roster')

    const pty = fakePty()
    const live = new ClaudeCodeDriver({
      store: fakeStore([]),
      pty: () => Promise.resolve(pty.host),
      cwd: () => '/home/roster',
      sessionCwd: () => '/srv/live',
    })
    expect((await live.startSession({ nativeSessionId: UUID })).cwd).toBe('/srv/live')
  })
})
