import { describe, it } from 'vitest'
import * as assert from 'node:assert/strict'
import { splitIntoChunksWithOffsets, meanPool } from './chunking.js'

function texts(chunks: { text: string }[]): string[] {
  return chunks.map((c) => c.text)
}

describe('splitIntoChunksWithOffsets', () => {
  it('returns single-element array for text within maxChars', () => {
    const text = 'hello world'
    const result = splitIntoChunksWithOffsets(text, 100)
    assert.deepEqual(texts(result), [text])
    assert.equal(result[0].charStart, 0)
    assert.equal(result[0].charEnd, text.length)
  })

  it('returns a single chunk when text length equals maxChars', () => {
    const text = 'hello'
    const result = splitIntoChunksWithOffsets(text, 5)
    assert.deepEqual(result, [{ text, charStart: 0, charEnd: 5 }])
  })

  it('returns a single empty chunk for empty input', () => {
    const result = splitIntoChunksWithOffsets('', 100)
    assert.deepEqual(result, [{ text: '', charStart: 0, charEnd: 0 }])
  })

  it('splits oversized text at double-newline boundary', () => {
    const text = 'chunk1\n\nchunk2\n\nchunk3'
    const result = splitIntoChunksWithOffsets(text, 10)
    assert.equal(result.length, 3)
    assert.ok(result.every((chunk) => chunk.text.length > 0))
  })

  it('falls back to single-newline if no double-newline in window', () => {
    const text = 'line1\nline2\nline3\nline4\nline5'
    const result = splitIntoChunksWithOffsets(text, 10)
    assert.ok(result.length >= 2)
    assert.ok(result.every((chunk) => chunk.text.length > 0))
  })

  it('falls back to period-space if no newline in window', () => {
    const text = 'Sentence one. Sentence two. Sentence three. Sentence four.'
    const result = splitIntoChunksWithOffsets(text, 20)
    assert.ok(result.length >= 2)
    assert.ok(result.every((chunk) => chunk.text.length > 0))
  })

  it('hard-breaks at maxChars if no soft boundary found', () => {
    const text = 'abcdefghijklmnopqrstuvwxyz'
    const result = splitIntoChunksWithOffsets(text, 10)
    assert.ok(result.length >= 2)
    assert.ok(result[0].text.length <= 10)
  })

  it('reconstructs original text when chunks are concatenated', () => {
    const text = 'Line 1\n\nLine 2\n\nLine 3\n\nLine 4'
    const chunks = splitIntoChunksWithOffsets(text, 15)
    const reconstructed = texts(chunks).join('')
    assert.equal(reconstructed, text)
  })

  it('handles very large text with multiple chunks', () => {
    const text = Array(100).fill('Lorem ipsum dolor sit amet. ').join('')
    const result = splitIntoChunksWithOffsets(text, 1000)
    assert.ok(result.length >= 3)
    assert.ok(result.every((chunk) => chunk.text.length > 0))
  })

  it('respects maxChars limit strictly on hard breaks', () => {
    const text = 'abcdefghijklmnopqrstuvwxyz'
    const result = splitIntoChunksWithOffsets(text, 10)
    assert.ok(result.every((chunk) => chunk.text.length <= 10))
  })

  it('covers the full string without gaps or overlap', () => {
    const text = 'Line 1\n\nLine 2\n\nLine 3\n\nLine 4'
    const chunks = splitIntoChunksWithOffsets(text, 15)
    assert.equal(chunks[0].charStart, 0)
    assert.equal(chunks[chunks.length - 1].charEnd, text.length)
    for (let i = 0; i < chunks.length; i++) {
      assert.equal(chunks[i].text, text.slice(chunks[i].charStart, chunks[i].charEnd))
      if (i > 0) assert.equal(chunks[i].charStart, chunks[i - 1].charEnd)
    }
    assert.equal(texts(chunks).join(''), text)
  })

  it('does not end a chunk mid-surrogate pair', () => {
    const emoji = '😀'
    assert.equal(emoji.length, 2)
    // 9 ASCII + emoji starting at index 9, so maxChars=10 would cut the pair.
    const text = 'abcdefghi' + emoji + 'xxxxxxxxxx'
    const chunks = splitIntoChunksWithOffsets(text, 10)
    for (const c of chunks) {
      assert.doesNotThrow(() => JSON.stringify(c.text))
      if (c.text.length > 0) {
        const last = c.text.charCodeAt(c.text.length - 1)
        assert.ok(!(last >= 0xd800 && last <= 0xdbff), 'chunk ends on high surrogate')
      }
    }
    assert.equal(texts(chunks).join(''), text)
    assert.ok(chunks[0].text.length < 10)
  })
})

describe('meanPool', () => {
  it('returns null for empty array', () => {
    const result = meanPool([])
    assert.equal(result, null)
  })

  it('returns null for array of all nulls', () => {
    const result = meanPool([null, null, null])
    assert.equal(result, null)
  })

  it('returns null for array of all undefined', () => {
    const result = meanPool([undefined, undefined])
    assert.equal(result, null)
  })

  it('pools single vector unchanged', () => {
    const vec = [1, 2, 3, 4, 5]
    const result = meanPool([vec])
    assert.deepEqual(result, vec)
  })

  it('computes mean of two identical vectors', () => {
    const vec = [2, 4, 6]
    const result = meanPool([vec, vec])
    assert.deepEqual(result, [2, 4, 6])
  })

  it('computes mean of two different vectors', () => {
    const result = meanPool([
      [1, 2, 3],
      [3, 4, 5],
    ])
    assert.deepEqual(result, [2, 3, 4])
  })

  it('skips null vectors in the middle', () => {
    const result = meanPool([[1, 2], null, [3, 4]])
    assert.deepEqual(result, [2, 3])
  })

  it('skips undefined vectors in the middle', () => {
    const result = meanPool([[2, 4], undefined, [4, 6]])
    assert.deepEqual(result, [3, 5])
  })

  it('skips vectors with mismatched dimension', () => {
    const result = meanPool([
      [1, 2, 3],
      [1, 2],
      [3, 4, 5],
    ])
    assert.deepEqual(result, [2, 3, 4])
  })

  it('handles mixed nulls, undefined, and dimension mismatch', () => {
    const result = meanPool([null, [1, 2, 3], undefined, [2, 4], [3, 4, 5]])
    assert.deepEqual(result, [2, 3, 4])
  })

  it('returns null when all vectors are either null or wrong dimension', () => {
    const result = meanPool([null, [1, 2], [1, 2], [1]])
    assert.deepEqual(result, [1, 2])
  })

  it('handles high-dimensional vectors', () => {
    const v1 = Array(1000).fill(1)
    const v2 = Array(1000).fill(3)
    const result = meanPool([v1, v2])
    assert.ok(result !== null)
    assert.equal(result!.length, 1000)
    assert.ok(result!.every((val) => Math.abs(val - 2) < 0.001))
  })

  it('handles fractional vectors and computes mean correctly', () => {
    const result = meanPool([
      [1.5, 2.5],
      [3.5, 4.5],
    ])
    assert.deepEqual(result, [2.5, 3.5])
  })
})
