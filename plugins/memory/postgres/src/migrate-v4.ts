#!/usr/bin/env npx tsx
/**
 * Migration v4: Add ros_summaries.pipeline_version for resumable backfill.
 *
 * Adds an integer column tracking which compaction pipeline produced each summary:
 *   1 = pre-v5 (legacy prompts / budgets, everything that existed before this PR)
 *   5 = v5 pipeline (rich formatter, thinking-mode prompts, 7k/14k/20k budgets)
 *
 * Existing rows default to 1 so the summary-refine backfill script can target
 * them with `WHERE pipeline_version < 5`. New inserts from the compactor/worker
 * set this explicitly.
 *
 * Idempotent: ADD COLUMN IF NOT EXISTS, CREATE INDEX IF NOT EXISTS.
 *
 * Run: npx tsx plugins/memory/postgres/src/migrate-v4.ts
 * Env: RIVETOS_PG_URL
 */

import pg from 'pg'

const { Pool } = pg

const CONNECTION_STRING = process.env.RIVETOS_PG_URL ?? ''

interface CountRow {
  n: number
}

interface VersionHistRow {
  pipeline_version: number
  n: number
}

async function count(pool: pg.Pool, table: string): Promise<number> {
  const res = await pool.query<CountRow>(`SELECT count(*)::int AS n FROM ${table}`)
  return res.rows[0].n
}

async function printSummary(pool: pg.Pool): Promise<void> {
  console.log('\n--- ros_summaries ---')
  const total = await count(pool, 'ros_summaries')
  console.log(`  total rows                    ${total.toLocaleString()}`)

  // Only try the histogram if the column exists
  const colCheck = await pool.query<{ exists: boolean }>(
    `SELECT EXISTS(
       SELECT 1 FROM information_schema.columns
       WHERE table_name = 'ros_summaries' AND column_name = 'pipeline_version'
     ) AS exists`,
  )
  if (!colCheck.rows[0].exists) {
    console.log('  (pipeline_version column not yet present)')
    return
  }

  const hist = await pool.query<VersionHistRow>(
    `SELECT pipeline_version, count(*)::int AS n
       FROM ros_summaries
       GROUP BY pipeline_version
       ORDER BY pipeline_version`,
  )
  for (const row of hist.rows) {
    console.log(
      `  pipeline_version = ${String(row.pipeline_version)}       ${row.n.toLocaleString()}`,
    )
  }
}

async function migrate(): Promise<void> {
  if (!CONNECTION_STRING) {
    console.error('RIVETOS_PG_URL is required')
    process.exit(1)
  }

  const pool = new Pool({ connectionString: CONNECTION_STRING, max: 5 })

  console.log('=== RivetOS Memory Migration v4: ros_summaries.pipeline_version ===\n')

  await printSummary(pool)

  const client = await pool.connect()
  try {
    await client.query('BEGIN')

    // Add column with DEFAULT 1 so existing rows are all tagged as pre-v5.
    // NOT NULL is safe because DEFAULT supplies a value for every existing row.
    await client.query(`
      ALTER TABLE ros_summaries
        ADD COLUMN IF NOT EXISTS pipeline_version INT NOT NULL DEFAULT 1;
    `)

    // Partial index: the backfill query always filters for pipeline_version < 5,
    // and future versions will bump the bound. Keeping the index narrow avoids
    // bloating the btree with rows we'll never scan for.
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_ros_summaries_pipeline_version
        ON ros_summaries(pipeline_version)
        WHERE pipeline_version < 5;
    `)

    await client.query('COMMIT')

    console.log('\n✅ Migration v4 complete — ros_summaries.pipeline_version ready.')
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    console.error('Migration failed:', err)
    process.exit(1)
  } finally {
    client.release()
  }

  await printSummary(pool)
  await pool.end()
}

migrate().catch((err: unknown) => {
  console.error('❌ Fatal:', err)
  process.exit(1)
})
