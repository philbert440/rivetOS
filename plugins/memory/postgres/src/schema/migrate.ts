#!/usr/bin/env node

/**
 * @rivetos/memory-postgres — apply pending SQL migrations to a Postgres DB.
 *
 * Reads `<thisDir>/migrations/*.sql` in lexical order, skips those already
 * recorded in `_rivetos_migrations`, applies the rest in transactions.
 *
 * Idempotent: safe to re-run any number of times. No-ops when nothing pending.
 *
 * Connection: reads `RIVETOS_PG_URL` from env (or `--url <pg>` arg).
 *
 * Exit codes:
 *   0  — success (zero or more migrations applied)
 *   1  — connection / SQL / IO error
 */

import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import pg from 'pg'

const { Client } = pg

export interface Migration {
  name: string
  path: string
  sql: string
}

export function listMigrations(migrationsDir: string): Migration[] {
  const entries = readdirSync(migrationsDir)
  return entries
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((name) => {
      const path = resolve(migrationsDir, name)
      const sql = readFileSync(path, 'utf8')
      return { name, path, sql }
    })
}

async function ensureMigrationsTable(client: pg.Client): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS _rivetos_migrations (
      name        TEXT PRIMARY KEY,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      checksum    TEXT
    )
  `)
}

async function getApplied(client: pg.Client): Promise<Set<string>> {
  const res = await client.query<{ name: string }>(
    'SELECT name FROM _rivetos_migrations ORDER BY name',
  )
  return new Set(res.rows.map((r) => r.name))
}

async function apply(client: pg.Client, migration: Migration): Promise<void> {
  console.log(`[migrate] applying ${migration.name}`)
  // DDL inside an explicit transaction; if a migration ever needs
  // non-transactional execution, split it into a separate file.
  await client.query('BEGIN')
  try {
    await client.query(migration.sql)
    await client.query('INSERT INTO _rivetos_migrations (name) VALUES ($1)', [migration.name])
    await client.query('COMMIT')
    console.log(`[migrate]   ✓ ${migration.name} applied`)
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined)
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`[migrate]   ✗ ${migration.name} failed: ${msg}`)
    throw err
  }
}

export interface RunOptions {
  pgUrl: string
  migrationsDir: string
  baseline?: boolean
}

export async function run(opts: RunOptions): Promise<void> {
  const migrations = listMigrations(opts.migrationsDir)
  if (migrations.length === 0) {
    console.log('[migrate] no migrations found, nothing to do')
    return
  }

  const client = new Client({ connectionString: opts.pgUrl })
  await client.connect()

  try {
    await ensureMigrationsTable(client)
    const applied = await getApplied(client)

    const pending = migrations.filter((m) => !applied.has(m.name))

    if (pending.length === 0) {
      console.log(`[migrate] up to date (${migrations.length} migrations recorded, 0 pending)`)
      return
    }

    if (opts.baseline) {
      console.log(
        `[migrate] baseline mode — recording ${pending.length} migration(s) as applied without running them`,
      )
      for (const m of pending) {
        await client.query(
          'INSERT INTO _rivetos_migrations (name) VALUES ($1) ON CONFLICT DO NOTHING',
          [m.name],
        )
        console.log(`[migrate]   ✓ ${m.name} marked applied (baseline)`)
      }
      console.log(`[migrate] baseline complete — ${pending.length} marked applied`)
      return
    }

    console.log(`[migrate] ${applied.size} applied, ${pending.length} pending`)

    for (const m of pending) {
      await apply(client, m)
    }

    console.log(`[migrate] done — ${pending.length} migration(s) applied`)
  } finally {
    await client.end()
  }
}

function parseArgs(argv: string[]): { pgUrl: string | null; baseline: boolean } {
  const i = argv.indexOf('--url')
  const pgUrl = i !== -1 ? argv[i + 1] : (process.env.RIVETOS_PG_URL ?? null)
  const baseline = argv.includes('--baseline')
  return { pgUrl, baseline }
}

// Resolved relative to the compiled JS file at dist/schema/migrate.js.
// `migrations/` is copied alongside it by the build step.
function defaultMigrationsDir(): string {
  return resolve(__dirname, 'migrations')
}

async function main(): Promise<void> {
  const { pgUrl, baseline } = parseArgs(process.argv.slice(2))
  if (!pgUrl) {
    console.error('[migrate] RIVETOS_PG_URL not set (or pass --url <pg-url>)')
    process.exit(1)
  }
  await run({ pgUrl, migrationsDir: defaultMigrationsDir(), baseline })
}

if (require.main === module) {
  main().catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`[migrate] fatal: ${msg}`)
    if (err instanceof Error && err.stack) {
      console.error(err.stack)
    }
    process.exit(1)
  })
}
