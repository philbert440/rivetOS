import { test } from 'node:test'
import assert from 'node:assert/strict'
import { splitIntoChunks, meanPool } from './chunking.js'

// ---------------------------------------------------------------------------
// splitIntoChunks
// ---------------------------------------------------------------------------

test('splitIntoChunks: short text returns single-element array unchanged', () => {
  const s = 'hello world'
  const out = splitIntoChunks(s, 100)
  assert.deepEqual(out, [s])
})

test('splitIntoChunks: text exactly at maxChars returns single chunk', () => {
  const s = 'x'.repeat(100)
  const out = splitIntoChunks(s, 100)
  assert.equal(out.length, 1)
  assert.equal(out[0], s)
})

test('splitIntoChunks: long text produces multiple chunks that concatenate back to original', () => {
  const s = 'a'.repeat(100000)
  const out = splitIntoChunks(s, 10000)
  assert.ok(out.length > 1, `expected multiple chunks, got ${out.length}`)
  assert.equal(out.join(''), s, 'concatenated chunks should equal original')
})

test('splitIntoChunks: prefers paragraph break within last 15% window', () => {
  // maxChars=1000, window is positions 850..999.
  // Put a '\n\n' at position 900 and fill rest with 'x'.
  // Chunk should end at the paragraph break (900+2 = 902 via lastIndexOf),
  // not the hard end at 1000.
  const head = 'x'.repeat(900)
  const tail = 'x'.repeat(2000)
  const s = head + '\n\n' + tail
  const out = splitIntoChunks(s, 1000)
  assert.ok(out.length >= 2)
  // The first chunk should end AT the '\n\n' boundary — i.e., its length
  // should be less than 1000 (the hard end) and align with position 900.
  assert.equal(
    out[0].length,
    900,
    `expected chunk 0 to end at paragraph break, got length ${out[0].length}`,
  )
  // And concatenation still equals original.
  assert.equal(out.join(''), s)
})

test('splitIntoChunks: falls back to hard split when no boundary in window', () => {
  // 100k chars of pure 'x' — no \n, no '. ' anywhere.
  const s = 'x'.repeat(100000)
  const out = splitIntoChunks(s, 10000)
  assert.equal(out.length, 10, `expected 10 chunks, got ${out.length}`)
  for (const c of out) {
    assert.equal(c.length, 10000)
  }
})

// ---------------------------------------------------------------------------
// meanPool
// ---------------------------------------------------------------------------

test('meanPool: empty array returns null', () => {
  assert.equal(meanPool([]), null)
})

test('meanPool: array of all nulls returns null', () => {
  assert.equal(meanPool([null, null, null]), null)
})

test('meanPool: averages correctly', () => {
  const out = meanPool([
    [1, 2, 3],
    [3, 4, 5],
  ])
  assert.deepEqual(out, [2, 3, 4])
})

test('meanPool: skips nulls in the input', () => {
  const out = meanPool([[1, 1], null, [3, 3]])
  assert.deepEqual(out, [2, 2])
})

test('meanPool: defensively skips mis-sized vectors', () => {
  const out = meanPool([
    [1, 1, 1],
    [9, 9], // wrong dim — must be skipped
    [3, 3, 3],
  ])
  assert.deepEqual(out, [2, 2, 2])
})

test('meanPool: single vector returns that vector', () => {
  const out = meanPool([[0.1, 0.2, 0.3]])
  assert.deepEqual(out, [0.1, 0.2, 0.3])
})
