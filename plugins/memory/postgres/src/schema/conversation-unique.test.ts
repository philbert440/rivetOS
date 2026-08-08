/**
 * Conversation dedup + UNIQUE(session_key, agent) + the adapter's race-safe
 * conversation upsert. Covers 0009 (the original) and 0010 (the same dedup re-run
 * under ACCESS EXCLUSIVE, because 0009 took no lock and could cascade-delete a
 * capture write that raced its DELETE).
 *
 * Unit half (always runs): shape assertions on the migration files themselves.
 *
 * Integration half (needs RIVETOS_PG_URL, same gate as adapter.test.ts): builds
 * throwaway schemas inside the target database, creates the subset of the 0001/
 * 0002/0005 tables the migrations touch, applies the real migration text from
 * disk, and checks the merge. Everything lives under `rivetos_conv_unique_test_
 * <ts>*` and is dropped in afterAll — no row in `public` is read or written. The
 * scratch tables deliberately omit vector/tsvector columns and the graphile
 * embedding triggers: the migrations do not touch them, and firing the triggers
 * would enqueue real embed jobs for rows that only exist inside the test schema.
 *
 * Both race tests are written to be discriminating — the 0009 one asserts the
 * message really is lost, and the 0010 one fails if pointed at 0009's SQL.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import pg from 'pg'
import { listMigrations } from './migrate.js'
import { PostgresMemory } from '../adapter.ts'

const MIGRATION = '0009_conversation_session_key_unique.sql'
const LOCKED = '0010_conversation_dedup_locked.sql'
const MIGRATIONS_DIR = resolve(__dirname, 'migrations')
const MIGRATION_SQL = readFileSync(resolve(MIGRATIONS_DIR, MIGRATION), 'utf8')
const LOCKED_SQL = readFileSync(resolve(MIGRATIONS_DIR, LOCKED), 'utf8')

// ---------------------------------------------------------------------------
// Unit — migration shape (no database required)
// ---------------------------------------------------------------------------

describe('conversation dedup migration files', () => {
  it('are discovered by the runner, with the locked re-run applying after the original', () => {
    const names = listMigrations(MIGRATIONS_DIR).map((m) => m.name)
    expect(names).toContain(MIGRATION)
    expect(names).toContain(LOCKED)
    expect(names.indexOf(LOCKED)).toBeGreaterThan(names.indexOf(MIGRATION))
  })

  for (const [name, sql] of [
    [MIGRATION, MIGRATION_SQL],
    [LOCKED, LOCKED_SQL],
  ] as const) {
    it(`${name} creates the unique index the adapter probes for, unpartitioned`, () => {
      expect(sql).toMatch(
        /CREATE UNIQUE INDEX IF NOT EXISTS ux_ros_conversations_session_agent\s+ON ros_conversations \(session_key, agent\);/,
      )
      // NULL semantics: deliberately NOT a partial index — see the file headers.
      expect(sql).not.toMatch(/CREATE UNIQUE INDEX[\s\S]*?WHERE session_key IS NOT NULL/)
    })

    it(`${name} repoints every table referencing a conversation id before deleting`, () => {
      const deleteAt = sql.indexOf('DELETE FROM ros_conversations c')
      expect(deleteAt).toBeGreaterThan(0)
      const beforeDelete = sql.slice(0, deleteAt)
      for (const table of ['ros_messages', 'ros_summaries', 'ros_tasks', 'ros_wiki_provenance']) {
        expect(beforeDelete).toContain(`UPDATE ${table}`)
      }
    })

    it(`${name} aborts rather than cascading on an unknown FK to ros_conversations`, () => {
      expect(sql).toContain('unhandled foreign key reference(s)')
    })
  }

  it('0010 takes ACCESS EXCLUSIVE at the top level, before it reads anything', () => {
    // Top-level (not wrapped in a DO block) so running the file outside a
    // transaction errors loudly instead of releasing the lock immediately.
    const lockAt = LOCKED_SQL.indexOf('LOCK TABLE ros_conversations IN ACCESS EXCLUSIVE MODE;')
    expect(lockAt).toBeGreaterThan(0)
    expect(LOCKED_SQL.indexOf('CREATE TEMP TABLE')).toBeGreaterThan(lockAt)

    // The soft-reference tables have no FK to block writers, so they are locked too.
    expect(LOCKED_SQL).toContain("LOCK TABLE ros_tasks IN ACCESS EXCLUSIVE MODE")
    expect(LOCKED_SQL).toContain("LOCK TABLE ros_wiki_provenance IN ACCESS EXCLUSIVE MODE")
  })

  it('0010 uses its own temp-table name so it can share a transaction with 0009', () => {
    expect(LOCKED_SQL).toContain('_ros_conv_dedup_map_0010')
    expect(LOCKED_SQL).not.toContain('_ros_conv_dedup_map ')
  })
})

// ---------------------------------------------------------------------------
// Integration — real Postgres, throwaway schema
// ---------------------------------------------------------------------------

const PG_URL = process.env.RIVETOS_PG_URL ?? ''
const describeIf = PG_URL.length > 0 ? describe : describe.skip
const SCHEMA = `rivetos_conv_unique_test_${Date.now()}`

/** Subset of the live schema that 0009 reads or writes. */
const SCRATCH_DDL = `
CREATE TABLE ros_conversations (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_key   TEXT NOT NULL,
    agent         TEXT NOT NULL,
    channel       TEXT NOT NULL DEFAULT 'unknown',
    channel_id    TEXT,
    bot_identity  TEXT,
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
CREATE TABLE ros_summaries (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id UUID REFERENCES ros_conversations(id),
    content         TEXT NOT NULL
);
CREATE TABLE ros_tasks (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id UUID,
    session_key     TEXT
);
CREATE TABLE ros_wiki_provenance (
    topic_slug      TEXT NOT NULL,
    source_kind     TEXT NOT NULL CHECK (source_kind IN ('summary','message','conversation','task')),
    source_id       UUID NOT NULL,
    conversation_id UUID,
    PRIMARY KEY (topic_slug, source_kind, source_id)
);
`

const A_OLD = '11111111-1111-1111-1111-111111111111'
const A_NEW = '11111111-1111-1111-1111-111111111112'
const B_OLD = '22222222-2222-2222-2222-222222222221'
const B_NEW = '22222222-2222-2222-2222-222222222222'
const SOLO = '44444444-4444-4444-4444-444444444444'
const SOLO_OTHER_AGENT = '44444444-4444-4444-4444-444444444445'

const FIXTURES = `
-- Two live rows for one session (the shape the racing select-then-insert produced).
INSERT INTO ros_conversations (id, session_key, agent, channel, active, created_at, updated_at, title, settings)
VALUES ('${A_OLD}','sess-a','opus','unknown',   true, '2026-03-13 22:37:14+00','2026-03-13 22:37:14+00', NULL,          '{}'),
       ('${A_NEW}','sess-a','opus','telegram',  true, '2026-03-14 01:08:06+00','2026-03-14 01:08:07+00', 'Later title', '{"k":1}');
-- Oldest row finalized, newer row live (the shape a close-then-reopen produced).
INSERT INTO ros_conversations (id, session_key, agent, channel, active, created_at, updated_at, title)
VALUES ('${B_OLD}','sess-b','rivet-hermes','hermes-telegram', false, '2026-05-23 21:40:18+00','2026-05-23 21:43:38+00','B old'),
       ('${B_NEW}','sess-b','rivet-hermes','hermes-telegram', true,  '2026-05-26 03:48:00+00','2026-05-26 03:48:00+00','B new');
-- Not duplicates: one singleton, and the same session_key under a different agent.
INSERT INTO ros_conversations (id, session_key, agent, active, created_at, updated_at)
VALUES ('${SOLO}','sess-d','a4', true, '2026-02-01','2026-02-02');
INSERT INTO ros_conversations (id, session_key, agent)
VALUES ('${SOLO_OTHER_AGENT}','sess-d','a5');

INSERT INTO ros_messages (conversation_id, agent, channel, role, content)
SELECT id, agent, 'c', 'user', 'm-' || id FROM ros_conversations;
INSERT INTO ros_summaries (conversation_id, content) SELECT id, 's-' || id FROM ros_conversations;
INSERT INTO ros_tasks (conversation_id) SELECT id FROM ros_conversations;
INSERT INTO ros_wiki_provenance (topic_slug, source_kind, source_id, conversation_id)
SELECT 'topic-x', 'summary', gen_random_uuid(), id FROM ros_conversations;
-- source_id doubles as a conversation id here, and is part of the primary key:
-- topic-y already has a row for the survivor, so the duplicate's row must be
-- dropped rather than repointed into a PK violation.
INSERT INTO ros_wiki_provenance (topic_slug, source_kind, source_id) VALUES
  ('topic-y','conversation','${A_OLD}'),
  ('topic-y','conversation','${A_NEW}'),
  ('topic-z','conversation','${B_NEW}');
`

describeIf('0009 dedup against a real Postgres', () => {
  let pool: pg.Pool

  const q = async <T extends pg.QueryResultRow>(sql: string, params?: unknown[]) => {
    const client = await pool.connect()
    try {
      await client.query(`SET search_path = ${SCHEMA}`)
      return await client.query<T>(sql, params)
    } finally {
      client.release()
    }
  }

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: PG_URL, max: 4 })
    const client = await pool.connect()
    try {
      await client.query(`CREATE SCHEMA ${SCHEMA}`)
      await client.query(`SET search_path = ${SCHEMA}`)
      await client.query(SCRATCH_DDL)
      await client.query(FIXTURES)
      await client.query('BEGIN')
      await client.query(MIGRATION_SQL)
      await client.query('COMMIT')
    } finally {
      client.release()
    }
  }, 60_000)

  afterAll(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`)
    await pool.end()
  })

  it('keeps the oldest row of each duplicate group and drops the rest', async () => {
    const res = await q<{ id: string; session_key: string; agent: string }>(
      'SELECT id, session_key, agent FROM ros_conversations ORDER BY session_key, agent',
    )
    expect(res.rows.map((r) => r.id)).toEqual([A_OLD, B_OLD, SOLO, SOLO_OTHER_AGENT])
  })

  it('merges metadata onto the survivor instead of dropping it', async () => {
    const a = await q<{ channel: string; title: string; settings: Record<string, unknown> }>(
      'SELECT channel, title, settings FROM ros_conversations WHERE id = $1',
      [A_OLD],
    )
    // Survivor had channel 'unknown' / no title / empty settings — all backfilled.
    expect(a.rows[0].channel).toBe('telegram')
    expect(a.rows[0].title).toBe('Later title')
    expect(a.rows[0].settings).toEqual({ k: 1 })

    const b = await q<{ active: boolean; created_at: Date; updated_at: Date; title: string }>(
      'SELECT active, created_at, updated_at, title FROM ros_conversations WHERE id = $1',
      [B_OLD],
    )
    // A live duplicate keeps the session live, or the merged messages would fall
    // out of every active = true read.
    expect(b.rows[0].active).toBe(true)
    // created_at = min across the group, updated_at = max.
    expect(b.rows[0].created_at.toISOString()).toBe('2026-05-23T21:40:18.000Z')
    expect(b.rows[0].updated_at.toISOString()).toBe('2026-05-26T03:48:00.000Z')
    // Survivor's own title wins over the duplicate's.
    expect(b.rows[0].title).toBe('B old')
  })

  it('repoints messages, summaries, tasks and wiki provenance', async () => {
    for (const table of ['ros_messages', 'ros_summaries', 'ros_tasks']) {
      const res = await q<{ conversation_id: string; n: string }>(
        `SELECT conversation_id, count(*)::text AS n FROM ${table} GROUP BY 1 ORDER BY 1`,
      )
      const byConv = Object.fromEntries(res.rows.map((r) => [r.conversation_id, Number(r.n)]))
      expect(byConv).toEqual({ [A_OLD]: 2, [B_OLD]: 2, [SOLO]: 1, [SOLO_OTHER_AGENT]: 1 })
    }

    const prov = await q<{ conversation_id: string; n: string }>(
      `SELECT conversation_id, count(*)::text AS n FROM ros_wiki_provenance
        WHERE conversation_id IS NOT NULL GROUP BY 1 ORDER BY 1`,
    )
    expect(Object.fromEntries(prov.rows.map((r) => [r.conversation_id, Number(r.n)]))).toEqual({
      [A_OLD]: 2,
      [B_OLD]: 2,
      [SOLO]: 1,
      [SOLO_OTHER_AGENT]: 1,
    })
  })

  it('drops conversation-kind provenance that would collide, repoints the rest', async () => {
    const res = await q<{ topic_slug: string; source_id: string }>(
      `SELECT topic_slug, source_id FROM ros_wiki_provenance
        WHERE source_kind = 'conversation' ORDER BY topic_slug`,
    )
    expect(res.rows).toEqual([
      { topic_slug: 'topic-y', source_id: A_OLD },
      { topic_slug: 'topic-z', source_id: B_OLD },
    ])
  })

  it('leaves no dangling conversation reference behind', async () => {
    const res = await q<{ dangling: string }>(
      `SELECT count(*)::text AS dangling FROM (
         SELECT conversation_id FROM ros_messages
         UNION ALL SELECT conversation_id FROM ros_summaries
         UNION ALL SELECT conversation_id FROM ros_tasks
         UNION ALL SELECT conversation_id FROM ros_wiki_provenance
       ) r WHERE r.conversation_id IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM ros_conversations c WHERE c.id = r.conversation_id)`,
    )
    expect(Number(res.rows[0].dangling)).toBe(0)
  })

  it('enforces the constraint afterwards, per agent', async () => {
    await expect(
      q(`INSERT INTO ros_conversations (session_key, agent) VALUES ('sess-d', 'a4')`),
    ).rejects.toMatchObject({ code: '23505' })
    // Same session_key under a different agent is still allowed.
    await expect(
      q(`INSERT INTO ros_conversations (session_key, agent) VALUES ('sess-d', 'a6')`),
    ).resolves.toBeTruthy()
  })

  it('is a no-op on a second application', async () => {
    const before = await q<{ n: string }>('SELECT count(*)::text AS n FROM ros_conversations')
    const client = await pool.connect()
    try {
      await client.query(`SET search_path = ${SCHEMA}`)
      await client.query('BEGIN')
      await client.query(MIGRATION_SQL)
      await client.query('COMMIT')
    } finally {
      client.release()
    }
    const after = await q<{ n: string }>('SELECT count(*)::text AS n FROM ros_conversations')
    expect(after.rows[0].n).toBe(before.rows[0].n)
  })
})

describeIf('0010 locked dedup', () => {
  let pool: pg.Pool
  const schemas: string[] = []

  /** Fresh scratch schema; `sql` is applied after DDL + fixtures. */
  const build = async (suffix: string, sql: string[]): Promise<string> => {
    const name = `${SCHEMA}_${suffix}`
    schemas.push(name)
    const client = await pool.connect()
    try {
      await client.query(`CREATE SCHEMA ${name}`)
      await client.query(`SET search_path = ${name}`)
      await client.query(SCRATCH_DDL)
      await client.query(FIXTURES)
      for (const stmt of sql) {
        await client.query('BEGIN')
        await client.query(stmt)
        await client.query('COMMIT')
      }
    } finally {
      client.release()
    }
    return name
  }

  const count = async (schema: string, table: string): Promise<number> => {
    const res = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM ${schema}.${table}`,
    )
    return Number(res.rows[0].n)
  }

  beforeAll(() => {
    pool = new pg.Pool({ connectionString: PG_URL, max: 4 })
  })

  afterAll(async () => {
    for (const s of schemas) {
      await pool.query(`DROP SCHEMA IF EXISTS ${s} CASCADE`)
    }
    await pool.end()
  }, 60_000)

  it('dedups on its own, for a database whose 0009 index build rolled back', async () => {
    const schema = await build('l1', [LOCKED_SQL])

    const rows = await pool.query<{ id: string }>(
      `SELECT id FROM ${schema}.ros_conversations ORDER BY session_key, agent`,
    )
    expect(rows.rows.map((r) => r.id)).toEqual([A_OLD, B_OLD, SOLO, SOLO_OTHER_AGENT])
    expect(await count(schema, 'ros_messages')).toBe(6)

    const dangling = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM ${schema}.ros_messages m
        WHERE NOT EXISTS (SELECT 1 FROM ${schema}.ros_conversations c WHERE c.id = m.conversation_id)`,
    )
    expect(Number(dangling.rows[0].n)).toBe(0)

    const idx = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM pg_indexes
        WHERE schemaname = $1 AND indexname = 'ux_ros_conversations_session_agent'`,
      [schema],
    )
    expect(Number(idx.rows[0].n)).toBe(1)
  }, 60_000)

  it('is a no-op on a database 0009 already deduped, however often it runs', async () => {
    const schema = await build('l2', [MIGRATION_SQL, LOCKED_SQL])
    const snapshot = {
      conversations: await count(schema, 'ros_conversations'),
      messages: await count(schema, 'ros_messages'),
      summaries: await count(schema, 'ros_summaries'),
      provenance: await count(schema, 'ros_wiki_provenance'),
    }
    expect(snapshot.conversations).toBe(4)

    const client = await pool.connect()
    try {
      await client.query(`SET search_path = ${schema}`)
      for (let i = 0; i < 2; i++) {
        await client.query('BEGIN')
        await client.query(LOCKED_SQL)
        await client.query('COMMIT')
      }
    } finally {
      client.release()
    }

    expect({
      conversations: await count(schema, 'ros_conversations'),
      messages: await count(schema, 'ros_messages'),
      summaries: await count(schema, 'ros_summaries'),
      provenance: await count(schema, 'ros_wiki_provenance'),
    }).toEqual(snapshot)
  }, 60_000)

  /**
   * The race window is between the repoint and the DELETE. Split the file there
   * so a capture write can be interleaved exactly where it hurts — a whole-file
   * run is not discriminating, because the DELETE's own row locks block a late
   * writer whether or not the migration took a table lock.
   */
  const splitAtDelete = (sql: string): [string, string] => {
    const cut = sql.indexOf('DELETE FROM ros_conversations c')
    expect(cut).toBeGreaterThan(0)
    return [sql.slice(0, cut), sql.slice(cut)]
  }

  /** A second connection pinned to `schema`, with a short statement timeout. */
  const racingWriter = async (schema: string): Promise<pg.PoolClient> => {
    const writer = await pool.connect()
    await writer.query(`SET search_path = ${schema}`)
    await writer.query(`SET statement_timeout = '1500ms'`)
    return writer
  }

  const RACE_INSERT = `INSERT INTO ros_messages (conversation_id, agent, channel, role, content)
                       VALUES ($1, 'opus', 'c', 'user', 'racing capture write')`

  it('0009 silently cascade-deletes a capture write that races the delete', async () => {
    // Documents the defect, so the fix below is measured against something real.
    const schema = await build('l3', [])
    const [head, tail] = splitAtDelete(MIGRATION_SQL)

    const migrator = await pool.connect()
    const writer = await racingWriter(schema)
    try {
      await migrator.query(`SET search_path = ${schema}`)
      await migrator.query('BEGIN')
      await migrator.query(head) // repoint done, no lock taken

      // Capture write lands on a row that is about to be deleted. Nothing stops it.
      await writer.query(RACE_INSERT, [A_NEW])

      await migrator.query(tail) // DELETE + index
      await migrator.query('COMMIT')
    } finally {
      await migrator.query('ROLLBACK').catch(() => undefined)
      migrator.release()
      await writer.query(`RESET statement_timeout`).catch(() => undefined)
      writer.release()
    }

    const survived = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM ${schema}.ros_messages WHERE content = 'racing capture write'`,
    )
    // Committed, then destroyed by ON DELETE CASCADE.
    expect(Number(survived.rows[0].n)).toBe(0)
  }, 60_000)

  it('0010 blocks that write instead of losing it', async () => {
    const schema = await build('l4', [])
    const [head] = splitAtDelete(LOCKED_SQL)

    const migrator = await pool.connect()
    const writer = await racingWriter(schema)
    try {
      await migrator.query(`SET search_path = ${schema}`)
      await migrator.query('BEGIN')
      await migrator.query(head) // first statement is the ACCESS EXCLUSIVE lock

      await expect(writer.query(RACE_INSERT, [A_NEW])).rejects.toMatchObject({ code: '57014' })

      // ros_messages itself is deliberately NOT locked — search and embedding
      // reads keep working for the duration of the dedup.
      const read = await writer.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM ros_messages`,
      )
      expect(Number(read.rows[0].n)).toBeGreaterThan(0)
    } finally {
      await migrator.query('ROLLBACK').catch(() => undefined)
      migrator.release()
      await writer.query(`RESET statement_timeout`).catch(() => undefined)
      writer.release()
    }
  }, 60_000)
})

describeIf('adapter conversation upsert', () => {
  const SCHEMA2 = `${SCHEMA}_adapter`
  let memory: PostgresMemory
  let pool: pg.Pool

  /** Call the private ensureConversation on a client pinned to the test schema. */
  const ensure = async (sessionId: string, agent: string, channel?: string): Promise<string> => {
    const client = await pool.connect()
    try {
      await client.query(`SET search_path = ${SCHEMA2}`)
      return await (
        memory as unknown as {
          ensureConversation: (
            c: pg.PoolClient,
            s: string,
            a: string,
            ch?: string,
          ) => Promise<string>
        }
      ).ensureConversation(client, sessionId, agent, channel)
    } finally {
      client.release()
    }
  }

  beforeAll(async () => {
    memory = new PostgresMemory({ connectionString: PG_URL, maxConnections: 6 })
    pool = memory.getPool()
    const client = await pool.connect()
    try {
      await client.query(`CREATE SCHEMA ${SCHEMA2}`)
      await client.query(`SET search_path = ${SCHEMA2}`)
      await client.query(SCRATCH_DDL)
      await client.query(MIGRATION_SQL)
    } finally {
      client.release()
    }
  }, 60_000)

  afterAll(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA2} CASCADE`)
    await memory.close()
  })

  it('yields one conversation for concurrent captures of the same session', async () => {
    const ids = await Promise.all([
      ensure('sess-race', 'agent-race', 'cli'),
      ensure('sess-race', 'agent-race', 'cli'),
      ensure('sess-race', 'agent-race', 'cli'),
      ensure('sess-race', 'agent-race', 'cli'),
    ])
    expect(new Set(ids).size).toBe(1)

    const rows = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM ${SCHEMA2}.ros_conversations
        WHERE session_key = 'sess-race' AND agent = 'agent-race'`,
    )
    expect(rows.rows[0].n).toBe('1')
  })

  it('reuses and reactivates a finalized conversation instead of forking it', async () => {
    const first = await ensure('sess-resume', 'agent-resume', 'cli')
    await pool.query(
      `UPDATE ${SCHEMA2}.ros_conversations SET active = false WHERE id = $1`,
      [first],
    )

    const second = await ensure('sess-resume', 'agent-resume', 'cli')
    expect(second).toBe(first)

    const row = await pool.query<{ active: boolean }>(
      `SELECT active FROM ${SCHEMA2}.ros_conversations WHERE id = $1`,
      [first],
    )
    expect(row.rows[0].active).toBe(true)
  })

  it('keys on (session_key, agent), not session_key alone', async () => {
    const a = await ensure('sess-shared', 'agent-one', 'cli')
    const b = await ensure('sess-shared', 'agent-two', 'cli')
    expect(a).not.toBe(b)
  })

  it('switches to the upsert when the migration lands mid-process, without a restart', async () => {
    // The deploy order is: new code to every node, then `rivetos db migrate`. A
    // process that probed before the migration must not stay on the legacy path —
    // that path INSERTs a fresh row whenever the conversation is finalized, which
    // is a 23505 once the unique index exists.
    const SCHEMA4 = `${SCHEMA}_midflight`
    const mem = new PostgresMemory({ connectionString: PG_URL })
    const memPool = mem.getPool()

    const call = async (): Promise<string> => {
      const client = await memPool.connect()
      try {
        await client.query(`SET search_path = ${SCHEMA4}`)
        return await (
          mem as unknown as {
            ensureConversation: (c: pg.PoolClient, s: string, a: string) => Promise<string>
          }
        ).ensureConversation(client, 'sess-midflight', 'agent-midflight')
      } finally {
        client.release()
      }
    }

    try {
      const setup = await memPool.connect()
      try {
        await setup.query(`CREATE SCHEMA ${SCHEMA4}`)
        await setup.query(`SET search_path = ${SCHEMA4}`)
        await setup.query(SCRATCH_DDL) // pre-migration: no unique index
      } finally {
        setup.release()
      }

      // Probes false and caches nothing.
      const first = await call()

      // Migration lands under the live pool.
      const migrate = await memPool.connect()
      try {
        await migrate.query(`SET search_path = ${SCHEMA4}`)
        await migrate.query('BEGIN')
        await migrate.query(LOCKED_SQL)
        await migrate.query('COMMIT')
      } finally {
        migrate.release()
      }

      // Finalize, then resume: the legacy path would INSERT a second row and hit
      // 23505. The upsert reuses and reactivates.
      await memPool.query(
        `UPDATE ${SCHEMA4}.ros_conversations SET active = false WHERE id = $1`,
        [first],
      )
      expect(await call()).toBe(first)

      const row = await memPool.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM ${SCHEMA4}.ros_conversations`,
      )
      expect(row.rows[0].n).toBe('1')

    } finally {
      await memPool.query(`DROP SCHEMA IF EXISTS ${SCHEMA4} CASCADE`).catch(() => undefined)
      await mem.close()
    }
  }, 60_000)

  it('falls back to select-then-insert when the index has not been created', async () => {
    const SCHEMA3 = `${SCHEMA}_legacy`
    const legacy = new PostgresMemory({ connectionString: PG_URL })
    const legacyPool = legacy.getPool()
    try {
      const setup = await legacyPool.connect()
      try {
        await setup.query(`CREATE SCHEMA ${SCHEMA3}`)
        await setup.query(`SET search_path = ${SCHEMA3}`)
        await setup.query(SCRATCH_DDL) // no 0009 → no unique index
      } finally {
        setup.release()
      }

      const call = async (): Promise<string> => {
        const client = await legacyPool.connect()
        try {
          await client.query(`SET search_path = ${SCHEMA3}`)
          return await (
            legacy as unknown as {
              ensureConversation: (c: pg.PoolClient, s: string, a: string) => Promise<string>
            }
          ).ensureConversation(client, 'sess-legacy', 'agent-legacy')
        } finally {
          client.release()
        }
      }

      // No 42P10: the probe sees no index and takes the historical path.
      const first = await call()
      expect(await call()).toBe(first)

      // And the historical quirk is preserved: a finalized conversation is not
      // reused, it forks — exactly the behaviour 0009 exists to stop.
      await legacyPool.query(
        `UPDATE ${SCHEMA3}.ros_conversations SET active = false WHERE id = $1`,
        [first],
      )
      expect(await call()).not.toBe(first)

    } finally {
      await legacyPool.query(`DROP SCHEMA IF EXISTS ${SCHEMA3} CASCADE`).catch(() => undefined)
      await legacy.close()
    }
  }, 60_000)
})
