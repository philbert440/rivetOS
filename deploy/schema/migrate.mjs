#!/usr/bin/env node

/**
 * deploy/schema/migrate.mjs — apply pending SQL migrations to a Postgres DB.
 *
 * Reads `deploy/schema/migrations/*.sql` in lexical order, skips those already
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

import { readdirSync, readFileSync, statSync } from 'fs';
import { resolve, dirname, basename } from 'path';
import { fileURLToPath } from 'url';
import pg from 'pg';

const { Client } = pg;

// --------------------------------------------------------------------------
// Config
// --------------------------------------------------------------------------

const argv = process.argv.slice(2);
const argUrlIdx = argv.indexOf('--url');
const argUrl = argUrlIdx !== -1 ? argv[argUrlIdx + 1] : null;
const PG_URL = argUrl || process.env.RIVETOS_PG_URL;

// --baseline marks all current migrations as applied without running them.
// Use when adopting an existing database whose schema already matches the
// migrations on disk (e.g. CT 110's production DB pre-dating this system).
const BASELINE_MODE = argv.includes('--baseline');

if (!PG_URL) {
  console.error('[migrate] RIVETOS_PG_URL not set (or pass --url <pg-url>)');
  process.exit(1);
}

// migrate.mjs lives in deploy/schema/, migrations/ is a sibling directory
const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = resolve(here, 'migrations');

// --------------------------------------------------------------------------
// Migration list discovery
// --------------------------------------------------------------------------

function listMigrations() {
  let entries;
  try {
    entries = readdirSync(migrationsDir);
  } catch (err) {
    console.error(`[migrate] cannot read migrations dir ${migrationsDir}: ${err.message}`);
    process.exit(1);
  }

  return entries
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((name) => {
      const path = resolve(migrationsDir, name);
      const sql = readFileSync(path, 'utf8');
      return { name, path, sql };
    });
}

// --------------------------------------------------------------------------
// Apply migrations
// --------------------------------------------------------------------------

async function ensureMigrationsTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS _rivetos_migrations (
      name        TEXT PRIMARY KEY,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      checksum    TEXT
    )
  `);
}

async function getApplied(client) {
  const res = await client.query('SELECT name FROM _rivetos_migrations ORDER BY name');
  return new Set(res.rows.map((r) => r.name));
}

async function apply(client, migration) {
  console.log(`[migrate] applying ${migration.name}`);
  // Some migrations contain DDL that doesn't run cleanly inside an explicit
  // transaction (e.g. CREATE EXTENSION can require non-transactional context
  // depending on the extension). Use a transaction; if a migration needs
  // non-transactional execution, it must be split into multiple files.
  await client.query('BEGIN');
  try {
    await client.query(migration.sql);
    await client.query('INSERT INTO _rivetos_migrations (name) VALUES ($1)', [
      migration.name,
    ]);
    await client.query('COMMIT');
    console.log(`[migrate]   ✓ ${migration.name} applied`);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    console.error(`[migrate]   ✗ ${migration.name} failed: ${err.message}`);
    throw err;
  }
}

async function main() {
  const migrations = listMigrations();
  if (migrations.length === 0) {
    console.log('[migrate] no migrations found, nothing to do');
    return;
  }

  const client = new Client({ connectionString: PG_URL });
  await client.connect();

  try {
    await ensureMigrationsTable(client);
    const applied = await getApplied(client);

    const pending = migrations.filter((m) => !applied.has(m.name));

    if (pending.length === 0) {
      console.log(
        `[migrate] up to date (${migrations.length} migrations recorded, 0 pending)`,
      );
      return;
    }

    if (BASELINE_MODE) {
      console.log(
        `[migrate] baseline mode — recording ${pending.length} migration(s) as applied without running them`,
      );
      for (const m of pending) {
        await client.query(
          'INSERT INTO _rivetos_migrations (name) VALUES ($1) ON CONFLICT DO NOTHING',
          [m.name],
        );
        console.log(`[migrate]   ✓ ${m.name} marked applied (baseline)`);
      }
      console.log(`[migrate] baseline complete — ${pending.length} marked applied`);
      return;
    }

    console.log(
      `[migrate] ${applied.size} applied, ${pending.length} pending`,
    );

    for (const m of pending) {
      await apply(client, m);
    }

    console.log(`[migrate] done — ${pending.length} migration(s) applied`);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(`[migrate] fatal: ${err.message}`);
  if (err.stack) {
    console.error(err.stack);
  }
  process.exit(1);
});
