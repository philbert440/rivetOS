import { describe, it, expect } from 'vitest'
import { denJoinKey } from './session-key.js'

const UUID = 'a1b2c3d4-1111-4222-8333-444455556666'

describe('denJoinKey', () => {
  it('resolves a canonical SessionId to the den room key', () => {
    expect(denJoinKey(`claude-code:${UUID}`)).toBe(UUID)
    expect(denJoinKey(`grok-build:${UUID}`)).toBe(UUID)
    expect(denJoinKey('kimi-code:session_abc')).toBe('session_abc')
    expect(denJoinKey(`hermes:${UUID}`)).toBe(UUID)
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
