// Contract tests for the shared `PtyHarnessDriver` base, run against ALL THREE
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
import type { HarnessPtyHost, PtyHarnessDriver } from './pty-harness-driver.js'

const UUID = 'a1b2c3d4-1111-4222-8333-444455556666'
/** hermes mints its own, and they are not uuids. */
const HERMES_NATIVE = '20260802_225647_6ad0b9'

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
      const store = fakeStore([
        { id: HERMES_NATIVE, command: 'hermes', title: 't', updatedAt: 1 },
      ])
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
