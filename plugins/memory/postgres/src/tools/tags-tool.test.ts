import { describe, expect, it, vi } from 'vitest'
import type pg from 'pg'
import { createTagsTool } from './tags-tool.js'

const NOW = new Date('2026-10-02T12:00:00Z')
const PENDING = {
  id: '11111111-1111-4111-8111-111111111111',
  entity_type: 'conversation',
  entity_id: 'c1',
  key: 'topic',
  value: 'memory-compaction',
  display: 'Memory Compaction',
  source: 'model',
  state: 'suggested',
  confidence: 0.91,
  proposed_by: 'tagger-model',
  reason: 'the summary is about compaction',
  decided_by: null,
  decided_at: null,
  created_at: NOW,
  updated_at: NOW,
  session_key: 'claude:abc',
  title: 'Compaction fixes',
  agent: 'rivet',
  conversation_id: 'c1',
  excerpt: null,
}

function pool(handler: (sql: string, params?: unknown[]) => { rows: unknown[]; rowCount?: number }) {
  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    const r = handler(sql, params)
    return { rows: r.rows, rowCount: r.rowCount ?? r.rows.length }
  })
  return { query } as unknown as pg.Pool & { query: typeof query }
}

describe('memory_tags tool', () => {
  it('defaults to the pending review queue and renders ids, literal, confidence and context', async () => {
    const tool = createTagsTool(pool((sql) => (sql.includes("t.state = 'suggested'") ? { rows: [PENDING] } : { rows: [] })))
    const out = (await tool.execute({})) as string
    expect(out).toContain('1 pending')
    expect(out).toContain(`${PENDING.id}  topic:Memory Compaction (0.91)  ← session claude:abc "Compaction fixes"`)
    expect(out).toContain('the summary is about compaction')
  })

  it('decide validates and reports the count', async () => {
    const p = pool((sql) => (sql.includes('UPDATE ros_tags') ? { rows: [{ id: 'a' }, { id: 'b' }] } : { rows: [] }))
    const tool = createTagsTool(p, { decidedBy: 'rivet', allowWrite: true })
    expect(await tool.execute({ action: 'decide', ids: [] })).toBe('ids required')
    expect(await tool.execute({ action: 'decide', ids: ['a'], state: 'maybe' })).toMatch(/^bad state/)
    expect(await tool.execute({ action: 'decide', ids: ['a'], state: 'suggested' })).toBe('state must be accepted or rejected')
    const tooMany = Array.from({ length: 1001 }, (_, n) => `id-${String(n)}`)
    expect(await tool.execute({ action: 'decide', ids: tooMany, state: 'accepted' })).toBe('at most 1000 ids')
    expect(p.query).not.toHaveBeenCalled()
    expect(await tool.execute({ action: 'decide', ids: ['a', 'b'], state: 'accepted' })).toBe('2 tag(s) accepted.')
    const [, params] = p.query.mock.calls[0] as unknown as [string, unknown[]]
    expect(params).toEqual([['a', 'b'], 'accepted', 'rivet'])
  })

  it('add tags a session from a literal and reports the row', async () => {
    const p = pool((sql) =>
      sql.includes('INSERT INTO ros_tags')
        ? { rows: [{ ...PENDING, source: 'user', state: 'accepted', key: 'project', value: 'acmeapp', display: 'AcmeApp' }] }
        : { rows: [] },
    )
    const tool = createTagsTool(p, { allowWrite: true })
    expect(await tool.execute({ action: 'add', entity_type: 'conversation', entity_id: 'c1', tag: 'project:AcmeApp' })).toBe(
      `Added project:AcmeApp to conversation c1 (${PENDING.id}).`,
    )
    expect(await tool.execute({ action: 'add', tag: 'project:x' })).toBe('entity_type and entity_id (or session_key) required')
  })

  it('lookup lists tags per session key and marks suggestions with ?', async () => {
    const p = pool((sql) =>
      sql.includes('c.session_key = ANY')
        ? { rows: [{ ...PENDING, session_key: 'claude:abc' }, { ...PENDING, id: 'x', key: 'project', value: 'acmeapp', display: 'AcmeApp', state: 'accepted', session_key: 'claude:abc' }] }
        : { rows: [] },
    )
    const tool = createTagsTool(p)
    const out = await tool.execute({ action: 'lookup', session_keys: ['claude:abc', 'codex:none'] })
    expect(out).toBe('claude:abc: topic:Memory Compaction?, project:AcmeApp\ncodex:none: (none)')
  })

  it('surfaces store errors as a message instead of throwing', async () => {
    const tool = createTagsTool(pool(() => { throw new Error('connection refused') }))
    expect(await tool.execute({ action: 'counts' })).toBe('memory_tags failed: connection refused')
  })

  it('before migration 0019: reads say there are no tags, writes say tagging is not installed', async () => {
    const missing = () => { throw new Error('relation "ros_tags" does not exist') }
    const tool = createTagsTool(pool(missing), { allowWrite: true })
    expect(await tool.execute({ action: 'counts' })).toMatch(/^No tags \(session tagging is not installed/)
    expect(await tool.execute({ action: 'decide', ids: ['a'], state: 'accepted' })).toMatch(/not installed on this database yet \(migration 0019\)/)
  })

  it('an unknown state is an error on every action, not a silently dropped filter', async () => {
    const p = pool(() => ({ rows: [] }))
    const tool = createTagsTool(p)
    for (const action of ['list', 'taxonomy']) {
      expect(await tool.execute({ action, state: 'acepted' })).toMatch(/^bad state/)
    }
    expect(p.query).not.toHaveBeenCalled()
  })

  it('is read-only by default: every mutating action is refused without touching the pool', async () => {
    const p = pool(() => ({ rows: [] }))
    const tool = createTagsTool(p)
    for (const action of ['decide', 'add', 'taxonomy_upsert', 'taxonomy_decide', 'taxonomy_merge']) {
      expect(await tool.execute({ action, ids: ['a'], state: 'accepted' })).toMatch(/read-only surface/)
    }
    expect(p.query).not.toHaveBeenCalled()
    expect(await tool.execute({ action: 'counts' })).toBe('No accepted tags yet.')
  })

  it('a fixed decider (routed user) overrides both the default and a caller-supplied decided_by', async () => {
    const p = pool((sql) => (sql.includes('UPDATE ros_tags') ? { rows: [{ id: 'a' }] } : { rows: [] }))
    const tool = createTagsTool(p, { allowWrite: true, fixedDecider: 'alice' })
    await tool.execute({ action: 'decide', ids: ['a'], state: 'accepted', decided_by: 'someone-else' })
    const [, params] = p.query.mock.calls[0] as unknown as [string, unknown[]]
    expect(params).toEqual([['a'], 'accepted', 'alice'])
    expect(createTagsTool(p).description).toContain('READ-ONLY')
    expect(tool.description).not.toContain('READ-ONLY')
  })

  it('names unknown actions', async () => {
    const tool = createTagsTool(pool(() => ({ rows: [] })))
    expect(await tool.execute({ action: 'nope' })).toMatch(/Unknown action "nope"/)
  })
})
