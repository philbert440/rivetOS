/**
 * WikiIndex integration tests — PG-gated (RIVETOS_WIKI_TEST_PG_URL), own
 * scratch schema per run; applies the real 0005 migration over a minimal
 * ros_summaries stub (the FK target — the real table needs the full
 * baseline, which is out of scope here).
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import pg from 'pg'
import { applyPatch } from '@rivetos/wiki-core'
import { WikiIndex } from './index-reader.js'

const TEST_PG_URL = process.env.RIVETOS_WIKI_TEST_PG_URL ?? process.env.RIVETOS_TASKS_TEST_PG_URL ?? ''
const describeIf = TEST_PG_URL ? describe : describe.skip

describeIf('WikiIndex (PG)', () => {
  const schema = `wiki_test_${Date.now()}`
  let admin: pg.Pool
  let pool: pg.Pool
  let index: WikiIndex

  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: TEST_PG_URL, max: 2 })
    await admin.query(`CREATE SCHEMA ${schema}`)
    pool = new pg.Pool({
      connectionString: TEST_PG_URL,
      max: 5,
      options: `-c search_path=${schema},public`,
    })
    await pool.query(
      'CREATE TABLE ros_summaries (id UUID PRIMARY KEY DEFAULT gen_random_uuid())',
    )
    const sql = readFileSync(resolve(__dirname, '../schema/migrations/0005_wiki.sql'), 'utf8')
    await pool.query(sql)
    index = new WikiIndex(pool)
    expect(await index.isReady()).toBe(true)
  }, 30_000)

  afterAll(async () => {
    await pool.end()
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
    await admin.end()
  })

  const page = (slug: string, state: string, extra?: Partial<Parameters<typeof applyPatch>[1]>) =>
    applyPatch(undefined, {
      action: 'create',
      slug,
      title: slug.replace(/-/g, ' '),
      currentState: state,
      addEntities: ['project:rivetos'],
      verifiedAt: '2026-07-07T00:00:00Z',
      ...extra,
    })

  it('upsert + get + list roundtrip; content change resets embed_status', async () => {
    await index.upsertTopic(page('rivetos-task-engine', 'ros_tasks is the only engine'), 'abc1234')
    const got = await index.getTopic('rivetos-task-engine')
    expect(got).toMatchObject({
      slug: 'rivetos-task-engine',
      gitSha: 'abc1234',
      currentState: 'ros_tasks is the only engine',
    })
    await pool.query(`UPDATE ros_wiki_topics SET embed_status = 'done' WHERE slug = $1`, [
      'rivetos-task-engine',
    ])
    // same content → embed_status preserved
    await index.upsertTopic(page('rivetos-task-engine', 'ros_tasks is the only engine'))
    let { rows } = await pool.query<{ embed_status: string | null }>(
      'SELECT embed_status FROM ros_wiki_topics WHERE slug = $1',
      ['rivetos-task-engine'],
    )
    expect(rows[0].embed_status).toBe('done')
    // alias change alters the search surface → reset too
    await index.upsertTopic(
      page('rivetos-task-engine', 'ros_tasks is the only engine', { addAliases: ['ros-tasks'] }),
    )
    ;({ rows } = await pool.query('SELECT embed_status FROM ros_wiki_topics WHERE slug = $1', [
      'rivetos-task-engine',
    ]))
    expect(rows[0].embed_status).toBeNull()

    const list = await index.listTopics({ entity: 'project:rivetos' })
    expect(list.total).toBe(1)
  })

  it('hybrid search finds by FTS and by fuzzy title; resolveTopic honors aliases', async () => {
    await index.upsertTopic(
      applyPatch(undefined, {
        action: 'create',
        slug: 'gerty-vllm-stack',
        title: 'GERTY vLLM stack',
        addAliases: ['pve3-llm'],
        currentState: 'Deckard W4A16 serves qwen-27b on pve3 port 8003 for the mesh.',
        verifiedAt: '2026-07-07T00:00:00Z',
      }),
    )
    // FTS retriever (vector needs an embedder — not wired in tests; the
    // purely semantic phrasing is covered by the hybrid design, not here).
    const byContent = await index.searchTopics('qwen-27b pve3')
    expect(byContent.map((h) => h.slug)).toContain('gerty-vllm-stack')
    const byFuzzy = await index.searchTopics('gerty vlm stak')
    expect(byFuzzy.map((h) => h.slug)).toContain('gerty-vllm-stack')

    const resolved = await index.resolveTopic('pve3-llm')
    expect(resolved.exact?.slug).toBe('gerty-vllm-stack')
  })

  it('provenance + extraction idempotency roundtrip', async () => {
    const { rows } = await pool.query<{ id: string }>(
      'INSERT INTO ros_summaries DEFAULT VALUES RETURNING id',
    )
    const summaryId = rows[0].id
    await index.recordProvenance(
      'gerty-vllm-stack',
      [{ kind: 'summary', ids: [summaryId], conversationId: undefined }],
      'abc1234',
    )
    await index.recordProvenance('gerty-vllm-stack', [{ kind: 'summary', ids: [summaryId] }]) // idempotent
    const prov = await pool.query('SELECT count(*) AS n FROM ros_wiki_provenance')
    expect(Number(prov.rows[0].n)).toBe(1)

    expect(await index.extractionDone(summaryId)).toBe(false)
    await index.markExtraction({ summaryId, status: 'done', pipelineVersion: 1, topicsTouched: ['gerty-vllm-stack'] })
    expect(await index.extractionDone(summaryId)).toBe(true)
    await index.markExtraction({ summaryId, status: 'failed', pipelineVersion: 1, error: 'llm down' })
    expect(await index.extractionDone(summaryId)).toBe(false)
  })

  it('gaps: stalest ordering + red links for unreferenced entities', async () => {
    await index.upsertTopic(
      applyPatch(undefined, {
        action: 'create',
        slug: 'phildesk',
        title: 'phildesk',
        addEntities: ['host:phildesk', 'host:ct999-missing'],
        currentState: 'WSL2 mesh peer.',
        verifiedAt: '2020-01-01T00:00:00Z',
      }),
    )
    const gaps = await index.gaps({ staleLimit: 2 })
    expect(gaps.stalest[0].slug).toBe('phildesk') // oldest last_verified first
    expect(gaps.redLinks.map((r) => r.entity)).toContain('host:ct999-missing')
  })
})
