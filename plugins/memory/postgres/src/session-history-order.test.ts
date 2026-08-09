/**
 * `getSessionHistory` ordering — the `, m.id DESC` tiebreaker on `created_at`.
 *
 * Capture writes a whole transcript pass in one transaction, so rows sharing a
 * `created_at` are routine rather than exotic. With `created_at` alone Postgres
 * may return the tied block in a different order on every call and a
 * reconnecting session sees its own history reshuffled.
 *
 * Needs RIVETOS_PG_URL (same gate as adapter.test.ts). Builds a throwaway schema
 * inside the target database with the subset of the 0001 tables the read
 * touches — everything lives under `rivetos_session_order_test_<ts>` and is
 * dropped in afterAll, so no row in `public` is read or written and no embedding
 * job is enqueued for a fixture. The tests are written to be discriminating:
 * they fail against `ORDER BY m.created_at DESC` alone.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import pg from 'pg'
import { PostgresMemory } from './adapter.ts'

const PG_URL = process.env.RIVETOS_PG_URL ?? ''
const describeIf = PG_URL.length > 0 ? describe : describe.skip
const SCHEMA = `rivetos_session_order_test_${Date.now()}`

// Lazily built: describe.skip still executes the suite body, so parsing the URL
// at collection time would throw on a machine with no RIVETOS_PG_URL.
/** Pin every connection of a pool to a scratch schema. */
const scopedUrl = (schema: string): string => {
  const url = new URL(PG_URL)
  url.searchParams.set('options', `-c search_path=${schema}`)
  return url.toString()
}

/** Subset of the live schema the session read touches. */
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

const SESSION = 'claude-code:order-probe'
const CONVERSATION = '33333333-0000-4000-8000-000000000001'

/** Two turns at distinct timestamps, then a five-row tied block. */
const FIXTURES = `
INSERT INTO ros_conversations (id, session_key, agent, active) VALUES
  ('${CONVERSATION}', '${SESSION}', 'rivet-claude', true);

INSERT INTO ros_messages (conversation_id, agent, channel, role, content, created_at) VALUES
  ('${CONVERSATION}','rivet-claude','claude-code','user',     'turn-1','2026-08-01 10:00:00+00'),
  ('${CONVERSATION}','rivet-claude','claude-code','assistant','turn-2','2026-08-01 10:01:00+00');

INSERT INTO ros_messages (conversation_id, agent, channel, role, content, created_at)
SELECT '${CONVERSATION}', 'rivet-claude', 'claude-code', 'user', 'tied-' || c,
       '2026-08-01 10:02:00+00'
  FROM generate_series(1, 5) AS c;
`

describeIf('getSessionHistory ordering against a real Postgres', () => {
  let memory: PostgresMemory
  let pool: pg.Pool
  /** The tied rows in the order the `m.id` tiebreaker pins them. */
  let tiedByIdAsc: string[]

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
    await pool.query(FIXTURES)

    const byId = await pool.query<{ content: string }>(
      `SELECT content FROM ros_messages WHERE content LIKE 'tied-%' ORDER BY id ASC`,
    )
    tiedByIdAsc = byId.rows.map((r) => r.content)
  }, 60_000)

  afterAll(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`).catch(() => undefined)
    await memory.close()
  })

  it('returns the same order on every call', async () => {
    const runs = await Promise.all([
      memory.getSessionHistory(SESSION),
      memory.getSessionHistory(SESSION),
      memory.getSessionHistory(SESSION),
    ])
    const contents = runs.map((r) => r.map((m) => m.content))
    expect(contents[1]).toEqual(contents[0])
    expect(contents[2]).toEqual(contents[0])
  })

  it('sorts tied rows by id, after everything older', async () => {
    const history = await memory.getSessionHistory(SESSION)
    const contents = history.map((m) => m.content)

    expect(contents.slice(0, 2)).toEqual(['turn-1', 'turn-2'])
    // Ids being random UUIDs, this is almost never insertion order — which is
    // what makes the assertion discriminating rather than a coincidence.
    expect(contents.slice(2)).toEqual(tiedByIdAsc)
  })

  it('keeps the newest tied rows when the limit cuts into the block', async () => {
    // The query takes the newest N descending and reverses, so a limit landing
    // mid-tie has to keep the high ids and still hand them back ascending.
    const history = await memory.getSessionHistory(SESSION, { limit: 3 })
    expect(history.map((m) => m.content)).toEqual(tiedByIdAsc.slice(-3))
  })
})
