// Rotation: the control plane's half of "the harness replaced its native id".
//
// Runs the shared driver-conformance suite against the fake rotating driver,
// once per way a driver may order its rotation emits (all four are conformant
// — the control plane must deliver exactly once regardless), then covers the
// control-plane-only edges the suite deliberately leaves out.

import { describe, expect, it } from 'vitest'
import { parseSessionId, type HarnessEvent, type SessionId } from '@rivetos/types'
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

describe('supersedes lineage (immutable session ids, plan W1 stage 1)', () => {
  it('records the edge without changing the id, aliasing, re-keying, or retiring', async () => {
    const { registry, driver, sessionId } = harness()
    const stream: HarnessEvent[] = []
    const tail: HarnessEvent[] = []
    registry.subscribe((e) => stream.push(e))
    registry.subscribeSession(sessionId, (e) => tail.push(e))

    const newNative = driver.supersede(sessionId)

    // The id is THE id: no alias entry, no retirement, no subscription re-key.
    expect(registry.knows(newNative)).toBe(false)
    expect(registry.isSuperseded(sessionId)).toBe(false)
    expect(driver.subscribeCalls).toEqual([sessionId])
    expect(
      stream.filter((e) => e.type === 'session-updated' && e.status === 'ended'),
    ).toEqual([])

    // The first rotation off a client-minted id supersedes the canonical id
    // itself (its native half WAS the original native id) — a legal self-edge.
    expect(registry.supersedesFor(sessionId)).toEqual([sessionId])
    // The event fans out verbatim on both streams.
    expect(stream).toEqual([
      { type: 'session-updated', sessionId, supersedes: sessionId, status: 'active' },
    ])
    expect(tail).toEqual(stream)

    // Later events still carry the unchanged id on the same sink.
    tail.length = 0
    driver.activity(sessionId)
    expect(tail.map((e) => e.sessionId)).toEqual([sessionId])

    // listSessions: still one row under the unchanged id, lineage field carried.
    const listed = await registry.listSessions('hermes')
    expect(listed).toHaveLength(1)
    expect(listed[0]).toMatchObject({ sessionId, supersedes: sessionId })
    registry.close()
  })

  it('appends successive edges and dedupes an idempotent re-emit', () => {
    const { registry, driver, sessionId } = harness()
    const n1 = driver.supersede(sessionId)
    driver.supersede(sessionId)
    expect(registry.supersedesFor(sessionId)).toEqual([sessionId, n1])

    // Re-emitting the current tail edge is an idempotent no-op, like aliases.
    driver.emitRaw({ type: 'session-updated', sessionId, supersedes: n1, status: 'active' })
    expect(registry.supersedesFor(sessionId)).toEqual([sessionId, n1])
    registry.close()
  })

  it('drops a cross-harness edge and strips it from the fanned-out event', () => {
    const { registry, driver, sessionId } = harness()
    const stream: HarnessEvent[] = []
    registry.subscribe((e) => stream.push(e))
    const foreign = 'claude-code:00000000-0000-4000-8000-000000000000' as SessionId
    driver.emitRaw({ type: 'session-updated', sessionId, supersedes: foreign, status: 'active' })

    expect(registry.supersedesFor(sessionId)).toEqual([])
    // The event itself still fans out — but WITHOUT the field the control
    // plane rejected: a consumer must never record an edge the plane called
    // junk by trusting the field without repeating the same-harness check.
    expect(stream).toEqual([{ type: 'session-updated', sessionId, status: 'active' }])
    registry.close()
  })

  it('drops a malformed edge and strips it from the fanned-out event', () => {
    const { registry, driver, sessionId } = harness()
    const stream: HarnessEvent[] = []
    registry.subscribe((e) => stream.push(e))
    driver.emitRaw({
      type: 'session-updated',
      sessionId,
      supersedes: 'not-an-id' as SessionId,
      status: 'active',
    })

    expect(registry.supersedesFor(sessionId)).toEqual([])
    expect(stream).toEqual([{ type: 'session-updated', sessionId, status: 'active' }])
    registry.close()
  })

  it('records an adoption edge declared at birth (session-created)', () => {
    const { registry, driver, sessionId } = harness()
    const parent = 'hermes:11111111-2222-4333-8444-555555555555' as SessionId
    driver.emitRaw({
      type: 'session-created',
      sessionId,
      summary: {
        sessionId,
        harnessId: 'hermes',
        createdAt: '2026-08-08T00:00:00.000Z',
        updatedAt: '2026-08-08T00:00:00.000Z',
        status: 'idle',
      },
      supersedes: parent,
    })

    // Lineage, not an alias: the parent occupies no chain and resolves nowhere.
    expect(registry.supersedesFor(sessionId)).toEqual([parent])
    expect(registry.knows(parent)).toBe(false)
    registry.close()
  })

  it('handles a legacy rotation and a supersedes edge on one event independently', () => {
    const { registry, driver, sessionId } = harness()
    const next = 'hermes:99999999-1111-4222-8333-444455556666' as SessionId
    driver.emitRaw({
      type: 'session-updated',
      sessionId: next,
      previousSessionId: sessionId,
      supersedes: sessionId,
      status: 'active',
    })

    // Legacy half: alias recorded, old id retired. New half: edge on the record.
    expect(registry.isSuperseded(sessionId)).toBe(true)
    expect(registry.supersedesFor(next)).toEqual([sessionId])
    registry.close()
  })

  it('stamps the latest recorded edge onto list rows the driver never updated', async () => {
    const { registry, driver, sessionId } = harness()
    const edge = 'hermes:22222222-3333-4444-8555-666666666666' as SessionId
    // The driver emits the edge but never touches its own list row: record
    // and list must still agree, because the lineage field on the list the
    // control plane serves is control-plane-owned.
    driver.emitRaw({ type: 'session-updated', sessionId, supersedes: edge, status: 'active' })

    const listed = await registry.listSessions('hermes')
    expect(listed).toHaveLength(1)
    expect(listed[0]).toMatchObject({ sessionId, supersedes: edge })
    expect(registry.supersedesFor(sessionId)).toEqual([edge])
    registry.close()
  })
})

describe('pin guard: the id namespace is closed (immutable session ids, plan W1)', () => {
  it('makes every native a supersedes lineage names unpinnable', async () => {
    const { registry, driver, sessionId } = harness()
    const n1 = driver.supersede(sessionId)

    // The superseded native — here the canonical id itself, a self-edge — is
    // taken. Lineage is "not an alias", but it is a pin denylist.
    await expect(
      registry.assertPinnable('hermes', parseSessionId(sessionId).nativeSessionId),
    ).rejects.toMatchObject({ code: 'session_id_collision' })

    // After a second rotation the first new native is an edge too.
    driver.supersede(sessionId)
    await expect(
      registry.assertPinnable('hermes', parseSessionId(n1).nativeSessionId),
    ).rejects.toMatchObject({ code: 'session_id_collision' })
    registry.close()
  })

  it('makes the CURRENT native under a live canonical id unpinnable', async () => {
    const { registry, driver, sessionId } = harness()
    // The new native is not in any edge yet — only the harness store knows
    // it — so the guard must probe the store, not just the lineage.
    const current = driver.supersede(sessionId)
    await expect(
      registry.assertPinnable('hermes', parseSessionId(current).nativeSessionId),
    ).rejects.toMatchObject({ code: 'session_id_collision' })
    registry.close()
  })

  it('makes a never-rotated live session unpinnable — minting over it is takeover', async () => {
    const { registry, driver, sessionId } = harness()
    // No alias chain, no lineage: the id sits only in the live store.
    expect(registry.knows(sessionId)).toBe(false)
    expect(registry.supersedesFor(sessionId)).toEqual([])
    await expect(
      registry.assertPinnable('hermes', parseSessionId(sessionId).nativeSessionId),
    ).rejects.toMatchObject({ code: 'session_id_collision' })
    registry.close()
  })
})

describe('legacy rotation refusal (immutable ids, plan W1 keystone)', () => {
  it('drops a previousSessionId rotation of a client-minted session: id unchanged, warning, no alias', async () => {
    const warnings: string[] = []
    const driver = new FakeRotatingDriver()
    const registry = createHarnessRegistry({ log: (msg) => warnings.push(msg) })
    registry.register(driver)
    const sessionId = driver.seed()
    registry.noteMinted(sessionId)
    const stream: HarnessEvent[] = []
    registry.subscribe((e) => stream.push(e))

    const attempted = driver.rotate(sessionId)

    // No alias entry, no retirement, no re-key: THE id is unchanged.
    expect(registry.knows(attempted)).toBe(false)
    expect(registry.isSuperseded(sessionId)).toBe(false)
    await expect(registry.resolve(sessionId)).resolves.toMatchObject({ sessionId })
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain(sessionId)
    // The event itself still fans out (a stream cannot 4xx) — as a plain
    // status tick; the old id is not retired.
    expect(stream).toEqual([
      {
        type: 'session-updated',
        sessionId: attempted,
        previousSessionId: sessionId,
        status: 'active',
      },
    ])
    expect(
      stream.filter((e) => e.type === 'session-updated' && e.status === 'ended'),
    ).toEqual([])
    registry.close()
  })

  it('drops a previousSessionId rotation of a session that has supersedes lineage', () => {
    const warnings: string[] = []
    const driver = new FakeRotatingDriver()
    const registry = createHarnessRegistry({ log: (msg) => warnings.push(msg) })
    registry.register(driver)
    const sessionId = driver.seed()
    driver.supersede(sessionId) // any supersedes edge makes the id immutable too
    const stream: HarnessEvent[] = []
    registry.subscribe((e) => stream.push(e))

    const attempted = driver.rotate(sessionId)

    expect(registry.knows(attempted)).toBe(false)
    expect(registry.isSuperseded(sessionId)).toBe(false)
    expect(warnings).toHaveLength(1)
    expect(registry.supersedesFor(sessionId)).toEqual([sessionId])
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
