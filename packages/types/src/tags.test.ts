import { describe, expect, it } from 'vitest'
import {
  TAG_KEY_MAX,
  TAG_VALUE_MAX,
  formatTag,
  normalizeTagKey,
  normalizeTagValue,
  parseTagLiteral,
  splitTagLiteral,
} from './tags.js'

describe('normalizeTagValue', () => {
  it('lowercases and trims', () => {
    expect(normalizeTagValue(' AcmeApp ')).toBe('acmeapp')
  })

  it('collapses whitespace and slashes to single dashes', () => {
    expect(normalizeTagValue('Rivet OS / hub')).toBe('rivet-os-hub')
    expect(normalizeTagValue('a -- b')).toBe('a-b')
  })

  it('strips outer dashes', () => {
    expect(normalizeTagValue('-foo-')).toBe('foo')
  })

  it('is idempotent', () => {
    const once = normalizeTagValue('Some Thing/Else')
    expect(normalizeTagValue(once)).toBe(once)
  })
})

describe('normalizeTagValue: unicode and bounds', () => {
  it('unifies composed/decomposed, full-width and compatibility forms (NFKC)', () => {
    expect(normalizeTagValue('caf\u00e9')).toBe(normalizeTagValue('cafe\u0301'))
    expect(normalizeTagValue('\uff21\uff43\uff4d\uff45\uff21\uff50\uff50')).toBe('acmeapp')
  })

  it('treats control characters as separators and returns "" when nothing is left', () => {
    expect(normalizeTagValue('Line\nBreak\u0007')).toBe('line-break')
    expect(normalizeTagValue('a\tb\u0085c')).toBe('a-b-c')
    expect(normalizeTagValue('///')).toBe('')
    expect(normalizeTagValue('\u0000\u200B')).toBe('')
  })

  it('a full-width or compatibility colon separates a literal like an ASCII one', () => {
    for (const colon of [':', '\uFF1A', '\uFE13', '\uFE55']) {
      expect(parseTagLiteral(`project${colon}AcmeApp`)).toEqual({ key: 'project', value: 'acmeapp' })
    }
    // The first separator splits; a later one belongs to the value's text.
    expect(splitTagLiteral('topic\uFF1Aa:b')).toEqual({ key: 'topic', value: 'a:b' })
    expect(splitTagLiteral('no separator')).toBeNull()
    expect(splitTagLiteral(':x')).toBeNull()
  })

  it('never returns a lone surrogate', () => {
    expect(normalizeTagValue('a\ud83d')).toBe('a')
    expect(normalizeTagValue('\ude00a')).toBe('a')
    expect(normalizeTagValue('\ud83d\ude00x')).toBe('\ud83d\ude00x')
  })

  it('drops every invisible format character, not only zero-width ones', () => {
    expect(normalizeTagValue('acme\u00ADapp')).toBe('acmeapp')
    expect(normalizeTagValue('\u200Eacmeapp\u200F')).toBe('acmeapp')
  })

  it('a key never contains a colon, so every literal round-trips', () => {
    expect(normalizeTagKey('a:b')).toBe('a-b')
    // Compatibility colons normalize to ':' under NFKC and are caught as well.
    for (const colon of ['\uFF1A', '\uFE13', '\uFE55']) {
      expect(normalizeTagKey(`a${colon}b`)).toBe('a-b')
    }
    expect(normalizeTagKey(normalizeTagKey('a\uFF1Ab'))).toBe('a-b')
    expect(parseTagLiteral(formatTag({ key: 'a\uFF1Ab', value: 'v', display: '' }))).toEqual({
      key: 'a-b',
      value: 'v',
    })
    const literal = formatTag({ key: 'A:B', value: 'x', display: '' })
    expect(literal).toBe('a-b:x')
    expect(parseTagLiteral(literal)).toEqual({ key: 'a-b', value: 'x' })
  })

  it('drops zero-width characters instead of keeping an invisible difference', () => {
    expect(normalizeTagValue('acme\u200Bapp')).toBe('acmeapp')
    expect(normalizeTagValue('\uFEFFacmeapp\u200D')).toBe('acmeapp')
  })

  it('truncates to the storage bounds without splitting a surrogate pair or leaving a trailing dash', () => {
    expect(normalizeTagValue('a'.repeat(500))).toHaveLength(TAG_VALUE_MAX)
    expect(normalizeTagKey('k'.repeat(500))).toHaveLength(TAG_KEY_MAX)
    const emoji = '\u{1F600}'.repeat(TAG_VALUE_MAX + 5)
    expect([...normalizeTagValue(emoji)]).toHaveLength(TAG_VALUE_MAX)
    expect(normalizeTagValue('a'.repeat(TAG_VALUE_MAX - 1) + ' b')).toBe('a'.repeat(TAG_VALUE_MAX - 1))
  })
})

describe('parseTagLiteral', () => {
  it('splits on the first colon and normalizes both sides', () => {
    expect(parseTagLiteral('Project:AcmeApp')).toEqual({ key: 'project', value: 'acmeapp' })
  })

  it('keeps later colons inside the value', () => {
    expect(parseTagLiteral('repo:org:name')).toEqual({ key: 'repo', value: 'org:name' })
  })

  it('rejects a missing key or value', () => {
    expect(parseTagLiteral('project')).toBeNull()
    expect(parseTagLiteral(':x')).toBeNull()
    expect(parseTagLiteral('project:  ')).toBeNull()
  })
})

describe('formatTag round-trip', () => {
  it('falls back to the value when display does not normalize to it', () => {
    const literal = formatTag({ key: 'project', value: 'acmeapp', display: 'Acme App ' })
    expect(literal).toBe('project:acmeapp')
    expect(parseTagLiteral(literal)).toEqual({ key: 'project', value: 'acmeapp' })
  })

  it('every rendered literal parses back to the same tag', () => {
    for (const display of ['AcmeApp', 'acmeapp', '', 'Other Thing']) {
      const literal = formatTag({ key: 'project', value: 'acmeapp', display })
      expect(parseTagLiteral(literal)).toEqual({ key: 'project', value: 'acmeapp' })
    }
  })
})

describe('formatTag', () => {
  it('prefers display casing, falls back to value', () => {
    expect(formatTag({ key: 'project', value: 'acmeapp', display: 'AcmeApp' })).toBe('project:AcmeApp')
    expect(formatTag({ key: 'project', value: 'acmeapp', display: '' })).toBe('project:acmeapp')
  })
})
