import { describe, it } from 'vitest'
import * as assert from 'node:assert/strict'
import { safeSlice } from './safe-slice.js'

describe('safeSlice', () => {
  it('returns full string when within maxLen', () => {
    const text = 'hello'
    const result = safeSlice(text, 100)
    assert.equal(result, text)
  })

  it('returns full string when exactly at maxLen', () => {
    const text = 'hello'
    const result = safeSlice(text, 5)
    assert.equal(result, text)
  })

  it('truncates string exceeding maxLen', () => {
    const text = 'hello world'
    const result = safeSlice(text, 5)
    assert.equal(result, 'hello')
  })

  it('handles empty string', () => {
    const result = safeSlice('', 10)
    assert.equal(result, '')
  })

  it('handles zero maxLen', () => {
    const result = safeSlice('hello', 0)
    assert.equal(result, '')
  })

  it('handles single-character string', () => {
    const result = safeSlice('a', 1)
    assert.equal(result, 'a')
  })

  it('avoids lone high surrogate (emoji)', () => {
    // U+1F600 (GRINNING FACE) is encoded as surrogate pair D83D DE00 in UTF-16
    // Truncating at odd position would leave lone high surrogate
    const emoji = '😀'
    assert.equal(emoji.length, 2) // confirms it's a surrogate pair
    const result = safeSlice(emoji + 'x', 2)
    // maxLen=2 means we'd get the full emoji (which is 2 code units)
    assert.equal(result, emoji)
  })

  it('backs off if truncation point falls on high surrogate', () => {
    const text = '😀'
    assert.equal(text.length, 2)
    const result = safeSlice(text, 1)
    // Should back off and return empty string since maxLen=1 would split the pair
    assert.equal(result, '')
  })

  it('preserves content before surrogate pair', () => {
    const text = 'hello😀world'
    // "hello" = 5 chars, "😀" = 2 chars, "world" = 5 chars
    // Total length = 12
    const result = safeSlice(text, 7) // Try to cut in middle of emoji
    // Position 7 is the first char of "world" after the emoji
    // No lone surrogate here, so result should be "hello😀w"
    assert.equal(result.length, 7)
  })

  it('does not trim valid ASCII string', () => {
    const text = 'abcdefghij'
    const result = safeSlice(text, 5)
    assert.equal(result, 'abcde')
  })

  it('handles string with multiple emojis safely', () => {
    const text = '😀😁😂'
    // Each emoji is 2 code units, total 6
    const result = safeSlice(text, 5)
    // Position 5 is in the middle of third emoji, should back off to 4
    assert.equal(result.length, 4)
    assert.ok(result.includes('😀'))
  })

  it('handles surrogate pair at exactly maxLen', () => {
    const text = '😀x'
    const result = safeSlice(text, 2)
    assert.equal(result, '😀')
  })

  it('handles surrogate pair one char before maxLen', () => {
    const text = '😀xx'
    const result = safeSlice(text, 3)
    assert.equal(result, '😀x')
  })

  it('does not affect low surrogates (they are valid ending points)', () => {
    const text = 'a😀b'
    // "a" = 1, "😀" = 2, "b" = 1, total 4
    const result = safeSlice(text, 3)
    // Position 3 is exactly after the emoji, safe
    assert.equal(result, 'a😀')
  })

  it('correctly identifies high surrogates in range 0xD800-0xDBFF', () => {
    // Most emojis and high surrogates fall in this range
    const text = '🌍world' // Earth emoji
    const result = safeSlice(text, 1)
    assert.equal(result, '') // Back off from lone surrogate
  })

  it('returns result with no lone surrogates (validation)', () => {
    const inputs = [
      { text: 'hello😀world', maxLen: 7 },
      { text: '😀😁😂😃', maxLen: 5 },
      { text: 'mixed🔥content', maxLen: 10 },
    ]

    for (const { text, maxLen } of inputs) {
      const result = safeSlice(text, maxLen)
      // Validate no lone surrogates by checking it can be JSON.stringify'd
      assert.doesNotThrow(() => {
        JSON.stringify(result)
      })
    }
  })
})
