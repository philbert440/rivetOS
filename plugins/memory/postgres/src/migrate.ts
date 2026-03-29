#!/usr/bin/env npx tsx
/**
 * Migration: LCM tables → RivetOS ros_* tables.
 *
 * One-shot script. Migrates conversations, messages (with tool data from
 * message_parts), summaries (with parent relationships from summary_parents),
 * and summary_sources (from summary_messages).
 *
 * Run:  npx tsx plugins/memory/postgres/src/migrate.ts
 * Env:  RIVETOS_PG_URL (default: see below)
 *
 * This script is idempotent-ish: it will fail with duplicate key errors if
 * you run it twice without truncating the ros_* tables first. That's by design —
 * you should only run it once.
 */

import pg from 'pg';

const { Pool } = pg;

const CONNECTION_STRING =
  process.env.RIVETOS_PG_URL ??
  'postgresql://rivet_agent:rivet_agent_2025@10.4.20.106:5432/phil_memory';

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function migrate(): Promise<void> {
  const pool = new Pool({ connectionString: CONNECTION_STRING, max: 5 });
  const client = await pool.connect();

  try {
    console.log('=== RivetOS Memory Migration: LCM → ros_* ===\n');

    // --- Source counts ---
    console.log('--- Source (LCM) ---');
    await printCount(client, 'conversations');
    await printCount(client, 'messages');
    await printCount(client, 'summaries');
    await printCount(client, 'summary_messages');
    await printCount(client, 'summary_parents');

    console.log('\n--- Destination (ros_*) BEFORE ---');
    await printCount(client, 'ros_conversations');
    await printCount(client, 'ros_messages');
    await printCount(client, 'ros_summaries');
    await printCount(client, 'ros_summary_sources');

    await client.query('BEGIN');

    // ===================================================================
    // TEMP MAPPING TABLES
    // ===================================================================
    // Old tables use integer PKs; new tables use UUIDs.
    // We create temp tables to hold old_id → new_id mappings.

    await client.query(`
      CREATE TEMP TABLE _conv_map (old_id INTEGER PRIMARY KEY, new_id UUID NOT NULL) ON COMMIT DROP
    `);
    await client.query(`
      CREATE TEMP TABLE _msg_map (old_id INTEGER PRIMARY KEY, new_id UUID NOT NULL) ON COMMIT DROP
    `);
    await client.query(`
      CREATE TEMP TABLE _sum_map (old_id TEXT PRIMARY KEY, new_id UUID NOT NULL) ON COMMIT DROP
    `);

    // ===================================================================
    // 1. CONVERSATIONS
    // ===================================================================
    console.log('\n[1/4] Migrating conversations...');

    // Insert and capture the mapping via a serial approach:
    // We iterate in app code because we need to map integer → UUID reliably.
    const convRows = await client.query(
      `SELECT conversation_id, session_id, session_key, agent_id, title,
              metadata, active, created_at, updated_at
       FROM conversations
       ORDER BY conversation_id`,
    );

    for (const row of convRows.rows) {
      const res = await client.query(
        `INSERT INTO ros_conversations
           (session_key, agent, channel, title, settings, active, created_at, updated_at)
         VALUES ($1, $2, 'unknown', $3, $4, $5, $6, $7)
         RETURNING id`,
        [
          row.session_key ?? row.session_id,
          row.agent_id ?? 'unknown',
          row.title,
          row.metadata ?? '{}',
          row.active,
          row.created_at,
          row.updated_at,
        ],
      );
      await client.query(
        'INSERT INTO _conv_map (old_id, new_id) VALUES ($1, $2)',
        [row.conversation_id, res.rows[0].id],
      );
    }
    console.log(`  Migrated ${convRows.rows.length} conversations`);

    // ===================================================================
    // 2. MESSAGES (with tool data from message_parts)
    // ===================================================================
    console.log('\n[2/4] Migrating messages...');

    // Batch in chunks of 1000 to avoid OOM on 70K+ messages
    const totalMsgs = await countTable(client, 'messages');
    const CHUNK = 1000;
    let migrated = 0;

    for (let offset = 0; offset < totalMsgs; offset += CHUNK) {
      const msgRows = await client.query(
        `SELECT m.message_id, m.conversation_id, m.role, m.content, m.embedding, m.created_at,
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
         ORDER BY m.message_id
         LIMIT $1 OFFSET $2`,
        [CHUNK, offset],
      );

      for (const row of msgRows.rows) {
        // Look up the new conversation UUID
        const convMap = await client.query(
          'SELECT new_id FROM _conv_map WHERE old_id = $1',
          [row.conversation_id],
        );
        if (convMap.rows.length === 0) continue; // orphan — skip

        let toolArgs: string | null = null;
        if (row.tool_input) {
          try {
            // Validate it's JSON, then store as-is
            JSON.parse(row.tool_input);
            toolArgs = row.tool_input;
          } catch {
            toolArgs = JSON.stringify({ raw: row.tool_input });
          }
        }

        const res = await client.query(
          `INSERT INTO ros_messages
             (conversation_id, agent, channel, role, content,
              tool_name, tool_args, tool_result,
              metadata, embedding, created_at)
           VALUES ($1, $2, 'unknown', $3, $4, $5, $6, $7, $8, $9, $10)
           RETURNING id`,
          [
            convMap.rows[0].new_id,
            row.agent_id ?? 'unknown',
            row.role,
            row.content,
            row.tool_name ?? null,
            toolArgs,
            row.tool_output ?? null,
            JSON.stringify({ message_id: row.message_id }),
            row.embedding,
            row.created_at,
          ],
        );

        await client.query(
          'INSERT INTO _msg_map (old_id, new_id) VALUES ($1, $2)',
          [row.message_id, res.rows[0].id],
        );
        migrated++;
      }

      if (migrated % 5000 === 0 && migrated > 0) {
        console.log(`  ... ${migrated} messages`);
      }
    }
    console.log(`  Migrated ${migrated} messages`);

    // ===================================================================
    // 3. SUMMARIES (with parent relationships from summary_parents)
    // ===================================================================
    console.log('\n[3/4] Migrating summaries...');

    // First pass: insert all summaries without parent_id
    const sumRows = await client.query(
      `SELECT s.summary_id, s.conversation_id, s.kind, s.depth, s.content,
              s.descendant_count, s.earliest_at, s.latest_at,
              s.embedding, s.model, s.created_at
       FROM summaries s
       ORDER BY s.depth ASC, s.created_at ASC`,
    );

    for (const row of sumRows.rows) {
      const convMap = await client.query(
        'SELECT new_id FROM _conv_map WHERE old_id = $1',
        [row.conversation_id],
      );
      if (convMap.rows.length === 0) continue;

      const res = await client.query(
        `INSERT INTO ros_summaries
           (conversation_id, depth, content, kind, message_count,
            earliest_at, latest_at, embedding, model, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         RETURNING id`,
        [
          convMap.rows[0].new_id,
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

      await client.query(
        'INSERT INTO _sum_map (old_id, new_id) VALUES ($1, $2)',
        [row.summary_id, res.rows[0].id],
      );
    }
    console.log(`  Migrated ${sumRows.rows.length} summaries`);

    // Second pass: set parent_id from summary_parents
    // Old schema is many-to-many; new schema is single parent.
    // Take the first parent by ordinal.
    const parentResult = await client.query(`
      WITH first_parent AS (
        SELECT DISTINCT ON (sp.summary_id)
          sp.summary_id, sp.parent_summary_id
        FROM summary_parents sp
        ORDER BY sp.summary_id, sp.ordinal
      )
      UPDATE ros_summaries rs
      SET parent_id = psm.new_id
      FROM first_parent fp
      JOIN _sum_map sm ON sm.old_id = fp.summary_id
      JOIN _sum_map psm ON psm.old_id = fp.parent_summary_id
      WHERE rs.id = sm.new_id
    `);
    console.log(`  Set parent_id for ${parentResult.rowCount} summaries`);

    // ===================================================================
    // 4. SUMMARY_SOURCES (from summary_messages)
    // ===================================================================
    console.log('\n[4/4] Migrating summary_sources...');

    const ssResult = await client.query(`
      INSERT INTO ros_summary_sources (summary_id, message_id, ordinal)
      SELECT sm2.new_id, mm.new_id, smsg.ordinal
      FROM summary_messages smsg
      JOIN _sum_map sm2 ON sm2.old_id = smsg.summary_id
      JOIN _msg_map mm ON mm.old_id = smsg.message_id
      ON CONFLICT DO NOTHING
    `);
    console.log(`  Migrated ${ssResult.rowCount} summary_source links`);

    await client.query('COMMIT');

    // --- Destination counts ---
    console.log('\n--- Destination (ros_*) AFTER ---');
    await printCount(client, 'ros_conversations');
    await printCount(client, 'ros_messages');
    await printCount(client, 'ros_summaries');
    await printCount(client, 'ros_summary_sources');

    console.log('\n✅ Migration complete!');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('\n❌ Migration failed (rolled back):', err);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function countTable(
  client: pg.PoolClient,
  table: string,
): Promise<number> {
  const res = await client.query(`SELECT count(*) AS n FROM ${table}`);
  return parseInt(res.rows[0].n, 10);
}

async function printCount(
  client: pg.PoolClient,
  table: string,
): Promise<void> {
  const n = await countTable(client, table);
  console.log(`  ${table.padEnd(22)} ${n.toLocaleString()}`);
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

migrate();
