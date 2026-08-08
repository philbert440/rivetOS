/**
 * Per-conversation task association (0011) + the query-time union read that
 * replaces the `RIVETOS_SESSION_KEY=task:<id>` write-key override.
 *
 * Unit half (always runs): shape assertions on the migration file itself —
 * notably that it does NOT rewrite existing rows, because legacy
 * `task:<id>`-keyed conversations are covered by the read-side union rather
 * than migrated.
 *
 * Integration half (needs RIVETOS_PG_URL, same gate as adapter.test.ts): builds
 * throwaway schemas inside the target database, creates the subset of the 0001
 * tables the read touches, applies the real migration text from disk, and
 * exercises PostgresMemory.getTaskHistory against fixtures that mix legacy and
 * canonical rows. Everything lives under `rivetos_conv_task_test_<ts>*` and is
 * dropped in afterAll — no row in `public` is read or written.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import pg from 'pg'
import { listMigrations } from './migrate.js'
import { PostgresMemory } from '../adapter.ts'

const MIGRATION = '0011_conversation_task_id.sql'
const MIGRATIONS_DIR = resolve(__dirname, 'migrations')
const MIGRATION_SQL = readFileSync(resolve(MIGRATIONS_DIR, MIGRATION), 'utf8')

// ---------------------------------------------------------------------------
// Unit — migration shape (no database required)
// ---------------------------------------------------------------------------

describe('0011 task association migration file', () => {
  it('is discovered by the runner, applying after the dedup files', () => {
    const names = listMigrations(MIGRATIONS_DIR).map((m) => m.name)
    expect(names).toContain(MIGRATION)
    expect(names.indexOf(MIGRATION)).toBeGreaterThan(
      names.indexOf('0010_conversation_dedup_locked.sql'),
    )
  })

  it('adds a nullable task_id and its partial index, both idempotently', () => {
    expect(MIGRATION_SQL).toMatch(/ADD COLUMN IF NOT EXISTS task_id UUID;/)
    expect(MIGRATION_SQL).not.toMatch(/task_id UUID[\s\S]{0,40}NOT NULL/)
    expect(MIGRATION_SQL).toMatch(
      /CREATE INDEX IF NOT EXISTS idx_ros_conversations_task\s+ON ros_conversations \(task_id, created_at\)\s+WHERE task_id IS NOT NULL;/,
    )
  })

  it('rewrites no existing rows — the union read covers legacy keys instead', () => {
    const statements = MIGRATION_SQL.replace(/--[^\n]*/g, '')
    expect(statements).not.toMatch(/\b(UPDATE|INSERT|DELETE)\b/i)
  })

  it('takes no FK on ros_tasks, matching the soft reference in the other direction', () => {
    expect(MIGRATION_SQL).not.toMatch(/REFERENCES\s+ros_tasks/i)
  })
})

// ---------------------------------------------------------------------------
// Integration — real Postgres, throwaway schema
// ---------------------------------------------------------------------------

const PG_URL = process.env.RIVETOS_PG_URL ?? ''
const describeIf = PG_URL.length > 0 ? describe : describe.skip
const SCHEMA = `rivetos_conv_task_test_${Date.now()}`

/** Pin every connection of a pool to a scratch schema. */
const scopedUrl = (schema: string): string => {
  const url = new URL(PG_URL)
  url.searchParams.set('options', `-c search_path=${schema}`)
  return url.toString()
}

/** Subset of the live schema the task-union read touches. */
const SCRATCH_DDL = `
CREATE TABLE ros_conversations (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_key   TEXT NOT NULL,
    agent         TEXT NOT NULL,
    channel       TEXT NOT NULL DEFAULT 'unknown',
    title         TEXT,
    settings      JSONB DEFAULT '{}'::jsonb,
    active        BOOLEAN DEFAULT true,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE ros_messages (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id UUID NOT NULL REFERENCES ros_conversations(id) ON DELETE CASCADE,
    agent           TEXT NOT NULL,
    channel         TEXT NOT NULL,
    role            TEXT NOT NULL,
    content         TEXT NOT NULL DEFAULT '',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
`

const TASK = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa'
const OTHER_TASK = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb'

/**
 * One task, three spawns: the legacy `task:<id>`-keyed conversation written
 * before the migration, and two canonically-keyed ones written after. Message
 * timestamps interleave across all three, so a correct union has to sort
 * globally rather than concatenate per conversation.
 */
const FIXTURES = `
INSERT INTO ros_conversations (id, session_key, agent, task_id, active) VALUES
  ('11111111-0000-4000-8000-000000000001', 'task:${TASK}',            'rivet-claude', NULL,          true),
  ('11111111-0000-4000-8000-000000000002', 'claude-code:spawn-two',   'rivet-claude', '${TASK}',     true),
  ('11111111-0000-4000-8000-000000000003', 'claude-code:spawn-three', 'rivet-claude', '${TASK}',     false),
  ('11111111-0000-4000-8000-000000000004', 'claude-code:unrelated',   'rivet-claude', '${OTHER_TASK}', true),
  ('11111111-0000-4000-8000-000000000005', 'task:${OTHER_TASK}',      'rivet-claude', NULL,          true);

INSERT INTO ros_messages (conversation_id, agent, channel, role, content, created_at) VALUES
  ('11111111-0000-4000-8000-000000000001','rivet-claude','claude-code','user',     'legacy-1','2026-08-01 10:00:00+00'),
  ('11111111-0000-4000-8000-000000000002','rivet-claude','claude-code','assistant','canon-2', '2026-08-01 10:01:00+00'),
  ('11111111-0000-4000-8000-000000000001','rivet-claude','claude-code','assistant','legacy-3','2026-08-01 10:02:00+00'),
  ('11111111-0000-4000-8000-000000000003','rivet-claude','claude-code','user',     'canon-4', '2026-08-01 10:03:00+00'),
  ('11111111-0000-4000-8000-000000000004','rivet-claude','claude-code','user',     'other-task','2026-08-01 10:04:00+00'),
  ('11111111-0000-4000-8000-000000000005','rivet-claude','claude-code','user',     'other-legacy','2026-08-01 10:05:00+00');
`

describeIf('task-union read against a real Postgres', () => {
  let memory: PostgresMemory
  let pool: pg.Pool

  beforeAll(async () => {
    const admin = new pg.Pool({ connectionString: PG_URL, max: 1 })
    try {
      await admin.query(`CREATE SCHEMA ${SCHEMA}`)
    } finally {
      await admin.end()
    }
    memory = new PostgresMemory({ connectionString: scopedUrl(SCHEMA) })
    pool = memory.getPool()
    await pool.query(SCRATCH_DDL)
    await pool.query(MIGRATION_SQL)
    await pool.query(FIXTURES)
  }, 60_000)

  afterAll(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`).catch(() => undefined)
    await memory.close()
  })

  it('unions legacy and canonical conversations into one chronological transcript', async () => {
    const history = await memory.getTaskHistory(TASK)
    expect(history.map((m) => m.content)).toEqual(['legacy-1', 'canon-2', 'legacy-3', 'canon-4'])
    expect(history.map((m) => m.role)).toEqual(['user', 'assistant', 'assistant', 'user'])
  })

  it('includes finalized spawns, which the session read filters out', async () => {
    // spawn-three is active = false (its SessionEnd hook fired) and its turn is
    // still in the union above — a resumed task must see what already happened.
    const legacyOnly = await memory.getSessionHistory(`task:${TASK}`)
    expect(legacyOnly.map((m) => m.content)).toEqual(['legacy-1', 'legacy-3'])
  })

  it('does not leak another task, by either key shape', async () => {
    const history = await memory.getTaskHistory(TASK)
    expect(history.map((m) => m.content)).not.toContain('other-task')
    expect(history.map((m) => m.content)).not.toContain('other-legacy')

    const other = await memory.getTaskHistory(OTHER_TASK)
    expect(other.map((m) => m.content)).toEqual(['other-task', 'other-legacy'])
  })

  it('limits to the newest N across the union, still chronological', async () => {
    const history = await memory.getTaskHistory(TASK, { limit: 2 })
    expect(history.map((m) => m.content)).toEqual(['legacy-3', 'canon-4'])
  })

  it('orders messages that share a timestamp stably', async () => {
    // Capture inserts a whole transcript pass in one transaction, so ties on
    // created_at are routine. Without a tiebreaker Postgres may return them in
    // a different order per call and a resumed task sees reshuffled history.
    await pool.query(`
      INSERT INTO ros_messages (conversation_id, agent, channel, role, content, created_at)
      SELECT ('11111111-0000-4000-8000-00000000000' || c)::uuid, 'rivet-claude', 'claude-code', 'user',
             'tied-' || c, '2026-08-01 11:00:00+00'
        FROM generate_series(1, 3) AS c;
    `)
    try {
      const runs = await Promise.all([
        memory.getTaskHistory(TASK),
        memory.getTaskHistory(TASK),
        memory.getTaskHistory(TASK),
      ])
      const contents = runs.map((r) => r.map((m) => m.content))
      expect(contents[1]).toEqual(contents[0])
      expect(contents[2]).toEqual(contents[0])
      // The tied rows still sort after everything older...
      expect(contents[0].slice(0, 4)).toEqual(['legacy-1', 'canon-2', 'legacy-3', 'canon-4'])
      // ...and among themselves they come back in the id order the query pins,
      // which — ids being random UUIDs — is almost never insertion order. That
      // is what makes this discriminating rather than a coincidence.
      const byId = await pool.query<{ content: string }>(
        `SELECT content FROM ros_messages WHERE content LIKE 'tied-%' ORDER BY id ASC`,
      )
      expect(contents[0].slice(4)).toEqual(byId.rows.map((r) => r.content))
    } finally {
      await pool.query(`DELETE FROM ros_messages WHERE content LIKE 'tied-%'`)
    }
  })

  it('reads the legacy key alone for a task id the UUID column cannot hold', async () => {
    // Binding a non-UUID would be a 22P02; the read degrades instead.
    await expect(memory.getTaskHistory('task-env-check')).resolves.toEqual([])
  })

  it('is a no-op on a second application', async () => {
    await pool.query(MIGRATION_SQL)
    const history = await memory.getTaskHistory(TASK)
    expect(history).toHaveLength(4)
  })
})

describeIf('task-union read before the migration lands', () => {
  const UNMIGRATED = `${SCHEMA}_pre0011`
  let memory: PostgresMemory
  let pool: pg.Pool

  beforeAll(async () => {
    const admin = new pg.Pool({ connectionString: PG_URL, max: 1 })
    try {
      await admin.query(`CREATE SCHEMA ${UNMIGRATED}`)
    } finally {
      await admin.end()
    }
    memory = new PostgresMemory({ connectionString: scopedUrl(UNMIGRATED) })
    pool = memory.getPool()
    await pool.query(SCRATCH_DDL) // no 0011 → no task_id column
    await pool.query(`
      INSERT INTO ros_conversations (id, session_key, agent)
      VALUES ('22222222-0000-4000-8000-000000000001', 'task:${TASK}', 'rivet-claude');
      INSERT INTO ros_messages (conversation_id, agent, channel, role, content)
      VALUES ('22222222-0000-4000-8000-000000000001','rivet-claude','claude-code','user','pre-migration');
    `)
  }, 60_000)

  afterAll(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS ${UNMIGRATED} CASCADE`).catch(() => undefined)
    await memory.close()
  })

  it('falls back to the legacy key instead of failing on the missing column', async () => {
    // Deploy order is code first, `rivetos db migrate` second — the read has to
    // survive the gap rather than 42703 every task view on the node.
    const history = await memory.getTaskHistory(TASK)
    expect(history.map((m) => m.content)).toEqual(['pre-migration'])
  })

  it('picks the union up mid-process once the migration lands, without a restart', async () => {
    await pool.query(MIGRATION_SQL)
    await pool.query(`
      INSERT INTO ros_conversations (id, session_key, agent, task_id)
      VALUES ('22222222-0000-4000-8000-000000000002', 'claude-code:late', 'rivet-claude', '${TASK}');
      INSERT INTO ros_messages (conversation_id, agent, channel, role, content)
      VALUES ('22222222-0000-4000-8000-000000000002','rivet-claude','claude-code','assistant','post-migration');
    `)

    const history = await memory.getTaskHistory(TASK)
    expect(history.map((m) => m.content)).toEqual(['pre-migration', 'post-migration'])
  }, 60_000)
})
