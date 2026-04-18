import { test } from 'node:test'
import assert from 'node:assert/strict'
import { safeSlice } from './safe-slice.js'

test('ASCII string shorter than maxLen is returned unchanged', () => {
  assert.equal(safeSlice('hello', 10), 'hello')
})

test('ASCII string exactly at maxLen is returned unchanged', () => {
  const s = 'x'.repeat(10)
  assert.equal(safeSlice(s, 10), s)
  assert.equal(safeSlice(s, 10).length, 10)
})

test('ASCII string longer than maxLen is truncated to maxLen', () => {
  const s = 'x'.repeat(20)
  const out = safeSlice(s, 10)
  assert.equal(out.length, 10)
  assert.equal(out, 'x'.repeat(10))
})

test('truncating mid-surrogate drops the lone high surrogate', () => {
  // '🚨' is U+1F6A8, UTF-16 = \uD83D\uDEA8 (high surrogate at 0, low at 1)
  // Build a string: 9 chars of 'a', then '🚨' at positions 9-10. maxLen=10.
  // slice(0, 10) would keep 'aaaaaaaaa' + '\uD83D' (lone high surrogate).
  const s = 'a'.repeat(9) + '🚨' + 'trailing'
  const out = safeSlice(s, 10)

  // Should have dropped the high surrogate → length 9
  assert.equal(out.length, 9)
  assert.equal(out, 'a'.repeat(9))

  // Last char must NOT be a lone high surrogate
  const last = out.charCodeAt(out.length - 1)
  assert.ok(
    !(last >= 0xd800 && last <= 0xdbff),
    `Last char is a lone high surrogate: 0x${last.toString(16)}`,
  )

  // JSON.stringify must produce valid JSON that parses back
  const json = JSON.stringify(out)
  const parsed = JSON.parse(json)
  assert.equal(parsed, out)
})

test('string ending in a complete emoji just inside maxLen is preserved', () => {
  // 9 chars + '🚨' (2 code units) = 11 code units. maxLen = 11 keeps it all.
  const s = 'a'.repeat(9) + '🚨'
  const out = safeSlice(s, 11)
  assert.equal(out, s)
  assert.equal(out.length, 11)

  // JSON roundtrip works
  const parsed = JSON.parse(JSON.stringify(out))
  assert.equal(parsed, out)
})

test('string with emoji straddling boundary roundtrips through JSON', () => {
  // The real-world failure mode: content with emojis near position 8000.
  // Build a large string with emojis sprinkled through.
  const chunk = 'hello world 🚨 warning sign 🎉 party '
  let s = ''
  while (s.length < 8050) s += chunk
  const out = safeSlice(s, 8000)
  assert.ok(out.length <= 8000)
  assert.ok(out.length >= 7999)

  // Must produce valid JSON. Before the fix this could throw or produce
  // invalid UTF-16 that downstream JSON parsers reject.
  const json = JSON.stringify(out)
  const parsed = JSON.parse(json)
  assert.equal(parsed, out)

  // No lone surrogates anywhere
  for (let i = 0; i < out.length; i++) {
    const cc = out.charCodeAt(i)
    if (cc >= 0xd800 && cc <= 0xdbff) {
      // High surrogate — next must be low surrogate
      const next = out.charCodeAt(i + 1)
      assert.ok(
        next >= 0xdc00 && next <= 0xdfff,
        `High surrogate at ${i} not followed by low surrogate (next=0x${next.toString(16)})`,
      )
    }
    if (cc >= 0xdc00 && cc <= 0xdfff) {
      // Low surrogate — prev must be high surrogate
      const prev = out.charCodeAt(i - 1)
      assert.ok(
        prev >= 0xd800 && prev <= 0xdbff,
        `Low surrogate at ${i} not preceded by high surrogate (prev=0x${prev.toString(16)})`,
      )
    }
  }
})

test('empty string is returned as empty', () => {
  assert.equal(safeSlice('', 10), '')
})

test('maxLen of 0 returns empty', () => {
  assert.equal(safeSlice('hello', 0), '')
})
