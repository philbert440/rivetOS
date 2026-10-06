import { describe, expect, it, vi } from 'vitest'
import type pg from 'pg'
import {
  addTag,
  conversationIdsWithTag,
  decideTags,
  decideTaxonomy,
  listTags,
  mergeTaxonomyValue,
  pendingTags,
  rowToTag,
  sessionKeyMatchers,
  tagCounts,
  tagsForConversations,
  tagsForSessionKeys,
  upsertTaxonomy,
  type TagRow,
} from './store.js'

const NOW = new Date('2026-10-02T12:00:00Z')
function row(over: Partial<TagRow> = {}): TagRow {
  return {
    id: 't1',
    entity_type: 'conversation',
    entity_id: 'c1',
    key: 'project',
    value: 'acmeapp',
    display: 'AcmeApp',
    source: 'model',
    state: 'suggested',
    confidence: 0.8,
    proposed_by: 'm',
    reason: 'r',
    decided_by: null,
    decided_at: null,
    created_at: NOW,
    updated_at: NOW,
    ...over,
  }
}

function db(rows: unknown[] = [], rowCount?: number) {
  const query = vi.fn(async () => ({ rows, rowCount: rowCount ?? rows.length }))
  return { query } as unknown as pg.Pool & { query: typeof query }
}

describe('rowToTag', () => {
  it('maps snake_case and drops null optionals', () => {
    expect(rowToTag(row())).toEqual({
      id: 't1',
      entityType: 'conversation',
      entityId: 'c1',
      key: 'project',
      value: 'acmeapp',
      display: 'AcmeApp',
      source: 'model',
      state: 'suggested',
      confidence: 0.8,
      proposedBy: 'm',
      reason: 'r',
      createdAt: NOW,
      updatedAt: NOW,
    })
  })
})

describe('listTags', () => {
  it('normalizes key/value filters and defaults to suggested+accepted', async () => {
    const pool = db([row()])
    await listTags(pool, { entityType: 'conversation', entityId: 'c1', key: 'Project', value: 'AcmeApp' })
    const [sql, params] = pool.query.mock.calls[0] as unknown as [string, unknown[]]
    expect(sql).toMatch(/entity_type = \$1 AND entity_id = \$2 AND key = \$3 AND value = \$4 AND state = ANY\(\$5::text\[\]\)/)
    expect(params).toEqual(['conversation', 'c1', 'project', 'acmeapp', ['suggested', 'accepted'], 200])
  })
})

describe('pendingTags', () => {
  it('joins conversation and summary context', async () => {
    const pool = db([
      { ...row(), session_key: 'claude:x', title: 'T', agent: 'rivet', conversation_id: 'c1', excerpt: null },
    ])
    const out = await pendingTags(pool, 10)
    expect(out[0]).toMatchObject({ id: 't1', sessionKey: 'claude:x', title: 'T', conversationId: 'c1' })
    const [sql, params] = pool.query.mock.calls[0] as unknown as [string, unknown[]]
    expect(sql).toMatch(/t\.state = 'suggested'/)
    expect(sql).toMatch(/c\.id IS NOT NULL OR s\.id IS NOT NULL/)
    expect(params).toEqual([10])
  })
})

describe('decideTags', () => {
  it('flips state with audit columns and returns changed ids', async () => {
    const pool = db([{ id: 'a' }])
    expect(await decideTags(pool, ['a', 'b'], 'rejected', 'alice')).toEqual(['a'])
    const update = pool.query.mock.calls.find(([sql]) => String(sql).includes('SET state = $2'))
    expect(update).toBeDefined()
    const [sql, params] = update as unknown as [string, unknown[]]
    expect(sql).toMatch(/SET state = \$2, decided_by = \$3, decided_at = now\(\)/)
    expect(sql).toMatch(/AND state <> \$2/)
    expect(params).toEqual([['a', 'b'], 'rejected', 'alice'])
  })
  it('is a no-op for an empty id list', async () => {
    const pool = db()
    expect(await decideTags(pool, [], 'accepted', 'x')).toEqual([])
    expect(pool.query).not.toHaveBeenCalled()
  })
})

describe('addTag', () => {
  it('parses a literal, keeps display casing, and upserts to accepted', async () => {
    const pool = db([row({ source: 'user', state: 'accepted' })])
    const tag = await addTag(pool, { entityType: 'conversation', entityId: 'c1', tag: 'Project:AcmeApp' }, 'alice')
    expect(tag.state).toBe('accepted')
    const [sql, params] = pool.query.mock.calls[0] as unknown as [string, unknown[]]
    expect(sql).toMatch(/'user', 'accepted'/)
    expect(sql).toMatch(/ON CONFLICT \(entity_type, entity_id, key, value\) DO UPDATE/)
    expect(params.slice(0, 6)).toEqual(['conversation', 'c1', 'project', 'acmeapp', 'AcmeApp', 'alice'])
  })
  it('refuses to guess when the session key exists under two agents and none was named', async () => {
    // The agent count comes from the whole match set, not the picked row.
    const pool = db([{ id: 'c1', agents: '2' }])
    await expect(
      addTag(pool, { entityType: 'conversation', sessionKey: 'claude-code:x', tag: 'topic:x' }, 'alice'),
    ).rejects.toThrow(/several agents; pass agent/)
    expect(pool.query).toHaveBeenCalledTimes(1)
    const [sql] = pool.query.mock.calls[0] as unknown as [string]
    expect(sql).toMatch(/SELECT count\(DISTINCT agent\) FROM m/)
    expect(sql).not.toMatch(/LIMIT 20/)
    // One named agent (count(DISTINCT) ignores NULL agents) is not ambiguous.
    const single = db()
    single.query
      .mockResolvedValueOnce({ rows: [{ id: 'c1', agents: '1' }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [row({ entity_id: 'c1', source: 'user', state: 'accepted' })], rowCount: 1 })
    const tag = await addTag(single, { entityType: 'conversation', sessionKey: 'claude-code:x', tag: 'topic:x' }, 'alice')
    expect(tag.entityId).toBe('c1')
  })
  it('keeps the display casing of a literal typed with a full-width colon', async () => {
    const pool = db([row({ source: 'user', state: 'accepted' })])
    await addTag(pool, { entityType: 'conversation', entityId: 'c1', tag: 'Project\uFF1AAcmeApp' }, 'alice')
    const [, params] = pool.query.mock.calls[0] as unknown as [string, unknown[]]
    expect(params.slice(2, 5)).toEqual(['project', 'acmeapp', 'AcmeApp'])
  })

  it('rejects a bad literal or missing parts', async () => {
    const pool = db()
    await expect(addTag(pool, { entityType: 'summary', entityId: 's', tag: 'nocolon' }, 'x')).rejects.toThrow(/invalid tag literal/)
    await expect(addTag(pool, { entityType: 'summary', entityId: 's', key: 'topic' }, 'x')).rejects.toThrow(/required/)
  })
  it('resolves a conversation from session_key, and fails clearly when none was captured', async () => {
    const found = db([{ id: 'c-found' }])
    found.query
      .mockResolvedValueOnce({ rows: [{ id: 'c-found', agents: '1' }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [row({ entity_id: 'c-found', source: 'user', state: 'accepted' })], rowCount: 1 })
    const tag = await addTag(found, { entityType: 'conversation', sessionKey: 'claude:abc', tag: 'topic:x' }, 'alice')
    expect(tag.entityId).toBe('c-found')
    const [sql, params] = found.query.mock.calls[0] as unknown as [string, unknown[]]
    expect(sql).toMatch(/session_key = ANY\(\$1::text\[\]\) OR session_key LIKE ANY\(\$4::text\[\]\)/)
    expect(params).toEqual([['claude:abc'], 'claude:abc', null, []])
    const none = db([])
    await expect(addTag(none, { entityType: 'conversation', sessionKey: 'claude:none', tag: 'topic:x' }, 'alice')).rejects.toThrow(/no conversation captured/)
  })
})

describe('lookups', () => {
  it('tagsForConversations groups by conversation and dedupes ids', async () => {
    const pool = db([{ ...row({ entity_id: 'c1' }), conversation_id: 'c1' }, { ...row({ id: 't2', entity_id: 'c1', key: 'topic', value: 'x' }), conversation_id: 'c1' }, { ...row({ id: 't3', entity_id: 'c2' }), conversation_id: 'c2' }])
    const map = await tagsForConversations(pool, ['c1', 'c2', 'c1', ''])
    expect([...map.keys()]).toEqual(['c1', 'c2'])
    expect(map.get('c1')?.map((t) => t.id)).toEqual(['t1', 't2'])
    const [, params] = pool.query.mock.calls[0] as unknown as [string, unknown[]]
    expect(params).toEqual([['c1', 'c2'], ['accepted']])
  })
  it('tagsForSessionKeys matches a den-spawned conversation stored under the bare native id', async () => {
    const UUID = 'a1b2c3d4-1111-4222-8333-444455556666'
    const pool = db([{ ...row({ entity_id: 'c1' }), session_key: UUID }])
    const map = await tagsForSessionKeys(pool, [`claude-code:${UUID}`, 'codex:other'])
    // Returned under the key the caller asked with, not the stored one.
    expect([...map.keys()]).toEqual([`claude-code:${UUID}`])
    expect(map.get(`claude-code:${UUID}`)?.[0].id).toBe('t1')
    const [, params] = pool.query.mock.calls[0] as unknown as [string, unknown[]]
    expect(params[0]).toEqual([`claude-code:${UUID}`, UUID, 'codex:other', 'other'])
    // Shapes the request cannot derive: Claude's path form, and any harness prefix for a bare uuid.
    // Only the asking harness's path form: a canonical ask never crosses harnesses.
    expect(params[2]).toEqual([`claude-code:%/${UUID}`])
  })

  it('tagsForSessionKeys answers a canonical ask from a path-form stored key, and a bare ask from a canonical one', async () => {
    const UUID = 'a1b2c3d4-1111-4222-8333-444455556666'
    const path = db([{ ...row({ entity_id: 'c1' }), session_key: `claude-code:-home-rivet-proj/${UUID}` }])
    const fromCanonical = await tagsForSessionKeys(path, [`claude-code:${UUID}`])
    expect(fromCanonical.get(`claude-code:${UUID}`)?.[0].id).toBe('t1')
    const canonical = db([{ ...row({ entity_id: 'c1' }), session_key: `claude-code:${UUID}` }])
    const fromBare = await tagsForSessionKeys(canonical, [UUID])
    expect(fromBare.get(UUID)?.[0].id).toBe('t1')
    // An unrelated stored key that merely matched a pattern answers for nobody.
    const stray = db([{ ...row({ entity_id: 'c9' }), session_key: 'codex:something-else' }])
    expect((await tagsForSessionKeys(stray, [UUID])).size).toBe(0)
  })

  it('sessionKeyMatchers: any-harness patterns only for a bare uuid ask', () => {
    const UUID = 'a1b2c3d4-1111-4222-8333-444455556666'
    expect(sessionKeyMatchers(UUID).like).toEqual([`%:${UUID}`, `%/${UUID}`])
    expect(sessionKeyMatchers(`claude-code:${UUID}`).like).toEqual([`claude-code:%/${UUID}`])
    expect(sessionKeyMatchers(`claude-code:-slug/${UUID}`).like).toEqual([`claude-code:%/${UUID}`])
    expect(sessionKeyMatchers('codex:chat-20260707-abcd').like).toEqual([])
    expect(sessionKeyMatchers('task:123').like).toEqual([])
  })

  it('tagsForSessionKeys does not duplicate a tag carried by both the canonical and the bare conversation', async () => {
    const UUID = 'a1b2c3d4-1111-4222-8333-444455556666'
    const pool = db([
      { ...row({ id: 'a', entity_id: 'c1' }), session_key: UUID },
      { ...row({ id: 'b', entity_id: 'c2' }), session_key: `claude-code:${UUID}` },
    ])
    const map = await tagsForSessionKeys(pool, [`claude-code:${UUID}`])
    expect(map.get(`claude-code:${UUID}`)).toHaveLength(1)
  })

  it('tagsForSessionKeys returns an empty map without a query for no keys', async () => {
    const pool = db()
    expect((await tagsForSessionKeys(pool, [])).size).toBe(0)
    expect(pool.query).not.toHaveBeenCalled()
  })
  it('conversationIdsWithTag normalizes and covers summary-only tags', async () => {
    const pool = db([{ id: 'c9' }])
    expect(await conversationIdsWithTag(pool, 'Project', 'AcmeApp')).toEqual(['c9'])
    const [sql, params] = pool.query.mock.calls[0] as unknown as [string, unknown[]]
    expect(sql).toMatch(/COALESCE\(c\.id, s\.conversation_id\)/)
    expect(params).toEqual(['project', 'acmeapp'])
  })
  it('tagCounts parses counts', async () => {
    const pool = db([{ key: 'project', value: 'acmeapp', display: 'AcmeApp', n: '7' }])
    expect(await tagCounts(pool, 'project')).toEqual([{ key: 'project', value: 'acmeapp', display: 'AcmeApp', conversations: 7 }])
  })
})

describe('taxonomy', () => {
  it('decideTaxonomy caps the batch', async () => {
    const many = Array.from({ length: 501 }, (_, n) => ({ key: 'topic', value: `v${String(n)}` }))
    await expect(decideTaxonomy(db(), many, 'accepted')).rejects.toThrow(/at most 500/)
  })

  it('upsertTaxonomy normalizes, forbids self-parent, and flags whether parent was given', async () => {
    const saved = {
      key: 'topic',
      value: 'rivethub',
      display: 'RivetHub',
      parent_value: 'rivetos',
      aliases: [],
      state: 'accepted',
      source: 'user',
      reason: '',
      decided_at: NOW,
      created_at: NOW,
      updated_at: NOW,
    }
    const query = vi.fn(async (sql: string) =>
      String(sql).includes('SELECT parent_value')
        ? { rows: [{ parent_value: null }], rowCount: 1 } // rivetos exists, top-level
        : { rows: [saved], rowCount: 1 },
    )
    const pool = { query } as unknown as pg.Pool
    const e = await upsertTaxonomy(pool, {
      key: 'Topic',
      value: 'RivetHub',
      parentValue: 'RivetOS',
      display: 'RivetHub',
    })
    expect(e).toMatchObject({ key: 'topic', value: 'rivethub', parentValue: 'rivetos', state: 'accepted' })
    const insert = query.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO ros_tag_taxonomy')) as unknown as [string, unknown[]]
    expect(insert[1]).toEqual(['topic', 'rivethub', 'RivetHub', 'rivetos', null, 'accepted', 'user', '', true])
    await expect(upsertTaxonomy(pool, { key: 'topic', value: 'x', parentValue: 'X' })).rejects.toThrow(/own parent/)
  })
  it('upsertTaxonomy refuses a parent that is not in the vocabulary', async () => {
    const query = vi.fn(async () => ({ rows: [], rowCount: 0 }))
    await expect(
      upsertTaxonomy({ query } as unknown as pg.Pool, { key: 'topic', value: 'child', parentValue: 'ghost' }),
    ).rejects.toThrow(/topic:ghost is not in the vocabulary/)
    expect(query).toHaveBeenCalledTimes(1)
  })

  it('upsertTaxonomy refuses a parent that would close a cycle', async () => {
    // a ⊂ b already; setting b ⊂ a must fail: walking up from a reaches b.
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql.includes('SELECT parent_value')) {
        return { rows: [{ parent_value: (params as string[])[1] === 'a' ? 'b' : null }], rowCount: 1 }
      }
      return { rows: [], rowCount: 0 }
    })
    await expect(
      upsertTaxonomy({ query } as unknown as pg.Pool, { key: 'topic', value: 'b', parentValue: 'a' }),
    ).rejects.toThrow(/cycle/)
    expect(query.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO ros_tag_taxonomy'))).toBe(false)
  })

  it('mergeTaxonomyValue runs in one transaction on a Pool and rolls back on failure', async () => {
    const calls: string[] = []
    const client = {
      query: vi.fn(async (sql: string) => {
        calls.push(String(sql).trim().split(/\s+/).slice(0, 3).join(' '))
        if (String(sql).includes('DELETE FROM ros_tags')) throw new Error('boom')
        if (String(sql).includes('UNION ALL')) return { rows: [{ '?column?': 1 }], rowCount: 1 }
        return { rows: [], rowCount: 1 }
      }),
      release: vi.fn(),
    }
    const poolLike = { query: vi.fn(), connect: vi.fn(async () => client), totalCount: 1 }
    await expect(
      mergeTaxonomyValue(poolLike as unknown as pg.Pool, 'topic', 'old', 'new'),
    ).rejects.toThrow(/boom/)
    expect(calls[0]).toBe('BEGIN')
    expect(calls.at(-1)).toBe('ROLLBACK')
    expect(client.release).toHaveBeenCalledOnce()
    expect(poolLike.query).not.toHaveBeenCalled()
  })

  it('mergeTaxonomyValue aliases, moves (clearing display), drops duplicates, retires the old value and re-homes its children', async () => {
    const query = vi.fn(async (sql: string) => {
      const text = String(sql)
      if (text.includes('= ANY(aliases) AND state')) return { rows: [], rowCount: 0 }
      if (text.includes('UNION ALL')) return { rows: [{ '?column?': 1 }], rowCount: 1 }
      if (text.includes('UPDATE ros_tags t SET value')) return { rows: [], rowCount: 4 }
      if (text.includes('DELETE FROM ros_tags')) return { rows: [], rowCount: 1 }
      return { rows: [], rowCount: 0 }
    })
    const r = await mergeTaxonomyValue({ query } as unknown as pg.Pool, 'topic', 'Wiki-Pages', 'wiki')
    expect(r).toEqual({ moved: 4, dropped: 1, into: 'wiki' })
    const sqls = query.mock.calls.map(([sql]) => String(sql).replace(/\s+/g, ' '))
    const at = (needle: string): number => sqls.findIndex((x) => x.includes(needle))
    expect(at('INSERT INTO ros_tag_taxonomy')).toBeGreaterThan(-1)
    // Entities carrying both values: the decided row wins before the old rows are dropped.
    expect(at('SET state = t.state, decided_by = t.decided_by')).toBeGreaterThan(at('UPDATE ros_tags t SET value'))
    expect(at('SET state = t.state, decided_by = t.decided_by')).toBeLessThan(
      at('DELETE FROM ros_tags WHERE key = $1 AND value = $2'),
    )
    expect(sqls[at('UPDATE ros_tags t SET value')]).toContain("SET value = $3, display = ''")
    expect(at('DELETE FROM ros_tags WHERE key = $1 AND value = $2')).toBeGreaterThan(
      at('UPDATE ros_tags t SET value'),
    )
    expect(sqls[at("SET state = 'rejected'")]).toContain("aliases = '{}', parent_value = NULL")
    expect(at('SET parent_value = $3')).toBeGreaterThan(-1)
    expect(at('array_remove(aliases, $2)')).toBeGreaterThan(-1)
    const move = query.mock.calls[at('UPDATE ros_tags t SET value')] as unknown as [string, unknown[]]
    expect(move[1]).toEqual(['topic', 'wiki-pages', 'wiki'])
    await expect(
      mergeTaxonomyValue({ query } as unknown as pg.Pool, 'topic', 'a', 'A'),
    ).rejects.toThrow(/two different values/)
  })

  it('mergeTaxonomyValue refuses a value that is neither in the vocabulary nor in use, and a target nested under it', async () => {
    const unknown = vi.fn(async () => ({ rows: [], rowCount: 0 }))
    await expect(
      mergeTaxonomyValue({ query: unknown } as unknown as pg.Pool, 'topic', 'typo', 'wiki'),
    ).rejects.toThrow(/topic:typo is not in the vocabulary or in use/)
    // rivethub ⊂ rivetos: merging rivetos INTO rivethub would re-home rivetos' children under their own descendant.
    const nested = vi.fn(async (sql: string, params?: unknown[]) => {
      const text = String(sql)
      if (text.includes('UNION ALL')) return { rows: [{ '?column?': 1 }], rowCount: 1 }
      if (text.includes('SELECT parent_value')) {
        return { rows: [{ parent_value: (params as string[])[1] === 'rivethub' ? 'rivetos' : null }], rowCount: 1 }
      }
      return { rows: [], rowCount: 0 }
    })
    await expect(
      mergeTaxonomyValue({ query: nested } as unknown as pg.Pool, 'topic', 'rivetos', 'rivethub'),
    ).rejects.toThrow(/topic:rivethub is nested under topic:rivetos/)
    expect(nested.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO ros_tag_taxonomy'))).toBe(false)
  })

  it('mergeTaxonomyValue follows a target that was itself merged away, and refuses a loop', async () => {
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      if (String(sql).includes('UNION ALL')) return { rows: [{ '?column?': 1 }], rowCount: 1 }
      if (String(sql).includes('= ANY(aliases) AND state')) {
        const target = (params as string[])[1]
        return target === 'old-wiki'
          ? { rows: [{ value: 'wiki' }], rowCount: 1 }
          : target === 'loop'
            ? { rows: [{ value: 'pages' }], rowCount: 1 }
            : { rows: [], rowCount: 0 }
      }
      return { rows: [], rowCount: 0 }
    })
    const pool = { query } as unknown as pg.Pool
    expect((await mergeTaxonomyValue(pool, 'topic', 'pages', 'old-wiki')).into).toBe('wiki')
    await expect(mergeTaxonomyValue(pool, 'topic', 'pages', 'loop')).rejects.toThrow(/invalid merge/)
  })
})
