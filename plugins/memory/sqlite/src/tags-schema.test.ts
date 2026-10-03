/**
 * v2 SQLite schema: ros_tags + ros_tag_taxonomy mirror postgres 0019_tags.sql.
 * Parity is checked against the migration file itself, not a hand copy, so a
 * column renamed on one side fails here.
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { SCHEMA, SCHEMA_VERSION } from './schema.js'

const PG_0019 = readFileSync(
  resolve(__dirname, '../../postgres/src/schema/migrations/0019_tags.sql'),
  'utf8',
).replace(/--[^\n]*/g, '')

/** Column names of one CREATE TABLE in the postgres migration, in order. */
function pgColumns(table: string): string[] {
  const m = new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\(([\\s\\S]*?)\\n\\);`).exec(PG_0019)
  if (!m) throw new Error(`no CREATE TABLE ${table} in 0019`)
  return m[1]
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '' && !/^(PRIMARY KEY|CHECK|UNIQUE|CONSTRAINT)\b/.test(l))
    .map((l) => l.split(/\s+/)[0])
}

function sqliteColumns(db: DatabaseSync, table: string): string[] {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  return rows.map((r) => r.name)
}

function fresh(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  db.exec(SCHEMA)
  return db
}

const INSERT_TAG = `INSERT INTO ros_tags (id, entity_type, entity_id, key, value, source, state, created_at, updated_at)
  VALUES (?, ?, 'c1', ?, ?, 'user', ?, '2026-10-02T00:00:00Z', '2026-10-02T00:00:00Z')`

describe('sqlite tags schema (v2)', () => {
  it('bumps SCHEMA_VERSION to at least 2', () => {
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(2)
  })

  it('has exactly the columns of postgres 0019, in the same order', () => {
    const db = fresh()
    expect(pgColumns('ros_tags').length).toBeGreaterThan(10)
    expect(sqliteColumns(db, 'ros_tags')).toEqual(pgColumns('ros_tags'))
    expect(sqliteColumns(db, 'ros_tag_taxonomy')).toEqual(pgColumns('ros_tag_taxonomy'))
    db.close()
  })

  it('has the same four indexes as postgres 0019', () => {
    const db = fresh()
    const pgIndexes = [...PG_0019.matchAll(/CREATE (?:UNIQUE )?INDEX IF NOT EXISTS (\w+)/g)].map(
      (m) => m[1],
    )
    const rows = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name IN ('ros_tags', 'ros_tag_taxonomy') AND name NOT LIKE 'sqlite_%'`,
      )
      .all() as Array<{ name: string }>
    expect(pgIndexes).toHaveLength(4)
    expect(rows.map((r) => r.name).sort()).toEqual([...pgIndexes].sort())
    db.close()
  })

  it('rejects a duplicate (entity_type, entity_id, key, value) so a rejected row blocks re-suggestion', () => {
    const db = fresh()
    const ins = db.prepare(INSERT_TAG)
    ins.run('t1', 'conversation', 'project', 'tenpal', 'rejected')
    expect(() => ins.run('t2', 'conversation', 'project', 'tenpal', 'suggested')).toThrow(/UNIQUE/)
    db.close()
  })

  it('enforces the same CHECKs as postgres: entity_type, key/value length, self-parent', () => {
    const db = fresh()
    const ins = db.prepare(INSERT_TAG)
    expect(() => ins.run('a', 'summaries', 'topic', 'x', 'accepted')).toThrow(/CHECK/)
    expect(() => ins.run('b', 'conversation', '', 'x', 'accepted')).toThrow(/CHECK/)
    expect(() => ins.run('b2', 'conversation', 'a:b', 'x', 'accepted')).toThrow(/CHECK/)
    expect(() => ins.run('c', 'conversation', 'k'.repeat(65), 'x', 'accepted')).toThrow(/CHECK/)
    expect(() => ins.run('d', 'conversation', 'topic', 'v'.repeat(129), 'accepted')).toThrow(/CHECK/)
    ins.run('e', 'summary', 'k'.repeat(64), 'v'.repeat(128), 'accepted')
    const tax = db.prepare(
      `INSERT INTO ros_tag_taxonomy (key, value, parent_value, created_at, updated_at) VALUES ('topic', ?, ?, 'x', 'x')`,
    )
    expect(() => tax.run('a', 'a')).toThrow(/CHECK/)
    expect(() => tax.run('k', '')).toThrow(/CHECK/)
    expect(() => tax.run('k', 'p'.repeat(129))).toThrow(/CHECK/)
    const taxKv = db.prepare(
      `INSERT INTO ros_tag_taxonomy (key, value, created_at, updated_at) VALUES (?, ?, 'x', 'x')`,
    )
    expect(() => taxKv.run('k'.repeat(65), 'v')).toThrow(/CHECK/)
    expect(() => taxKv.run('k', 'v'.repeat(129))).toThrow(/CHECK/)
    const conf = db.prepare(
      `INSERT INTO ros_tags (id, entity_type, entity_id, key, value, source, state, confidence, created_at, updated_at)
       VALUES (?, 'summary', 's', 'topic', ?, 'model', 'suggested', ?, 'x', 'x')`,
    )
    expect(() => conf.run('c1', 'a', 1.5)).toThrow(/CHECK/)
    conf.run('c2', 'b', 0.5)
    tax.run('a', 'b')
    tax.run('b', null)
    db.close()
  })
})
