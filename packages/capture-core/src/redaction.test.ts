import { afterEach, describe, expect, it } from 'vitest'
import {
  captureRedactionFromEnv,
  redactMessage,
  redactText,
  resolveCaptureRedaction,
} from './redaction.js'
import type { CaptureMessage } from './types.js'

const enabled = resolveCaptureRedaction({ enabled: true })
if (!enabled) throw new Error('expected resolved redaction')

describe('resolveCaptureRedaction', () => {
  it('returns null when unset, disabled, or empty', () => {
    expect(resolveCaptureRedaction(undefined)).toBeNull()
    expect(resolveCaptureRedaction(null)).toBeNull()
    expect(resolveCaptureRedaction({})).toBeNull()
    expect(resolveCaptureRedaction({ enabled: false })).toBeNull()
    expect(resolveCaptureRedaction({ enabled: true, builtins: false, patterns: [] })).toBeNull()
  })

  it('enables builtins by default and compiles patterns', () => {
    const resolved = resolveCaptureRedaction({
      enabled: true,
      patterns: ['\\bCUSTOM-[A-Z0-9]{8}\\b'],
    })
    expect(resolved).toMatchObject({ enabled: true, builtins: true })
    expect(resolved?.patterns).toHaveLength(1)
    expect(resolved?.patterns[0]?.index).toBe(0)
  })
})

describe('captureRedactionFromEnv', () => {
  const key = 'RIVETOS_CAPTURE_REDACTION'
  const previous = process.env[key]
  afterEach(() => {
    if (previous === undefined) delete process.env[key]
    else process.env[key] = previous
  })

  it('is undefined for empty or falsey values', () => {
    expect(captureRedactionFromEnv({})).toBeUndefined()
    expect(captureRedactionFromEnv({ [key]: '0' })).toBeUndefined()
    expect(captureRedactionFromEnv({ [key]: 'false' })).toBeUndefined()
  })

  it.each(['1', 'true', 'YES', 'on'])('enables builtins for %s', (value) => {
    expect(captureRedactionFromEnv({ [key]: value })).toEqual({
      enabled: true,
      builtins: true,
    })
  })
})

describe('redactText builtins', () => {
  it('replaces common secret shapes with deterministic placeholders', () => {
    const sample =
      'Bearer aaaabbbbccccddddeeee ' +
      'AWS_ACCESS_KEY_ID=not-an-akia-shape ' +
      'bare AKIAIOSFODNN7EXAMPLE ' +
      'ghp_abcdefghijklmnopqrstuvwxyz0123456789 ' +
      'xoxb-1234567890-abcdefghij ' +
      'sk-abcdefghijklmnopqrstuvwxyz ' +
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.signaturepad'
    const { text, count } = redactText(sample, enabled)
    expect(count).toBeGreaterThan(0)
    expect(text).toContain('[REDACTED:bearer]')
    expect(text).toContain('[REDACTED:aws_access_key]')
    expect(text).toContain('[REDACTED:github_token]')
    expect(text).toContain('[REDACTED:slack_token]')
    expect(text).toContain('[REDACTED:sk_token]')
    expect(text).toContain('[REDACTED:jwt]')
    expect(text).toContain('AWS_ACCESS_KEY_ID=[REDACTED:assignment]')
    expect(text).not.toContain('aaaabbbbccccddddeeee')
    expect(text).not.toContain('AKIAIOSFODNN7EXAMPLE')
    expect(text).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789')
  })

  it('applies operator patterns with stable indices', () => {
    const resolved = resolveCaptureRedaction({
      enabled: true,
      builtins: false,
      patterns: ['\\bCUSTOM-[A-Z0-9]{8}\\b', '\\bOTHER-[0-9]{4}\\b'],
    })
    if (!resolved) throw new Error('expected patterns')
    const { text, count } = redactText('see CUSTOM-ABCD1234 and OTHER-9999', resolved)
    expect(count).toBe(2)
    expect(text).toBe('see [REDACTED:pattern:0] and [REDACTED:pattern:1]')
  })
})

describe('redactMessage', () => {
  it('redacts content, tool_result, tool_args strings and secret keys', () => {
    const message: CaptureMessage = {
      event_id: 'e1',
      role: 'tool',
      content: 'token sk-abcdefghijklmnopqrstuvwxyz',
      tool_result: 'Authorization: Bearer aaaabbbbccccddddeeee',
      tool_args: {
        prompt: 'use ghp_abcdefghijklmnopqrstuvwxyz0123456789',
        api_key: 'should-not-appear',
        nested: { password: 'also-secret', note: 'ok' },
      },
    }
    const { message: next, count } = redactMessage(message, enabled)
    expect(count).toBeGreaterThan(0)
    expect(next.content).toContain('[REDACTED:sk_token]')
    expect(next.tool_result).toContain('[REDACTED:bearer]')
    const args = next.tool_args as Record<string, unknown>
    expect(args.api_key).toBe('[REDACTED:secret_key]')
    expect((args.nested as Record<string, unknown>).password).toBe('[REDACTED:secret_key]')
    expect((args.nested as Record<string, unknown>).note).toBe('ok')
    expect(String(args.prompt)).toContain('[REDACTED:github_token]')
    expect(JSON.stringify(next)).not.toContain('should-not-appear')
    expect(JSON.stringify(next)).not.toContain('also-secret')
  })

  it('returns the same object reference when nothing matched', () => {
    const message: CaptureMessage = {
      event_id: 'e2',
      role: 'user',
      content: 'hello world',
    }
    const { message: next, count } = redactMessage(message, enabled)
    expect(count).toBe(0)
    expect(next).toBe(message)
  })
})
