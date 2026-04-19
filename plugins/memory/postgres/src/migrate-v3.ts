#!/usr/bin/env npx tsx
/**
 * Migration v3: Add ros_tool_synth_queue for async tool-call content synthesis (v5 pipeline).
 *
 * Idempotent: CREATE IF NOT EXISTS, index if not exists. Safe to run multiple times.
 *
 * Run: npx tsx plugins/memory/postgres/src/migrate-v3.ts
 * Env: RIVETOS_PG_URL
 */

import pg from 'pg'

const { Pool } = pg

const CONNECTION_STRING = process.env.RIVETOS_PG_URL ?? ''

interface CountRow {
  n: number
}

async function count(pool: pg.Pool, table: string): Promise<number> {
  const res = await pool.query<CountRow>(`SELECT count(*)::int AS n FROM ${table}`)
  return res.rows[0].n
}

async function printCounts(pool: pg.Pool): Promise<void> {
  console.log('\n--- ros_tool_synth_queue ---')
  try {
    const n = await count(pool, 'ros_tool_synth_queue')
    console.log(`  ros_tool_synth_queue          ${n.toLocaleString()}`)
  } catch (_e) {
    console.log('  (table not yet created)')
  }
}

async function migrate(): Promise<void> {
  if (!CONNECTION_STRING) {
    console.error('RIVETOS_PG_URL is required')
    process.exit(1)
  }

  const pool = new Pool({ connectionString: CONNECTION_STRING, max: 5 })

  console.log('=== RivetOS Memory Migration v3: tool_synth_queue ===\n')

  await printCounts(pool)

  const client = await pool.connect()
  try {
    await client.query('BEGIN')

    await client.query(`
      CREATE TABLE IF NOT EXISTS ros_tool_synth_queue (
        message_id UUID PRIMARY KEY REFERENCES ros_messages(id) ON DELETE CASCADE,
        enqueued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        attempts INT NOT NULL DEFAULT 0,
        last_error TEXT,
        last_attempt_at TIMESTAMPTZ
      );
    `)

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_tool_synth_queue_enqueued 
      ON ros_tool_synth_queue(enqueued_at);
    `)

    await client.query('COMMIT')

    console.log('\n✅ Migration v3 complete — ros_tool_synth_queue ready.')
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    console.error('Migration failed:', err)
    process.exit(1)
  } finally {
    client.release()
    await pool.end()
  }

  await printCounts(pool)
}

migrate().catch((err: unknown) => {
  console.error('❌ Fatal:', err)
  process.exit(1)
})
