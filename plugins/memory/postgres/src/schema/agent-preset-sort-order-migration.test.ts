/**
 * Shape of 0018 (agent preset sort order). Unit half only — applying it
 * against Postgres lives with PgAgentPresetStore.
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { listMigrations } from './migrate.js'

const MIGRATION = '0018_agent_preset_sort_order.sql'
const MIGRATIONS_DIR = resolve(__dirname, 'migrations')
const SQL = readFileSync(resolve(MIGRATIONS_DIR, MIGRATION), 'utf8')

describe('0018 agent preset sort order migration file', () => {
  it('is discovered by the runner, applying after 0017_agent_presets.sql', () => {
    const names = listMigrations(MIGRATIONS_DIR).map((migration) => migration.name)
    expect(names).toContain(MIGRATION)
    expect(names.indexOf(MIGRATION)).toBeGreaterThan(names.indexOf('0017_agent_presets.sql'))
  })

  it('adds a nullable sort_order column idempotently', () => {
    expect(SQL).toMatch(/ADD COLUMN IF NOT EXISTS sort_order INTEGER;/)
    expect(SQL.replace(/--[^\n]*/g, '')).not.toMatch(/NOT NULL|DEFAULT/i)
  })

  it('rewrites no rows and takes no foreign keys or triggers', () => {
    const statements = SQL.replace(/--[^\n]*/g, '')
    expect(statements).not.toMatch(/\b(UPDATE|INSERT|DELETE)\b/i)
    expect(statements).not.toMatch(/\bREFERENCES\b/)
    expect(statements).not.toMatch(/\bCREATE\s+TRIGGER\b/i)
  })
})
