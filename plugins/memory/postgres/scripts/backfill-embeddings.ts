#!/usr/bin/env npx tsx
/**
 * Backfill embeddings after CHARS_PER_CHUNK fix.
 *
 * Cleans stuck queue entries and poison flags, then re-enqueues all rows with NULL embedding.
 * Standalone script (not a migration, not in CI).
 *
 * Usage:
 *   npx tsx plugins/memory/postgres/scripts/backfill-embeddings.ts [--dry-run]
 *
 * Env: RIVETOS_PG_URL (Postgres connection string)
 *
 * Schema reference (verified against live DB):
 *   ros_embedding_queue(id bigserial, target_table text, target_id uuid,
 *                       attempts int default 0, last_error text, created_at timestamptz)
 *     UNIQUE (target_table, target_id)
 *   ros_messages / ros_summaries both have columns: embedding, embed_failures, embed_error
 */

import pg from 'pg'

const { Pool } = pg

const CONNECTION_STRING =
  process.env.RIVETOS_PG_URL ?? 'postgresql://postgres:postgres@localhost:5432/rivet'
const isDryRun = process.argv.includes('--dry-run')

console.log(`=== RivetOS Embedding Backfill ===`)
console.log(`Mode: ${isDryRun ? 'DRY-RUN (no changes)' : 'LIVE'}`)
console.log(`DB: ${CONNECTION_STRING.split('@')[1] || CONNECTION_STRING}\n`)

interface CountRow {
  count: string
}

interface QueueRow {
  target_id: string
  target_table: string
}

async function queryCount(client: pg.PoolClient, sql: string, params: unknown[] = []): Promise<number> {
  const res = await client.query<CountRow>(sql, params)
  return parseInt(res.rows[0].count, 10)
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function main() {
  const pool = new Pool({ connectionString: CONNECTION_STRING, max: 5 })
  const client = await pool.connect()

  let deleted = 0
  let resetMessages = 0
  let resetSummaries = 0
  let enqueued = 0
  let skipped = 0

  try {
    console.log('Phase 1: Cleaning stuck queue entries and poison flags...\n')

    // 1. Clean queue (attempts >= 3)
    if (isDryRun) {
      deleted = await queryCount(
        client,
        `SELECT COUNT(*)::text AS count FROM ros_embedding_queue WHERE attempts >= 3`
      )
      console.log(`Would delete ${deleted} stuck entries from ros_embedding_queue (dry-run)`)
    } else {
      const res = await client.query(`DELETE FROM ros_embedding_queue WHERE attempts >= 3`)
      deleted = res.rowCount ?? 0
      console.log(`Deleted ${deleted} stuck entries from ros_embedding_queue`)
    }

    // 2. Reset embed_failures on ros_messages
    if (isDryRun) {
      resetMessages = await queryCount(
        client,
        `SELECT COUNT(*)::text AS count FROM ros_messages WHERE embedding IS NULL AND embed_failures >= 3`
      )
      console.log(`Would reset embed_failures for ${resetMessages} messages (dry-run)`)
    } else {
      const res = await client.query(
        `UPDATE ros_messages SET embed_failures = 0 WHERE embedding IS NULL AND embed_failures >= 3`
      )
      resetMessages = res.rowCount ?? 0
      console.log(`Reset embed_failures for ${resetMessages} messages`)
    }

    // 3. Reset for ros_summaries
    if (isDryRun) {
      resetSummaries = await queryCount(
        client,
        `SELECT COUNT(*)::text AS count FROM ros_summaries WHERE embedding IS NULL AND embed_failures >= 3`
      )
      console.log(`Would reset embed_failures for ${resetSummaries} summaries (dry-run)`)
    } else {
      const res = await client.query(
        `UPDATE ros_summaries SET embed_failures = 0 WHERE embedding IS NULL AND embed_failures >= 3`
      )
      resetSummaries = res.rowCount ?? 0
      console.log(`Reset embed_failures for ${resetSummaries} summaries`)
    }

    console.log('\nPhase 2: Re-enqueuing rows with NULL embeddings...\n')

    // Get current queue entries (after Phase 1 deletions) to skip duplicates
    const queuedRes = await client.query<QueueRow>(
      `SELECT target_id, target_table FROM ros_embedding_queue`
    )
    const queuedSet = new Set(queuedRes.rows.map((r) => `${r.target_table}:${r.target_id}`))
    console.log(`Found ${queuedRes.rows.length} existing queue entries (will skip them)`)

    // Candidate messages
    const msgRes = await client.query<{ id: string }>(
      `SELECT id FROM ros_messages WHERE embedding IS NULL ORDER BY created_at ASC`
    )
    const msgToEnqueue = msgRes.rows.filter((r) => !queuedSet.has(`ros_messages:${r.id}`))
    console.log(
      `Messages needing enqueue: ${msgToEnqueue.length} (skipping ${
        msgRes.rows.length - msgToEnqueue.length
      } already queued)`
    )

    // Candidate summaries
    const sumRes = await client.query<{ id: string }>(
      `SELECT id FROM ros_summaries WHERE embedding IS NULL ORDER BY created_at ASC`
    )
    const sumToEnqueue = sumRes.rows.filter((r) => !queuedSet.has(`ros_summaries:${r.id}`))
    console.log(
      `Summaries needing enqueue: ${sumToEnqueue.length} (skipping ${
        sumRes.rows.length - sumToEnqueue.length
      } already queued)`
    )

    const allToEnqueue: { id: string; table: string }[] = [
      ...msgToEnqueue.map((r) => ({ id: r.id, table: 'ros_messages' })),
      ...sumToEnqueue.map((r) => ({ id: r.id, table: 'ros_summaries' })),
    ]
    const totalToEnqueue = allToEnqueue.length
    console.log(`\nTotal to enqueue: ${totalToEnqueue}\n`)

    if (totalToEnqueue === 0) {
      console.log('Nothing to enqueue.')
    } else if (isDryRun) {
      console.log('(dry-run: no inserts performed)')
      skipped = totalToEnqueue
    } else {
      const batchSize = 500
      const delayMs = 100
      let batchNum = 0

      for (let i = 0; i < allToEnqueue.length; i += batchSize) {
        const batch = allToEnqueue.slice(i, i + batchSize)
        batchNum++

        // ros_embedding_queue: (target_table, target_id), UNIQUE (target_table, target_id)
        const values = batch
          .map((_, idx) => `($${idx * 2 + 1}, $${idx * 2 + 2})`)
          .join(', ')
        const params = batch.flatMap((item) => [item.table, item.id])

        const res = await client.query(
          `INSERT INTO ros_embedding_queue (target_table, target_id)
           VALUES ${values}
           ON CONFLICT (target_table, target_id) DO NOTHING`,
          params
        )

        const inserted = res.rowCount ?? 0
        enqueued += inserted
        skipped += batch.length - inserted
        console.log(
          `Batch ${batchNum}: inserted ${inserted}/${batch.length} (running total enqueued ${enqueued} / ${totalToEnqueue})`
        )

        if (i + batchSize < allToEnqueue.length) {
          await sleep(delayMs)
        }
      }
    }

    console.log('\n=== Backfill Complete ===')
    console.log(`Deleted from queue       : ${deleted}`)
    console.log(`Reset messages           : ${resetMessages}`)
    console.log(`Reset summaries          : ${resetSummaries}`)
    console.log(`Enqueued                 : ${enqueued}`)
    console.log(`Skipped (already queued) : ${skipped}`)
    if (isDryRun) console.log('\nThis was a dry-run — no database changes were made.')
    console.log('\nMonitor with:')
    console.log(`  SELECT count(*) FROM ros_embedding_queue;`)
    console.log(`  SELECT count(*) FROM ros_messages WHERE embedding IS NULL;`)
    console.log(`  SELECT count(*) FROM ros_summaries WHERE embedding IS NULL;`)
  } catch (error) {
    console.error('\n[ERROR]', error)
    process.exit(1)
  } finally {
    client.release()
    await pool.end()
  }
}

void main()
