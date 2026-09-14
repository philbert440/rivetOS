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
  EXISTING_CONVERSATION_IDS_SQL,
  EXPORT_CURSOR_PAGE,
  EXPORT_TX_BEGIN_SQL,
  EXPORT_TX_COMMIT_SQL,
  EXPORT_TX_ROLLBACK_SQL,
  EXPORT_TYPE,
  EXPORT_VERSION,
  GRAPHILE_MISSING_HINT,
  GRAPHILE_NAMESPACE_SQL,
  IMPORT_BATCH_SIZE,
  RESOLVE_CONVERSATIONS_SQL,
  SELECTED_SUMMARIES_CTE,
  SUMMARY_PARENT_UNRESOLVED_SQL,
  SUMMARY_PARENT_UPDATE_SQL,
  closeCursorSql,
  declareCursorSql,
  exportCursorName,
  exportMemory,
  fetchCursorSql,
  groupByPresentColumns,
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
  const query = async (sql: string, params?: unknown[]): Promise<PortabilityQueryResult> => {
    calls.push({ sql, params })
    return handler(sql, params)
  }
  const pool: PortabilityPool = {
    query,
    async connect() {
      return { query, release() {} }
    },
  }
  return { pool, calls }
}

/** Serve DECLARE/FETCH/CLOSE against in-memory table rows. */
function cursorHandler(
  tableRows: Partial<Record<string, Record<string, unknown>[]>>,
  extra?: (
    sql: string,
    params?: unknown[],
  ) => PortabilityQueryResult | Promise<PortabilityQueryResult> | undefined,
): (sql: string, params?: unknown[]) => PortabilityQueryResult | Promise<PortabilityQueryResult> {
  const cursors = new Map<string, { rows: Record<string, unknown>[]; offset: number }>()
  return (sql, params) => {
    const fromExtra = extra?.(sql, params)
    if (fromExtra) return fromExtra
    const decl = /^DECLARE (export_(ros_\w+)) NO SCROLL CURSOR FOR /.exec(sql)
    if (decl) {
      const table = decl[2]
      cursors.set(decl[1], { rows: tableRows[table] ?? [], offset: 0 })
      return { rows: [], rowCount: 0 }
    }
    const fetch = /^FETCH (\d+) FROM (export_ros_\w+)$/.exec(sql)
    if (fetch) {
      const cur = cursors.get(fetch[2])
      if (!cur) return { rows: [], rowCount: 0 }
      const n = Number(fetch[1])
      const slice = cur.rows.slice(cur.offset, cur.offset + n)
      cur.offset += slice.length
      return { rows: slice, rowCount: slice.length }
    }
    if (
      sql.startsWith('CLOSE ') ||
      sql === EXPORT_TX_BEGIN_SQL ||
      sql === EXPORT_TX_COMMIT_SQL ||
      sql === EXPORT_TX_ROLLBACK_SQL
    ) {
      return { rows: [], rowCount: 0 }
    }
    return { rows: [], rowCount: 0 }
  }
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

  it('uses DEFAULT VALUES when the column set is empty', () => {
    expect(insertBatchSql('ros_conversations', [])).toBe(
      'INSERT INTO ros_conversations DEFAULT VALUES ON CONFLICT DO NOTHING',
    )
  })
})

describe('pickKnownColumns / groupByPresentColumns', () => {
  it('drops unknown row keys (forward-compat)', () => {
    expect(pickKnownColumns({ id: 'a', extra: 'nope', content: 'hi' }, ['id', 'content'])).toEqual({
      id: 'a',
      content: 'hi',
    })
  })

  it('groups mixed shapes and treats explicit null as present', () => {
    const groups = groupByPresentColumns(
      [
        { id: 'c1', session_key: 's' },
        { id: 'c2', session_key: 's', channel: null },
        { id: 'c3', session_key: 's' },
      ],
      ['id', 'session_key', 'channel'],
    )
    expect(groups).toHaveLength(2)
    const byLen = [...groups].sort((a, b) => a.cols.length - b.cols.length)
    expect(byLen[0]?.cols).toEqual(['id', 'session_key'])
    expect(byLen[0]?.rows).toHaveLength(2)
    expect(byLen[1]?.cols).toEqual(['id', 'session_key', 'channel'])
    expect(byLen[1]?.rows[0]?.channel).toBeNull()
  })
})

describe('selectTableSql --since closure', () => {
  const since = '2026-09-01T00:00:00.000Z'

  it('pulls conversations of selected messages and selected summaries', () => {
    const { sql, params } = selectTableSql('ros_conversations', ['id'], since)
    expect(params).toEqual([since])
    expect(sql).toContain(SELECTED_SUMMARIES_CTE)
    expect(sql).toContain('FROM ros_conversations WHERE id IN')
    expect(sql).toContain('FROM ros_messages WHERE created_at >= $1::timestamptz')
    expect(sql).toContain('SELECT conversation_id FROM selected_summaries')
  })

  it('walks summary parents recursively and keeps junction rows only when both ends are in the dump', () => {
    const summaries = selectTableSql('ros_summaries', ['id'], since)
    expect(summaries.sql).toContain('id IN (SELECT id FROM selected_summaries)')
    const sources = selectTableSql('ros_summary_sources', ['summary_id', 'message_id'], since)
    expect(sources.sql).toContain('summary_id IN (SELECT id FROM selected_summaries)')
    expect(sources.sql).toContain(
      'message_id IN (SELECT id FROM ros_messages WHERE created_at >= $1::timestamptz)',
    )
  })

  it('limits wiki to topics changed since plus their redirects and citations', () => {
    const topics = selectTableSql('ros_wiki_topics', ['slug'], since)
    expect(topics.sql).toContain('created_at >= $1::timestamptz OR updated_at >= $1::timestamptz')
    const redirects = selectTableSql('ros_wiki_redirects', ['from_slug', 'to_slug'], since)
    expect(redirects.sql).toContain('to_slug IN (')
    expect(redirects.sql).toContain('FROM ros_wiki_topics')
    const citations = selectTableSql('ros_wiki_citations', ['topic_slug'], since)
    expect(citations.sql).toContain('topic_slug IN (')
    expect(citations.sql).not.toContain('cited_at')
  })

  it('exports wiki (and everything else) unfiltered when --since is absent', () => {
    expect(selectTableSql('ros_wiki_topics', ['slug']).sql).toBe('SELECT slug FROM ros_wiki_topics')
    expect(selectTableSql('ros_summary_sources', ['summary_id']).params).toEqual([])
    expect(selectTableSql('ros_summary_sources', ['summary_id']).sql).not.toContain('WHERE')
  })
})

describe('exportMemory', () => {
  it('writes a gzip NDJSON v1 header then rows in table order through a pinned cursor', async () => {
    const { pool, calls } = recordedPool(
      cursorHandler({
        ros_conversations: [
          {
            id: 'c1',
            session_key: 's',
            agent: 'grok',
            channel: 'unknown',
            created_at: new Date('2026-09-14T00:00:00.000Z'),
            extra: 'drop-me',
          },
        ],
        ros_messages: [
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
      }),
    )
    const { out, chunks } = collectWritable()
    await exportMemory(pool, out, {
      exportedAt: '2026-09-14T12:00:00.000Z',
      source: { kind: 'local', id: 'test-host' },
    })

    expect(calls[0]?.sql).toBe(EXPORT_TX_BEGIN_SQL)
    const declared = calls
      .map((c) => /^DECLARE (export_(ros_\w+)) /.exec(c.sql)?.[2])
      .filter(Boolean)
    expect(declared).toEqual([...EXPORT_TABLES])
    const convDecl = calls.find((c) =>
      c.sql.startsWith(declareCursorSql(exportCursorName('ros_conversations'), '')),
    )
    expect(convDecl?.sql).toContain(EXPORT_COLUMNS.ros_conversations.join(', '))
    const msgDecl = calls.find((c) => c.sql.includes('export_ros_messages'))
    expect(msgDecl?.sql).toContain(EXPORT_COLUMNS.ros_messages.join(', '))
    expect(msgDecl?.sql).not.toContain('embedding')
    expect(calls.some((c) => c.sql === EXPORT_TX_COMMIT_SQL)).toBe(true)
    expect(calls.some((c) => c.sql === closeCursorSql(exportCursorName('ros_conversations')))).toBe(
      true,
    )

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

  it('binds --since closure SQL on the declared cursors', async () => {
    const { pool, calls } = recordedPool(cursorHandler({}))
    const { out } = collectWritable()
    await exportMemory(pool, out, {
      since: '2026-09-01T00:00:00.000Z',
      source: { kind: 'cloud', id: 'demo' },
    })
    const conv = calls.find((c) => c.sql.includes('export_ros_conversations'))
    expect(conv?.sql).toContain('FROM ros_conversations WHERE id IN')
    expect(conv?.params).toEqual(['2026-09-01T00:00:00.000Z'])
    const sources = calls.find((c) => c.sql.includes('export_ros_summary_sources'))
    expect(sources?.sql).toContain('summary_id IN')
    expect(sources?.sql).toContain('message_id IN')
  })

  it('fetches through the cursor in pages of 1000', async () => {
    const rows = Array.from({ length: EXPORT_CURSOR_PAGE + 1 }, (_, i) => ({
      id: `c${String(i)}`,
    }))
    const { pool, calls } = recordedPool(cursorHandler({ ros_conversations: rows }))
    const { out, chunks } = collectWritable()
    await exportMemory(pool, out, {
      exportedAt: '2026-09-14T12:00:00.000Z',
      source: { kind: 'local', id: 'page' },
    })
    const convFetches = calls.filter(
      (c) => c.sql === fetchCursorSql(exportCursorName('ros_conversations')),
    )
    expect(convFetches).toHaveLength(3)
    const body = gunzipSync(Buffer.concat(chunks)).toString('utf8')
    expect(body.match(/"t":"ros_conversations"/g)).toHaveLength(EXPORT_CURSOR_PAGE + 1)
  })

  it('closes open cursors and rolls back when a later DECLARE fails', async () => {
    const { pool, calls } = recordedPool(
      cursorHandler({}, (sql) => {
        if (sql.startsWith('DECLARE export_ros_messages')) throw new Error('boom')
        return undefined
      }),
    )
    const { out } = collectWritable()
    await expect(
      exportMemory(pool, out, {
        exportedAt: '2026-09-14T12:00:00.000Z',
        source: { kind: 'local', id: 'fail' },
      }),
    ).rejects.toThrow(/boom/)
    expect(calls.some((c) => c.sql === EXPORT_TX_ROLLBACK_SQL)).toBe(true)
    expect(calls.some((c) => c.sql === closeCursorSql(exportCursorName('ros_conversations')))).toBe(
      true,
    )
  })
})

describe('importMemory', () => {
  it('checks the header, batches 500, SET LOCAL per batch, ON CONFLICT, drops unknown keys', async () => {
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
      if (sql === RESOLVE_CONVERSATIONS_SQL) {
        return { rows: [{ id: 'c1', session_key: 's', agent: 'grok' }], rowCount: 1 }
      }
      if (sql.includes('INSERT INTO ros_messages')) {
        const payload = JSON.parse(
          String(calls[calls.length - 1]?.params?.[0] ?? '[]'),
        ) as unknown[]
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
    const firstBegin = sqls.indexOf('BEGIN')
    expect(deferAt).toBeGreaterThan(-1)
    expect(firstBegin).toBeGreaterThan(-1)
    expect(firstBegin).toBeLessThan(deferAt)
    expect(firstMsg).toBeGreaterThan(deferAt)
    expect(DEFER_EMBED_GUC_SQL).toContain('SET LOCAL')

    const msgCols = ['id', 'conversation_id', 'agent', 'channel', 'role', 'content']
    const msgInserts = calls.filter((c) => c.sql.includes('INSERT INTO ros_messages'))
    expect(msgInserts).toHaveLength(2)
    expect(msgInserts[0]?.sql).toBe(insertBatchSql('ros_messages', msgCols))
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
    expect(result.merged.ros_conversations).toBe(0)
    expect(result.skipped.orphan_messages).toBe(0)
    expect(result.unresolvedParentLinks).toBe(0)
    expect(sqls).toContain(RESOLVE_CONVERSATIONS_SQL)
  })

  it('groups mixed column shapes into one INSERT per shape and preserves explicit null', async () => {
    const input = ndjsonGzip([
      HEADER,
      { t: 'ros_conversations', r: { id: 'c1', session_key: 's', agent: 'grok' } },
      {
        t: 'ros_conversations',
        r: { id: 'c2', session_key: 's', agent: 'grok', channel: null },
      },
    ])
    const { pool, calls } = recordedPool((sql) => {
      if (sql === GRAPHILE_NAMESPACE_SQL) return { rows: [], rowCount: 0 }
      if (sql.includes('INSERT INTO')) return { rows: [], rowCount: 1 }
      return { rows: [], rowCount: 0 }
    })
    await importMemory(pool, input, { log: () => undefined })
    const inserts = calls.filter((c) => c.sql.includes('INSERT INTO ros_conversations'))
    expect(inserts).toHaveLength(2)
    expect(inserts[0]?.sql).toBe(
      insertBatchSql('ros_conversations', ['id', 'session_key', 'agent']),
    )
    expect(inserts[1]?.sql).toContain('channel')
    const withNull = JSON.parse(String(inserts[1]?.params?.[0])) as Array<{ channel: unknown }>
    expect(withNull[0]?.channel).toBeNull()
  })

  it('inserts summaries with parent_id omitted then UPDATEs parent links', async () => {
    const input = ndjsonGzip([
      HEADER,
      {
        t: 'ros_summaries',
        r: {
          id: '11111111-1111-1111-1111-111111111111',
          parent_id: '22222222-2222-2222-2222-222222222222',
          content: 'child',
          kind: 'leaf',
        },
      },
      {
        t: 'ros_summaries',
        r: {
          id: '22222222-2222-2222-2222-222222222222',
          parent_id: null,
          content: 'parent',
          kind: 'root',
        },
      },
    ])
    const { pool, calls } = recordedPool((sql, params) => {
      if (sql === GRAPHILE_NAMESPACE_SQL) return { rows: [], rowCount: 0 }
      if (sql === SUMMARY_PARENT_UPDATE_SQL) return { rows: [], rowCount: 1 }
      if (sql === SUMMARY_PARENT_UNRESOLVED_SQL) return { rows: [{ n: 0 }], rowCount: 1 }
      if (sql.includes('INSERT INTO ros_summaries')) {
        const payload = JSON.parse(String(params?.[0] ?? '[]')) as Array<{ id?: unknown }>
        return {
          rows: payload.filter((r) => r.id != null).map((r) => ({ id: r.id })),
          rowCount: payload.length,
        }
      }
      if (sql.includes('INSERT INTO')) return { rows: [], rowCount: 1 }
      return { rows: [], rowCount: 0 }
    })
    const result = await importMemory(pool, input, { log: () => undefined })
    const inserts = calls.filter((c) => c.sql.includes('INSERT INTO ros_summaries'))
    expect(inserts.length).toBeGreaterThan(0)
    for (const ins of inserts) {
      expect(ins.sql).not.toMatch(/INSERT INTO ros_summaries \([^)]*parent_id/)
      expect(ins.sql).toContain('RETURNING id')
      const payload = JSON.parse(String(ins.params?.[0])) as Array<{ parent_id?: unknown }>
      for (const row of payload) expect(row.parent_id).toBeUndefined()
    }
    const update = calls.find((c) => c.sql === SUMMARY_PARENT_UPDATE_SQL)
    expect(update).toBeDefined()
    const links = JSON.parse(String(update?.params?.[0])) as Array<{
      id: string
      parent_id: string
    }>
    expect(links).toEqual([
      {
        id: '11111111-1111-1111-1111-111111111111',
        parent_id: '22222222-2222-2222-2222-222222222222',
      },
    ])
    expect(result.unresolvedParentLinks).toBe(0)
    const sqls = calls.map((c) => c.sql)
    expect(sqls.indexOf(DEFER_EMBED_GUC_SQL)).toBeGreaterThan(-1)
  })

  it('counts unresolved summary parent links', async () => {
    const input = ndjsonGzip([
      HEADER,
      {
        t: 'ros_summaries',
        r: {
          id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
          parent_id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
          content: 'orphan',
          kind: 'leaf',
        },
      },
    ])
    const { pool } = recordedPool((sql, params) => {
      if (sql === GRAPHILE_NAMESPACE_SQL) return { rows: [], rowCount: 0 }
      if (sql === SUMMARY_PARENT_UPDATE_SQL) return { rows: [], rowCount: 0 }
      if (sql === SUMMARY_PARENT_UNRESOLVED_SQL) return { rows: [{ n: 1 }], rowCount: 1 }
      if (sql.includes('INSERT INTO ros_summaries')) {
        const payload = JSON.parse(String(params?.[0] ?? '[]')) as Array<{ id?: unknown }>
        return {
          rows: payload.filter((r) => r.id != null).map((r) => ({ id: r.id })),
          rowCount: payload.length,
        }
      }
      if (sql.includes('INSERT INTO')) return { rows: [], rowCount: 1 }
      return { rows: [], rowCount: 0 }
    })
    const result = await importMemory(pool, input, { log: () => undefined })
    expect(result.unresolvedParentLinks).toBe(1)
  })

  it('does not rewrite parent_id on summaries skipped by ON CONFLICT', async () => {
    const child = 'cccccccc-cccc-cccc-cccc-cccccccccccc'
    const p1 = '11111111-1111-1111-1111-111111111111'
    const p2 = '22222222-2222-2222-2222-222222222222'
    const dest = new Map<string, string | null>([
      [child, p2],
      [p2, null],
    ])
    const input = ndjsonGzip([
      HEADER,
      {
        t: 'ros_summaries',
        r: { id: child, parent_id: p1, content: 'child', kind: 'leaf' },
      },
      {
        t: 'ros_summaries',
        r: { id: p1, parent_id: null, content: 'dump-parent', kind: 'root' },
      },
    ])
    const { pool, calls } = recordedPool((sql, params) => {
      if (sql === GRAPHILE_NAMESPACE_SQL) return { rows: [], rowCount: 0 }
      if (sql === SUMMARY_PARENT_UPDATE_SQL) {
        const links = JSON.parse(String(params?.[0] ?? '[]')) as Array<{
          id: string
          parent_id: string
        }>
        for (const link of links) {
          if (dest.has(link.id)) dest.set(link.id, link.parent_id)
        }
        return { rows: [], rowCount: links.length }
      }
      if (sql === SUMMARY_PARENT_UNRESOLVED_SQL) return { rows: [{ n: 0 }], rowCount: 1 }
      if (sql.includes('INSERT INTO ros_summaries')) {
        const payload = JSON.parse(String(params?.[0] ?? '[]')) as Array<{ id: string }>
        const wrote = payload.filter((r) => !dest.has(r.id))
        for (const row of wrote) dest.set(row.id, null)
        return { rows: wrote.map((r) => ({ id: r.id })), rowCount: wrote.length }
      }
      if (sql.includes('INSERT INTO')) return { rows: [], rowCount: 1 }
      return { rows: [], rowCount: 0 }
    })
    const result = await importMemory(pool, input, { log: () => undefined })
    expect(result.skipped.ros_summaries).toBe(1)
    expect(dest.get(child)).toBe(p2)
    const update = calls.find((c) => c.sql === SUMMARY_PARENT_UPDATE_SQL)
    if (update) {
      const links = JSON.parse(String(update.params?.[0])) as Array<{ id: string }>
      expect(links.some((l) => l.id === child)).toBe(false)
    }
  })

  it('SET LOCAL inside the transaction for a summaries-only dump', async () => {
    const input = ndjsonGzip([
      HEADER,
      {
        t: 'ros_summaries',
        r: { id: 's1', content: 'only', kind: 'leaf' },
      },
    ])
    const { pool, calls } = recordedPool((sql) => {
      if (sql === GRAPHILE_NAMESPACE_SQL) return { rows: [], rowCount: 0 }
      if (sql.includes('INSERT INTO')) return { rows: [], rowCount: 1 }
      return { rows: [], rowCount: 0 }
    })
    await importMemory(pool, input, { log: () => undefined })
    const sqls = calls.map((c) => c.sql)
    const begin = sqls.indexOf('BEGIN')
    const defer = sqls.indexOf(DEFER_EMBED_GUC_SQL)
    const insert = sqls.findIndex((s) => s.includes('INSERT INTO ros_summaries'))
    const commit = sqls.indexOf('COMMIT')
    expect(begin).toBeGreaterThan(-1)
    expect(defer).toBeGreaterThan(begin)
    expect(insert).toBeGreaterThan(defer)
    expect(commit).toBeGreaterThan(insert)
  })

  it('rolls back a failed batch', async () => {
    const input = ndjsonGzip([HEADER, { t: 'ros_messages', r: { id: 'm1', content: 'x' } }])
    const { pool, calls } = recordedPool((sql) => {
      if (sql.includes('INSERT INTO')) throw new Error('sql boom')
      return { rows: [], rowCount: 0 }
    })
    await expect(importMemory(pool, input)).rejects.toThrow(/sql boom/)
    expect(calls.some((c) => c.sql === 'ROLLBACK')).toBe(true)
  })

  it('rejects when the source stream errors', async () => {
    const input = new Readable({
      read() {
        this.destroy(new Error('source boom'))
      },
    })
    const { pool } = recordedPool(() => ({ rows: [], rowCount: 0 }))
    await expect(importMemory(pool, input)).rejects.toThrow(/source boom/)
  })

  it('rejects truncated gzip', async () => {
    const full = gzipSync(`${JSON.stringify(HEADER)}\n`)
    const input = Readable.from([full.subarray(0, 8)])
    const { pool } = recordedPool(() => ({ rows: [], rowCount: 0 }))
    await expect(importMemory(pool, input)).rejects.toThrow()
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

  it('merges conversations on (session_key, agent) and rewrites message conversation_id', async () => {
    const destId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
    const incomingId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
    const dest = {
      conversations: [{ id: destId, session_key: 'S', agent: 'A' }],
      messages: [] as Array<Record<string, unknown>>,
    }
    const input = ndjsonGzip([
      HEADER,
      {
        t: 'ros_conversations',
        r: { id: incomingId, session_key: 'S', agent: 'A', channel: 'unknown' },
      },
      {
        t: 'ros_messages',
        r: {
          id: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
          conversation_id: incomingId,
          agent: 'A',
          channel: 'unknown',
          role: 'user',
          content: 'hello',
        },
      },
    ])
    const { pool, calls } = recordedPool((sql, params) => {
      if (sql === GRAPHILE_NAMESPACE_SQL) return { rows: [], rowCount: 0 }
      if (sql === RESOLVE_CONVERSATIONS_SQL) {
        const pairs = JSON.parse(String(params?.[0] ?? '[]')) as Array<{
          session_key: string
          agent: string
        }>
        const rows = dest.conversations.filter((c) =>
          pairs.some((p) => p.session_key === c.session_key && p.agent === c.agent),
        )
        return { rows, rowCount: rows.length }
      }
      if (sql === EXISTING_CONVERSATION_IDS_SQL) {
        const want = new Set((params?.[0] as string[] | undefined)?.map(String) ?? [])
        const rows = dest.conversations.filter((c) => want.has(c.id)).map((c) => ({ id: c.id }))
        return { rows, rowCount: rows.length }
      }
      if (sql.includes('INSERT INTO ros_conversations')) {
        const payload = JSON.parse(String(params?.[0] ?? '[]')) as Array<{
          id: string
          session_key: string
          agent: string
        }>
        let wrote = 0
        for (const row of payload) {
          const conflict = dest.conversations.some(
            (c) => c.id === row.id || (c.session_key === row.session_key && c.agent === row.agent),
          )
          if (!conflict) {
            dest.conversations.push(row)
            wrote += 1
          }
        }
        return { rows: [], rowCount: wrote }
      }
      if (sql.includes('INSERT INTO ros_messages')) {
        const payload = JSON.parse(String(params?.[0] ?? '[]')) as Array<Record<string, unknown>>
        for (const row of payload) {
          const cid = String(row.conversation_id)
          if (!dest.conversations.some((c) => c.id === cid)) {
            throw new Error('ros_messages_conversation_id_fkey')
          }
          dest.messages.push(row)
        }
        return { rows: [], rowCount: payload.length }
      }
      if (sql.includes('INSERT INTO')) return { rows: [], rowCount: 1 }
      return { rows: [], rowCount: 0 }
    })
    const result = await importMemory(pool, input, { log: () => undefined })
    expect(result.merged.ros_conversations).toBe(1)
    expect(result.inserted.ros_conversations).toBe(0)
    expect(result.skipped.ros_conversations).toBe(1)
    expect(result.inserted.ros_messages).toBe(1)
    expect(result.skipped.orphan_messages).toBe(0)
    expect(dest.messages).toHaveLength(1)
    expect(dest.messages[0]?.conversation_id).toBe(destId)
    expect(calls.some((c) => c.sql === RESOLVE_CONVERSATIONS_SQL)).toBe(true)
    expect(RESOLVE_CONVERSATIONS_SQL).toContain(
      'SELECT id, session_key, agent FROM ros_conversations',
    )
    expect(RESOLVE_CONVERSATIONS_SQL).toContain('WHERE (session_key, agent) IN')
  })

  it('counts messages whose conversation is neither mapped nor present as orphan_messages', async () => {
    const input = ndjsonGzip([
      HEADER,
      {
        t: 'ros_messages',
        r: {
          id: 'dddddddd-dddd-dddd-dddd-dddddddddddd',
          conversation_id: 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee',
          agent: 'A',
          channel: 'unknown',
          role: 'user',
          content: 'orphan',
        },
      },
    ])
    const { pool, calls } = recordedPool((sql) => {
      if (sql === GRAPHILE_NAMESPACE_SQL) return { rows: [], rowCount: 0 }
      if (sql === EXISTING_CONVERSATION_IDS_SQL) return { rows: [], rowCount: 0 }
      if (sql.includes('INSERT INTO ros_messages')) {
        throw new Error('ros_messages_conversation_id_fkey')
      }
      if (sql.includes('INSERT INTO')) return { rows: [], rowCount: 1 }
      return { rows: [], rowCount: 0 }
    })
    const result = await importMemory(pool, input, { log: () => undefined })
    expect(result.skipped.orphan_messages).toBe(1)
    expect(result.inserted.ros_messages).toBe(0)
    expect(calls.some((c) => c.sql.includes('INSERT INTO ros_messages'))).toBe(false)
    expect(calls.some((c) => c.sql === EXISTING_CONVERSATION_IDS_SQL)).toBe(true)
  })
})
