/**
 * Shape of 0019 (session + summary tags, taxonomy). Unit half only: the file
 * is also executed against real PGlite with every other migration by
 * packages/boot/src/embedded-pg.test.ts, and the SQLite mirror is checked
 * column-for-column against it in plugins/memory/sqlite/src/tags-schema.test.ts.
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { listMigrations } from './migrate.js'

const MIGRATION = '0019_tags.sql'
const MIGRATIONS_DIR = resolve(__dirname, 'migrations')
const SQL = readFileSync(resolve(MIGRATIONS_DIR, MIGRATION), 'utf8')
const STATEMENTS = SQL.replace(/--[^\n]*/g, '')

describe('0019 tags migration file', () => {
  it('is discovered by the runner, applying after 0018', () => {
    const names = listMigrations(MIGRATIONS_DIR).map((migration) => migration.name)
    expect(names).toContain(MIGRATION)
    expect(names.indexOf(MIGRATION)).toBeGreaterThan(
      names.indexOf('0018_agent_preset_sort_order.sql'),
    )
  })

  it('creates ros_tags and ros_tag_taxonomy idempotently', () => {
    expect(STATEMENTS).toMatch(/CREATE TABLE IF NOT EXISTS ros_tags \(/)
    expect(STATEMENTS).toMatch(/CREATE TABLE IF NOT EXISTS ros_tag_taxonomy \(/)
    expect(STATEMENTS.match(/CREATE (UNIQUE )?INDEX IF NOT EXISTS/g)?.length).toBe(4)
  })

  it('keys a tag by (entity_type, entity_id, key, value) so a rejected row blocks re-suggestion', () => {
    expect(STATEMENTS).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS ux_ros_tags_entity_kv\s+ON ros_tags \(entity_type, entity_id, key, value\)/,
    )
  })

  it('CHECKs only the closed/structural parts: entity_type, key/value length, self-parent', () => {
    // Every CHECK is one of the clauses asserted below (2 + 2 + 1 + 1 + 1 + 1).
    expect(STATEMENTS.match(/\bCHECK\s*\(/g)).toHaveLength(8)
    expect(STATEMENTS).toMatch(/CHECK \(confidence IS NULL OR \(confidence >= 0 AND confidence <= 1\)\)/)
    expect(STATEMENTS).toMatch(
      /CHECK \(parent_value IS NULL OR char_length\(parent_value\) BETWEEN 1 AND 128\)/,
    )
    expect(STATEMENTS).toMatch(/CHECK \(entity_type IN \('conversation', 'summary'\)\)/)
    expect(
      STATEMENTS.match(/CHECK \(char_length\(key\) BETWEEN 1 AND 64 AND key NOT LIKE '%:%'\)/g),
    ).toHaveLength(2)
    expect(STATEMENTS.match(/CHECK \(char_length\(value\) BETWEEN 1 AND 128\)/g)).toHaveLength(2)
    expect(STATEMENTS).toMatch(/CHECK \(parent_value IS NULL OR parent_value <> value\)/)
    // source and state stay open text: a new tagger or state needs no migration.
    expect(STATEMENTS).not.toMatch(/CHECK \((source|state)\b/)
  })

  it('rewrites no rows and takes no foreign keys or triggers', () => {
    expect(STATEMENTS).not.toMatch(/\b(UPDATE|INSERT|DELETE)\b/i)
    expect(STATEMENTS).not.toMatch(/\bREFERENCES\b/)
    expect(STATEMENTS).not.toMatch(/\bCREATE\s+TRIGGER\b/i)
  })

  it('is PGlite-safe: no LISTEN/NOTIFY, no DO blocks', () => {
    expect(STATEMENTS).not.toMatch(/\b(LISTEN|NOTIFY)\b/i)
    expect(STATEMENTS).not.toMatch(/\bDO\s+\$\$/i)
  })
})
