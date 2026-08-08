/**
 * Capture-side task association: a task-spawned CLI session writes its turns
 * under its OWN canonical `claude-code:<session_id>` key and records the task
 * on the conversation, so the task's transcript is a query-time union instead
 * of a shared write key.
 *
 * Integration only (needs RIVETOS_PG_URL, same gate as the memory plugin's
 * schema tests): builds a throwaway schema inside the target database, creates
 * the subset of the 0001 tables capture writes to, applies the real 0011
 * migration text from disk, and drives the exported ingest path. Everything
 * lives under `rivetos_capture_task_test_<ts>*` and is dropped in afterAll — no
 * row in `public` is read or written.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import pg from 'pg'
import { CAPTURE_AGENT, ingestHookEvent } from './transcript-capture.js'

const PG_URL = process.env.RIVETOS_PG_URL ?? ''
const describeIf = PG_URL.length > 0 ? describe : describe.skip
const SCHEMA = `rivetos_capture_task_test_${Date.now()}`

/**
 * The real migration text, read from the memory plugin's migrations dir — this
 * package does not depend on it, so it is a file read rather than an import.
 */
const migrationSql = (): string =>
  readFileSync(
    resolve(
      dirname(fileURLToPath(import.meta.url)),
      '../../../memory/postgres/src/schema/migrations/0011_conversation_task_id.sql',
    ),
    'utf8',
  )

/** Pin every connection of a pool to the scratch schema. */
const scopedUrl = (schema: string): string => {
  const url = new URL(PG_URL)
  url.searchParams.set('options', `-c search_path=${schema}`)
  return url.toString()
}

/** Subset of the live schema the capture path writes to. */
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
    tool_name       TEXT,
    tool_args       JSONB,
    tool_result     TEXT,
    metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX ux_ros_conversations_session_agent
    ON ros_conversations (session_key, agent);
`

const TASK = 'cccccccc-3333-4333-8333-cccccccccccc'

const prompt = (sessionId: string, text: string) => ({
  hook_event_name: 'UserPromptSubmit',
  session_id: sessionId,
  prompt: text,
})

describeIf('capture records the task association', () => {
  let pool: pg.Pool
  const pgUrl = scopedUrl(SCHEMA)

  const conversations = async (): Promise<
    Array<{ session_key: string; task_id: string | null }>
  > => {
    const res = await pool.query<{ session_key: string; task_id: string | null }>(
      `SELECT session_key, task_id FROM ros_conversations ORDER BY session_key`,
    )
    return res.rows
  }

  beforeAll(async () => {
    const admin = new pg.Pool({ connectionString: PG_URL, max: 1 })
    try {
      await admin.query(`CREATE SCHEMA ${SCHEMA}`)
    } finally {
      await admin.end()
    }
    pool = new pg.Pool({ connectionString: pgUrl, max: 2 })
    await pool.query(SCRATCH_DDL)
    await pool.query(migrationSql())
  }, 60_000)

  afterAll(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`).catch(() => undefined)
    await pool.end()
  })

  it('keys on the canonical session and stamps the task on the conversation', async () => {
    const res = await ingestHookEvent({
      payload: prompt('spawn-one', 'do the thing'),
      taskId: TASK,
      pgUrl,
    })
    expect(res.sessionKey).toBe('claude-code:spawn-one')
    expect(res.created).toBe(true)

    const row = await pool.query<{ task_id: string | null }>(
      `SELECT task_id FROM ros_conversations WHERE session_key = 'claude-code:spawn-one'`,
    )
    expect(row.rows[0].task_id).toBe(TASK)
  })

  it('gives a second spawn its own conversation under the same task', async () => {
    await ingestHookEvent({ payload: prompt('spawn-two', 'more work'), taskId: TASK, pgUrl })

    const rows = await conversations()
    expect(rows).toEqual([
      { session_key: 'claude-code:spawn-one', task_id: TASK },
      { session_key: 'claude-code:spawn-two', task_id: TASK },
    ])
  })

  it('backfills the association onto a conversation that predates it', async () => {
    // A conversation created by another writer (the adapter's own upsert) has
    // no task_id; the next task-context ingest fills it in.
    await pool.query(
      `INSERT INTO ros_conversations (session_key, agent) VALUES ('claude-code:spawn-three', $1)`,
      [CAPTURE_AGENT],
    )
    await ingestHookEvent({ payload: prompt('spawn-three', 'resumed'), taskId: TASK, pgUrl })

    const row = await pool.query<{ task_id: string | null }>(
      `SELECT task_id FROM ros_conversations WHERE session_key = 'claude-code:spawn-three'`,
    )
    expect(row.rows[0].task_id).toBe(TASK)
  })

  it('never repoints an association that is already set', async () => {
    await ingestHookEvent({
      payload: prompt('spawn-one', 'a stray second task context'),
      taskId: 'dddddddd-4444-4444-8444-dddddddddddd',
      pgUrl,
    })

    const row = await pool.query<{ task_id: string | null }>(
      `SELECT task_id FROM ros_conversations WHERE session_key = 'claude-code:spawn-one'`,
    )
    expect(row.rows[0].task_id).toBe(TASK)
  })

  it('honors a deprecated RIVETOS_SESSION_KEY=task:<id> override verbatim', async () => {
    // The rolling-deploy path: an executor that predates this change still
    // writes into the legacy namespace, and the ingest must not fight it.
    const res = await ingestHookEvent({
      payload: prompt('spawn-legacy', 'mid-flight turn'),
      sessionKeyOverride: `task:${TASK}`,
      taskId: TASK,
      pgUrl,
    })
    expect(res.sessionKey).toBe(`task:${TASK}`)

    const row = await pool.query<{ task_id: string | null }>(
      `SELECT task_id FROM ros_conversations WHERE session_key = $1`,
      [`task:${TASK}`],
    )
    expect(row.rows[0].task_id).toBe(TASK)
  })

  it('captures the turns anyway when the task id is not a UUID', async () => {
    const res = await ingestHookEvent({
      payload: prompt('spawn-badid', 'still capture me'),
      taskId: 'task-env-check',
      pgUrl,
    })
    expect(res.inserted).toBe(1)

    const row = await pool.query<{ task_id: string | null }>(
      `SELECT task_id FROM ros_conversations WHERE session_key = 'claude-code:spawn-badid'`,
    )
    expect(row.rows[0].task_id).toBeNull()
  })
})

describeIf('capture on a node whose 0011 has not landed', () => {
  const UNMIGRATED = `${SCHEMA}_pre0011`
  let pool: pg.Pool
  const pgUrl = scopedUrl(UNMIGRATED)

  beforeAll(async () => {
    const admin = new pg.Pool({ connectionString: PG_URL, max: 1 })
    try {
      await admin.query(`CREATE SCHEMA ${UNMIGRATED}`)
    } finally {
      await admin.end()
    }
    pool = new pg.Pool({ connectionString: pgUrl, max: 2 })
    await pool.query(SCRATCH_DDL) // no 0011 → no task_id column
  }, 60_000)

  afterAll(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS ${UNMIGRATED} CASCADE`).catch(() => undefined)
    await pool.end()
  })

  it('skips the association instead of failing the ingest', async () => {
    const res = await ingestHookEvent({
      payload: prompt('spawn-unmigrated', 'capture must not break'),
      taskId: TASK,
      pgUrl,
    })
    expect(res.sessionKey).toBe('claude-code:spawn-unmigrated')
    expect(res.inserted).toBe(1)
  })
})
