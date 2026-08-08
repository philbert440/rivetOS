import { describe, it, expect } from 'vitest'
import { HarnessError } from './errors.js'
import { HARNESS_IDS } from './harness.js'
import {
  decodeSessionIdSegment,
  encodeSessionIdSegment,
  formatSessionId,
  isSessionId,
  parseSessionId,
} from './harness-session-id.js'

/** Every rejection must be a typed `invalid_session_id`, not a bare Error —
 *  the gateway maps the code to HTTP 400. */
function expectInvalid(fn: () => unknown) {
  expect(fn).toThrow(HarnessError)
  try {
    fn()
  } catch (err) {
    expect((err as HarnessError).code).toBe('invalid_session_id')
  }
}

describe('parseSessionId', () => {
  it('splits on the FIRST colon so native ids may contain colons', () => {
    expect(parseSessionId('grok-build:sess_01HZX:part:two')).toEqual({
      harnessId: 'grok-build',
      nativeSessionId: 'sess_01HZX:part:two',
    })
  })

  it('accepts every harness id in the enum', () => {
    for (const harnessId of HARNESS_IDS) {
      expect(parseSessionId(`${harnessId}:abc`).harnessId).toBe(harnessId)
    }
  })

  it('keeps path-shaped legacy Claude native ids intact', () => {
    expect(parseSessionId('claude-code:-home-rivet-project/a1b2c3d4')).toEqual({
      harnessId: 'claude-code',
      nativeSessionId: '-home-rivet-project/a1b2c3d4',
    })
  })

  it('rejects surrounding whitespace instead of silently trimming', () => {
    expectInvalid(() => parseSessionId(' claude-code:abc'))
    expectInvalid(() => parseSessionId('claude-code:abc '))
    expectInvalid(() => parseSessionId('\tclaude-code:abc\n'))
    // ...but whitespace INSIDE the opaque native id is preserved, not rejected.
    expect(parseSessionId('claude-code:a b').nativeSessionId).toBe('a b')
  })

  it('rejects unknown harness ids and legacy prefixes', () => {
    expectInvalid(() => parseSessionId('claude:abc'))
    expectInvalid(() => parseSessionId('cc:abc'))
    expectInvalid(() => parseSessionId('CLAUDE-CODE:abc'))
    expectInvalid(() => parseSessionId('task:t_123'))
  })

  it('rejects an empty native id, an empty harness id, and a bare native id', () => {
    expectInvalid(() => parseSessionId('claude-code:'))
    expectInvalid(() => parseSessionId(':abc'))
    expectInvalid(() => parseSessionId('a1b2c3d4-uuid'))
    expectInvalid(() => parseSessionId(''))
  })
})

describe('formatSessionId', () => {
  it('round-trips with parseSessionId, colons and slashes included', () => {
    const cases: Array<[(typeof HARNESS_IDS)[number], string]> = [
      ['claude-code', 'a1b2c3d4-5e6f-7890-abcd-ef1234567890'],
      ['claude-code', '-home-rivet-rivetOS/a1b2c3d4-5e6f'],
      ['grok-build', 'sess_01HZX:2:3'],
      ['kimi-code', 'c7f2-uuid'],
      ['hermes', '9b41-uuid'],
    ]
    for (const [harnessId, nativeSessionId] of cases) {
      const id = formatSessionId(harnessId, nativeSessionId)
      expect(id).toBe(`${harnessId}:${nativeSessionId}`)
      expect(parseSessionId(id)).toEqual({ harnessId, nativeSessionId })
    }
  })

  it('rejects an empty or trailing-whitespace native id', () => {
    expectInvalid(() => formatSessionId('claude-code', ''))
    expectInvalid(() => formatSessionId('claude-code', 'abc '))
    // Asymmetric by contract: the trim check is on the whole SessionId, and a
    // LEADING space sits after the separator, so `claude-code: abc` is a legal
    // (if ugly) canonical id — the native half is opaque.
    expect(formatSessionId('claude-code', ' abc')).toBe('claude-code: abc')
  })
})

describe('isSessionId', () => {
  it('narrows valid ids and rejects invalid ones without throwing', () => {
    expect(isSessionId('hermes:9b41-uuid')).toBe(true)
    expect(isSessionId('claude:9b41-uuid')).toBe(false)
    expect(isSessionId('claude-code:')).toBe(false)
  })
})

describe('enc/dec session id segment', () => {
  const ids = [
    'claude-code:a1b2c3d4-5e6f-7890-abcd-ef1234567890',
    // legacy Claude path-derived key — contains `/`
    'claude-code:-home-rivet-rivetOS/a1b2c3d4-5e6f',
    // native id containing `:`
    'grok-build:sess_01HZX:sub:3',
    // both, plus non-ASCII
    'kimi-code:proj/名前:7f3a',
    'hermes:9b41-uuid',
  ]

  it('round-trips ids containing ":" and "/"', () => {
    for (const id of ids) {
      const seg = encodeSessionIdSegment(id)
      expect(decodeSessionIdSegment(seg)).toBe(id)
    }
  })

  it('emits unpadded base64url — safe as a single path segment', () => {
    for (const id of ids) {
      const seg = encodeSessionIdSegment(id)
      expect(seg).toMatch(/^[A-Za-z0-9_-]+$/)
      expect(seg).not.toContain('=')
      expect(seg).not.toContain('/')
      expect(seg).not.toContain('+')
    }
  })

  it('rejects encoding a non-canonical id', () => {
    expectInvalid(() => encodeSessionIdSegment('claude:abc'))
    expectInvalid(() => encodeSessionIdSegment(' claude-code:abc'))
  })

  it('rejects segments that are padded, non-base64url, or decode to garbage', () => {
    expectInvalid(() => decodeSessionIdSegment(''))
    expectInvalid(() => decodeSessionIdSegment('not base64url!'))
    // padded standard base64 of an otherwise valid id
    const padded = btoa('claude-code:abcd')
    expect(padded).toContain('=')
    expectInvalid(() => decodeSessionIdSegment(padded))
    // well-formed base64url that decodes to a non-canonical id
    expectInvalid(() => decodeSessionIdSegment(encodeToSegment('claude:abc')))
    expectInvalid(() => decodeSessionIdSegment(encodeToSegment('bare-uuid')))
  })

  it('rejects a base64url-shaped segment of impossible length (atob throws)', () => {
    // Passes the charset regex but length % 4 === 1 is not decodable — atob
    // raises a DOMException, which must surface as the typed code, not escape.
    expectInvalid(() => decodeSessionIdSegment('A'))
    expectInvalid(() => decodeSessionIdSegment('Y2xhdWRlLWNvZGU6YWJjZQ'.slice(0, 17)))
  })

  it('rejects a segment whose bytes are not valid UTF-8', () => {
    // 'claude-code:' + a lone 0xFF — decodable base64url, undecodable UTF-8.
    const segment = btoa(`claude-code:${String.fromCharCode(0xff)}`)
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '')
    expect(segment).toMatch(/^[A-Za-z0-9_-]+$/)
    expectInvalid(() => decodeSessionIdSegment(segment))
  })
})

/** Encode without the canonical-id validation, to build bad-input fixtures. */
function encodeToSegment(raw: string): string {
  const bytes = new TextEncoder().encode(raw)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
