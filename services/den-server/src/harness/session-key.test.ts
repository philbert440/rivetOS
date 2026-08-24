import { describe, it, expect } from 'vitest'
import { denJoinKey, denSessionRef } from './session-key.js'

const UUID = 'a1b2c3d4-1111-4222-8333-444455556666'

describe('denJoinKey', () => {
  it('resolves a canonical SessionId to the den room key', () => {
    expect(denJoinKey(`claude-code:${UUID}`)).toBe(UUID)
    expect(denJoinKey(`grok-build:${UUID}`)).toBe(UUID)
    expect(denJoinKey('kimi-code:session_abc')).toBe('session_abc')
    expect(denJoinKey(`hermes:${UUID}`)).toBe(UUID)
    expect(denJoinKey('deepseek-harness:session-86ffe759-cd7b-49a7-955d-c282631a935d')).toBe(
      'session-86ffe759-cd7b-49a7-955d-c282631a935d',
    )
  })

  it('passes a bare native id through unchanged (the legacy shape)', () => {
    expect(denJoinKey(UUID)).toBe(UUID)
  })

  it("collapses Claude's path-fallback capture key onto its uuid", () => {
    // § Legacy keys precedence: the uuid form is canonical, the path form is
    // an alias for it.
    expect(denJoinKey(`claude-code:-home-rivet-proj/${UUID}`)).toBe(UUID)
  })

  it('leaves non-session strings alone rather than rejecting them', () => {
    // den rooms are their own key space and hold plenty of these.
    for (const id of ['den-pty-1a2b3c4d', 'unknown-4211', 'task:9f2c', 'claude:nickname', '']) {
      expect(denJoinKey(id)).toBe(id)
    }
  })

  it('splits on the FIRST colon only — native ids may contain colons', () => {
    expect(denJoinKey('hermes:a:b:c')).toBe('a:b:c')
  })
})

describe('denSessionRef', () => {
  it('names the store a canonical id belongs to', () => {
    // The store name is what stops a canonical read falling through to another
    // harness's store on a uuid collision (§ Collision rules, rule 2).
    expect(denSessionRef(`claude-code:${UUID}`)).toEqual({ native: UUID, command: 'claude' })
    expect(denSessionRef(`grok-build:${UUID}`)).toEqual({ native: UUID, command: 'grok' })
    expect(denSessionRef('kimi-code:session_abc')).toEqual({
      native: 'session_abc',
      command: 'kimi',
    })
    expect(denSessionRef(`hermes:${UUID}`)).toEqual({ native: UUID, command: 'hermes' })
    expect(
      denSessionRef('deepseek-harness:session-86ffe759-cd7b-49a7-955d-c282631a935d'),
    ).toEqual({
      native: 'session-86ffe759-cd7b-49a7-955d-c282631a935d',
      command: 'dsh',
    })
    // Path-fallback still names claude, and still collapses to the uuid.
    // SHARED VECTOR: `packages/core/src/domain/gateway-channel.test.ts`
    // asserts `bareAliasOf` resolves this exact input to the same native id —
    // the two alias implementations must not drift on a documented legacy
    // shape (§ Legacy keys row 2).
    expect(denSessionRef(`claude-code:-home-rivet-proj/${UUID}`)).toEqual({
      native: UUID,
      command: 'claude',
    })
    // a native id that merely contains `/` is opaque, not a path fallback
    expect(denSessionRef('hermes:some/other')).toEqual({
      native: 'some/other',
      command: 'hermes',
    })
  })

  it('names no store for a bare id — probing every store is its documented behavior', () => {
    expect(denSessionRef(UUID)).toEqual({ native: UUID })
    expect(denSessionRef('den-pty-1a2b3c4d')).toEqual({ native: 'den-pty-1a2b3c4d' })
    expect(denSessionRef('task:9f2c')).toEqual({ native: 'task:9f2c' })
  })
})
