#!/usr/bin/env npx tsx
/**
 * Migration v2: LCM tables → RivetOS ros_* tables.
 *
 * Strategy: Insert messages WITHOUT embeddings (HNSW index is the bottleneck),
 * then bulk-update embeddings in a second pass using lcm_message_id metadata.
 */

import pg from 'pg';

const { Pool } = pg;

const CONNECTION_STRING =
  process.env.RIVETOS_PG_URL ??
  'postgresql://lcm_phil:pheon.lcm4@10.4.20.106:5432/phil_memory';

const BATCH_SIZE = 2000;
const WORKERS = 4;
const EMBEDDING_BATCH = 500;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function count(pool: pg.Pool, table: string): Promise<number> {
  const res = await pool.query(`SELECT count(*)::int AS n FROM ${table}`);
  return res.rows[0].n;
}

async function printCounts(pool: pg.Pool, label: string): Promise<void> {
  console.log(`\n--- ${label} ---`);
  for (const t of ['ros_conversations', 'ros_messages', 'ros_summaries', 'ros_summary_sources']) {
    const n = await count(pool, t);
    console.log(`  ${t.padEnd(24)} ${n.toLocaleString()}`);
  }
}

// ---------------------------------------------------------------------------
// Build conversation mapping
// ---------------------------------------------------------------------------

async function buildConvMap(pool: pg.Pool): Promise<Map<number, string>> {
  const res = await pool.query(`
    SELECT c.conversation_id AS old_id, rc.id AS new_id
    FROM conversations c
    JOIN ros_conversations rc
      ON rc.session_key = COALESCE(c.session_key, c.session_id)
      AND rc.created_at = c.created_at
  `);
  const map = new Map<number, string>();
  for (const row of res.rows) {
    map.set(row.old_id, row.new_id);
  }
  console.log(`  Built conversation mapping: ${map.size} entries`);
  return map;
}

// ---------------------------------------------------------------------------
// Phase 1: Insert messages WITHOUT embeddings (fast — no HNSW updates)
// ---------------------------------------------------------------------------

async function migrateMessages(
  pool: pg.Pool,
  convMap: Map<number, string>,
): Promise<Map<number, string>> {
  console.log('\n[2] Migrating messages (without embeddings)...');

  const totalMsgs = await count(pool, 'messages');
  console.log(`  Source: ${totalMsgs.toLocaleString()} messages`);

  const rangeRes = await pool.query('SELECT min(message_id) AS lo, max(message_id) AS hi FROM messages');
  const lo = rangeRes.rows[0].lo;
  const hi = rangeRes.rows[0].hi;
  const chunkSize = Math.ceil((hi - lo + 1) / WORKERS);

  const startTime = Date.now();
  let progressTotal = 0;

  const workerPromises = Array.from({ length: WORKERS }, async (_, i) => {
    const workerLo = lo + i * chunkSize;
    const workerHi = Math.min(lo + (i + 1) * chunkSize - 1, hi);
    const localMap: [number, string][] = [];

    let cursor = workerLo;
    while (cursor <= workerHi) {
      const batchEnd = Math.min(cursor + BATCH_SIZE, workerHi + 1);
      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        const msgRows = await client.query(
          `SELECT m.message_id, m.conversation_id, m.role, m.content, m.created_at,
                  c.agent_id,
                  tp.tool_name, tp.tool_input, tp.tool_output
           FROM messages m
           JOIN conversations c ON c.conversation_id = m.conversation_id
           LEFT JOIN LATERAL (
             SELECT tool_name, tool_input, tool_output
             FROM message_parts
             WHERE message_id = m.message_id AND part_type = 'tool'
             ORDER BY ordinal LIMIT 1
           ) tp ON true
           WHERE m.message_id >= $1 AND m.message_id < $2
           ORDER BY m.message_id`,
          [cursor, batchEnd],
        );

        for (const row of msgRows.rows) {
          const newConvId = convMap.get(row.conversation_id);
          if (!newConvId) continue;

          let toolArgs: string | null = null;
          if (row.tool_input) {
            try {
              JSON.parse(row.tool_input);
              toolArgs = row.tool_input;
            } catch {
              toolArgs = JSON.stringify({ raw: row.tool_input });
            }
          }

          // Insert WITHOUT embedding — skip HNSW entirely
          const res = await client.query(
            `INSERT INTO ros_messages
               (conversation_id, agent, channel, role, content,
                tool_name, tool_args, tool_result,
                metadata, created_at)
             VALUES ($1, $2, 'unknown', $3, $4, $5, $6, $7, $8, $9)
             RETURNING id`,
            [
              newConvId,
              row.agent_id ?? 'unknown',
              row.role,
              row.content,
              row.tool_name ?? null,
              toolArgs,
              row.tool_output ?? null,
              JSON.stringify({ lcm_message_id: row.message_id }),
              row.created_at,
            ],
          );

          localMap.push([row.message_id, res.rows[0].id]);
        }

        await client.query('COMMIT');
        cursor = batchEnd;

        progressTotal += msgRows.rows.length;
        const elapsed = (Date.now() - startTime) / 1000;
        if (progressTotal % 10000 < BATCH_SIZE) {
          const rate = Math.round(progressTotal / elapsed);
          console.log(`  ... ${progressTotal.toLocaleString()} messages (${rate}/s, ${elapsed.toFixed(0)}s)`);
        }
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    }

    return localMap;
  });

  const results = await Promise.all(workerPromises);

  const msgMap = new Map<number, string>();
  for (const localMap of results) {
    for (const [oldId, newId] of localMap) {
      msgMap.set(oldId, newId);
    }
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`  Inserted ${msgMap.size.toLocaleString()} messages in ${elapsed}s (no embeddings)`);
  return msgMap;
}

// ---------------------------------------------------------------------------
// Phase 2: Backfill embeddings from old messages table
// ---------------------------------------------------------------------------

async function backfillEmbeddings(pool: pg.Pool): Promise<void> {
  console.log('\n[5] Backfilling embeddings from LCM messages...');

  const startTime = Date.now();

  // Join ros_messages to old messages via lcm_message_id in metadata
  // Process in batches to avoid locking everything
  const totalRes = await pool.query(`
    SELECT count(*)::int AS n
    FROM ros_messages rm
    JOIN messages m ON m.message_id = (rm.metadata->>'lcm_message_id')::int
    WHERE rm.embedding IS NULL AND m.embedding IS NOT NULL
  `);
  const total = totalRes.rows[0].n;
  console.log(`  ${total.toLocaleString()} messages need embeddings`);

  let updated = 0;
  while (updated < total) {
    const res = await pool.query(`
      WITH batch AS (
        SELECT rm.id AS ros_id, m.embedding
        FROM ros_messages rm
        JOIN messages m ON m.message_id = (rm.metadata->>'lcm_message_id')::int
        WHERE rm.embedding IS NULL AND m.embedding IS NOT NULL
        LIMIT $1
      )
      UPDATE ros_messages SET embedding = batch.embedding
      FROM batch WHERE ros_messages.id = batch.ros_id
    `, [EMBEDDING_BATCH]);

    updated += res.rowCount ?? 0;
    if (updated % 5000 < EMBEDDING_BATCH) {
      const elapsed = (Date.now() - startTime) / 1000;
      const rate = Math.round(updated / elapsed);
      console.log(`  ... ${updated.toLocaleString()} embeddings (${rate}/s)`);
    }

    // Safety: if nothing was updated, we're done
    if ((res.rowCount ?? 0) === 0) break;
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`  Backfilled ${updated.toLocaleString()} embeddings in ${elapsed}s`);
}

// ---------------------------------------------------------------------------
// Summaries + Summary sources (unchanged from v1 approach)
// ---------------------------------------------------------------------------

async function migrateSummaries(
  pool: pg.Pool,
  convMap: Map<number, string>,
): Promise<Map<string, string>> {
  console.log('\n[3] Migrating summaries...');

  const sumMap = new Map<string, string>();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const sumRows = await client.query(
      `SELECT s.summary_id, s.conversation_id, s.kind, s.depth, s.content,
              s.descendant_count, s.earliest_at, s.latest_at,
              s.embedding, s.model, s.created_at
       FROM summaries s
       ORDER BY s.depth ASC, s.created_at ASC`,
    );

    for (const row of sumRows.rows) {
      const newConvId = convMap.get(row.conversation_id);
      if (!newConvId) continue;

      const res = await client.query(
        `INSERT INTO ros_summaries
           (conversation_id, depth, content, kind, message_count,
            earliest_at, latest_at, embedding, model, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         RETURNING id`,
        [
          newConvId,
          row.depth,
          row.content,
          row.kind,
          row.descendant_count,
          row.earliest_at,
          row.latest_at,
          row.embedding,
          row.model,
          row.created_at,
        ],
      );

      sumMap.set(row.summary_id, res.rows[0].id);
    }

    await client.query('COMMIT');
    console.log(`  Migrated ${sumMap.size} summaries`);

    // Set parent_id
    await client.query('BEGIN');
    const parentResult = await client.query(`
      SELECT DISTINCT ON (sp.summary_id)
        sp.summary_id, sp.parent_summary_id
      FROM summary_parents sp
      ORDER BY sp.summary_id, sp.ordinal
    `);

    let parentsSet = 0;
    for (const row of parentResult.rows) {
      const newSumId = sumMap.get(row.summary_id);
      const newParentId = sumMap.get(row.parent_summary_id);
      if (newSumId && newParentId) {
        await client.query(
          'UPDATE ros_summaries SET parent_id = $1 WHERE id = $2',
          [newParentId, newSumId],
        );
        parentsSet++;
      }
    }
    await client.query('COMMIT');
    console.log(`  Set parent_id for ${parentsSet} summaries`);
  } finally {
    client.release();
  }

  return sumMap;
}

async function migrateSummarySources(
  pool: pg.Pool,
  sumMap: Map<string, string>,
  msgMap: Map<number, string>,
): Promise<void> {
  console.log('\n[4] Migrating summary_sources...');

  const rows = await pool.query(
    'SELECT summary_id, message_id, ordinal FROM summary_messages ORDER BY summary_id, ordinal',
  );

  let migrated = 0;
  let batch: { sumId: string; msgId: string; ordinal: number }[] = [];

  const flush = async () => {
    if (batch.length === 0) return;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const { sumId, msgId, ordinal } of batch) {
        await client.query(
          'INSERT INTO ros_summary_sources (summary_id, message_id, ordinal) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
          [sumId, msgId, ordinal],
        );
      }
      await client.query('COMMIT');
      migrated += batch.length;
    } finally {
      client.release();
    }
    batch = [];
  };

  for (const row of rows.rows) {
    const newSumId = sumMap.get(row.summary_id);
    const newMsgId = msgMap.get(row.message_id);
    if (!newSumId || !newMsgId) continue;

    batch.push({ sumId: newSumId, msgId: newMsgId, ordinal: row.ordinal });
    if (batch.length >= BATCH_SIZE) await flush();
  }
  await flush();

  console.log(`  Migrated ${migrated.toLocaleString()} summary_source links`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function migrate(): Promise<void> {
  const pool = new Pool({ connectionString: CONNECTION_STRING, max: WORKERS + 2 });

  console.log('=== RivetOS Memory Migration v2: LCM → ros_* ===');
  console.log(`  Workers: ${WORKERS}, Batch size: ${BATCH_SIZE}`);
  console.log(`  Strategy: Insert without embeddings → backfill after\n`);

  await printCounts(pool, 'BEFORE');

  // Step 1: Build conversation mapping
  console.log('\n[1] Building conversation mapping...');
  const convMap = await buildConvMap(pool);
  if (convMap.size === 0) {
    console.error('❌ No conversation mapping found!');
    process.exit(1);
  }

  // Step 2: Messages (no embeddings)
  const msgMap = await migrateMessages(pool, convMap);

  // Step 3: Summaries
  const sumMap = await migrateSummaries(pool, convMap);

  // Step 4: Summary sources
  await migrateSummarySources(pool, sumMap, msgMap);

  // Step 5: Backfill embeddings
  await backfillEmbeddings(pool);

  await printCounts(pool, 'AFTER');

  console.log('\n✅ Migration v2 complete!');
  await pool.end();
}

migrate().catch((err) => {
  console.error('❌ Fatal:', err);
  process.exit(1);
});
