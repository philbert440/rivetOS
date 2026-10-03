/**
 * Tag store against real SQL: the review loop, lookups, vocabulary guards and
 * merge semantics that fake-pool tests cannot prove. Needs RIVETOS_PG_URL
 * (same gate as schema/conversation-unique.test.ts); runs in a scratch schema.
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import * as store from './store.js'

const PG_URL = process.env.RIVETOS_PG_URL ?? ''
const SCHEMA = `tags_store_${String(process.pid)}`
const MIGRATION = readFileSync(resolve(__dirname, '../schema/migrations/0019_tags.sql'), 'utf8')

describe.skipIf(PG_URL === '')('tag store (real Postgres)', () => {
  let pool: pg.Pool
  let c: pg.PoolClient

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: PG_URL, max: 1 })
    c = await pool.connect()
    await c.query(`CREATE SCHEMA ${SCHEMA}`)
    await c.query(`SET search_path = ${SCHEMA}`)
    await c.query(
      `CREATE TABLE ros_conversations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), session_key text, title text, agent text, updated_at timestamptz DEFAULT now());
       CREATE TABLE ros_summaries (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), conversation_id uuid, content text)`,
    )
    await c.query(MIGRATION)
  })
  afterAll(async () => {
    await c.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`)
    c.release()
    await pool.end()
  })
  beforeEach(async () => {
    await c.query('TRUNCATE ros_tags, ros_tag_taxonomy, ros_conversations, ros_summaries')
  })

  const conversation = (sessionKey: string, agent = 'rivet'): Promise<string> =>
    c
      .query<{ id: string }>(
        `INSERT INTO ros_conversations (session_key, title, agent) VALUES ($1, 'T', $2) RETURNING id`,
        [sessionKey, agent],
      )
      .then((r) => r.rows[0].id)
  const summaryOf = (conversationId: string): Promise<string> =>
    c
      .query<{ id: string }>(
        `INSERT INTO ros_summaries (conversation_id, content) VALUES ($1, 'summary') RETURNING id`,
        [conversationId],
      )
      .then((r) => r.rows[0].id)
  const raw = (
    entityType: string,
    entityId: string,
    key: string,
    value: string,
    state: string,
    source = 'model',
  ) =>
    c.query(
      `INSERT INTO ros_tags (entity_type, entity_id, key, value, display, source, state)
       VALUES ($1, $2, $3, $4, $4, $5, $6)`,
      [entityType, entityId, key, value, source, state],
    )
  const states = (entityId: string) =>
    c
      .query<{ value: string; state: string; display: string }>(
        `SELECT value, state, display FROM ros_tags WHERE entity_id = $1 ORDER BY value`,
        [entityId],
      )
      .then((r) => r.rows)

  it('add by session key (through its aliases), pending, decide, and a rejected row blocks re-suggestion', async () => {
    const uuid = 'a1b2c3d4-1111-4222-8333-444455556666'
    const conv = await conversation(uuid) // den-spawned: stored under the bare native id
    const added = await store.addTag(
      c,
      { entityType: 'conversation', sessionKey: `claude-code:${uuid}`, tag: 'Project:TenPAL' },
      'phil',
    )
    expect(added).toMatchObject({ entityId: conv, value: 'tenpal', display: 'TenPAL', state: 'accepted' })
    await raw('conversation', conv, 'topic', 'wiki-pages', 'suggested')
    const pending = await store.pendingTags(c, 10)
    expect(pending).toHaveLength(1)
    expect(pending[0]).toMatchObject({ sessionKey: uuid, title: 'T' })
    expect(await store.decideTags(c, [pending[0].id], 'rejected', 'phil')).toHaveLength(1)
    const again = await c.query(
      `INSERT INTO ros_tags (entity_type, entity_id, key, value, source, state)
       VALUES ('conversation', $1, 'topic', 'wiki-pages', 'model', 'suggested')
       ON CONFLICT (entity_type, entity_id, key, value) DO NOTHING`,
      [conv],
    )
    expect(again.rowCount).toBe(0)
    // Lookup under the canonical key returns the tags of the bare-keyed conversation.
    const map = await store.tagsForSessionKeys(c, [`claude-code:${uuid}`])
    expect(map.get(`claude-code:${uuid}`)?.map((t) => t.value)).toEqual(['tenpal'])
  })

  it('session key matching works in both directions: path-form and canonical stored keys', async () => {
    const uuid = 'b2c3d4e5-2222-4333-8444-555566667777'
    const pathConv = await conversation(`claude-code:-home-rivet-proj/${uuid}`)
    const added = await store.addTag(
      c,
      { entityType: 'conversation', sessionKey: `claude-code:${uuid}`, tag: 'project:rivetos' },
      'phil',
    )
    expect(added.entityId).toBe(pathConv)
    expect((await store.tagsForSessionKeys(c, [`claude-code:${uuid}`])).get(`claude-code:${uuid}`)).toHaveLength(1)
    expect((await store.tagsForSessionKeys(c, [uuid])).get(uuid)).toHaveLength(1)
    // The same uuid under another harness does not answer a canonical ask.
    const codexConv = await conversation(`codex:${uuid}`)
    await raw('conversation', codexConv, 'topic', 'codex-only', 'accepted')
    expect(
      (await store.tagsForSessionKeys(c, [`claude-code:${uuid}`])).get(`claude-code:${uuid}`)?.map((t) => t.value),
    ).toEqual(['rivetos'])
    await c.query('DELETE FROM ros_conversations WHERE id = $1', [codexConv])
    await c.query('DELETE FROM ros_tags WHERE entity_id = $1', [codexConv])
    // A different session's key is not matched by the patterns.
    const other = 'c3d4e5f6-3333-4444-8555-666677778888'
    expect((await store.tagsForSessionKeys(c, [`claude-code:${other}`])).size).toBe(0)
    // Same key under two agents: refused without an agent, resolved with one.
    await conversation(`claude-code:${uuid}`, 'grok')
    await expect(
      store.addTag(c, { entityType: 'conversation', sessionKey: `claude-code:${uuid}`, tag: 'topic:x' }, 'phil'),
    ).rejects.toThrow(/several agents/)
    const narrowed = await store.addTag(
      c,
      { entityType: 'conversation', sessionKey: `claude-code:${uuid}`, agent: 'rivet', tag: 'topic:x' },
      'phil',
    )
    expect(narrowed.entityId).toBe(pathConv)
  })

  it('re-adding the cwd rule tag makes it a user tag; other sources keep theirs', async () => {
    const conv = await conversation('codex:promote')
    await raw('conversation', conv, 'project', 'rivetos', 'accepted', 'rule')
    await raw('conversation', conv, 'topic', 'wiki', 'suggested', 'model')
    const promoted = await store.addTag(c, { entityType: 'conversation', entityId: conv, tag: 'project:rivetos' }, 'phil')
    expect(promoted).toMatchObject({ source: 'user', state: 'accepted', decidedBy: 'phil' })
    const kept = await store.addTag(c, { entityType: 'conversation', entityId: conv, tag: 'topic:wiki' }, 'phil')
    expect(kept).toMatchObject({ source: 'model', state: 'accepted' })
  })

  it('re-accepting a rejected rule tag promotes it; rejecting does not', async () => {
    const conv = await conversation('codex:reaccept')
    await raw('conversation', conv, 'project', 'rivetos', 'accepted', 'rule')
    const [{ id }] = (await c.query<{ id: string }>(`SELECT id FROM ros_tags WHERE entity_id = $1`, [conv])).rows
    await store.decideTags(c, [id], 'rejected', 'phil')
    expect((await c.query(`SELECT source FROM ros_tags WHERE id = $1`, [id])).rows[0]).toEqual({ source: 'rule' })
    await store.decideTags(c, [id], 'accepted', 'phil')
    expect((await c.query(`SELECT source FROM ros_tags WHERE id = $1`, [id])).rows[0]).toEqual({ source: 'user' })
  })

  it('a merge onto a rule survivor keeps the folded tag reviewed', async () => {
    const conv = await conversation('codex:merge-source')
    await raw('conversation', conv, 'project', 'a', 'accepted', 'rule')
    await store.addTag(c, { entityType: 'conversation', entityId: conv, tag: 'project:b' }, 'phil')
    await store.mergeTaxonomyValue(c, 'project', 'b', 'a')
    const rows = (
      await c.query(`SELECT value, source, state FROM ros_tags WHERE entity_id = $1 ORDER BY value`, [conv])
    ).rows
    expect(rows).toEqual([{ value: 'a', source: 'user', state: 'accepted' }])
  })

  it('tagsForConversations honours a row limit', async () => {
    const conv = await conversation('codex:limit')
    for (const v of ['a', 'b', 'c']) await raw('conversation', conv, 'topic', v, 'accepted')
    expect((await store.tagsForConversations(c, [conv])).get(conv)).toHaveLength(3)
    expect((await store.tagsForConversations(c, [conv], ['accepted'], { limit: 2 })).get(conv)).toHaveLength(2)
    expect((await store.tagsForConversations(c, [conv], ['accepted'], { limit: Number.NaN })).get(conv)).toHaveLength(3)
    expect(
      (await store.tagsForConversations(c, [conv], ['accepted'], { includeSummaryTags: true, limit: 1 })).get(conv),
    ).toHaveLength(1)
  })

  it('a pending summary suggestion carries its session key, title and agent', async () => {
    const conv = await conversation('codex:pending-sum')
    const sum = await summaryOf(conv)
    await raw('summary', sum, 'topic', 'wiki', 'suggested')
    const [p] = await store.pendingTags(c)
    expect(p).toMatchObject({
      entityType: 'summary',
      entityId: sum,
      conversationId: conv,
      sessionKey: 'codex:pending-sum',
      title: 'T',
      agent: 'rivet',
      excerpt: 'summary',
    })
  })

  it('tagCounts counts a conversation once whether the tag is on the session, a summary, or both', async () => {
    const a = await conversation('codex:count-a')
    const b = await conversation('codex:count-b')
    await raw('conversation', a, 'topic', 'wiki', 'accepted')
    await raw('summary', await summaryOf(a), 'topic', 'wiki', 'accepted')
    await raw('summary', await summaryOf(b), 'topic', 'wiki', 'accepted')
    await raw('summary', await summaryOf(b), 'topic', 'draft', 'suggested')
    // A tag whose entity is gone is not a tagged conversation.
    await raw('summary', '00000000-0000-4000-8000-000000000000', 'topic', 'wiki', 'accepted')
    expect(await store.tagCounts(c, 'topic')).toEqual([
      { key: 'topic', value: 'wiki', display: 'wiki', conversations: 2 },
    ])
    expect((await store.conversationIdsWithTag(c, 'topic', 'wiki')).sort()).toEqual([a, b].sort())
  })

  it('refuses an ambiguous session key however many conversations match', async () => {
    const uuid = 'd4e5f6a7-4444-4555-8666-777788889999'
    // 25 path-form conversations for one agent, then one more under another.
    for (let n = 0; n < 25; n += 1) await conversation(`claude-code:-proj-${String(n)}/${uuid}`)
    await c.query(
      `INSERT INTO ros_conversations (session_key, title, agent, updated_at) VALUES ($1, 'T', 'grok', now() - interval '1 day')`,
      [`claude-code:-old/${uuid}`],
    )
    await expect(
      store.addTag(c, { entityType: 'conversation', sessionKey: `claude-code:${uuid}`, tag: 'topic:x' }, 'phil'),
    ).rejects.toThrow(/several agents/)
  })

  it('"tagged" means the session or any of its summaries, for the id list, the shared predicate, and enrichment', async () => {
    const conv = await conversation('codex:xyz')
    const sum = await summaryOf(conv)
    await raw('summary', sum, 'topic', 'wiki', 'accepted')
    const other = await conversation('codex:other')
    await raw('conversation', other, 'topic', 'wiki', 'rejected')
    expect(await store.conversationIdsWithTag(c, 'topic', 'wiki')).toEqual([conv])
    const viaSql = await c.query<{ id: string }>(
      `SELECT m.id FROM ros_conversations m WHERE m.id IN ${store.taggedConversationsSql(1, 2)}`,
      ['topic', 'wiki'],
    )
    expect(viaSql.rows.map((r) => r.id)).toEqual([conv])
    expect((await store.tagsForConversations(c, [conv])).size).toBe(0)
    const enriched = await store.tagsForConversations(c, [conv], ['accepted'], { includeSummaryTags: true })
    expect(enriched.get(conv)?.map((t) => t.value)).toEqual(['wiki'])
  })

  it('vocabulary: parent must exist, cycles are refused, an empty parent is no parent', async () => {
    await store.upsertTaxonomy(c, { key: 'topic', value: 'rivetos' })
    await store.upsertTaxonomy(c, { key: 'topic', value: 'wiki', parentValue: 'rivetos' })
    await expect(
      store.upsertTaxonomy(c, { key: 'topic', value: 'rivetos', parentValue: 'wiki' }),
    ).rejects.toThrow(/cycle/)
    await expect(
      store.upsertTaxonomy(c, { key: 'topic', value: 'x', parentValue: 'ghost' }),
    ).rejects.toThrow(/not in the vocabulary/)
    const top = await store.upsertTaxonomy(c, { key: 'topic', value: 'solo', parentValue: '///' })
    expect(top.parentValue).toBeUndefined()
  })

  it('merge: moves tags, clears display, keeps the stronger decision, retires the old value, re-homes children', async () => {
    const a = await conversation('k:a') // only the old value
    const b = await conversation('k:b') // old accepted + new suggested → new must end accepted
    const d = await conversation('k:d') // old suggested + new accepted → stays accepted
    await raw('conversation', a, 'topic', 'wiki-pages', 'accepted')
    await raw('conversation', b, 'topic', 'wiki-pages', 'accepted')
    await raw('conversation', b, 'topic', 'wiki', 'suggested')
    await raw('conversation', d, 'topic', 'wiki-pages', 'suggested')
    await raw('conversation', d, 'topic', 'wiki', 'accepted')
    await store.upsertTaxonomy(c, { key: 'topic', value: 'wiki' })
    await store.upsertTaxonomy(c, { key: 'topic', value: 'wiki-pages' })
    await store.upsertTaxonomy(c, { key: 'topic', value: 'drafts', parentValue: 'wiki-pages' })

    const merged = await store.mergeTaxonomyValue(c, 'topic', 'Wiki-Pages', 'wiki')
    expect(merged).toEqual({ moved: 1, dropped: 2, into: 'wiki' })
    expect(await states(a)).toEqual([{ value: 'wiki', state: 'accepted', display: '' }])
    expect(await states(b)).toEqual([{ value: 'wiki', state: 'accepted', display: 'wiki' }])
    expect(await states(d)).toEqual([{ value: 'wiki', state: 'accepted', display: 'wiki' }])
    const tax = Object.fromEntries(
      (
        await c.query<{ value: string; state: string; aliases: string[]; parent_value: string | null }>(
          `SELECT value, state, aliases, parent_value FROM ros_tag_taxonomy WHERE key = 'topic'`,
        )
      ).rows.map((r) => [r.value, r]),
    )
    expect(tax.wiki).toMatchObject({ state: 'accepted', aliases: ['wiki-pages'] })
    expect(tax['wiki-pages']).toMatchObject({ state: 'rejected', parent_value: null })
    expect(tax.drafts.parent_value).toBe('wiki')
    // Merging into the retired value follows it to the survivor.
    await raw('conversation', a, 'topic', 'drafts', 'accepted')
    expect((await store.mergeTaxonomyValue(c, 'topic', 'drafts', 'wiki-pages')).into).toBe('wiki')
  })

  it('merge: a later rejection of the target is not overridden by an older acceptance, and vice versa', async () => {
    const conv = await conversation('k:e')
    await raw('conversation', conv, 'topic', 'old', 'accepted')
    await raw('conversation', conv, 'topic', 'new', 'rejected')
    await c.query(
      `UPDATE ros_tags SET decided_at = CASE value WHEN 'old' THEN now() - interval '2 days' ELSE now() END WHERE entity_id = $1`,
      [conv],
    )
    await store.mergeTaxonomyValue(c, 'topic', 'old', 'new')
    expect(await states(conv)).toEqual([{ value: 'new', state: 'rejected', display: 'new' }])

    const conv2 = await conversation('k:f')
    await raw('conversation', conv2, 'topic', 'old2', 'accepted')
    await raw('conversation', conv2, 'topic', 'new2', 'rejected')
    await c.query(
      `UPDATE ros_tags SET decided_at = CASE value WHEN 'new2' THEN now() - interval '2 days' ELSE now() END WHERE entity_id = $1`,
      [conv2],
    )
    await store.mergeTaxonomyValue(c, 'topic', 'old2', 'new2')
    expect(await states(conv2)).toEqual([{ value: 'new2', state: 'accepted', display: 'new2' }])
  })

  it('merge: refuses a typo and a target nested under the value being merged', async () => {
    await expect(store.mergeTaxonomyValue(c, 'topic', 'typo', 'wiki')).rejects.toThrow(
      /not in the vocabulary or in use/,
    )
    await store.upsertTaxonomy(c, { key: 'topic', value: 'rivetos' })
    await store.upsertTaxonomy(c, { key: 'topic', value: 'rivethub', parentValue: 'rivetos' })
    await store.upsertTaxonomy(c, { key: 'topic', value: 'docs', parentValue: 'rivethub' })
    await expect(store.mergeTaxonomyValue(c, 'topic', 'rivetos', 'rivethub')).rejects.toThrow(
      /topic:rivethub is nested under topic:rivetos/,
    )
    const parents = await c.query<{ value: string; parent_value: string | null }>(
      `SELECT value, parent_value FROM ros_tag_taxonomy WHERE key = 'topic' ORDER BY value`,
    )
    expect(parents.rows).toEqual([
      { value: 'docs', parent_value: 'rivethub' },
      { value: 'rivethub', parent_value: 'rivetos' },
      { value: 'rivetos', parent_value: null },
    ])
  })
})
