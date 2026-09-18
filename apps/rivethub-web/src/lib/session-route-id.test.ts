import { describe, expect, it } from 'vitest'
import { encodeSessionIdSegment, type SessionId } from '@rivetos/types'
import {
  chatSessionHref,
  resolveSessionRouteParam,
  sessionDetailPath,
  sessionLookupId,
  sessionPathSegment,
} from './session-route-id.js'

const CANONICAL = 'claude-code:a1b2c3d4-1111-4222-8333-444455556666' as SessionId
const WITH_SLASH = 'claude-code:projects/-home-rivet/abc-def-uuid' as SessionId

describe('resolveSessionRouteParam', () => {
  it('round-trips an encoded canonical SessionId', () => {
    const seg = encodeSessionIdSegment(CANONICAL)
    const resolved = resolveSessionRouteParam(seg)
    expect(resolved).toEqual({ kind: 'canonical', sessionId: CANONICAL })
    expect(sessionLookupId(resolved)).toBe(CANONICAL)
  })

  it('accepts a bare native uuid (legacy deep link)', () => {
    const bare = 'a1b2c3d4-1111-4222-8333-444455556666'
    const resolved = resolveSessionRouteParam(bare)
    expect(resolved).toEqual({ kind: 'bare', nativeId: bare })
    expect(sessionLookupId(resolved)).toBe(bare)
  })

  it('round-trips a native id that contains /', () => {
    const seg = encodeSessionIdSegment(WITH_SLASH)
    expect(seg).not.toContain('/')
    const resolved = resolveSessionRouteParam(seg)
    expect(resolved).toEqual({ kind: 'canonical', sessionId: WITH_SLASH })
    expect(sessionPathSegment(WITH_SLASH)).toBe(seg)
    expect(sessionDetailPath(WITH_SLASH)).toBe(`/sessions/${seg}`)
  })

  it('accepts a raw canonical string in the path', () => {
    expect(resolveSessionRouteParam(CANONICAL)).toEqual({
      kind: 'canonical',
      sessionId: CANONICAL,
    })
  })
})

describe('chatSessionHref', () => {
  it('builds the Open in Chat deep link', () => {
    expect(chatSessionHref(CANONICAL)).toBe(`/?session=${encodeURIComponent(CANONICAL)}`)
    expect(chatSessionHref('bare-uuid')).toBe('/?session=bare-uuid')
  })
})
