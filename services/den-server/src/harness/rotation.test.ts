// Rotation: the control plane's half of "the harness replaced its native id".
//
// Runs the shared driver-conformance suite against the fake rotating driver,
// once per way a driver may order its rotation emits (all four are conformant
// — the control plane must deliver exactly once regardless), then covers the
// control-plane-only edges the suite deliberately leaves out.

import { describe, expect, it } from 'vitest'
import type { HarnessEvent, SessionId } from '@rivetos/types'
import { createHarnessRegistry, type HarnessRegistry } from './registry.js'
import { runHarnessRotationConformance } from './test/driver-conformance.js'
import {
  FakeRotatingDriver,
  type FakeRotatingDriverOpts,
  type RotationDelivery,
} from './test/fake-rotating-driver.js'

const DELIVERIES: RotationDelivery[] = [
  'session-sinks-first',
  'registry-first',
  'registry-only',
  'new-id-sinks',
]

function harness(opts: FakeRotatingDriverOpts = {}): {
  registry: HarnessRegistry
  driver: FakeRotatingDriver
  sessionId: SessionId
} {
  const driver = new FakeRotatingDriver(opts)
  const registry = createHarnessRegistry()
  registry.register(driver)
  return { registry, driver, sessionId: driver.seed() }
}

for (const rotationDelivery of DELIVERIES) {
  runHarnessRotationConformance(`fake rotating driver (${rotationDelivery})`, () => {
    const ctx = harness({ rotationDelivery })
    return {
      ...ctx,
      rotate: (from) => ctx.driver.rotate(from),
      emitActivity: (id) => {
        ctx.driver.activity(id)
      },
      teardown: () => {
        ctx.registry.close()
      },
    }
  })
}

// The store-keyed-on-the-old-id shape: the row must survive the rotation, but
// under its canonical id.
runHarnessRotationConformance('fake rotating driver (stale list rows)', () => {
  const ctx = harness({ keepSupersededInList: true })
  return {
    ...ctx,
    rotate: (from) => ctx.driver.rotate(from),
    emitActivity: (id) => {
      ctx.driver.activity(id)
    },
    teardown: () => {
      ctx.registry.close()
    },
  }
})

describe('subscription re-keying', () => {
  it('re-subscribes the driver under the new id and drops the old one', () => {
    const { registry, driver, sessionId } = harness()
    registry.subscribeSession(sessionId, () => undefined)
    const next = driver.rotate(sessionId)

    expect(driver.subscribeCalls).toEqual([sessionId, next])
    // The old id has no sinks left, so an event emitted there reaches nobody.
    const seen: HarnessEvent[] = []
    registry.subscribeSession(next, (e) => seen.push(e))
    driver.activity(sessionId)
    expect(seen).toEqual([])
    registry.close()
  })

  it('moves only the tails on the rotating chain', () => {
    const { registry, driver, sessionId } = harness()
    const other = driver.seed()
    const rotated: HarnessEvent[] = []
    const untouched: HarnessEvent[] = []
    registry.subscribeSession(sessionId, (e) => rotated.push(e))
    registry.subscribeSession(other, (e) => untouched.push(e))

    const next = driver.rotate(sessionId)
    driver.activity(other)

    expect(rotated.map((e) => e.sessionId)).toEqual([next])
    expect(untouched.map((e) => e.sessionId)).toEqual([other])
    registry.close()
  })

  it('attaches a late subscriber straight to the canonical id', () => {
    const { registry, driver, sessionId } = harness()
    const next = driver.rotate(sessionId)
    const seen: HarnessEvent[] = []
    // Subscribing with a superseded id is legal and never reaches the driver
    // as such — alias resolution happens before dispatch.
    registry.subscribeSession(sessionId, (e) => seen.push(e))
    expect(driver.subscribeCalls).toEqual([next])
    driver.activity(next)
    expect(seen.map((e) => e.sessionId)).toEqual([next])
    registry.close()
  })

  it('keeps one bad sink from breaking the others through a rotation', () => {
    const { registry, driver, sessionId } = harness()
    const good: HarnessEvent[] = []
    registry.subscribeSession(sessionId, () => {
      throw new Error('bad subscriber')
    })
    registry.subscribeSession(sessionId, (e) => good.push(e))

    const next = driver.rotate(sessionId)
    driver.activity(next)

    expect(good.map((e) => e.sessionId)).toEqual([next, next])
    registry.close()
  })

  it('leaves the tail alone when the rotation is rejected', () => {
    const { registry, driver, sessionId } = harness()
    const seen: HarnessEvent[] = []
    registry.subscribeSession(sessionId, (e) => seen.push(e))
    // Cross-harness alias: rejected by the store, so nothing is re-keyed and
    // the tail stays where it is.
    driver.emitRaw({
      type: 'session-updated',
      sessionId: 'claude-code:99999999-0000-4000-8000-000000000000',
      previousSessionId: sessionId,
      status: 'active',
    })

    expect(seen).toEqual([])
    expect(registry.isSuperseded(sessionId)).toBe(false)
    expect(driver.subscribeCalls).toEqual([sessionId])
    registry.close()
  })

  it('survives a rotation emitted from inside the re-key subscribe', () => {
    // The re-entrancy case: the driver rotates AGAIN while the control plane
    // is attaching the tail to the first new id. The inner frame gets further
    // down the chain than the outer one, so the outer must not overwrite it.
    const { registry, driver, sessionId } = harness()
    const seen: HarnessEvent[] = []
    registry.subscribeSession(sessionId, (e) => seen.push(e))

    let nested = false
    let third: SessionId | undefined
    driver.hookSubscribe = (id) => {
      if (nested || id === sessionId) return
      nested = true
      third = driver.rotate(id)
    }
    const second = driver.rotate(sessionId)
    driver.hookSubscribe = undefined

    expect(third).toBeDefined()
    expect(driver.subscribeCalls).toEqual([sessionId, second, third])
    // Both hops reached the client, in chain order and once each.
    expect(seen).toEqual([
      { type: 'session-updated', sessionId: second, previousSessionId: sessionId, status: 'active' },
      { type: 'session-updated', sessionId: third, previousSessionId: second, status: 'active' },
    ])

    // The tail ended up on the head of the chain, attached exactly once, and
    // nothing is left listening on the abandoned ids.
    seen.length = 0
    driver.activity(third as SessionId)
    driver.activity(second)
    driver.activity(sessionId)
    expect(seen.map((e) => e.sessionId)).toEqual([third])
    registry.close()
  })

  it('has teeth: a self-rekeying driver double-delivers and the suite would fail it', () => {
    // The conformance suite asserts an EXACT sequence for post-rotation
    // events. This is the misbehavior that assertion exists to catch: a driver
    // that drags its own sinks onto the new id leaves the tail attached twice.
    const { registry, driver, sessionId } = harness({ selfRekeyOnRotate: true })
    const seen: HarnessEvent[] = []
    registry.subscribeSession(sessionId, (e) => seen.push(e))
    const next = driver.rotate(sessionId)
    seen.length = 0

    driver.activity(next)

    expect(seen.map((e) => e.sessionId)).toEqual([next, next])
    registry.close()
  })

  it('signals the client when the driver refuses the post-rotation tail', () => {
    const { registry, driver, sessionId } = harness()
    const doomedNative = '5f0c1d22-0000-4000-8000-0000000000ab'
    const doomed = `hermes:${doomedNative}` as SessionId
    driver.refuseSubscribeFor.add(doomed)
    const seen: HarnessEvent[] = []
    registry.subscribeSession(sessionId, (e) => seen.push(e))

    expect(driver.rotate(sessionId, doomedNative)).toBe(doomed)

    // A silently dead tail would look like a live socket with a quiet session.
    expect(seen).toEqual([
      { type: 'session-updated', sessionId: doomed, previousSessionId: sessionId, status: 'active' },
      {
        type: 'error',
        sessionId: doomed,
        code: 'subscribe_failed',
        message: expect.stringContaining('re-subscribe') as unknown as string,
        retryable: true,
      },
    ])
    // The old attachment is gone too — no zombie tail on the retired id.
    seen.length = 0
    driver.activity(sessionId)
    expect(seen).toEqual([])
    registry.close()
  })

  it('drops every tail on close', () => {
    const { registry, driver, sessionId } = harness()
    const seen: HarnessEvent[] = []
    registry.subscribeSession(sessionId, (e) => seen.push(e))
    registry.close()
    driver.activity(sessionId)
    expect(seen).toEqual([])
  })

  it('rejects a session id no driver owns', () => {
    const registry = createHarnessRegistry()
    expect(() =>
      registry.subscribeSession('hermes:9b41' as SessionId, () => undefined),
    ).toThrowError(/no driver registered/)
  })

  it('propagates a driver that cannot serve a live tail', () => {
    const driver = new FakeRotatingDriver({ liveStream: false })
    const registry = createHarnessRegistry()
    registry.register(driver)
    const sessionId = driver.seed()
    expect(() => registry.subscribeSession(sessionId, () => undefined)).toThrowError(
      /no live stream/,
    )
    registry.close()
  })
})

describe('rotation bookkeeping edges', () => {
  const endings = (events: HarnessEvent[], id: SessionId): HarnessEvent[] =>
    events.filter((e) => e.type === 'session-updated' && e.sessionId === id && e.status === 'ended')

  it('retires a superseded id exactly once, however often the driver repeats itself', () => {
    const { registry, driver, sessionId } = harness()
    const stream: HarnessEvent[] = []
    registry.subscribe((e) => stream.push(e))
    const next = driver.rotate(sessionId)
    // The same rotation again: the alias is idempotent, so the retirement must
    // not fire a second time.
    driver.emitRaw({
      type: 'session-updated',
      sessionId: next,
      previousSessionId: sessionId,
      status: 'active',
    })
    expect(endings(stream, sessionId)).toHaveLength(1)
    registry.close()
  })

  it('treats a session-updated that restates its own id as a status, not a rotation', () => {
    const { registry, driver, sessionId } = harness()
    const stream: HarnessEvent[] = []
    const tail: HarnessEvent[] = []
    registry.subscribe((e) => stream.push(e))
    registry.subscribeSession(sessionId, (e) => tail.push(e))

    driver.emitRaw({
      type: 'session-updated',
      sessionId,
      previousSessionId: sessionId,
      status: 'idle',
    })

    expect(registry.isSuperseded(sessionId)).toBe(false)
    expect(endings(stream, sessionId)).toEqual([])
    expect(stream).toHaveLength(1) // the status itself, and nothing synthesized
    // The tail keeps its attachment: no re-key, no detach.
    driver.activity(sessionId)
    expect(tail.map((e) => e.type)).toEqual(['assistant-delta'])
    registry.close()
  })

  it('refuses to re-point an id that already rotated, and strands nothing', () => {
    const { registry, driver, sessionId } = harness()
    const tail: HarnessEvent[] = []
    registry.subscribeSession(sessionId, (e) => tail.push(e))
    const real = driver.rotate(sessionId)
    tail.length = 0

    // A second successor for the same predecessor: a driver bug. Overwriting
    // would strand this tail on `real` and end `sessionId` twice.
    const forked = 'hermes:0f0f0f0f-0000-4000-8000-000000000fff' as SessionId
    driver.emitRaw({
      type: 'session-updated',
      sessionId: forked,
      previousSessionId: sessionId,
      status: 'active',
    })

    expect(registry.knows(forked)).toBe(false)
    expect(driver.subscribeCalls).toEqual([sessionId, real])
    driver.activity(real)
    expect(tail.map((e) => e.sessionId)).toEqual([real])
    registry.close()
  })

  it('de-dupes every hop of a chain rotated to its depth cap', async () => {
    // The per-subscription dedup set is bounded (chain-depth sized), which the
    // store's own depth cap already guarantees — a chain cannot outgrow 32
    // hops, so the eviction is belt-and-braces. Rotate to the cap and check
    // nothing doubles or goes missing on the way.
    const { registry, driver, sessionId } = harness({ rotationDelivery: 'session-sinks-first' })
    const seen: HarnessEvent[] = []
    registry.subscribeSession(sessionId, (e) => seen.push(e))
    let current = sessionId
    for (let i = 0; i < 30; i++) current = driver.rotate(current)

    expect(seen).toHaveLength(30)
    seen.length = 0
    driver.activity(current)
    expect(seen.map((e) => e.sessionId)).toEqual([current])
    expect((await registry.resolve(sessionId)).sessionId).toBe(current)
    registry.close()
  })
})

describe('canonical-only listSessions', () => {
  it('rewrites a row the driver still keys on a superseded id', async () => {
    const { registry, driver, sessionId } = harness({ keepSupersededInList: true })
    const next = driver.rotate(sessionId)
    const rows = await driver.listSessions()
    expect(rows.map((r) => r.sessionId)).toContain(sessionId) // driver still leaks it

    const listed = await registry.listSessions('hermes')
    expect(listed.map((r) => r.sessionId)).toEqual([next])
    registry.close()
  })

  it('prefers the canonical row when the driver returns both', async () => {
    const { registry, driver, sessionId } = harness({ keepSupersededInList: true })
    const next = driver.rotate(sessionId)
    const listed = await registry.listSessions('hermes')
    expect(listed).toHaveLength(1)
    // The canonical row wins: status comes from the live session, not the
    // retired shell the store still reports.
    expect(listed[0]).toMatchObject({ sessionId: next, status: 'idle' })
    registry.close()
  })

  it('reports an unknown harness and a driver that cannot list', async () => {
    const registry = createHarnessRegistry()
    await expect(registry.listSessions('hermes')).rejects.toMatchObject({
      code: 'invalid_session_id',
    })
    registry.register(new FakeRotatingDriver({ listSessions: false }))
    await expect(registry.listSessions('hermes')).rejects.toMatchObject({
      code: 'capability_unsupported',
    })
    registry.close()
  })
})
