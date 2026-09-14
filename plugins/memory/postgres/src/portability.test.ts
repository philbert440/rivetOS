import { Readable, Writable } from 'node:stream'
import { gunzipSync, gzipSync } from 'node:zlib'
import { describe, expect, it, vi } from 'vitest'
import {
  EXPORT_COLUMNS,
  EXPORT_TABLES,
  ROS_CONVERSATIONS_COLUMNS,
  ROS_MESSAGES_COLUMNS,
} from './portability-columns.js'
import {
  DEFER_EMBED_GUC_SQL,
  ENQUEUE_UNEMBEDDED_SQL,
  EXPORT_TYPE,
  EXPORT_VERSION,
  GRAPHILE_MISSING_HINT,
  GRAPHILE_NAMESPACE_SQL,
  IMPORT_BATCH_SIZE,
  exportMemory,
  importMemory,
  insertBatchSql,
  pickKnownColumns,
  selectTableSql,
  type PortabilityPool,
  type PortabilityQueryResult,
} from './portability.js'

function collectWritable(): { out: Writable; chunks: Buffer[] } {
  const chunks: Buffer[] = []
  const out = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(Buffer.from(chunk as Buffer))
      cb()
    },
  })
  return { out, chunks }
}

function recordedPool(
  handler: (
    sql: string,
    params?: unknown[],
  ) => PortabilityQueryResult | Promise<PortabilityQueryResult>,
): { pool: PortabilityPool; calls: Array<{ sql: string; params?: unknown[] }> } {
  const calls: Array<{ sql: string; params?: unknown[] }> = []
  const pool: PortabilityPool = {
    async query(sql, params) {
      calls.push({ sql, params })
      return handler(sql, params)
    },
  }
  return { pool, calls }
}

function ndjsonGzip(lines: unknown[]): Readable {
  const body = lines.map((l) => JSON.stringify(l)).join('\n') + '\n'
  return Readable.from([gzipSync(body)])
}

const HEADER = {
  type: EXPORT_TYPE,
  version: EXPORT_VERSION,
  exported_at: '2026-09-14T00:00:00.000Z',
  source: { kind: 'local' as const, id: 'test-host' },
  tables: EXPORT_TABLES,
}

describe('column lists', () => {
  it('exports tables in FK-safe spec order', () => {
    expect([...EXPORT_TABLES]).toEqual([
      'ros_conversations',
      'ros_messages',
      'ros_summaries',
      'ros_summary_sources',
      'ros_wiki_topics',
      'ros_wiki_redirects',
      'ros_wiki_citations',
    ])
  })

  it('omits embedding and generated tsvector columns', () => {
    for (const table of EXPORT_TABLES) {
      expect(EXPORT_COLUMNS[table]).not.toContain('embedding')
      expect(EXPORT_COLUMNS[table]).not.toContain('content_tsv')
    }
  })

  it('includes columns added after the baseline', () => {
    expect(ROS_CONVERSATIONS_COLUMNS).toContain('task_id')
    expect(ROS_CONVERSATIONS_COLUMNS).toContain('owner_user_id')
    expect(ROS_MESSAGES_COLUMNS).toContain('owner_user_id')
    expect(ROS_MESSAGES_COLUMNS).toContain('content_hash')
    expect(EXPORT_COLUMNS.ros_wiki_topics).toContain('article')
    expect(EXPORT_COLUMNS.ros_wiki_topics).toContain('related')
  })
})

describe('insertBatchSql', () => {
  it('uses json_populate_recordset, explicit cols, ON CONFLICT DO NOTHING, batch bind $1', () => {
    const sql = insertBatchSql('ros_messages', ['id', 'content'])
    expect(sql).toContain('INSERT INTO ros_messages (id, content)')
    expect(sql).toContain(
      'SELECT id, content FROM json_populate_recordset(NULL::ros_messages, $1::json)',
    )
    expect(sql).toContain('ON CONFLICT DO NOTHING')
  })
})

describe('pickKnownColumns', () => {
  it('drops unknown row keys (forward-compat)', () => {
    expect(pickKnownColumns({ id: 'a', extra: 'nope', content: 'hi' }, ['id', 'content'])).toEqual({
      id: 'a',
      content: 'hi',
    })
  })
})

describe('exportMemory', () => {
  it('writes a gzip NDJSON v1 header then rows in table order', async () => {
    const { pool, calls } = recordedPool((sql) => {
      if (sql.includes('FROM ros_conversations')) {
        return {
          rows: [
            {
              id: 'c1',
              session_key: 's',
              agent: 'grok',
              channel: 'unknown',
              created_at: new Date('2026-09-14T00:00:00.000Z'),
              extra: 'drop-me',
            },
          ],
          rowCount: 1,
        }
      }
      if (sql.includes('FROM ros_messages')) {
        return {
          rows: [
            {
              id: 'm1',
              conversation_id: 'c1',
              agent: 'grok',
              channel: 'unknown',
              role: 'user',
              content: 'hello',
              embedding: [1, 2, 3],
              created_at: new Date('2026-09-14T00:01:00.000Z'),
            },
          ],
          rowCount: 1,
        }
      }
      return { rows: [], rowCount: 0 }
    })
    const { out, chunks } = collectWritable()
    await exportMemory(pool, out, {
      exportedAt: '2026-09-14T12:00:00.000Z',
      source: { kind: 'local', id: 'test-host' },
    })

    const tablesInSelect = calls
      .map((c) => {
        const m = /FROM (ros_\w+)/.exec(c.sql)
        return m?.[1]
      })
      .filter(Boolean)
    expect(tablesInSelect).toEqual([...EXPORT_TABLES])
    expect(calls[0]?.sql).toContain(EXPORT_COLUMNS.ros_conversations.join(', '))
    expect(calls[1]?.sql).toContain(EXPORT_COLUMNS.ros_messages.join(', '))
    expect(calls[1]?.sql).not.toContain('embedding')

    const lines = gunzipSync(Buffer.concat(chunks))
      .toString('utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as Record<string, unknown>)
    expect(lines[0]).toMatchObject({
      type: EXPORT_TYPE,
      version: EXPORT_VERSION,
      exported_at: '2026-09-14T12:00:00.000Z',
      source: { kind: 'local', id: 'test-host' },
      tables: [...EXPORT_TABLES],
    })
    expect(lines[1]).toMatchObject({ t: 'ros_conversations', r: { id: 'c1' } })
    expect((lines[1] as { r: Record<string, unknown> }).r.extra).toBeUndefined()
    expect((lines[1] as { r: Record<string, unknown> }).r.created_at).toBe(
      '2026-09-14T00:00:00.000Z',
    )
    expect(lines[2]).toMatchObject({ t: 'ros_messages', r: { id: 'm1', content: 'hello' } })
    expect((lines[2] as { r: Record<string, unknown> }).r.embedding).toBeUndefined()
  })

  it('binds --since on tables that have a timestamp column', async () => {
    const { pool, calls } = recordedPool(() => ({ rows: [], rowCount: 0 }))
    const { out } = collectWritable()
    await exportMemory(pool, out, {
      since: '2026-09-01T00:00:00.000Z',
      source: { kind: 'cloud', id: 'demo' },
    })
    const conv = calls.find((c) => c.sql.includes('FROM ros_conversations'))
    expect(conv?.sql).toContain('WHERE created_at >= $1::timestamptz')
    expect(conv?.params).toEqual(['2026-09-01T00:00:00.000Z'])
    const sources = calls.find((c) => c.sql.includes('FROM ros_summary_sources'))
    expect(sources?.sql).not.toContain('WHERE')
    expect(sources?.params).toEqual([])
    expect(
      selectTableSql('ros_wiki_citations', ['topic_slug'], '2026-09-01T00:00:00.000Z').sql,
    ).toContain('cited_at')
  })
})

describe('importMemory', () => {
  it('checks the header, batches 500, sets the defer GUC before messages, ON CONFLICT, drops unknown keys', async () => {
    const messageRows = Array.from({ length: IMPORT_BATCH_SIZE + 1 }, (_, i) => ({
      t: 'ros_messages',
      r: {
        id: `m${String(i)}`,
        conversation_id: 'c1',
        agent: 'grok',
        channel: 'unknown',
        role: 'user',
        content: 'ping',
        unknown_future_col: 'drop-me',
      },
    }))
    const input = ndjsonGzip([
      HEADER,
      {
        t: 'ros_conversations',
        r: { id: 'c1', session_key: 's', agent: 'grok', channel: 'unknown' },
      },
      ...messageRows,
    ])

    const { pool, calls } = recordedPool((sql) => {
      if (sql === GRAPHILE_NAMESPACE_SQL) return { rows: [{ '?column?': 1 }], rowCount: 1 }
      if (sql.includes('INSERT INTO ros_messages')) {
        const payload = JSON.parse(
          String(calls[calls.length - 1]?.params?.[0] ?? '[]'),
        ) as unknown[]
        // rowCount = inserted; last batch of 1 conflicts
        return { rows: [], rowCount: payload.length === 1 ? 0 : payload.length }
      }
      if (sql.includes('INSERT INTO')) return { rows: [], rowCount: 1 }
      if (sql === ENQUEUE_UNEMBEDDED_SQL) return { rows: [{}], rowCount: 1 }
      return { rows: [], rowCount: 0 }
    })

    const result = await importMemory(pool, input)

    const sqls = calls.map((c) => c.sql)
    expect(sqls.some((s) => s.includes('INSERT INTO ros_conversations'))).toBe(true)
    const deferAt = sqls.indexOf(DEFER_EMBED_GUC_SQL)
    const firstMsg = sqls.findIndex((s) => s.includes('INSERT INTO ros_messages'))
    expect(deferAt).toBeGreaterThan(-1)
    expect(firstMsg).toBeGreaterThan(deferAt)

    const msgInserts = calls.filter((c) => c.sql.includes('INSERT INTO ros_messages'))
    expect(msgInserts).toHaveLength(2)
    expect(msgInserts[0]?.sql).toBe(insertBatchSql('ros_messages', EXPORT_COLUMNS.ros_messages))
    expect(msgInserts[0]?.sql).toContain('ON CONFLICT DO NOTHING')
    expect(msgInserts[0]?.sql).toContain('json_populate_recordset(NULL::ros_messages, $1::json)')
    const batch0 = JSON.parse(String(msgInserts[0]?.params?.[0])) as Record<string, unknown>[]
    const batch1 = JSON.parse(String(msgInserts[1]?.params?.[0])) as Record<string, unknown>[]
    expect(batch0).toHaveLength(IMPORT_BATCH_SIZE)
    expect(batch1).toHaveLength(1)
    expect(batch0[0]?.unknown_future_col).toBeUndefined()
    expect(batch0[0]?.id).toBe('m0')

    expect(sqls).toContain(GRAPHILE_NAMESPACE_SQL)
    expect(sqls).toContain(ENQUEUE_UNEMBEDDED_SQL)
    expect(result.enqueuedEmbeds).toBe(1)
    expect(result.inserted.ros_conversations).toBe(1)
    expect(result.inserted.ros_messages).toBe(IMPORT_BATCH_SIZE)
    expect(result.skipped.ros_messages).toBe(1)
  })

  it('skips enqueue-unembedded when graphile_worker schema is absent and prints a hint', async () => {
    const log = vi.fn()
    const input = ndjsonGzip([
      HEADER,
      {
        t: 'ros_conversations',
        r: { id: 'c1', session_key: 's', agent: 'grok', channel: 'unknown' },
      },
    ])
    const { pool, calls } = recordedPool((sql) => {
      if (sql === GRAPHILE_NAMESPACE_SQL) return { rows: [], rowCount: 0 }
      if (sql.includes('INSERT INTO')) return { rows: [], rowCount: 1 }
      return { rows: [], rowCount: 0 }
    })
    const result = await importMemory(pool, input, { log })
    expect(calls.map((c) => c.sql)).not.toContain(ENQUEUE_UNEMBEDDED_SQL)
    expect(log).toHaveBeenCalledWith(GRAPHILE_MISSING_HINT)
    expect(result.enqueuedEmbeds).toBe(0)
  })

  it('dry-run parses the file and never INSERTs or SETs', async () => {
    const input = ndjsonGzip([HEADER, { t: 'ros_messages', r: { id: 'm1', content: 'x' } }])
    const { pool, calls } = recordedPool(() => ({ rows: [], rowCount: 0 }))
    const result = await importMemory(pool, input, { dryRun: true })
    expect(calls).toEqual([])
    expect(result.inserted.ros_messages).toBe(0)
    expect(result.skipped.ros_messages).toBe(0)
  })

  it('rejects a bad header', async () => {
    const input = ndjsonGzip([{ type: 'nope', version: 1 }])
    const { pool } = recordedPool(() => ({ rows: [], rowCount: 0 }))
    await expect(importMemory(pool, input)).rejects.toThrow(/invalid rivet-memory-export/)
  })
})
