import { describe, it, expect } from 'vitest'
import { isSafeArg, assertSafeArg } from './ssh.js'

describe('isSafeArg', () => {
  it('accepts real version tags, channels, users and unit names', () => {
    for (const ok of [
      'main',
      'v0.4.0-beta.6',
      '0.4.0-beta.2',
      'latest',
      'beta',
      'rivet',
      'root',
      'rivet-embedder.service',
      'feat/some-branch',
      'user@host',
      'host:22',
    ]) {
      expect(isSafeArg(ok), ok).toBe(true)
    }
  })

  it('rejects shell metacharacters and empty input', () => {
    for (const bad of [
      '',
      'main; rm -rf /',
      'main && reboot',
      '$(whoami)',
      '`id`',
      'a|b',
      'a b',
      'a>b',
      "a'b",
      'a"b',
      'a\nb',
    ]) {
      expect(isSafeArg(bad), JSON.stringify(bad)).toBe(false)
    }
  })
})

describe('assertSafeArg', () => {
  it('returns the value when safe', () => {
    expect(assertSafeArg('v1.2.3', '--version')).toBe('v1.2.3')
  })

  it('throws with the label when unsafe', () => {
    expect(() => assertSafeArg('x; rm -rf /', '--version')).toThrowError(/--version/)
  })
})
