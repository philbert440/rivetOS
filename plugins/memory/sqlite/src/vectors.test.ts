import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { SCHEMA } from './schema.js'
import { ExactScanIndex, decodeVector, encodeVector } from './vectors.js'

function store(db: DatabaseSync, id: string, agent: string, vector: number[] | null): void {
  db.prepare(
    `INSERT INTO ros_conversations (id, session_key, agent, created_at, updated_at)
     VALUES (?, ?, ?, 'x', 'x') ON CONFLICT DO NOTHING`,
  ).run(`c-${agent}`, `s-${agent}`, agent)
  db.prepare(
    `INSERT INTO ros_messages (id, conversation_id, agent, channel, role, content, created_at, embedding)
     VALUES (?, ?, ?, 'cli', 'user', ?, 'x', ?)`,
  ).run(id, `c-${agent}`, agent, id, vector ? encodeVector(vector) : null)
}

describe('vector encoding', () => {
  it('normalizes to unit length and round-trips as float32', () => {
    const blob = encodeVector([3, 4])
    expect(blob).not.toBeNull()
    if (!blob) return
    expect(blob.byteLength).toBe(8)
    const back = decodeVector(blob)
    expect(back[0]).toBeCloseTo(0.6, 6)
    expect(back[1]).toBeCloseTo(0.8, 6)
  })

  it('refuses an empty, zero or non-finite vector', () => {
    expect(encodeVector([])).toBeNull()
    expect(encodeVector([0, 0, 0])).toBeNull()
    expect(encodeVector([1, Number.NaN])).toBeNull()
  })
})

describe('ExactScanIndex', () => {
  it('returns the nearest vectors by cosine similarity, best first', () => {
    const db = new DatabaseSync(':memory:')
    db.exec(SCHEMA)
    store(db, 'east', 'a', [1, 0, 0])
    store(db, 'north', 'a', [0, 1, 0])
    store(db, 'north-east', 'a', [1, 1, 0])
    store(db, 'no-vector', 'a', null)
    const index = new ExactScanIndex(db)
    expect(index.size()).toBe(3)
    const hits = index.search([10, 1, 0], 2)
    expect(hits.map((h) => h.id)).toEqual(['east', 'north-east'])
    expect(hits[0].score).toBeGreaterThan(hits[1].score)
    expect(hits[0].score).toBeLessThanOrEqual(1.000001)
  })

  it('filters by agent, and sees new vectors only after invalidate()', () => {
    const db = new DatabaseSync(':memory:')
    db.exec(SCHEMA)
    store(db, 'mine', 'a', [1, 0])
    store(db, 'theirs', 'b', [1, 0])
    const index = new ExactScanIndex(db)
    expect(index.search([1, 0], 5, { agent: 'b' }).map((h) => h.id)).toEqual(['theirs'])
    store(db, 'later', 'b', [1, 0.1])
    expect(index.search([1, 0], 5, { agent: 'b' })).toHaveLength(1)
    index.invalidate()
    expect(index.search([1, 0], 5, { agent: 'b' })).toHaveLength(2)
  })

  it('ignores a query or stored row of another width instead of comparing them', () => {
    const db = new DatabaseSync(':memory:')
    db.exec(SCHEMA)
    store(db, 'two', 'a', [1, 0])
    store(db, 'three', 'a', [1, 0, 0])
    store(db, 'two-b', 'a', [0, 1])
    const logs: string[] = []
    const index = new ExactScanIndex(db, 'ros_messages', '1 = 1', (l) => logs.push(l))
    // The common width is the index's; the stray row is left out, and said so.
    expect(index.search([1, 0], 5).map((h) => h.id)).toEqual(['two', 'two-b'])
    expect(index.size()).toBe(2)
    expect(logs.join('\n')).toMatch(/1 stored vector\(s\) are not 2 wide/)
    expect(index.search([1, 0, 0], 5)).toEqual([])
    expect(index.search([], 5)).toEqual([])
    expect(index.search([1, 0], 0)).toEqual([])
  })

  it('add() appends or replaces a vector without reloading, and size() does not load', () => {
    const db = new DatabaseSync(':memory:')
    db.exec(SCHEMA)
    store(db, 'east', 'a', [1, 0])
    const index = new ExactScanIndex(db)
    expect(index.size()).toBe(1)
    // Before the first search add() is a no-op: the load will pick the row up.
    index.add('ignored', 'a', encodeVector([0, 1]) as Uint8Array)
    expect(index.search([0, 1], 5).map((h) => h.id)).toEqual(['east'])
    // Loaded now: a new vector is searchable at once, with no row in the table.
    index.add('north', 'b', encodeVector([0, 1]) as Uint8Array)
    expect(index.search([0, 1], 1)[0].id).toBe('north')
    expect(index.search([0, 1], 5, { agent: 'a' }).map((h) => h.id)).toEqual(['east'])
    index.add('east', 'a', encodeVector([0, 1]) as Uint8Array)
    expect(index.size()).toBe(2)
    expect(index.search([0, 1], 5, { agent: 'a' })[0].score).toBeCloseTo(1, 5)
  })

  it('scans a few thousand vectors quickly', () => {
    const db = new DatabaseSync(':memory:')
    db.exec(SCHEMA)
    const dims = 256
    db.exec('BEGIN')
    for (let i = 0; i < 3000; i += 1) {
      const v = Array.from({ length: dims }, (_, d) => Math.sin(i * 0.37 + d * 0.11))
      store(db, `m${String(i)}`, 'a', v)
    }
    db.exec('COMMIT')
    const index = new ExactScanIndex(db)
    const query = Array.from({ length: dims }, (_, d) => Math.sin(1500 * 0.37 + d * 0.11))
    index.search(query, 10) // load
    const start = performance.now()
    const hits = index.search(query, 10)
    expect(hits[0].id).toBe('m1500')
    expect(performance.now() - start).toBeLessThan(500)
  })
})
