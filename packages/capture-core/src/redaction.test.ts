import { afterEach, describe, expect, it } from 'vitest'
import {
  REDACT_SCAN_LIMIT,
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
      'Bearer aaaabbbbccccdddd1234 ' +
      'api_key=not-an-akia-shape ' +
      'bare AKIAIOSFODNN7EXAMPLE ' +
      'temp ASIAY34F92NBKMABCDEF ' +
      'ghp_abcdefghijklmnopqrstuvwxyz0123456789 ' +
      'github_pat_abcdefghijklmnopqrstuvwxyz0123456789ABCDEF ' +
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
    expect(text).toContain('api_key=[REDACTED:assignment]')
    expect(text).not.toContain('aaaabbbbccccdddd1234')
    expect(text).not.toContain('AKIAIOSFODNN7EXAMPLE')
    expect(text).not.toContain('ASIAY34F92NBKMABCDEF')
    expect(text).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789')
    expect(text).not.toContain('github_pat_abcdefghijklmnopqrstuvwxyz0123456789ABCDEF')
  })

  it('does not redact ordinary prose that previously false-positived', () => {
    const prose = [
      'the basic understanding of X',
      'Basic authentication was enabled',
      'Bearer credentials expire tomorrow',
      'author: Jane Doe',
      'monkey: business',
      'secretary: Ann',
      'hockey: game',
      'tokenizer: bpe',
      'token_count: 1200',
      'authority: local',
      'keyword: true',
    ].join('\n')
    const { text, count } = redactText(prose, enabled)
    expect(count).toBe(0)
    expect(text).toBe(prose)
  })

  it('redacts underscore-compound assignment names', () => {
    const sample = [
      'SECRET_KEY=abc123def456',
      'db_password: hunter2',
      'secret_key: s3cr3tvalue',
      'api_secret: xyzzy12345',
      'auth_key: zz-top-secret',
    ].join('\n')
    const { text, count } = redactText(sample, enabled)
    expect(count).toBe(5)
    expect(text).toContain('SECRET_KEY=[REDACTED:assignment]')
    expect(text).toContain('db_password: [REDACTED:assignment]')
    expect(text).toContain('secret_key: [REDACTED:assignment]')
    expect(text).toContain('api_secret: [REDACTED:assignment]')
    expect(text).toContain('auth_key: [REDACTED:assignment]')
    expect(text).not.toContain('abc123def456')
    expect(text).not.toContain('hunter2')
  })

  it('redacts HTTP Basic credentials but not the English word basic', () => {
    const basicAuth = `Basic ${Buffer.from('user:pass-secret-value').toString('base64')}`
    const { text: authText, count: authCount } = redactText(basicAuth, enabled)
    expect(authCount).toBe(1)
    expect(authText).toBe('[REDACTED:bearer]')

    const { text: proseText, count: proseCount } = redactText(
      'the basic understanding of auth flows',
      enabled,
    )
    expect(proseCount).toBe(0)
    expect(proseText).toContain('basic understanding')
  })

  it('redacts multi-word assignment values and preserves trailing punctuation', () => {
    const { text, count } = redactText('password: hunter2 and other words, next=ok', enabled)
    expect(count).toBe(1)
    expect(text).toBe('password: [REDACTED:assignment], next=ok')
  })

  it('redacts PEM private key blocks in content', () => {
    const pem = `before
-----BEGIN RSA PRIVATE KEY-----
MIIEowIBAAKFAKESECRET
-----END RSA PRIVATE KEY-----
after`
    const { text, count } = redactText(pem, enabled)
    expect(count).toBe(1)
    expect(text).toContain('[REDACTED:pem_private_key]')
    expect(text).not.toContain('MIIEowIBAAKFAKESECRET')
    expect(text.startsWith('before\n')).toBe(true)
    expect(text.endsWith('\nafter')).toBe(true)
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

  it('skips nested-quantifier operator patterns (ReDoS guard)', () => {
    const resolved = resolveCaptureRedaction({
      enabled: true,
      builtins: false,
      patterns: ['(a+)+b', '\\bSAFE-[A-Z0-9]{4}\\b'],
    })
    if (!resolved) throw new Error('expected patterns')
    // Catastrophic source is dropped at resolve; safe pattern keeps its index.
    expect(resolved.patterns.map((p) => p.source)).toEqual(['\\bSAFE-[A-Z0-9]{4}\\b'])
    expect(resolved.patterns[0]?.index).toBe(1)
    // Put the safe token in the scanned prefix; pad with a's past the limit.
    const huge = `SAFE-ABCD ${'a'.repeat(REDACT_SCAN_LIMIT + 5_000)}`
    const started = Date.now()
    const { text, count } = redactText(huge, resolved)
    const elapsed = Date.now() - started
    expect(elapsed).toBeLessThan(2_000)
    expect(count).toBe(1)
    expect(text).toContain('[REDACTED:pattern:1]')
    expect(text).not.toContain('SAFE-ABCD')
  })

  it('only scans the first REDACT_SCAN_LIMIT units of a large string', () => {
    const resolved = resolveCaptureRedaction({
      enabled: true,
      builtins: false,
      patterns: ['\\bCUSTOM-[A-Z0-9]{8}\\b'],
    })
    if (!resolved) throw new Error('expected patterns')
    const secret = 'CUSTOM-ABCD1234'
    const textInHead = `${'x'.repeat(100)} ${secret} ${'y'.repeat(100)}`
    const textInTail = `${'x'.repeat(REDACT_SCAN_LIMIT + 10)} ${secret}`
    expect(redactText(textInHead, resolved).text).toContain('[REDACTED:pattern:0]')
    // Tail past the scan limit is not scanned (matches the content/tool_result cap).
    expect(redactText(textInTail, resolved).text).toContain(secret)
  })

  it('compiles the documented case-insensitive pattern example', () => {
    // Character-class form — works on engines.node >= 22 (no RegExp modifiers).
    const source = '\\b[Mm][Yy][Pp]refix-[a-z0-9]{20,}\\b'
    expect(() => new RegExp(source, 'g')).not.toThrow()
    const resolved = resolveCaptureRedaction({
      enabled: true,
      builtins: false,
      patterns: [source],
    })
    if (!resolved) throw new Error('expected patterns')
    const sample = 'leak MyPrefix-abcdefghijklmnopqrstuvwxyz'
    const { text, count } = redactText(sample, resolved)
    expect(count).toBe(1)
    expect(text).toBe('leak [REDACTED:pattern:0]')
  })
})

describe('redactMessage', () => {
  it('redacts content, tool_result, tool_args strings and secret keys', () => {
    const message: CaptureMessage = {
      event_id: 'e1',
      role: 'tool',
      content: 'token sk-abcdefghijklmnopqrstuvwxyz',
      tool_result: 'Authorization: Bearer aaaabbbbccccdddd1234',
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

  it('does not wipe ordinary keys or non-string secret-shaped misses', () => {
    const message: CaptureMessage = {
      event_id: 'e3',
      role: 'tool',
      content: 'ok',
      tool_args: {
        author: 'Jane',
        token_count: 1200,
        max_tokens: 4096,
        authority: { level: 1 },
        api_key: 'real-secret',
      },
    }
    const { message: next, count } = redactMessage(message, enabled)
    const args = next.tool_args as Record<string, unknown>
    expect(args.author).toBe('Jane')
    expect(args.token_count).toBe(1200)
    expect(args.max_tokens).toBe(4096)
    expect(args.authority).toEqual({ level: 1 })
    expect(args.api_key).toBe('[REDACTED:secret_key]')
    expect(count).toBe(1)
  })

  it('redacts compound secret key names in tool_args', () => {
    const message: CaptureMessage = {
      event_id: 'e4',
      role: 'tool',
      content: 'ok',
      tool_args: {
        SECRET_KEY: 'django-secret-abc',
        db_password: 'hunter2',
        author: 'Jane',
      },
    }
    const { message: next, count } = redactMessage(message, enabled)
    const args = next.tool_args as Record<string, unknown>
    expect(args.SECRET_KEY).toBe('[REDACTED:secret_key]')
    expect(args.db_password).toBe('[REDACTED:secret_key]')
    expect(args.author).toBe('Jane')
    expect(count).toBe(2)
    expect(JSON.stringify(next)).not.toContain('django-secret-abc')
    expect(JSON.stringify(next)).not.toContain('hunter2')
  })

  it('scans tool_args string leaves past REDACT_SCAN_LIMIT', () => {
    const secret = 'AKIAIOSFODNN7EXAMPLE'
    // Space before the key so \\b can fire; offset past the content scan cap.
    const body = `${'x'.repeat(REDACT_SCAN_LIMIT + 100)} ${secret}`
    // content / redactText leave the unscanned tail alone.
    expect(redactText(body, enabled).text).toContain(secret)
    const message: CaptureMessage = {
      event_id: 'e5',
      role: 'tool',
      content: 'ok',
      tool_args: { dump: body },
    }
    const { message: next, count } = redactMessage(message, enabled)
    expect(count).toBeGreaterThan(0)
    const dump = String((next.tool_args as Record<string, unknown>).dump)
    expect(dump).toContain('[REDACTED:aws_access_key]')
    expect(dump).not.toContain(secret)
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
