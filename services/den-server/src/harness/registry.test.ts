// Driver registry: registration, capability sheet, alias-resolved dispatch,
// bare-uuid probing, and the rotation bookkeeping it does on behalf of drivers.

import { describe, expect, it, vi } from 'vitest'
import type {
  HarnessCapabilities,
  HarnessDriver,
  HarnessEvent,
  HarnessId,
  HarnessSessionSummary,
  SessionId,
} from '@rivetos/types'
import type { HarnessCapabilityEvent } from './capabilities.js'
import { createHarnessRegistry, isHarnessId } from './registry.js'

const UUID = 'a1b2c3d4-1111-4222-8333-444455556666'

const CAPS: HarnessCapabilities = {
  interrupt: true,
  resume: true,
  approvals: false,
  liveStream: true,
  listSessions: true,
}

class StubDriver implements HarnessDriver {
  get capabilities(): HarnessCapabilities {
    return CAPS
  }
  readonly known = new Set<SessionId>()
  readonly getSessionCalls: SessionId[] = []
  private readonly registrySinks = new Set<(e: HarnessEvent) => void>()
  detached = 0

  constructor(readonly harnessId: HarnessId) {}

  startSession(): Promise<HarnessSessionSummary> {
    throw new Error('not used')
  }
  resumeSession(): Promise<HarnessSessionSummary> {
    throw new Error('not used')
  }
  interrupt(): Promise<void> {
    return Promise.resolve()
  }
  sendUserTurn(): Promise<void> {
    return Promise.resolve()
  }
  resolveApproval(): Promise<void> {
    return Promise.resolve()
  }
  subscribe(): () => void {
    return () => undefined
  }
  subscribeEvents(sink: (e: HarnessEvent) => void): () => void {
    this.registrySinks.add(sink)
    return () => {
      this.detached++
      this.registrySinks.delete(sink)
    }
  }
  listSessions(): Promise<HarnessSessionSummary[]> {
    return Promise.resolve([])
  }
  getSession(sessionId: SessionId): Promise<HarnessSessionSummary | null> {
    this.getSessionCalls.push(sessionId)
    return Promise.resolve(
      this.known.has(sessionId)
        ? {
            sessionId,
            harnessId: this.harnessId,
            createdAt: '2026-08-08T00:00:00.000Z',
            updatedAt: '2026-08-08T00:00:00.000Z',
            status: 'idle',
          }
        : null,
    )
  }
  emit(e: HarnessEvent): void {
    for (const sink of this.registrySinks) sink(e)
  }
}

describe('isHarnessId', () => {
  it('accepts only the four product tokens', () => {
    expect(['claude-code', 'grok-build', 'kimi-code', 'hermes'].every(isHarnessId)).toBe(true)
    expect(isHarnessId('claude')).toBe(false)
    expect(isHarnessId('claude-cli')).toBe(false)
  })
})

describe('registration', () => {
  it('exposes drivers and their capability flags', () => {
    const registry = createHarnessRegistry()
    registry.register(new StubDriver('claude-code'))
    expect(registry.list()).toEqual([{ harnessId: 'claude-code', capabilities: CAPS }])
    expect(registry.get('claude-code')).toBeDefined()
    expect(registry.get('grok-build')).toBeUndefined()
    expect(registry.get('nonsense')).toBeUndefined()
  })

  it('refuses a second driver for the same harness', () => {
    const registry = createHarnessRegistry()
    registry.register(new StubDriver('claude-code'))
    expect(() => registry.register(new StubDriver('claude-code'))).toThrowError(
      /already registered/,
    )
  })

  it('refuses an unknown harness id', () => {
    const registry = createHarnessRegistry()
    expect(() =>
      registry.register(new StubDriver('claude-cli' as unknown as HarnessId)),
    ).toThrowError(/unknown harness id/)
  })

  it('detaches every driver stream on close', () => {
    const registry = createHarnessRegistry()
    const driver = new StubDriver('claude-code')
    registry.register(driver)
    registry.close()
    expect(driver.detached).toBe(1)
    expect(registry.list()).toEqual([])
  })
})

describe('resolve', () => {
  it('dispatches a canonical id without probing the driver', async () => {
    const registry = createHarnessRegistry()
    const driver = new StubDriver('claude-code')
    registry.register(driver)
    const resolved = await registry.resolve(`claude-code:${UUID}`)
    expect(resolved.sessionId).toBe(`claude-code:${UUID}`)
    expect(resolved.requestedId).toBeUndefined()
    expect(driver.getSessionCalls).toEqual([])
  })

  it('collapses the path fallback and reports the requested id', async () => {
    const registry = createHarnessRegistry()
    registry.register(new StubDriver('claude-code'))
    const legacy = `claude-code:-home-rivet-repo/${UUID}`
    const resolved = await registry.resolve(legacy)
    expect(resolved.sessionId).toBe(`claude-code:${UUID}`)
    expect(resolved.requestedId).toBe(legacy)
  })

  it('probes registered drivers for a bare native uuid, then memoizes', async () => {
    const registry = createHarnessRegistry()
    const grok = new StubDriver('grok-build')
    const claude = new StubDriver('claude-code')
    claude.known.add(`claude-code:${UUID}`)
    registry.register(grok)
    registry.register(claude)

    const first = await registry.resolve(UUID)
    expect(first.sessionId).toBe(`claude-code:${UUID}`)
    expect(first.driver).toBe(claude)
    expect(grok.getSessionCalls).toEqual([`grok-build:${UUID}`])

    const before = claude.getSessionCalls.length
    await registry.resolve(UUID)
    // grok is not re-probed once the owner is known
    expect(grok.getSessionCalls).toHaveLength(1)
    expect(claude.getSessionCalls.length).toBe(before + 1)
  })

  it('rejects a bare uuid no driver claims', async () => {
    const registry = createHarnessRegistry()
    registry.register(new StubDriver('claude-code'))
    await expect(registry.resolve(UUID)).rejects.toMatchObject({ code: 'invalid_session_id' })
  })

  it('rejects a canonical id whose harness has no driver', async () => {
    const registry = createHarnessRegistry()
    registry.register(new StubDriver('claude-code'))
    await expect(registry.resolve('hermes:9b41')).rejects.toMatchObject({
      code: 'invalid_session_id',
    })
  })

  it('rejects malformed ids before dispatch', async () => {
    const registry = createHarnessRegistry()
    registry.register(new StubDriver('claude-code'))
    for (const bad of ['', 'task:42', 'claude:xyz', ` claude-code:${UUID} `]) {
      await expect(registry.resolve(bad)).rejects.toMatchObject({ code: 'invalid_session_id' })
    }
  })
})

describe('rotation bookkeeping', () => {
  it('records the alias from a driver session-updated and resolves through it', async () => {
    const registry = createHarnessRegistry()
    const driver = new StubDriver('claude-code')
    registry.register(driver)
    const previous = `claude-code:${UUID}` as SessionId
    const next = 'claude-code:rotated-0001' as SessionId
    driver.emit({ type: 'session-updated', sessionId: next, previousSessionId: previous, status: 'active' })

    expect(registry.knows(previous)).toBe(true)
    const resolved = await registry.resolve(previous)
    expect(resolved.sessionId).toBe(next)
    expect(resolved.requestedId).toBe(previous)
  })

  it('drops a cross-harness rotation but still delivers the event', () => {
    const registry = createHarnessRegistry()
    const driver = new StubDriver('claude-code')
    registry.register(driver)
    const seen: HarnessEvent[] = []
    registry.subscribe((e) => seen.push(e))
    const event: HarnessEvent = {
      type: 'session-updated',
      sessionId: 'claude-code:new',
      previousSessionId: 'grok-build:old',
      status: 'active',
    }
    driver.emit(event)
    expect(seen).toEqual([event])
    expect(registry.knows('grok-build:old')).toBe(false)
  })
})

describe('registry stream', () => {
  it('fans every driver out, honors the harness filter, and unsubscribes', () => {
    const registry = createHarnessRegistry()
    const claude = new StubDriver('claude-code')
    const grok = new StubDriver('grok-build')
    registry.register(claude)
    registry.register(grok)

    const all: HarnessEvent[] = []
    const claudeOnly: HarnessEvent[] = []
    const offAll = registry.subscribe((e) => all.push(e))
    registry.subscribe((e) => claudeOnly.push(e), 'claude-code')

    const summary: HarnessSessionSummary = {
      sessionId: `claude-code:${UUID}`,
      harnessId: 'claude-code',
      createdAt: '2026-08-08T00:00:00.000Z',
      updatedAt: '2026-08-08T00:00:00.000Z',
      status: 'idle',
    }
    claude.emit({ type: 'session-created', sessionId: summary.sessionId, summary })
    grok.emit({ type: 'session-updated', sessionId: 'grok-build:x', status: 'idle' })
    offAll()
    claude.emit({ type: 'session-updated', sessionId: summary.sessionId, status: 'ended' })

    expect(all).toHaveLength(2)
    expect(claudeOnly.map((e) => e.type)).toEqual(['session-created', 'session-updated'])
  })

  it('keeps fanning out when one subscriber throws', () => {
    const registry = createHarnessRegistry()
    const driver = new StubDriver('claude-code')
    registry.register(driver)
    const good = vi.fn()
    registry.subscribe(() => {
      throw new Error('bad subscriber')
    })
    registry.subscribe(good)
    driver.emit({ type: 'session-updated', sessionId: `claude-code:${UUID}`, status: 'idle' })
    expect(good).toHaveBeenCalledOnce()
  })
})

// -- capability truthing -------------------------------------------------------
//
// The registry owns the capability SHEET, so it also owns making the sheet
// honest: probing drivers before their flags are advertised, and fanning a
// post-advertisement flip to registry-stream clients. Both are feature-detected
// off the driver (`capabilities.ts`) — a driver without the surface still
// registers, still lists, and simply never flips.

/** A driver that runtime-truths its flags, the way `PtyHarnessDriver` does. */
class TruthingDriver extends StubDriver {
  probes = 0
  private pty = true
  private readonly capabilitySinks = new Set<(e: HarnessCapabilityEvent) => void>()

  override get capabilities(): HarnessCapabilities {
    return { ...CAPS, interrupt: this.pty, resume: this.pty }
  }

  /** Model the node losing its PTY backend between reads. */
  losePty(): void {
    this.pty = false
    const event: HarnessCapabilityEvent = {
      type: 'harness-capabilities',
      harnessId: this.harnessId,
      capabilities: this.capabilities,
      changed: { interrupt: false, resume: false },
      reason: 'test',
    }
    for (const sink of this.capabilitySinks) sink(event)
  }

  verifyCapabilities(): Promise<HarnessCapabilities> {
    this.probes += 1
    return Promise.resolve(this.capabilities)
  }

  subscribeCapabilities(sink: (e: HarnessCapabilityEvent) => void): () => void {
    this.capabilitySinks.add(sink)
    return () => this.capabilitySinks.delete(sink)
  }
}

describe('capability truthing', () => {
  it('probes every driver, or just the one asked for', async () => {
    const registry = createHarnessRegistry()
    const claude = new TruthingDriver('claude-code')
    const hermes = new TruthingDriver('hermes')
    registry.register(claude)
    registry.register(hermes)

    await registry.verifyCapabilities()
    expect([claude.probes, hermes.probes]).toEqual([1, 1])

    await registry.verifyCapabilities('hermes')
    expect([claude.probes, hermes.probes]).toEqual([1, 2])
  })

  it('reports the post-probe sheet in list()', async () => {
    const registry = createHarnessRegistry()
    const driver = new TruthingDriver('claude-code')
    registry.register(driver)
    driver.losePty()
    await registry.verifyCapabilities()
    expect(registry.list()).toEqual([
      { harnessId: 'claude-code', capabilities: { ...CAPS, interrupt: false, resume: false } },
    ])
  })

  it('tolerates a driver with no truthing surface, and one whose probe rejects', async () => {
    const registry = createHarnessRegistry()
    registry.register(new StubDriver('claude-code'))
    const broken = new TruthingDriver('hermes')
    broken.verifyCapabilities = (): Promise<HarnessCapabilities> =>
      Promise.reject(new Error('probe exploded'))
    registry.register(broken)
    // A probe is a question about capabilities, never a way to fail the caller.
    await expect(registry.verifyCapabilities()).resolves.toBeUndefined()
    expect(registry.list()).toHaveLength(2)
  })

  it('fans a flip to capability subscribers, honoring the harness filter', () => {
    const registry = createHarnessRegistry()
    const claude = new TruthingDriver('claude-code')
    const hermes = new TruthingDriver('hermes')
    registry.register(claude)
    registry.register(hermes)

    const all: HarnessCapabilityEvent[] = []
    const hermesOnly: HarnessCapabilityEvent[] = []
    registry.subscribeCapabilities((e) => all.push(e))
    registry.subscribeCapabilities((e) => hermesOnly.push(e), 'hermes')

    claude.losePty()
    hermes.losePty()

    expect(all.map((e) => e.harnessId)).toEqual(['claude-code', 'hermes'])
    expect(hermesOnly.map((e) => e.harnessId)).toEqual(['hermes'])
  })

  it('stops fanning flips once the subscriber unsubscribes, and on close', () => {
    const registry = createHarnessRegistry()
    const driver = new TruthingDriver('claude-code')
    registry.register(driver)
    const seen: HarnessCapabilityEvent[] = []
    const off = registry.subscribeCapabilities((e) => seen.push(e))
    off()
    driver.losePty()
    expect(seen).toEqual([])

    const after: HarnessCapabilityEvent[] = []
    registry.subscribeCapabilities((e) => after.push(e))
    registry.close()
    driver.losePty()
    expect(after).toEqual([])
  })

  it('keeps fanning when one capability subscriber throws', () => {
    const registry = createHarnessRegistry()
    const driver = new TruthingDriver('claude-code')
    registry.register(driver)
    const good = vi.fn()
    registry.subscribeCapabilities(() => {
      throw new Error('bad subscriber')
    })
    registry.subscribeCapabilities(good)
    driver.losePty()
    expect(good).toHaveBeenCalledOnce()
  })
})
