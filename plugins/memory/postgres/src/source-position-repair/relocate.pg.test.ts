import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { conversationStateHash } from './hash.ts'
import { derivedCaptureEventId, derivedIngestEventId, sourceOrdinal } from './ordinal.ts'
import type { SourcePositionRepairPlan } from './plan.ts'
import { relocateSourcePositions } from './relocate.ts'

const PG_URL = process.env.RIVETOS_PG_URL ?? ''
const SCHEMA = `src_pos_repair_${String(process.pid)}`

const CONV = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'
const MSG_A = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1'
const MSG_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2'
const MSG_C = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb3'
const MSG_D = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb4'
const SESSION = 'synth-repair-session'
const AGENT = 'synth-repair-agent'

const SCRATCH_DDL = `
CREATE TABLE ros_conversations (
    id UUID PRIMARY KEY,
    session_key TEXT NOT NULL,
    agent TEXT NOT NULL,
    channel TEXT NOT NULL DEFAULT 'unknown',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX ux_ros_conversations_session_agent ON ros_conversations (session_key, agent);
CREATE TABLE ros_messages (
    id UUID PRIMARY KEY,
    conversation_id UUID NOT NULL REFERENCES ros_conversations(id) ON DELETE CASCADE,
    agent TEXT NOT NULL,
    channel TEXT NOT NULL DEFAULT 'unknown',
    role TEXT NOT NULL,
    content TEXT NOT NULL DEFAULT '',
    tool_name TEXT,
    tool_args JSONB,
    tool_result TEXT,
    metadata JSONB DEFAULT '{}'::jsonb,
    access_count INTEGER DEFAULT 0,
    last_accessed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    content_tsv tsvector GENERATED ALWAYS AS (
      to_tsvector('english', left(coalesce(content, ''), 300000) || ' ' || left(coalesce(tool_result, ''), 32768))
    ) STORED
);
CREATE INDEX idx_ros_messages_conversation ON ros_messages (conversation_id);
CREATE TABLE ros_message_chunks (
    id UUID PRIMARY KEY,
    message_id UUID NOT NULL REFERENCES ros_messages(id) ON DELETE CASCADE,
    idx INT NOT NULL,
    char_start INT NOT NULL,
    char_end INT NOT NULL,
    content TEXT NOT NULL,
    UNIQUE (message_id, idx)
);
CREATE TABLE ros_summaries (
    id UUID PRIMARY KEY,
    conversation_id UUID REFERENCES ros_conversations(id),
    content TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE ros_summary_sources (
    summary_id UUID NOT NULL REFERENCES ros_summaries(id) ON DELETE CASCADE,
    message_id UUID NOT NULL REFERENCES ros_messages(id) ON DELETE RESTRICT,
    ordinal INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (summary_id, message_id)
);
`

describe.skipIf(PG_URL === '')('source position relocate (real Postgres)', () => {
  let pool: pg.Pool
  let tmp: string

  const withSearchPath = async (client: pg.PoolClient): Promise<void> => {
    await client.query(`SET search_path = ${SCHEMA}`)
  }

  const loadRows = async () => {
    const result = await pool.query(
      `SELECT id, conversation_id, role, content, tool_name, tool_args, tool_result,
              created_at, access_count, metadata
         FROM ${SCHEMA}.ros_messages
        ORDER BY id`,
    )
    return result.rows.map((row) => ({
      ...row,
      metadata: row.metadata as Record<string, unknown>,
    }))
  }

  const eventId = (content: string, ordinal: number, role = 'user') =>
    derivedCaptureEventId({
      sessionKey: SESSION,
      role,
      content,
      ordinal,
    })

  const insertMessage = async (opts: {
    id: string
    content: string
    position: number
    sub?: number
    createdAt: string
    role?: string
    toolName?: string
    toolResult?: string
    sourceId?: string
    accessCount?: number
    eventId?: string
    jsonlPath?: string
    jsonlLine?: number
  }) => {
    const sub = opts.sub ?? 0
    const ordinal = sourceOrdinal(opts.position, sub)
    const eid = opts.eventId ?? eventId(opts.content, ordinal, opts.role ?? 'user')
    await pool.query(
      `INSERT INTO ${SCHEMA}.ros_messages
        (id, conversation_id, agent, channel, role, content, tool_name, tool_result, metadata, created_at, access_count)
       VALUES ($1,$2,$3,'synth',$4,$5,$6,$7,$8::jsonb,$9,$10)`,
      [
        opts.id,
        CONV,
        AGENT,
        opts.role ?? 'user',
        opts.content,
        opts.toolName ?? null,
        opts.toolResult ?? null,
        JSON.stringify({
          capture_source: 'synth-capture',
          position: opts.position,
          ordinal,
          event_id: eid,
          ...(opts.sourceId ? { source_id: opts.sourceId } : {}),
          ...(opts.jsonlPath
            ? { session_jsonl_path: opts.jsonlPath, session_jsonl_line: opts.jsonlLine }
            : {}),
        }),
        opts.createdAt,
        opts.accessCount ?? 0,
      ],
    )
  }

  const planFor = async (
    relocations: SourcePositionRepairPlan['relocations'],
  ): Promise<SourcePositionRepairPlan> => {
    const rows = await loadRows()
    return {
      schemaVersion: 1,
      conversationId: CONV,
      sessionKey: SESSION,
      agent: AGENT,
      provenanceRef: 'synth-evidence-ref',
      expectedStateHash: conversationStateHash(rows),
      relocations,
    }
  }

  const relocation = (
    id: string,
    fromPosition: number,
    toPosition: number,
    content: string,
    sub = 0,
  ) => {
    const fromOrdinal = sourceOrdinal(fromPosition, sub)
    return {
      messageId: id,
      from: {
        position: fromPosition,
        ordinal: fromOrdinal,
        eventId: eventId(content, fromOrdinal),
        captureSource: 'synth-capture',
      },
      to: { position: toPosition },
    }
  }

  const repairPool = (): pg.Pool =>
    ({
      connect: async () => {
        const client = await pool.connect()
        await client.query(`SET search_path = ${SCHEMA}`)
        return client
      },
    }) as unknown as pg.Pool

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: PG_URL, max: 6 })
    tmp = mkdtempSync(join(tmpdir(), 'src-pos-repair-'))
    const client = await pool.connect()
    try {
      await client.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`)
      await client.query(`CREATE SCHEMA ${SCHEMA}`)
      await client.query(`SET search_path = ${SCHEMA}`)
      await client.query(SCRATCH_DDL)
    } finally {
      client.release()
    }
  }, 60_000)

  afterAll(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`)
    await pool.end()
    rmSync(tmp, { recursive: true, force: true })
  }, 60_000)

  beforeEach(async () => {
    const client = await pool.connect()
    try {
      await withSearchPath(client)
      await client.query(
        'TRUNCATE ros_summary_sources, ros_summaries, ros_message_chunks, ros_messages, ros_conversations CASCADE',
      )
      await client.query(
        `INSERT INTO ros_conversations (id, session_key, agent, channel) VALUES ($1,$2,$3,'synth')`,
        [CONV, SESSION, AGENT],
      )
    } finally {
      client.release()
    }
  })

  it('dry-run reports the move and writes nothing', async () => {
    await insertMessage({
      id: MSG_A,
      content: 'alpha',
      position: 4,
      createdAt: '2026-01-01T00:00:04.000Z',
    })
    await insertMessage({
      id: MSG_B,
      content: 'beta',
      position: 9,
      createdAt: '2026-01-01T00:00:09.000Z',
    })
    const plan = await planFor([relocation(MSG_A, 4, 2, 'alpha')])
    const before = await loadRows()
    const outcome = await relocateSourcePositions(repairPool(), plan, { kind: 'dry-run' })
    expect(outcome.kind).toBe('dry-run')
    expect(outcome.report.datesRepaired).toBe(false)
    expect(outcome.report.moves[0]).toMatchObject({
      messageId: MSG_A,
      fromPosition: 4,
      toPosition: 2,
      toOrdinal: sourceOrdinal(2, 0),
      eventIdRewritten: true,
    })
    expect(await loadRows()).toEqual(before)
  })

  it('relocates one row, recomputes ordinal and event_id, and preserves uuid/content/chunks/fts/access', async () => {
    await insertMessage({
      id: MSG_A,
      content: 'alpha',
      position: 4,
      createdAt: '2026-01-01T00:00:02.000Z',
      accessCount: 7,
      sourceId: 'readtranscript:slug:4:0',
      jsonlPath: 'synth/updates.jsonl',
      jsonlLine: 4,
    })
    await insertMessage({
      id: MSG_B,
      content: 'beta',
      position: 9,
      createdAt: '2026-01-01T00:00:09.000Z',
    })
    await pool.query(
      `INSERT INTO ${SCHEMA}.ros_message_chunks (id, message_id, idx, char_start, char_end, content)
       VALUES ('cccccccc-cccc-4ccc-8ccc-ccccccccccc1', $1, 0, 0, 5, 'alpha-chunk')`,
      [MSG_A],
    )
    const tsvBefore = await pool.query<{ content_tsv: string }>(
      `SELECT content_tsv::text AS content_tsv FROM ${SCHEMA}.ros_messages WHERE id = $1`,
      [MSG_A],
    )
    const plan = await planFor([relocation(MSG_A, 4, 2, 'alpha')])
    const backupPath = join(tmp, 'simple.json')
    const outcome = await relocateSourcePositions(repairPool(), plan, { kind: 'apply', backupPath })
    expect(outcome.kind).toBe('applied')
    const row = (await loadRows()).find((item) => item.id === MSG_A)
    expect(row?.content).toBe('alpha')
    expect(row?.access_count).toBe(7)
    expect(row?.metadata).toMatchObject({
      position: 2,
      ordinal: sourceOrdinal(2, 0),
      event_id: eventId('alpha', sourceOrdinal(2, 0)),
      source_id: 'readtranscript:slug:2:0',
      session_jsonl_path: 'synth/updates.jsonl',
      session_jsonl_line: 4,
    })
    const tsvAfter = await pool.query<{ content_tsv: string }>(
      `SELECT content_tsv::text AS content_tsv FROM ${SCHEMA}.ros_messages WHERE id = $1`,
      [MSG_A],
    )
    expect(tsvAfter.rows[0].content_tsv).toBe(tsvBefore.rows[0].content_tsv)
    const chunk = await pool.query(
      `SELECT id, content FROM ${SCHEMA}.ros_message_chunks WHERE message_id = $1`,
      [MSG_A],
    )
    expect(chunk.rows[0]).toEqual({
      id: 'cccccccc-cccc-4ccc-8ccc-ccccccccccc1',
      content: 'alpha-chunk',
    })
    const backup = JSON.parse(readFileSync(backupPath, 'utf8')) as { before: Array<{ id: string }> }
    expect(backup.before[0].id).toBe(MSG_A)
    const rerun = await relocateSourcePositions(repairPool(), plan, {
      kind: 'apply',
      backupPath: join(tmp, 'simple-rerun.json'),
    })
    expect(rerun.kind).toBe('already-applied')
  })

  it('moves a dependency chain without inventing sessions', async () => {
    await insertMessage({
      id: MSG_A,
      content: 'a',
      position: 1,
      createdAt: '2026-01-01T00:00:03.000Z',
    })
    await insertMessage({
      id: MSG_B,
      content: 'b',
      position: 2,
      createdAt: '2026-01-01T00:00:04.000Z',
    })
    await insertMessage({
      id: MSG_C,
      content: 'c',
      position: 3,
      createdAt: '2026-01-01T00:00:05.000Z',
    })
    const plan = await planFor([
      relocation(MSG_A, 1, 2, 'a'),
      relocation(MSG_B, 2, 3, 'b'),
      relocation(MSG_C, 3, 4, 'c'),
    ])
    await relocateSourcePositions(repairPool(), plan, { kind: 'apply', backupPath: join(tmp, 'chain.json') })
    const rows = await loadRows()
    expect(rows.map((row) => [row.id, row.metadata.position])).toEqual([
      [MSG_A, 2],
      [MSG_B, 3],
      [MSG_C, 4],
    ])
  })

  it('rejects duplicate targets, occupied targets, and repeated-content auto-mapping', async () => {
    await insertMessage({
      id: MSG_A,
      content: 'same-text',
      position: 1,
      createdAt: '2026-01-01T00:00:01.000Z',
    })
    await insertMessage({
      id: MSG_B,
      content: 'same-text',
      position: 2,
      createdAt: '2026-01-01T00:00:02.000Z',
    })
    await insertMessage({
      id: MSG_C,
      content: 'held',
      position: 8,
      createdAt: '2026-01-01T00:00:08.000Z',
    })
    const dup = await planFor([relocation(MSG_A, 1, 5, 'same-text'), relocation(MSG_B, 2, 5, 'same-text')])
    await expect(relocateSourcePositions(repairPool(), dup, { kind: 'dry-run' })).rejects.toMatchObject({
      code: 'duplicate_target',
    })
    const occupied = await planFor([relocation(MSG_A, 1, 8, 'same-text')])
    await expect(
      relocateSourcePositions(repairPool(), occupied, { kind: 'dry-run' }),
    ).rejects.toMatchObject({ code: 'occupied_target' })
    const mixed = await planFor([relocation(MSG_A, 1, 3, 'same-text')])
    mixed.relocations.push({
      ...relocation(MSG_A, 1, 6, 'same-text'),
    })
    await expect(relocateSourcePositions(repairPool(), mixed, { kind: 'dry-run' })).rejects.toMatchObject({
      code: 'duplicate_message',
    })
  })

  it('rejects a stale hash and a cross-conversation id', async () => {
    await insertMessage({
      id: MSG_A,
      content: 'alpha',
      position: 4,
      createdAt: '2026-01-01T00:00:04.000Z',
    })
    const plan = await planFor([relocation(MSG_A, 4, 1, 'alpha')])
    plan.expectedStateHash = 'cd'.repeat(32)
    await expect(relocateSourcePositions(repairPool(), plan, { kind: 'dry-run' })).rejects.toMatchObject({
      code: 'stale_hash',
    })
    const cross = await planFor([relocation(MSG_A, 4, 1, 'alpha')])
    cross.conversationId = 'dddddddd-dddd-4ddd-8ddd-ddddddddddd1'
    await expect(relocateSourcePositions(repairPool(), cross, { kind: 'dry-run' })).rejects.toMatchObject({
      code: 'missing_row',
    })
  })

  it('rejects destination order that would invert created_at browse order', async () => {
    await insertMessage({
      id: MSG_A,
      content: 'later-text',
      position: 8,
      createdAt: '2026-01-01T00:00:08.000Z',
    })
    await insertMessage({
      id: MSG_B,
      content: 'earlier-text',
      position: 2,
      createdAt: '2026-01-01T00:00:02.000Z',
    })
    const plan = await planFor([relocation(MSG_A, 8, 1, 'later-text')])
    await expect(relocateSourcePositions(repairPool(), plan, { kind: 'dry-run' })).rejects.toMatchObject({
      code: 'timestamp_order',
    })
  })

  it('rejects splitting a multi-sub source entry', async () => {
    await insertMessage({
      id: MSG_A,
      content: 'call',
      position: 5,
      sub: 0,
      createdAt: '2026-01-01T00:00:05.000Z',
      role: 'assistant',
    })
    await insertMessage({
      id: MSG_B,
      content: 'result',
      position: 5,
      sub: 1,
      createdAt: '2026-01-01T00:00:05.100Z',
      role: 'tool',
    })
    const plan = await planFor([
      {
        messageId: MSG_A,
        from: {
          position: 5,
          ordinal: sourceOrdinal(5, 0),
          eventId: eventId('call', sourceOrdinal(5, 0), 'assistant'),
          captureSource: 'synth-capture',
        },
        to: { position: 7 },
      },
    ])
    await expect(relocateSourcePositions(repairPool(), plan, { kind: 'dry-run' })).rejects.toMatchObject({
      code: 'split_entry',
    })
    const together = await planFor([
      {
        messageId: MSG_A,
        from: {
          position: 5,
          ordinal: sourceOrdinal(5, 0),
          eventId: eventId('call', sourceOrdinal(5, 0), 'assistant'),
          captureSource: 'synth-capture',
        },
        to: { position: 7 },
      },
      {
        messageId: MSG_B,
        from: {
          position: 5,
          ordinal: sourceOrdinal(5, 1),
          eventId: eventId('result', sourceOrdinal(5, 1), 'tool'),
          captureSource: 'synth-capture',
        },
        to: { position: 7 },
      },
    ])
    const moved = await relocateSourcePositions(repairPool(), together, { kind: 'dry-run' })
    expect(moved.report.moves.map((item) => item.toPosition)).toEqual([7, 7])
  })

  it('rejects moving one sibling of a multi-sub entry onto an occupied destination', async () => {
    await insertMessage({
      id: MSG_A,
      content: 'call',
      position: 5,
      sub: 0,
      createdAt: '2026-01-01T00:00:05.000Z',
      role: 'assistant',
    })
    await insertMessage({
      id: MSG_B,
      content: 'result',
      position: 5,
      sub: 1,
      createdAt: '2026-01-01T00:00:05.100Z',
      role: 'tool',
    })
    await insertMessage({
      id: MSG_C,
      content: 'held',
      position: 7,
      createdAt: '2026-01-01T00:00:07.000Z',
    })
    const plan = await planFor([
      {
        messageId: MSG_A,
        from: {
          position: 5,
          ordinal: sourceOrdinal(5, 0),
          eventId: eventId('call', sourceOrdinal(5, 0), 'assistant'),
          captureSource: 'synth-capture',
        },
        to: { position: 7 },
      },
    ])
    await expect(relocateSourcePositions(repairPool(), plan, { kind: 'dry-run' })).rejects.toMatchObject({
      code: 'split_entry',
    })
  })

  it('keeps a hook-native event_id and still recomputes ordinal', async () => {
    await insertMessage({
      id: MSG_A,
      content: 'alpha',
      position: 4,
      createdAt: '2026-01-01T00:00:02.000Z',
      eventId: 'hook-native-evt-1',
    })
    await insertMessage({
      id: MSG_B,
      content: 'beta',
      position: 9,
      createdAt: '2026-01-01T00:00:09.000Z',
    })
    const plan = await planFor([
      {
        messageId: MSG_A,
        from: {
          position: 4,
          ordinal: sourceOrdinal(4, 0),
          eventId: 'hook-native-evt-1',
          captureSource: 'synth-capture',
        },
        to: { position: 2 },
      },
    ])
    await relocateSourcePositions(repairPool(), plan, {
      kind: 'apply',
      backupPath: join(tmp, 'native.json'),
    })
    const row = (await loadRows()).find((item) => item.id === MSG_A)
    expect(row?.metadata).toMatchObject({
      position: 2,
      ordinal: sourceOrdinal(2, 0),
      event_id: 'hook-native-evt-1',
    })
  })

  it('recomputes ingestEventId when that is the stored occurrence id', async () => {
    const fromOrdinal = sourceOrdinal(4, 0)
    const toOrdinal = sourceOrdinal(2, 0)
    const fromId = derivedIngestEventId({
      sessionId: SESSION,
      agent: AGENT,
      role: 'user',
      content: 'alpha',
      ordinal: fromOrdinal,
    })
    await insertMessage({
      id: MSG_A,
      content: 'alpha',
      position: 4,
      createdAt: '2026-01-01T00:00:02.000Z',
      eventId: fromId,
    })
    await insertMessage({
      id: MSG_B,
      content: 'beta',
      position: 9,
      createdAt: '2026-01-01T00:00:09.000Z',
    })
    const plan = await planFor([
      {
        messageId: MSG_A,
        from: {
          position: 4,
          ordinal: fromOrdinal,
          eventId: fromId,
          captureSource: 'synth-capture',
        },
        to: { position: 2 },
      },
    ])
    await relocateSourcePositions(repairPool(), plan, {
      kind: 'apply',
      backupPath: join(tmp, 'ingest-id.json'),
    })
    const row = (await loadRows()).find((item) => item.id === MSG_A)
    expect(row?.metadata.event_id).toBe(
      derivedIngestEventId({
        sessionId: SESSION,
        agent: AGENT,
        role: 'user',
        content: 'alpha',
        ordinal: toOrdinal,
      }),
    )
    expect(row?.metadata.event_id).not.toBe(fromId)
  })

  it('maps by row UUID when the same source_id string exists twice', async () => {
    await insertMessage({
      id: MSG_A,
      content: 'alpha',
      position: 4,
      createdAt: '2026-01-01T00:00:04.000Z',
      sourceId: 'shared-source-id',
    })
    await insertMessage({
      id: MSG_B,
      content: 'beta',
      position: 9,
      createdAt: '2026-01-01T00:00:09.000Z',
      sourceId: 'shared-source-id',
    })
    const plan = await planFor([
      {
        messageId: MSG_A,
        from: {
          position: 4,
          ordinal: sourceOrdinal(4, 0),
          eventId: eventId('alpha', sourceOrdinal(4, 0)),
          captureSource: 'synth-capture',
          sourceId: 'shared-source-id',
        },
        to: { position: 2 },
      },
    ])
    await relocateSourcePositions(repairPool(), plan, {
      kind: 'apply',
      backupPath: join(tmp, 'collision.json'),
    })
    const rows = await loadRows()
    expect(rows.find((item) => item.id === MSG_A)?.metadata.position).toBe(2)
    expect(rows.find((item) => item.id === MSG_B)?.metadata).toMatchObject({
      position: 9,
      source_id: 'shared-source-id',
    })
  })

  it('rejects a mixed already-applied and pending plan', async () => {
    await insertMessage({
      id: MSG_A,
      content: 'alpha',
      position: 4,
      createdAt: '2026-01-01T00:00:02.000Z',
    })
    await insertMessage({
      id: MSG_B,
      content: 'beta',
      position: 9,
      createdAt: '2026-01-01T00:00:09.000Z',
    })
    const first = await planFor([relocation(MSG_A, 4, 2, 'alpha')])
    await relocateSourcePositions(repairPool(), first, {
      kind: 'apply',
      backupPath: join(tmp, 'partial.json'),
    })
    const mixed = await planFor([relocation(MSG_A, 4, 2, 'alpha'), relocation(MSG_B, 9, 10, 'beta')])
    mixed.relocations[0].from = {
      position: 4,
      ordinal: sourceOrdinal(4, 0),
      eventId: eventId('alpha', sourceOrdinal(4, 0)),
      captureSource: 'synth-capture',
    }
    await expect(relocateSourcePositions(repairPool(), mixed, { kind: 'dry-run' })).rejects.toMatchObject({
      code: 'ambiguous',
    })
  })

  it('rejects a summary whose source ordinals are not created_at-contiguous', async () => {
    await insertMessage({
      id: MSG_A,
      content: 'first',
      position: 1,
      createdAt: '2026-01-01T00:00:01.000Z',
    })
    await insertMessage({
      id: MSG_B,
      content: 'second',
      position: 2,
      createdAt: '2026-01-01T00:00:02.000Z',
    })
    await pool.query(
      `INSERT INTO ${SCHEMA}.ros_summaries (id, conversation_id, content)
       VALUES ('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1', $1, 'leaf')`,
      [CONV],
    )
    await pool.query(
      `INSERT INTO ${SCHEMA}.ros_summary_sources (summary_id, message_id, ordinal) VALUES
       ('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1', $1, 0),
       ('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1', $2, 1)`,
      [MSG_B, MSG_A],
    )
    const plan = await planFor([relocation(MSG_B, 2, 3, 'second')])
    await expect(relocateSourcePositions(repairPool(), plan, { kind: 'dry-run' })).rejects.toMatchObject({
      code: 'summary_contiguity',
    })
  })

  it('rolls back when the backup cannot persist', async () => {
    await insertMessage({
      id: MSG_A,
      content: 'alpha',
      position: 4,
      createdAt: '2026-01-01T00:00:02.000Z',
    })
    await insertMessage({
      id: MSG_B,
      content: 'beta',
      position: 9,
      createdAt: '2026-01-01T00:00:09.000Z',
    })
    const plan = await planFor([relocation(MSG_A, 4, 2, 'alpha')])
    await expect(
      relocateSourcePositions(repairPool(), plan, {
        kind: 'apply',
        backupPath: join(tmp, 'missing-dir', 'nope.json'),
      }),
    ).rejects.toMatchObject({ code: 'backup_failed' })
    const row = (await loadRows()).find((item) => item.id === MSG_A)
    expect(row?.metadata.position).toBe(4)
  })

  it('does not overwrite an existing backup after a crash leftover', async () => {
    await insertMessage({
      id: MSG_A,
      content: 'alpha',
      position: 4,
      createdAt: '2026-01-01T00:00:02.000Z',
    })
    await insertMessage({
      id: MSG_B,
      content: 'beta',
      position: 9,
      createdAt: '2026-01-01T00:00:09.000Z',
    })
    const backupPath = join(tmp, 'leftover.json')
    writeFileSync(backupPath, '{"leftover":true}\n')
    const plan = await planFor([relocation(MSG_A, 4, 2, 'alpha')])
    await expect(
      relocateSourcePositions(repairPool(), plan, { kind: 'apply', backupPath }),
    ).rejects.toMatchObject({ code: 'backup_failed' })
    expect(readFileSync(backupPath, 'utf8')).toBe('{"leftover":true}\n')
    expect((await loadRows()).find((item) => item.id === MSG_A)?.metadata.position).toBe(4)
  })

  it('restores source metadata from the apply backup without changing uuid or content', async () => {
    await insertMessage({
      id: MSG_A,
      content: 'alpha',
      position: 4,
      createdAt: '2026-01-01T00:00:02.000Z',
      accessCount: 7,
      sourceId: 'readtranscript:slug:4:0',
      jsonlPath: 'synth/updates.jsonl',
      jsonlLine: 4,
    })
    await insertMessage({
      id: MSG_B,
      content: 'beta',
      position: 9,
      createdAt: '2026-01-01T00:00:09.000Z',
    })
    const before = await loadRows()
    const plan = await planFor([relocation(MSG_A, 4, 2, 'alpha')])
    const backupPath = join(tmp, 'restore.json')
    await relocateSourcePositions(repairPool(), plan, { kind: 'apply', backupPath })
    expect((await loadRows()).find((item) => item.id === MSG_A)?.metadata.position).toBe(2)
    const backup = JSON.parse(readFileSync(backupPath, 'utf8')) as {
      before: Array<{ id: string; metadata: Record<string, unknown>; created_at: string }>
    }
    expect(backup.before.map((row) => row.id)).toEqual([MSG_A])
    for (const row of backup.before) {
      await pool.query(`UPDATE ${SCHEMA}.ros_messages SET metadata = $2::jsonb WHERE id = $1`, [
        row.id,
        JSON.stringify(row.metadata),
      ])
    }
    const restored = await loadRows()
    const beforeA = before.find((item) => item.id === MSG_A)
    const restoredA = restored.find((item) => item.id === MSG_A)
    expect(restoredA?.id).toBe(MSG_A)
    expect(restoredA?.content).toBe('alpha')
    expect(restoredA?.access_count).toBe(7)
    expect(restoredA?.created_at.toISOString()).toBe(beforeA?.created_at.toISOString())
    expect(restoredA?.metadata).toEqual(beforeA?.metadata)
    expect(restored.find((item) => item.id === MSG_B)?.metadata).toEqual(
      before.find((item) => item.id === MSG_B)?.metadata,
    )
  })

  it('blocks a competing capture-style insert behind the session advisory lock', async () => {
    await insertMessage({
      id: MSG_A,
      content: 'alpha',
      position: 4,
      createdAt: '2026-01-01T00:00:02.000Z',
    })
    await insertMessage({
      id: MSG_B,
      content: 'beta',
      position: 9,
      createdAt: '2026-01-01T00:00:09.000Z',
    })
    const plan = await planFor([relocation(MSG_A, 4, 2, 'alpha')])
    const relocator = await pool.connect()
    const writer = await pool.connect()
    try {
      await relocator.query(`SET search_path = ${SCHEMA}`)
      await relocator.query('BEGIN ISOLATION LEVEL SERIALIZABLE')
      await relocator.query('SELECT pg_advisory_xact_lock(hashtext($1))', [SESSION])
      await writer.query(`SET search_path = ${SCHEMA}`)
      await writer.query(`SET lock_timeout = '500ms'`)
      await writer.query('BEGIN')
      await expect(
        writer.query('SELECT pg_advisory_xact_lock(hashtext($1))', [SESSION]),
      ).rejects.toMatchObject({ code: '55P03' })
      await writer.query('ROLLBACK').catch(() => {})
      await relocator.query('ROLLBACK')
    } finally {
      relocator.release()
      writer.release()
    }
    const outcome = await relocateSourcePositions(repairPool(), plan, {
      kind: 'apply',
      backupPath: join(tmp, 'lock.json'),
    })
    expect(outcome.kind).toBe('applied')
  })

  it('aborts apply against an ordinary INSERT, then applies all-or-none and reapplies idempotently', async () => {
    await insertMessage({
      id: MSG_A,
      content: 'alpha',
      position: 4,
      createdAt: '2026-01-01T00:00:02.000Z',
    })
    await insertMessage({
      id: MSG_B,
      content: 'beta',
      position: 9,
      createdAt: '2026-01-01T00:00:09.000Z',
    })
    const plan = await planFor([relocation(MSG_A, 4, 2, 'alpha')])
    const backupPath = join(tmp, 'race.json')
    const writer = await pool.connect()
    const timedPool = (): pg.Pool =>
      ({
        connect: async () => {
          const client = await pool.connect()
          await client.query(`SET search_path = ${SCHEMA}`)
          await client.query(`SET lock_timeout = '500ms'`)
          return client
        },
      }) as unknown as pg.Pool
    try {
      await writer.query(`SET search_path = ${SCHEMA}`)
      await writer.query('BEGIN')
      await writer.query(
        `INSERT INTO ros_messages (id, conversation_id, agent, channel, role, content, metadata, created_at)
         VALUES ($1,$2,$3,'synth','user','sneak','{}','2026-01-01T00:00:03.000Z')`,
        [MSG_D, CONV, AGENT],
      )
      await expect(
        relocateSourcePositions(timedPool(), plan, { kind: 'apply', backupPath }),
      ).rejects.toMatchObject({ code: 'concurrent_insert' })
      expect((await loadRows()).find((item) => item.id === MSG_A)?.metadata.position).toBe(4)
      expect(existsSync(backupPath)).toBe(false)
      await writer.query('ROLLBACK')
    } finally {
      writer.release()
    }
    const applied = await relocateSourcePositions(repairPool(), plan, {
      kind: 'apply',
      backupPath: join(tmp, 'race-apply.json'),
    })
    expect(applied.kind).toBe('applied')
    expect((await loadRows()).find((item) => item.id === MSG_A)?.metadata.position).toBe(2)
    const again = await relocateSourcePositions(repairPool(), plan, {
      kind: 'apply',
      backupPath: join(tmp, 'race-reapply.json'),
    })
    expect(again.kind).toBe('already-applied')
    expect((await loadRows()).map((row) => row.id).sort()).toEqual([MSG_A, MSG_B].sort())
  })
})

describe.skipIf(PG_URL === '')('source position relocate (ros_* views over rh_* tables)', () => {
  const ADOPT = `src_pos_adopt_${String(process.pid)}`
  let pool: pg.Pool
  let tmp: string

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: PG_URL, max: 4 })
    tmp = mkdtempSync(join(tmpdir(), 'src-pos-adopt-'))
    const client = await pool.connect()
    try {
      await client.query(`DROP SCHEMA IF EXISTS ${ADOPT} CASCADE`)
      await client.query(`CREATE SCHEMA ${ADOPT}`)
      await client.query(`SET search_path = ${ADOPT}`)
      await client.query(`
        CREATE TABLE rh_conversations (
          id UUID PRIMARY KEY,
          session_key TEXT NOT NULL,
          agent TEXT NOT NULL,
          channel TEXT NOT NULL DEFAULT 'unknown',
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE TABLE rh_messages (
          id UUID PRIMARY KEY,
          conversation_id UUID NOT NULL REFERENCES rh_conversations(id) ON DELETE CASCADE,
          agent TEXT NOT NULL,
          channel TEXT NOT NULL DEFAULT 'unknown',
          role TEXT NOT NULL,
          content TEXT NOT NULL DEFAULT '',
          tool_name TEXT,
          tool_args JSONB,
          tool_result TEXT,
          metadata JSONB DEFAULT '{}'::jsonb,
          access_count INTEGER DEFAULT 0,
          last_accessed_at TIMESTAMPTZ,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          content_tsv tsvector GENERATED ALWAYS AS (
            to_tsvector('english', left(coalesce(content, ''), 300000) || ' ' || left(coalesce(tool_result, ''), 32768))
          ) STORED
        );
        CREATE TABLE rh_message_chunks (
          id UUID PRIMARY KEY,
          message_id UUID NOT NULL REFERENCES rh_messages(id) ON DELETE CASCADE,
          idx INT NOT NULL,
          char_start INT NOT NULL,
          char_end INT NOT NULL,
          content TEXT NOT NULL
        );
        CREATE TABLE rh_summaries (
          id UUID PRIMARY KEY,
          conversation_id UUID REFERENCES rh_conversations(id),
          content TEXT NOT NULL
        );
        CREATE TABLE rh_summary_sources (
          summary_id UUID NOT NULL REFERENCES rh_summaries(id) ON DELETE CASCADE,
          message_id UUID NOT NULL REFERENCES rh_messages(id) ON DELETE RESTRICT,
          ordinal INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (summary_id, message_id)
        );
        CREATE TABLE rh_embed_log (op TEXT NOT NULL, id UUID NOT NULL);
        CREATE FUNCTION rh_log_embed() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          INSERT INTO rh_embed_log VALUES (TG_OP, NEW.id);
          RETURN NEW;
        END $$;
        CREATE TRIGGER trg_embed_message AFTER INSERT ON rh_messages
          FOR EACH ROW EXECUTE FUNCTION rh_log_embed();
        CREATE VIEW ros_conversations AS SELECT * FROM rh_conversations;
        CREATE VIEW ros_messages AS SELECT * FROM rh_messages;
        CREATE VIEW ros_message_chunks AS SELECT * FROM rh_message_chunks;
        CREATE VIEW ros_summaries AS SELECT * FROM rh_summaries;
        CREATE VIEW ros_summary_sources AS SELECT * FROM rh_summary_sources;
      `)
    } finally {
      client.release()
    }
  }, 60_000)

  afterAll(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS ${ADOPT} CASCADE`)
    await pool.end()
    rmSync(tmp, { recursive: true, force: true })
  }, 60_000)

  it('updates through auto-updatable views without firing INSERT triggers or dropping chunk FKs', async () => {
    const client = await pool.connect()
    try {
      await client.query(`SET search_path = ${ADOPT}`)
      await client.query(
        `INSERT INTO ros_conversations (id, session_key, agent, channel) VALUES ($1,$2,$3,'synth')`,
        [CONV, SESSION, AGENT],
      )
      const ordinal = sourceOrdinal(4, 0)
      const eid = derivedCaptureEventId({
        sessionKey: SESSION,
        role: 'user',
        content: 'alpha',
        ordinal,
      })
      await client.query(
        `INSERT INTO ros_messages
          (id, conversation_id, agent, channel, role, content, metadata, created_at, access_count)
         VALUES ($1,$2,$3,'synth','user','alpha',$4::jsonb,'2026-01-01T00:00:02.000Z',3)`,
        [
          MSG_A,
          CONV,
          AGENT,
          JSON.stringify({
            capture_source: 'synth-capture',
            position: 4,
            ordinal,
            event_id: eid,
          }),
        ],
      )
      await client.query(
        `INSERT INTO ros_messages
          (id, conversation_id, agent, channel, role, content, metadata, created_at)
         VALUES ($1,$2,$3,'synth','user','beta',$4::jsonb,'2026-01-01T00:00:09.000Z')`,
        [
          MSG_B,
          CONV,
          AGENT,
          JSON.stringify({
            capture_source: 'synth-capture',
            position: 9,
            ordinal: sourceOrdinal(9, 0),
            event_id: derivedCaptureEventId({
              sessionKey: SESSION,
              role: 'user',
              content: 'beta',
              ordinal: sourceOrdinal(9, 0),
            }),
          }),
        ],
      )
      await client.query(
        `INSERT INTO ros_message_chunks (id, message_id, idx, char_start, char_end, content)
         VALUES ('cccccccc-cccc-4ccc-8ccc-ccccccccccc1', $1, 0, 0, 5, 'alpha-chunk')`,
        [MSG_A],
      )
    } finally {
      client.release()
    }
    const rows = (
      await pool.query(
        `SELECT id, conversation_id, role, content, tool_name, tool_args, tool_result,
                created_at, access_count, metadata
           FROM ${ADOPT}.ros_messages ORDER BY id`,
      )
    ).rows.map((row) => ({ ...row, metadata: row.metadata as Record<string, unknown> }))
    const plan: SourcePositionRepairPlan = {
      schemaVersion: 1,
      conversationId: CONV,
      sessionKey: SESSION,
      agent: AGENT,
      provenanceRef: 'synth-evidence-ref',
      expectedStateHash: conversationStateHash(rows),
      relocations: [
        {
          messageId: MSG_A,
          from: {
            position: 4,
            ordinal: sourceOrdinal(4, 0),
            eventId: derivedCaptureEventId({
              sessionKey: SESSION,
              role: 'user',
              content: 'alpha',
              ordinal: sourceOrdinal(4, 0),
            }),
            captureSource: 'synth-capture',
          },
          to: { position: 2 },
        },
      ],
    }
    const adoptPool = (): pg.Pool =>
      ({
        connect: async () => {
          const c = await pool.connect()
          await c.query(`SET search_path = ${ADOPT}`)
          return c
        },
      }) as unknown as pg.Pool
    const tsvBefore = await pool.query<{ content_tsv: string }>(
      `SELECT content_tsv::text AS content_tsv FROM ${ADOPT}.rh_messages WHERE id = $1`,
      [MSG_A],
    )
    await relocateSourcePositions(adoptPool(), plan, {
      kind: 'apply',
      backupPath: join(tmp, 'adopt.json'),
    })
    const base = await pool.query(
      `SELECT id, content, access_count, metadata FROM ${ADOPT}.rh_messages WHERE id = $1`,
      [MSG_A],
    )
    expect(base.rows[0].content).toBe('alpha')
    expect(base.rows[0].access_count).toBe(3)
    expect(base.rows[0].metadata).toMatchObject({
      position: 2,
      ordinal: sourceOrdinal(2, 0),
      event_id: derivedCaptureEventId({
        sessionKey: SESSION,
        role: 'user',
        content: 'alpha',
        ordinal: sourceOrdinal(2, 0),
      }),
    })
    const log = await pool.query(`SELECT op FROM ${ADOPT}.rh_embed_log ORDER BY op`)
    expect(log.rows.map((row) => row.op)).toEqual(['INSERT', 'INSERT'])
    const tsvAfter = await pool.query<{ content_tsv: string }>(
      `SELECT content_tsv::text AS content_tsv FROM ${ADOPT}.rh_messages WHERE id = $1`,
      [MSG_A],
    )
    expect(tsvAfter.rows[0].content_tsv).toBe(tsvBefore.rows[0].content_tsv)
    const chunk = await pool.query(
      `SELECT id, content FROM ${ADOPT}.rh_message_chunks WHERE message_id = $1`,
      [MSG_A],
    )
    expect(chunk.rows[0]).toEqual({
      id: 'cccccccc-cccc-4ccc-8ccc-ccccccccccc1',
      content: 'alpha-chunk',
    })
  })
})

describe.skipIf(PG_URL !== '')('source position relocate (Postgres missing)', () => {
  it('records that runtime transaction tests were skipped', () => {
    expect(PG_URL).toBe('')
  })
})
