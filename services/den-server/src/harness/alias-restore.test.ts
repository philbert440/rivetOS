// Post-restart alias reconstruction: rotation breadcrumbs read back out of the
// memory DB and re-recorded as aliases (§ Rotation migration story).
//
// The thing under test is not "does it write to a Map" — it is that a chain
// rebuilt from disk is subject to the SAME control-plane rules a live rotation
// is, that a bad row cannot poison the store, and that a memory DB which is
// down costs the node nothing but a log line.

import { describe, expect, it } from 'vitest'
import type { SessionId } from '@rivetos/types'
import { MAX_ALIAS_CHAIN_DEPTH } from './alias.js'
import {
  restoreHarnessAliases,
  startAliasRestore,
  type RotationBreadcrumb,
  type RotationBreadcrumbSource,
} from './alias-restore.js'
import { createHarnessRegistry, type HarnessRegistry } from './registry.js'

const A = 'hermes:20260802_225647_6ad0b9' as SessionId
const B = 'hermes:20260802_231001_7c11ab' as SessionId
const C = 'hermes:20260803_004417_9de220' as SessionId

/** Oldest-first, the way the pg source hands them over. */
function source(...rows: Partial<RotationBreadcrumb>[]): RotationBreadcrumbSource & {
  reads: number
  closes: number
} {
  const state = { reads: 0, closes: 0 }
  return {
    get reads() {
      return state.reads
    },
    get closes() {
      return state.closes
    },
    close: () => {
      state.closes += 1
      return Promise.resolve()
    },
    read: () => {
      state.reads += 1
      return Promise.resolve(
        rows.map((r) => ({
          previousSessionKey: r.previousSessionKey ?? '',
          sessionKey: r.sessionKey ?? '',
          ...(r.reason ? { reason: r.reason } : {}),
          ...(r.at ? { at: r.at } : {}),
        })),
      )
    },
  }
}

const link = (previousSessionKey: string, sessionKey: string): Partial<RotationBreadcrumb> => ({
  previousSessionKey,
  sessionKey,
})

/** A registry with no drivers — alias bookkeeping needs none. */
const registry = (): HarnessRegistry => createHarnessRegistry()

describe('restoreHarnessAliases', () => {
  it('rebuilds a multi-hop chain so every superseded id resolves to the head', async () => {
    const reg = registry()
    const result = await restoreHarnessAliases({
      registry: reg,
      source: source(link(A, B), link(B, C), { previousSessionKey: A, sessionKey: B }),
    })
    expect(result).toMatchObject({
      ok: true,
      read: 3,
      linked: 3,
      malformed: 0,
      selfLinks: 0,
      rejected: 0,
    })
    // The whole point: an id a client held before the restart resolves again.
    expect(reg.isSuperseded(A)).toBe(true)
    expect(reg.isSuperseded(B)).toBe(true)
    expect(reg.isSuperseded(C)).toBe(false)
    expect(reg.knows(A)).toBe(true)
  })

  it('is idempotent — a second boot re-reads the same rows and changes nothing', async () => {
    const reg = registry()
    const rows = source(link(A, B), link(B, C))
    const first = await restoreHarnessAliases({ registry: reg, source: rows })
    const second = await restoreHarnessAliases({ registry: reg, source: rows })
    expect(first).toEqual(second)
    expect(second.rejected).toBe(0)
    expect(reg.isSuperseded(A)).toBe(true)
  })

  it('keeps the chain guards armed — they are not relaxed for a rebuild', async () => {
    const reg = registry()
    const log: string[] = []
    const result = await restoreHarnessAliases({
      registry: reg,
      log: (m) => log.push(m),
      source: source(
        link(A, B),
        link(B, C),
        // a cycle back onto the head of the chain we just rebuilt
        link(C, A),
        // cross-harness (§ Rotation rule 8)
        link(B, 'claude-code:a1b2c3d4-1111-4222-8333-444455556666'),
        // a SECOND successor for an id that already rotated
        link(A, C),
      ),
    })
    expect(result).toMatchObject({ read: 5, linked: 2, malformed: 0, rejected: 3 })
    expect(log.filter((m) => m.includes('rejected —'))).toHaveLength(3)
    // The healthy A → B → C survived; nothing else was forced in.
    expect(reg.isSuperseded(A)).toBe(true)
    expect(reg.isSuperseded(C)).toBe(false)
  })

  it('rebuilds a chain deeper than the cap exactly as a live rotation would', async () => {
    // Not a special case: recording forward, each hop resolves in ONE step, so
    // the write-side depth guard never fires — for a rebuild or for the live
    // rotations that produced these breadcrumbs in the first place. What the
    // cap does is refuse the READ, loudly, from an id too far down the chain.
    // The reconstructor inherits that verbatim, which is the requirement.
    const reg = registry()
    const id = (i: number): string => `hermes:20260802_2200${String(i).padStart(2, '0')}_aaaaaa`
    const hops = Array.from({ length: MAX_ALIAS_CHAIN_DEPTH + 5 }, (_, i) =>
      link(id(i), id(i + 1)),
    )
    const result = await restoreHarnessAliases({ registry: reg, source: source(...hops) })
    expect(result).toMatchObject({ linked: MAX_ALIAS_CHAIN_DEPTH + 5, rejected: 0 })
    // Near the head: resolvable. Beyond the cap: rejected, never guessed at.
    await expect(reg.resolve(id(MAX_ALIAS_CHAIN_DEPTH + 4))).rejects.toMatchObject({
      // no driver is registered, so it gets that far and no further
      code: 'invalid_session_id',
    })
    await expect(reg.resolve(id(0))).rejects.toMatchObject({ code: 'invalid_session_id' })
    expect(() => reg.alias(id(0), id(1))).not.toThrow()
  })

  it('skips malformed breadcrumbs instead of throwing on them', async () => {
    const reg = registry()
    const log: string[] = []
    const result = await restoreHarnessAliases({
      registry: reg,
      log: (m) => log.push(m),
      source: source(
        // no predecessor recorded (a row from a capture build that predates it)
        { sessionKey: B },
        // bare native uuid — carries no harness, so it is not a SessionId
        link('a1b2c3d4-1111-4222-8333-444455556666', B),
        // the task conversation-key namespace, which is never a SessionId
        link('task:11111111-2222-4333-8444-555555555555', B),
        // an agent nickname rather than a harness id
        link('claude:abc', 'claude:def'),
        // whitespace: validated as-is, never silently trimmed
        link(` ${A}`, B),
        // the one good row, to prove a bad batch does not abort the good rows
        link(A, B),
      ),
    })
    expect(result).toMatchObject({ ok: true, read: 6, linked: 1, malformed: 5, rejected: 0 })
    expect(log.filter((m) => m.includes('skipping malformed'))).toHaveLength(5)
    expect(reg.isSuperseded(A)).toBe(true)
  })

  it('reports a DB miss as ok:false and leaves the store untouched', async () => {
    const reg = registry()
    const log: string[] = []
    const result = await restoreHarnessAliases({
      registry: reg,
      log: (m) => log.push(m),
      source: { read: () => Promise.reject(new Error('ECONNREFUSED 192.0.2.10:5432')) },
    })
    expect(result).toEqual({
      ok: false,
      read: 0,
      linked: 0,
      malformed: 0,
      selfLinks: 0,
      rejected: 0,
    })
    expect(log.join('\n')).toContain('alias reconstruction skipped')
    expect(reg.knows(A)).toBe(false)
  })

  it('counts a self-alias as neither linked nor rejected', async () => {
    // `record()` no-ops `previous === canonical`, so counting it as a link
    // would report a chain hop nobody made. Both keys parse, and nothing
    // refused it — it is simply nothing.
    const reg = registry()
    const result = await restoreHarnessAliases({
      registry: reg,
      source: source(link(A, A), link(A, B)),
    })
    expect(result).toMatchObject({ read: 2, linked: 1, selfLinks: 1, rejected: 0, malformed: 0 })
    expect(reg.isSuperseded(A)).toBe(true)
  })

  it('releases the source when it is done — on the good path and the bad one', async () => {
    const good = source(link(A, B))
    await restoreHarnessAliases({ registry: registry(), source: good })
    expect(good.closes).toBe(1)

    let closed = 0
    const result = await restoreHarnessAliases({
      registry: registry(),
      source: {
        read: () => Promise.reject(new Error('ECONNREFUSED 192.0.2.10:5432')),
        close: () => {
          closed += 1
          return Promise.resolve()
        },
      },
    })
    // A read that gave up must not leave a connection open behind it.
    expect(closed).toBe(1)
    expect(result.ok).toBe(false)
  })

  it('survives a source whose close() throws', async () => {
    const result = await restoreHarnessAliases({
      registry: registry(),
      source: {
        read: () => Promise.resolve([]),
        close: () => Promise.reject(new Error('socket already gone')),
      },
    })
    expect(result).toMatchObject({ ok: true, read: 0 })
  })

  it('passes the caller’s bounds to the source', async () => {
    const seen: { limit: number; lookbackMs: number }[] = []
    await restoreHarnessAliases({
      registry: registry(),
      limit: 7,
      lookbackMs: 1234,
      source: {
        read: (opts) => {
          seen.push(opts)
          return Promise.resolve([])
        },
      },
    })
    expect(seen).toEqual([{ limit: 7, lookbackMs: 1234 }])
  })
})

describe('startAliasRestore', () => {
  it('does nothing, quietly, with no source and no pg url', async () => {
    const result = await startAliasRestore({ registry: registry() })
    expect(result).toMatchObject({ ok: false, read: 0, linked: 0 })
  })

  it('is explicitly disableable with null', async () => {
    const rows = source(link(A, B))
    const reg = registry()
    await startAliasRestore({ registry: reg, source: null, pgUrl: 'postgres://ignored/db' })
    expect(rows.reads).toBe(0)
    expect(reg.knows(A)).toBe(false)
  })

  it('never rejects, even when the restore itself blows up', async () => {
    const log: string[] = []
    const result = await startAliasRestore({
      registry: {
        alias: (): void => {
          throw new Error('unreachable — record() failures are caught per row')
        },
      },
      log: (m) => log.push(m),
      source: {
        read: () => {
          throw new Error('synchronous explosion')
        },
      },
    })
    expect(result.ok).toBe(false)
  })
})
