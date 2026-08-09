/**
 * HarnessDriver **rotation** conformance suite — the shared contract tests any
 * driver whose harness can replace its native session id must pass before it
 * ships (docs/plans/harness-control-plane.md § Native session id rotation,
 * § Contract semantics).
 *
 * Rotation is control-plane machinery, so most of what this asserts is the
 * registry's behavior, not the driver's. What it asks OF a driver is small and
 * exact: emit one `session-updated` with `previousSessionId` set, on the same
 * harness id, and keep pinning per-session sinks to the id you were handed.
 * Everything else — alias recording, moving live tails, retiring the old id,
 * canonical-only listings, collision on a reused id — the registry owns, and
 * the suite proves it end to end through the real `createHarnessRegistry`.
 *
 * Usage from a driver's own test file:
 *
 * ```ts
 * import { runHarnessRotationConformance } from './test/driver-conformance.js'
 *
 * runHarnessRotationConformance('hermes', () => {
 *   const driver = new HermesDriver(deps)
 *   const registry = createHarnessRegistry()
 *   registry.register(driver)
 *   return {
 *     registry,
 *     driver,
 *     sessionId: driver.seedForTest(),
 *     rotate: (from) => driver.forceCompact(from), // returns the NEW SessionId
 *     emitActivity: (id) => driver.emitForTest(id),
 *     teardown: () => registry.close(),
 *   }
 * })
 * ```
 *
 * A driver whose harness genuinely cannot rotate (`claude-code`) has nothing
 * to run here — the machinery is unobservable for it, which is exactly why
 * this suite exists against a fake instead.
 *
 * Lives under `test/` (not `*.test.ts`) so it is importable as a helper rather
 * than collected as a suite of its own — same convention as
 * `packages/core/src/domain/task/test/executor-conformance.ts`. It is not
 * exported from the package barrel on purpose: every driver in the plan lands
 * in this same `services/den-server/src/harness/` directory, so a relative
 * import is the whole distribution story, and the suite pulls in `vitest`,
 * which has no business in a runtime entry point.
 */

import { describe, expect, it } from 'vitest'
import {
  HarnessError,
  parseSessionId,
  type HarnessDriver,
  type HarnessEvent,
  type SessionId,
} from '@rivetos/types'
import type { HarnessRegistry } from '../registry.js'

export interface RotationConformanceContext {
  /** A real registry with `driver` already registered. */
  registry: HarnessRegistry
  driver: HarnessDriver
  /** A session the driver already knows about, canonical id. */
  sessionId: SessionId
  /**
   * Make the harness rotate `from` onto a new native id, the way it would in
   * production. MUST emit `session-updated` with `previousSessionId: from`.
   * Returns the new canonical id.
   */
  rotate(from: SessionId): Promise<SessionId> | SessionId
  /**
   * Emit one ordinary per-session event (an `assistant-delta` will do) for
   * `sessionId`, so the suite can watch which id later events carry.
   */
  emitActivity(sessionId: SessionId): Promise<void> | void
  teardown?(): Promise<void> | void
}

export type RotationConformanceSetup = () =>
  Promise<RotationConformanceContext> | RotationConformanceContext

/** `previousSessionId` is optional on the union; narrow once, read everywhere. */
function rotationsIn(events: HarnessEvent[]): HarnessEvent[] {
  return events.filter((e) => e.type === 'session-updated' && e.previousSessionId !== undefined)
}

async function expectNotInvalidId(call: Promise<unknown>): Promise<void> {
  // A driver may legitimately refuse a turn (`turn_in_flight`) or an
  // unsupported method (501). What it must NEVER do is fail to recognize an
  // id the control plane resolved for it.
  await call.catch((err: unknown) => {
    if (err instanceof HarnessError && err.code === 'invalid_session_id') throw err
  })
}

export function runHarnessRotationConformance(name: string, setup: RotationConformanceSetup): void {
  describe(`HarnessDriver rotation conformance: ${name}`, () => {
    const withCtx = async (
      body: (ctx: RotationConformanceContext) => Promise<void> | void,
    ): Promise<void> => {
      const ctx = await setup()
      try {
        await body(ctx)
      } finally {
        await ctx.teardown?.()
      }
    }

    it('delivers the rotation session-updated on the EXISTING subscription, once', async () => {
      await withCtx(async (ctx) => {
        const seen: HarnessEvent[] = []
        // Subscribed exactly once, under the pre-rotation id. The client never
        // calls this again — that is the contract being tested.
        ctx.registry.subscribeSession(ctx.sessionId, (e) => seen.push(e))

        const next = await ctx.rotate(ctx.sessionId)

        const rotations = rotationsIn(seen)
        expect(rotations).toHaveLength(1)
        expect(rotations[0]).toMatchObject({
          type: 'session-updated',
          sessionId: next,
          previousSessionId: ctx.sessionId,
        })
      })
    })

    it('carries the new sessionId on later events, on that same sink, once each', async () => {
      await withCtx(async (ctx) => {
        const seen: HarnessEvent[] = []
        ctx.registry.subscribeSession(ctx.sessionId, (e) => seen.push(e))
        const next = await ctx.rotate(ctx.sessionId)
        seen.length = 0

        await ctx.emitActivity(next)

        // Exact sequence, not "every event carries the new id": a driver that
        // re-keys its OWN sinks leaves the tail attached twice and doubles
        // every later event, which is exactly the bug this suite is for.
        expect(seen.map((e) => e.sessionId)).toEqual([next])
      })
    })

    it('follows a chain of rotations without a re-subscribe', async () => {
      await withCtx(async (ctx) => {
        const seen: HarnessEvent[] = []
        ctx.registry.subscribeSession(ctx.sessionId, (e) => seen.push(e))
        const second = await ctx.rotate(ctx.sessionId)
        const third = await ctx.rotate(second)
        expect(rotationsIn(seen)).toHaveLength(2)
        seen.length = 0

        await ctx.emitActivity(third)

        expect(seen.map((e) => e.sessionId)).toEqual([third])
        // Both hops resolve to the head, from anywhere in the chain.
        expect((await ctx.registry.resolve(ctx.sessionId)).sessionId).toBe(third)
        expect((await ctx.registry.resolve(second)).sessionId).toBe(third)
      })
    })

    it('stops delivering after unsubscribe, post-rotation', async () => {
      await withCtx(async (ctx) => {
        const seen: HarnessEvent[] = []
        const off = ctx.registry.subscribeSession(ctx.sessionId, (e) => seen.push(e))
        const next = await ctx.rotate(ctx.sessionId)
        off()
        seen.length = 0

        await ctx.emitActivity(next)

        expect(seen).toEqual([])
        expect(() => {
          off()
        }).not.toThrow()
      })
    })

    it('resolves the superseded id everywhere — dispatch, reads, transcript', async () => {
      await withCtx(async (ctx) => {
        const previous = ctx.sessionId
        const next = await ctx.rotate(previous)

        const resolved = await ctx.registry.resolve(previous)
        expect(resolved.sessionId).toBe(next)
        expect(resolved.requestedId).toBe(previous)
        expect(resolved.driver).toBe(ctx.driver)

        // Every method dispatches on the canonical id the control plane
        // resolved — the driver must recognize it, and must never be asked
        // about the superseded one.
        expect(await resolved.driver.getSession(resolved.sessionId)).toMatchObject({
          sessionId: next,
        })
        await expectNotInvalidId(
          resolved.driver.sendUserTurn(resolved.sessionId, { text: 'after rotation' }),
        )
        await expectNotInvalidId(resolved.driver.interrupt(resolved.sessionId))
        const source = resolved.driver as unknown as {
          transcript?: (id: SessionId) => Promise<unknown>
        }
        if (typeof source.transcript === 'function') {
          await expectNotInvalidId(source.transcript(resolved.sessionId))
        }
      })
    })

    it('ends the superseded id: retired, reported once, gone from listSessions', async () => {
      await withCtx(async (ctx) => {
        const previous = ctx.sessionId
        const registryEvents: HarnessEvent[] = []
        ctx.registry.subscribe((e) => registryEvents.push(e))

        const next = await ctx.rotate(previous)

        expect(ctx.registry.isSuperseded(previous)).toBe(true)
        expect(ctx.registry.isSuperseded(next)).toBe(false)
        const ended = registryEvents.filter(
          (e) => e.type === 'session-updated' && e.sessionId === previous && e.status === 'ended',
        )
        expect(ended).toHaveLength(1)

        const listed = await ctx.registry.listSessions(ctx.driver.harnessId)
        const ids = listed.map((s) => s.sessionId)
        expect(ids).not.toContain(previous)
        expect(ids).toContain(next)
        expect(new Set(ids).size).toBe(ids.length)
      })
    })

    it('treats any id in the chain as taken by startSession', async () => {
      await withCtx(async (ctx) => {
        const previous = ctx.sessionId
        const next = await ctx.rotate(previous)
        const { harnessId } = parseSessionId(previous)

        for (const id of [previous, next]) {
          const { nativeSessionId } = parseSessionId(id)
          let thrown: unknown
          try {
            ctx.registry.assertPinnable(harnessId, nativeSessionId)
          } catch (err) {
            thrown = err
          }
          expect(thrown).toBeInstanceOf(HarnessError)
          expect((thrown as HarnessError).code).toBe('session_id_collision')
        }
        // A fresh id is still pinnable — the rule is about chains, not a
        // blanket ban on pinning.
        expect(() => {
          ctx.registry.assertPinnable(harnessId, 'e6bd9c34-0000-4000-8000-0000000000ff')
        }).not.toThrow()
      })
    })
  })
}
