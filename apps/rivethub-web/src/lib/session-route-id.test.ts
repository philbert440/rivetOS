import { describe, expect, it } from 'vitest'
import { encodeSessionIdSegment, type SessionId } from '@rivetos/types'
import {
  chatSessionHref,
  resolveSessionRouteParam,
  sessionDetailPath,
  sessionLookupId,
  sessionRouteParam,
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
    expect(sessionRouteParam(WITH_SLASH)).toBe(seg)
    expect(sessionDetailPath(WITH_SLASH)).toBe(`/sessions/${seg}`)
  })

  it('accepts a raw canonical string in the path', () => {
    expect(resolveSessionRouteParam(CANONICAL)).toEqual({
      kind: 'canonical',
      sessionId: CANONICAL,
    })
  })
})

describe('sessionRouteParam / sessionDetailPath', () => {
  it('hands the router a raw bare key so it is encoded exactly once', () => {
    const bare = 'projects/-home-rivet/abc def'
    // router params: raw — TanStack applies encodeURIComponent itself
    expect(sessionRouteParam(bare)).toBe(bare)
    // literal href: encoded once, no %25 double-encoding
    const href = sessionDetailPath(bare)
    expect(href).toBe(`/sessions/${encodeURIComponent(bare)}`)
    expect(href).not.toContain('%25')
    // the router decodes the matched segment once → bare lookup id
    const matched = decodeURIComponent(href.slice('/sessions/'.length))
    expect(sessionLookupId(resolveSessionRouteParam(matched))).toBe(bare)
  })

  it('encoded canonical segment is unchanged by the router encode/decode', () => {
    const seg = sessionRouteParam(WITH_SLASH)
    expect(encodeURIComponent(seg)).toBe(seg)
    expect(resolveSessionRouteParam(decodeURIComponent(seg))).toEqual({
      kind: 'canonical',
      sessionId: WITH_SLASH,
    })
  })
})

describe('chatSessionHref', () => {
  it('builds the Open in Chat deep link', () => {
    expect(chatSessionHref(CANONICAL)).toBe(`/?session=${encodeURIComponent(CANONICAL)}`)
    expect(chatSessionHref('bare-uuid')).toBe('/?session=bare-uuid')
  })
})
