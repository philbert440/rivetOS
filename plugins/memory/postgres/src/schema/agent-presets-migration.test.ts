/**
 * Shape of 0017 (agent preset registry). Unit half only — the SQL file is
 * discovered, idempotent, and does not rewrite rows, take foreign keys, or
 * install triggers. Applying it against Postgres lives with PgAgentPresetStore.
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { listMigrations } from './migrate.js'

const MIGRATION = '0017_agent_presets.sql'
const MIGRATIONS_DIR = resolve(__dirname, 'migrations')
const SQL = readFileSync(resolve(MIGRATIONS_DIR, MIGRATION), 'utf8')

describe('0017 agent presets migration file', () => {
  it('is discovered by the runner, applying after 0016_defer_embed_enqueue.sql', () => {
    const names = listMigrations(MIGRATIONS_DIR).map((migration) => migration.name)
    expect(names).toContain(MIGRATION)
    expect(names.indexOf(MIGRATION)).toBeGreaterThan(names.indexOf('0016_defer_embed_enqueue.sql'))
  })

  it('creates ros_agent_presets idempotently', () => {
    expect(SQL).toMatch(/CREATE TABLE IF NOT EXISTS ros_agent_presets/)
  })

  it('rewrites no rows and takes no foreign keys or triggers', () => {
    const statements = SQL.replace(/--[^\n]*/g, '')
    expect(statements).not.toMatch(/\b(UPDATE|INSERT|DELETE)\b/i)
    expect(statements).not.toMatch(/\bREFERENCES\b/)
    expect(statements).not.toMatch(/\bCREATE\s+TRIGGER\b/i)
    expect(statements).not.toMatch(/\bCHECK\b/i)
  })
})
