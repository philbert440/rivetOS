import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import pg from 'pg'
import { PgAgentPresetStore } from './pg-store.js'
import { PresetConflictError, type AgentPresetInput } from './store.js'
import {
  describePresetStoreContract,
  type RawPresetSeed,
  type StoredPreset,
} from './test/store-contract.test-helper.js'

function seedRawRow(pool: pg.Pool, row: RawPresetSeed): Promise<unknown> {
  return pool.query(
    `INSERT INTO ros_agent_presets (
       id, name, color, harness_id, model, effort, system_prompt,
       node, directory, shared_link, node_base_url, created_at, updated_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [
      row.id,
      row.name,
      row.color ?? '',
      row.harnessId,
      row.model,
      row.effort ?? 'medium',
      row.systemPrompt ?? '',
      row.node,
      row.directory,
      row.sharedLink ?? true,
      row.nodeBaseUrl ?? '',
      new Date(row.createdAt ?? 1),
      new Date(row.updatedAt ?? 1),
    ],
  )
}

async function readStoredRow(pool: pg.Pool, id: string): Promise<StoredPreset | undefined> {
  const result = await pool.query<{
    name: string
    model: string
    harness_id: string | null
    shared_link: boolean
  }>('SELECT name, model, harness_id, shared_link FROM ros_agent_presets WHERE id = $1', [id])
  const row = result.rows[0]
  if (!row) return undefined
  return {
    name: row.name,
    model: row.model,
    harnessId: row.harness_id,
    sharedLink: row.shared_link,
  }
}

const TEST_PG_URL = process.env.RIVETOS_TASKS_TEST_PG_URL
const MIGRATION_SQL = readFileSync(
  resolve(
    __dirname,
    '../../../plugins/memory/postgres/src/schema/migrations/0017_agent_presets.sql',
  ),
  'utf8',
)
const SORT_ORDER_SQL = readFileSync(
  resolve(
    __dirname,
    '../../../plugins/memory/postgres/src/schema/migrations/0018_agent_preset_sort_order.sql',
  ),
  'utf8',
)
const NOW = 1_700_000_000_000

function input(overrides: Partial<AgentPresetInput> = {}): AgentPresetInput {
  return {
    name: 'Reviewer',
    node: 'ct115',
    directory: '/tmp/agents/reviewer',
    ...overrides,
  }
}

describe.skipIf(!TEST_PG_URL)('PgAgentPresetStore (scratch schema)', () => {
  const suffix = Math.random().toString(36).slice(2, 10)
  const schema = `ros_agent_presets_test_${suffix}`
  const emptySchema = `ros_agent_presets_empty_${suffix}`
  const pre0018Schema = `ros_agent_presets_pre0018_${suffix}`
  let admin: pg.Pool
  let pool: pg.Pool
  let emptyPool: pg.Pool
  let pre0018Pool: pg.Pool
  let store: PgAgentPresetStore

  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: TEST_PG_URL, max: 1 })
    await admin.query(`CREATE SCHEMA ${schema}`)
    await admin.query(`CREATE SCHEMA ${emptySchema}`)
    await admin.query(`CREATE SCHEMA ${pre0018Schema}`)
    pre0018Pool = new pg.Pool({
      connectionString: TEST_PG_URL,
      max: 1,
      options: `-c search_path=${pre0018Schema}`,
    })
    await pre0018Pool.query(MIGRATION_SQL)

    emptyPool = new pg.Pool({
      connectionString: TEST_PG_URL,
      max: 1,
      options: `-c search_path=${emptySchema}`,
    })
    const unready = new PgAgentPresetStore(emptyPool)
    expect(await unready.isReady()).toBe(false)

    pool = new pg.Pool({
      connectionString: TEST_PG_URL,
      max: 4,
      options: `-c search_path=${schema}`,
    })
    store = new PgAgentPresetStore(pool, { now: () => NOW })
    expect(await store.isReady()).toBe(false)
    await pool.query(MIGRATION_SQL)
    await pool.query(SORT_ORDER_SQL)
    expect(await store.isReady()).toBe(true)
    expect(await store.isReady()).toBe(true)
  }, 60_000)

  beforeEach(async () => {
    await pool.query('DELETE FROM ros_agent_presets')
  })

  afterAll(async () => {
    await pool?.end()
    await emptyPool?.end()
    await pre0018Pool?.end()
    if (admin) {
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
      await admin.query(`DROP SCHEMA IF EXISTS ${emptySchema} CASCADE`)
      await admin.query(`DROP SCHEMA IF EXISTS ${pre0018Schema} CASCADE`)
      await admin.end()
    }
  })

  it('before 0018: lists by creation time and names the migration when ordering', async () => {
    const legacy = new PgAgentPresetStore(pre0018Pool, { now: () => NOW })
    const older = await legacy.create(input({ name: 'Older', createdAt: 1_000 }))
    await legacy.create(input({ name: 'Newer', createdAt: 2_000 }))
    expect((await legacy.list()).map((p) => p.name)).toEqual(['Older', 'Newer'])
    await expect(legacy.update(older.id, { sortOrder: 0 })).rejects.toThrow(
      /0018_agent_preset_sort_order/,
    )
    expect((await legacy.get(older.id))?.sortOrder).toBeUndefined()
  })

  it('is ready after 0017', async () => {
    expect(await store.isReady()).toBe(true)
  })

  it('fills create defaults and round-trips timestamps as epoch ms', async () => {
    const created = await store.create(
      input({ name: '  Reviewer  ', createdAt: 1_600_000_000_000 }),
    )
    expect(created).toMatchObject({
      name: 'Reviewer',
      color: '',
      model: '',
      effort: 'medium',
      systemPrompt: '',
      sharedLink: true,
      nodeBaseUrl: '',
      node: 'ct115',
      directory: '/tmp/agents/reviewer',
      createdAt: 1_600_000_000_000,
      updatedAt: NOW,
    })
    const got = await store.get(created.id)
    expect(got?.createdAt).toBe(1_600_000_000_000)
    expect(got?.updatedAt).toBe(NOW)
    const raw = await pool.query<{ created_at: Date; updated_at: Date }>(
      'SELECT created_at, updated_at FROM ros_agent_presets WHERE id = $1',
      [created.id],
    )
    expect(raw.rows[0]?.created_at.getTime()).toBe(1_600_000_000_000)
    expect(raw.rows[0]?.updated_at.getTime()).toBe(NOW)
  })

  it('persists a catalog model migration', async () => {
    const created = await store.create(input({ name: 'Legacy', model: 'claude' }))
    expect(created.harnessId).toBe('claude-code')
    expect(created.model).toBe('')
    const raw = await pool.query<{ model: string; harness_id: string | null }>(
      'SELECT model, harness_id FROM ros_agent_presets WHERE id = $1',
      [created.id],
    )
    expect(raw.rows[0]?.model).toBe('')
    expect(raw.rows[0]?.harness_id).toBe('claude-code')
  })

  it('resolves findByHandle as id, then exact name, then case-insensitive name', async () => {
    await store.create(input({ id: 'beta', name: 'Alpha', directory: '/a' }))
    await store.create(input({ id: 'id-b', name: 'beta', directory: '/b' }))
    await store.create(input({ id: 'id-c', name: 'Gamma', directory: '/c' }))
    expect((await store.findByHandle('beta'))?.id).toBe('beta')
    expect((await store.findByHandle('Alpha'))?.id).toBe('beta')
    expect((await store.findByHandle('gamma'))?.id).toBe('id-c')
    expect((await store.findByHandle('  gamma  '))?.id).toBe('id-c')
    expect(await store.findByHandle('missing')).toBeUndefined()
  })

  it('maps unique violations (23505) to PresetConflictError', async () => {
    await store.create(input({ name: 'Reviewer' }))
    await expect(store.create(input({ name: ' reviewer ' }))).rejects.toBeInstanceOf(
      PresetConflictError,
    )
    const other = await store.create(input({ name: 'Other', directory: '/tmp/agents/other' }))
    await expect(store.update(other.id, { name: 'REVIEWER' })).rejects.toBeInstanceOf(
      PresetConflictError,
    )
    await expect(
      store.create(input({ id: 'same', name: 'One', directory: '/one' })),
    ).resolves.toMatchObject({ id: 'same' })
    await expect(
      store.create(input({ id: 'same', name: 'Two', directory: '/two' })),
    ).rejects.toBeInstanceOf(PresetConflictError)
  })

  it('unsets harnessId without changing id, node, or createdAt', async () => {
    const created = await store.create(
      input({ harnessId: 'codex', model: 'opus', createdAt: 1_500_000_000_000 }),
    )
    const updated = await store.update(created.id, { harnessId: null })
    expect(updated?.harnessId).toBeUndefined()
    expect(updated?.model).toBe('opus')
    expect(updated?.id).toBe(created.id)
    expect(updated?.node).toBe('ct115')
    expect(updated?.createdAt).toBe(1_500_000_000_000)
    expect(updated?.updatedAt).toBe(NOW)
  })

  it('lands concurrent patches of different columns', async () => {
    const created = await store.create(input({ name: 'Orig', color: '#111111' }))
    await Promise.all([
      store.update(created.id, { name: 'FromA' }),
      store.update(created.id, { color: '#abcdef' }),
    ])
    const got = await store.get(created.id)
    expect(got?.name).toBe('FromA')
    expect(got?.color).toBe('#abcdef')
  })

  it('lists by createdAt then id, filters by node, and deletes', async () => {
    await store.create(input({ id: 'b', name: 'B', createdAt: 2_000, directory: '/b' }))
    await store.create(
      input({ id: 'c', name: 'C', createdAt: 1_000, directory: '/c', node: 'other' }),
    )
    await store.create(input({ id: 'a', name: 'A', createdAt: 1_000, directory: '/a' }))
    expect((await store.list()).map((preset) => preset.id)).toEqual(['a', 'c', 'b'])
    expect((await store.list({ node: 'ct115' })).map((preset) => preset.id)).toEqual(['a', 'b'])
    expect(await store.delete('missing')).toBe(false)
    expect(await store.delete('a')).toBe(true)
    expect(await store.get('a')).toBeUndefined()
    expect(await store.update('missing', { name: 'nope' })).toBeUndefined()
  })

  describePresetStoreContract({
    newStore: () => store,
    seedRaw: async (row) => {
      await seedRawRow(pool, row)
    },
    readStored: (id) => readStoredRow(pool, id),
  })
})
