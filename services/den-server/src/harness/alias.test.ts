// Session-id normalization + the rotation alias store: the legacy-key table
// from docs/plans/harness-control-plane.md, and the chain-hygiene rules
// (same-harness, cycle detection, depth cap).

import { describe, expect, it } from 'vitest'
import { HarnessError, type SessionId } from '@rivetos/types'
import {
  MAX_ALIAS_CHAIN_DEPTH,
  collapsePathFallback,
  createAliasStore,
  isBareNativeUuid,
  normalizeSessionId,
} from './alias.js'

const UUID = 'a1b2c3d4-1111-4222-8333-444455556666'
const UUID2 = 'b2c3d4e5-2222-4333-8444-555566667777'
const UUID3 = 'c3d4e5f6-3333-4444-8555-666677778888'

describe('isBareNativeUuid', () => {
  it('accepts a uuid and rejects everything else', () => {
    expect(isBareNativeUuid(UUID)).toBe(true)
    expect(isBareNativeUuid(`claude-code:${UUID}`)).toBe(false)
    expect(isBareNativeUuid('thread-42')).toBe(false)
    expect(isBareNativeUuid('')).toBe(false)
  })
})

describe('collapsePathFallback', () => {
  it('collapses the capture path fallback onto the uuid form', () => {
    expect(collapsePathFallback(`claude-code:-home-rivet-repo/${UUID}` as SessionId)).toBe(
      `claude-code:${UUID}`,
    )
  })

  it('leaves an opaque native id that merely contains a slash alone', () => {
    const id = 'claude-code:some/opaque/native' as SessionId
    expect(collapsePathFallback(id)).toBe(id)
  })

  it('is a no-op on an already-canonical id', () => {
    expect(collapsePathFallback(`claude-code:${UUID}` as SessionId)).toBe(`claude-code:${UUID}`)
  })
})

describe('normalizeSessionId', () => {
  it('passes a canonical id through', () => {
    expect(normalizeSessionId(`claude-code:${UUID}`)).toEqual({
      kind: 'canonical',
      sessionId: `claude-code:${UUID}`,
    })
  })

  it('collapses the path fallback (alias, not dual-write)', () => {
    expect(normalizeSessionId(`claude-code:proj-slug/${UUID}`)).toEqual({
      kind: 'canonical',
      sessionId: `claude-code:${UUID}`,
    })
  })

  it('reports a bare native uuid for the registry to probe', () => {
    expect(normalizeSessionId(UUID)).toEqual({ kind: 'bare', nativeSessionId: UUID })
  })

  it('splits on the FIRST colon only — native ids may contain colons', () => {
    expect(normalizeSessionId('grok-build:sess:01HZX')).toEqual({
      kind: 'canonical',
      sessionId: 'grok-build:sess:01HZX',
    })
  })

  it('refuses task keys — a parallel namespace, never a SessionId', () => {
    expect(() => normalizeSessionId('task:abc123')).toThrowError(HarnessError)
    try {
      normalizeSessionId('task:abc123')
    } catch (err) {
      expect((err as HarnessError).code).toBe('invalid_session_id')
    }
  })

  it.each([
    ['empty', ''],
    ['whitespace-padded', ` claude-code:${UUID} `],
    ['agent nickname prefix', `claude:${UUID}`],
    ['unknown harness', `codex:${UUID}`],
    ['no native half', 'claude-code:'],
  ])('rejects %s', (_label, value) => {
    expect(() => normalizeSessionId(value)).toThrowError(HarnessError)
  })
})

describe('alias store', () => {
  it('resolves an unknown id to itself', () => {
    const store = createAliasStore()
    expect(store.resolve(`claude-code:${UUID}` as SessionId)).toBe(`claude-code:${UUID}`)
    expect(store.knows(`claude-code:${UUID}` as SessionId)).toBe(false)
  })

  it('follows a rotation chain to the newest id', () => {
    const store = createAliasStore()
    store.record(`claude-code:${UUID}` as SessionId, `claude-code:${UUID2}` as SessionId)
    store.record(`claude-code:${UUID2}` as SessionId, `claude-code:${UUID3}` as SessionId)
    expect(store.resolve(`claude-code:${UUID}` as SessionId)).toBe(`claude-code:${UUID3}`)
    expect(store.knows(`claude-code:${UUID}` as SessionId)).toBe(true)
    expect(store.chainFor(`claude-code:${UUID3}` as SessionId)).toEqual(
      expect.arrayContaining([`claude-code:${UUID}`, `claude-code:${UUID2}`]),
    )
  })

  it('accepts an idempotent re-record but refuses a second successor', () => {
    const store = createAliasStore()
    const a = `claude-code:${UUID}` as SessionId
    const b = `claude-code:${UUID2}` as SessionId
    const c = `claude-code:${UUID3}` as SessionId
    store.record(a, b)
    store.record(a, b) // the driver repeated itself — no-op, not an error

    // Re-pointing a already rotated once would strand every live tail on `b`
    // and retire `a` twice, so the store refuses instead of overwriting.
    let thrown: unknown
    try {
      store.record(a, c)
    } catch (err) {
      thrown = err
    }
    expect((thrown as HarnessError).code).toBe('session_id_collision')
    expect(store.resolve(a)).toBe(b)
    expect(store.knows(c)).toBe(false)
  })

  it('rejects a cross-harness alias', () => {
    const store = createAliasStore()
    expect(() =>
      store.record(`claude-code:${UUID}` as SessionId, `grok-build:${UUID2}` as SessionId),
    ).toThrowError(/cross-harness/)
  })

  it('rejects a cycle instead of poisoning later reads', () => {
    const store = createAliasStore()
    store.record(`claude-code:${UUID}` as SessionId, `claude-code:${UUID2}` as SessionId)
    expect(() =>
      store.record(`claude-code:${UUID2}` as SessionId, `claude-code:${UUID}` as SessionId),
    ).toThrowError(/cycle/)
    // The store is still usable after the rejection.
    expect(store.resolve(`claude-code:${UUID}` as SessionId)).toBe(`claude-code:${UUID2}`)
  })

  it('treats a self-alias as a no-op', () => {
    const store = createAliasStore()
    store.record(`claude-code:${UUID}` as SessionId, `claude-code:${UUID}` as SessionId)
    expect(store.size()).toBe(0)
  })

  it(`caps chain depth at ${String(MAX_ALIAS_CHAIN_DEPTH)}`, () => {
    const store = createAliasStore()
    const id = (n: number): SessionId => `claude-code:link-${String(n).padStart(4, '0')}` as SessionId
    // Grow the chain from the head so each record() re-walks the whole thing:
    // a_n → a_{n-1} → … → a_0.
    let deepest = 0
    let threw = false
    for (let n = 1; n <= MAX_ALIAS_CHAIN_DEPTH + 5; n++) {
      try {
        store.record(id(n), id(n - 1))
        deepest = n
      } catch (err) {
        expect((err as HarnessError).message).toMatch(/exceeds depth/)
        threw = true
        break
      }
    }
    expect(threw).toBe(true)
    expect(deepest).toBeLessThanOrEqual(MAX_ALIAS_CHAIN_DEPTH)
  })
})
