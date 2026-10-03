/**
 * applyProjectRuleTag against real SQL: the once-per-conversation guard, the
 * rejected-row and rejected-vocabulary blocks, and the merge alias, none of
 * which a mock pool can prove. Needs RIVETOS_PG_URL (same gate as
 * schema/conversation-unique.test.ts); runs in a scratch schema.
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ProjectRuleResult } from '@rivetos/types'
import { applyProjectRuleTag } from './rule-project.js'
import { addTag } from './store.js'

const PG_URL = process.env.RIVETOS_PG_URL ?? ''
const SCHEMA = `tags_rule_${String(process.pid)}`
const MIGRATION = readFileSync(resolve(__dirname, '../schema/migrations/0019_tags.sql'), 'utf8')

const HIT: ProjectRuleResult = {
  key: 'project',
  value: 'rivetos',
  display: 'rivetOS',
  rule: 'git-remote',
  reason: 'git-remote: github.com/philbert440/rivetOS',
}

describe.skipIf(PG_URL === '')('applyProjectRuleTag (real Postgres)', () => {
  let pool: pg.Pool
  let client: pg.PoolClient

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: PG_URL, max: 1 })
    client = await pool.connect()
    await client.query(`CREATE SCHEMA ${SCHEMA}`)
    await client.query(`SET search_path = ${SCHEMA}`)
    await client.query(MIGRATION)
  })
  afterAll(async () => {
    await client.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`)
    client.release()
    await pool.end()
  })

  const conv = (): Promise<string> =>
    client.query<{ id: string }>('SELECT gen_random_uuid() AS id').then((r) => r.rows[0].id)
  const tagsOf = (id: string) =>
    client
      .query<{ value: string; state: string; source: string; decided_by: string | null }>(
        `SELECT value, state, source, decided_by FROM ros_tags WHERE entity_id = $1 ORDER BY value`,
        [id],
      )
      .then((r) => r.rows)
  /** Run inside a transaction, as capture does. */
  const apply = async (id: string, hit = HIT): Promise<boolean> => {
    await client.query('BEGIN')
    const wrote = await applyProjectRuleTag(client, id, hit, () => {})
    await client.query('COMMIT')
    return wrote
  }

  it('writes one accepted, attributed row and is a no-op on the next batch', async () => {
    const id = await conv()
    expect(await apply(id)).toBe(true)
    expect(await apply(id)).toBe(false)
    expect(await tagsOf(id)).toEqual([
      { value: 'rivetos', state: 'accepted', source: 'rule', decided_by: 'cwd-git-root' },
    ])
  })

  it('does not resurrect a rule tag the user rejected, nor add a second project from a later directory', async () => {
    const id = await conv()
    await apply(id)
    await client.query(`UPDATE ros_tags SET state = 'rejected' WHERE entity_id = $1`, [id])
    expect(await apply(id)).toBe(false)
    expect(await apply(id, { ...HIT, value: 'other-repo', display: 'other-repo' })).toBe(false)
    expect(await tagsOf(id)).toEqual([
      { value: 'rivetos', state: 'rejected', source: 'rule', decided_by: 'cwd-git-root' },
    ])
  })

  it('still counts its tag after a person re-added it (source promoted to user): no second project', async () => {
    const id = await conv()
    await apply(id)
    // A person re-adds the rule tag: addTag's conflict path promotes its source.
    await addTag(client, { entityType: 'conversation', entityId: id, tag: 'project:rivetos' }, 'phil')
    expect(await apply(id, { ...HIT, value: 'other-repo', display: 'other-repo' })).toBe(false)
    expect(await tagsOf(id)).toEqual([
      { value: 'rivetos', state: 'accepted', source: 'user', decided_by: 'phil' },
    ])
  })

  it('follows a vocabulary merge to the survivor and skips a rejected vocabulary value', async () => {
    await client.query(
      `INSERT INTO ros_tag_taxonomy (key, value, display, aliases, state)
       VALUES ('project', 'rivet-os', 'RivetOS', ARRAY['rivetos'], 'accepted'),
              ('project', 'scratch', '', '{}', 'rejected')`,
    )
    const merged = await conv()
    expect(await apply(merged)).toBe(true)
    expect((await tagsOf(merged)).map((t) => t.value)).toEqual(['rivet-os'])
    const rejected = await conv()
    expect(await apply(rejected, { ...HIT, value: 'scratch', display: 'scratch' })).toBe(false)
    expect(await tagsOf(rejected)).toEqual([])
  })

  it('a failing statement rolls back to the savepoint and leaves the outer transaction usable', async () => {
    const id = await conv()
    await client.query('BEGIN')
    await client.query('CREATE TEMP TABLE probe (n int) ON COMMIT DROP')
    await client.query('INSERT INTO probe VALUES (1)')
    // An oversized key violates the CHECK inside the savepoint.
    const wrote = await applyProjectRuleTag(
      client,
      id,
      { ...HIT, key: 'k'.repeat(65) as 'project' },
      () => {},
    )
    expect(wrote).toBe(false)
    const still = await client.query<{ n: number }>('SELECT n FROM probe')
    expect(still.rows).toEqual([{ n: 1 }])
    await client.query('COMMIT')
  })
})
