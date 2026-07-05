/**
 * TaskStore tests.
 *
 * - InMemoryTaskStore: full lifecycle, no external deps.
 * - PgTaskStore: gated behind RIVETOS_TASKS_TEST_PG_URL (a DEDICATED test
 *   env var — deliberately NOT RIVETOS_PG_URL, so these can never point at
 *   the production datahub by accident). The suite creates its own scratch
 *   schemas (ros_tasks + graphile_worker) and drops them afterwards.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import pg from 'pg'
import { makeWorkerUtils, type WorkerUtils } from 'graphile-worker'
import type { NewTaskInput } from './store.js'
import { InMemoryTaskStore, PgTaskStore, taskJobKey, TASK_JOB_NAME } from './store.js'

function input(overrides?: Partial<NewTaskInput>): NewTaskInput {
  return {
    goal: 'Test the task store',
    executor: 'chat-loop',
    agentId: 'opus',
    origin: 'tool',
    budget: { maxTurns: 3 },
    ...overrides,
  }
}

const usage = {
  inputTokens: 10,
  outputTokens: 20,
  totalTokens: 30,
  turns: 1,
  wallClockMs: 100,
}

const completedResult = {
  verdict: 'completed' as const,
  summary: 'done',
  artifacts: [],
  usage,
}

// ---------------------------------------------------------------------------
// In-memory store
// ---------------------------------------------------------------------------

describe('InMemoryTaskStore', () => {
  it('runs the full lifecycle: create → claim → usage → finish', async () => {
    const enqueued: string[] = []
    const store = new InMemoryTaskStore((id) => enqueued.push(id))

    const task = await store.create(input())
    expect(task.status).toBe('queued')
    expect(task.sessionKey).toBe(taskJobKey(task.id))
    expect(enqueued).toEqual([task.id])

    const claimed = await store.claim(task.id, 'node-a')
    expect(claimed?.status).toBe('running')
    expect(claimed?.claimedBy).toBe('node-a')
    expect(claimed?.attempt).toBe(1)

    // Second claim loses the CAS.
    expect(await store.claim(task.id, 'node-b')).toBeUndefined()

    await store.updateUsage(task.id, usage)
    await store.finish(task.id, 'completed', completedResult)

    const done = await store.get(task.id)
    expect(done?.status).toBe('completed')
    expect(done?.result?.summary).toBe('done')
    expect(done?.usage?.totalTokens).toBe(30)
    expect(done?.completedAt).toBeDefined()
    expect(done?.durationMs).toBeDefined()
  })

  it('lists by status and agent', async () => {
    const store = new InMemoryTaskStore()
    const a = await store.create(input({ agentId: 'opus' }))
    await store.create(input({ agentId: 'grok' }))
    await store.claim(a.id, 'node-a')

    expect(await store.list({ agentId: 'grok' })).toHaveLength(1)
    expect(await store.list({ status: 'running' })).toHaveLength(1)
    expect(await store.list()).toHaveLength(2)
  })

  it('awaiting-input flip + send re-enqueues and stashes the message', async () => {
    const enqueued: string[] = []
    const store = new InMemoryTaskStore((id) => enqueued.push(id))
    const task = await store.create(input())
    await store.claim(task.id, 'node-a')
    await store.markAwaitingInput(task.id)
    expect((await store.get(task.id))?.status).toBe('awaiting-input')

    await store.send(task.id, 'continue please')
    expect((await store.get(task.id))?.pendingMessage).toBe('continue please')
    expect(enqueued).toEqual([task.id, task.id])

    // awaiting-input rows are claimable.
    const reclaimed = await store.claim(task.id, 'node-a')
    expect(reclaimed?.pendingMessage).toBe('continue please')
    expect(reclaimed?.attempt).toBe(2)
  })

  it('sweep requeues under max_attempts and fails at the cap', async () => {
    const store = new InMemoryTaskStore()
    const retryable = await store.create(input({ maxAttempts: 2 }))
    const capped = await store.create(input({ maxAttempts: 1 }))
    const otherNode = await store.create(input({ maxAttempts: 1 }))
    await store.claim(retryable.id, 'node-a')
    await store.claim(capped.id, 'node-a')
    await store.claim(otherNode.id, 'node-b')

    expect(await store.sweep('node-a')).toBe(2)
    expect((await store.get(retryable.id))?.status).toBe('queued')
    const failed = await store.get(capped.id)
    expect(failed?.status).toBe('failed')
    expect(failed?.error).toBe('worker_restarted')
    // Other node's row untouched.
    expect((await store.get(otherNode.id))?.status).toBe('running')
  })
})

// ---------------------------------------------------------------------------
// Postgres store — scratch-schema integration, RIVETOS_TASKS_TEST_PG_URL only.
// ---------------------------------------------------------------------------

const TEST_PG_URL = process.env.RIVETOS_TASKS_TEST_PG_URL

describe.skipIf(!TEST_PG_URL)('PgTaskStore (scratch schema)', () => {
  const suffix = Math.random().toString(36).slice(2, 10)
  const taskSchema = `ros_tasks_test_${suffix}`
  const graphileSchema = `graphile_test_${suffix}`
  let admin: pg.Pool
  let pool: pg.Pool
  let utils: WorkerUtils
  let store: PgTaskStore

  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: TEST_PG_URL, max: 1 })
    await admin.query(`CREATE SCHEMA ${taskSchema}`)

    pool = new pg.Pool({
      connectionString: TEST_PG_URL,
      max: 5,
      options: `-c search_path=${taskSchema},public`,
    })

    // Apply the real 0002 migration into the scratch schema.
    const sql = readFileSync(
      resolve(
        __dirname,
        '../../../../../plugins/memory/postgres/src/schema/migrations/0002_ros_tasks.sql',
      ),
      'utf8',
    )
    await pool.query(sql)

    // Install graphile-worker into its own scratch schema.
    utils = await makeWorkerUtils({ connectionString: TEST_PG_URL, schema: graphileSchema })
    await utils.migrate()

    store = new PgTaskStore(pool, { graphileSchema })
  }, 60_000)

  afterAll(async () => {
    await utils.release()
    await pool.end()
    await admin.query(`DROP SCHEMA IF EXISTS ${taskSchema} CASCADE`)
    await admin.query(`DROP SCHEMA IF EXISTS ${graphileSchema} CASCADE`)
    await admin.end()
  })

  async function jobCount(taskId: string): Promise<number> {
    const { rows } = await pool.query<{ n: string }>(
      `SELECT count(*) AS n FROM ${graphileSchema}.jobs
        WHERE task_identifier = $1 AND key = $2`,
      [TASK_JOB_NAME, taskJobKey(taskId)],
    )
    return Number(rows[0].n)
  }

  it('create inserts the row and enqueues the run-task job in one transaction', async () => {
    const task = await store.create(input())
    expect(task.status).toBe('queued')
    expect(task.sessionKey).toBe(taskJobKey(task.id))
    expect(await jobCount(task.id)).toBe(1)

    const fetched = await store.get(task.id)
    expect(fetched?.goal).toBe('Test the task store')
    expect(fetched?.budget).toEqual({ maxTurns: 3 })
  })

  it('claim CAS: two concurrent claims, exactly one wins', async () => {
    const task = await store.create(input())
    const [a, b] = await Promise.all([store.claim(task.id, 'node-a'), store.claim(task.id, 'node-b')])
    const winners = [a, b].filter(Boolean)
    expect(winners).toHaveLength(1)
    expect(winners[0]?.status).toBe('running')
    expect(winners[0]?.attempt).toBe(1)
  })

  it('send stashes pending_message and replaces the job under the same jobKey', async () => {
    const task = await store.create(input())
    await store.claim(task.id, 'node-a')
    await store.markAwaitingInput(task.id)

    await store.send(task.id, 'keep going')
    const row = await store.get(task.id)
    expect(row?.status).toBe('awaiting-input')
    expect(row?.pendingMessage).toBe('keep going')
    expect(await jobCount(task.id)).toBe(1) // replaced, not duplicated

    const reclaimed = await store.claim(task.id, 'node-a')
    expect(reclaimed?.pendingMessage).toBe('keep going')
  })

  it('finish records status, result, usage, and duration', async () => {
    const task = await store.create(input())
    await store.claim(task.id, 'node-a')
    await store.updateUsage(task.id, usage)
    await store.finish(task.id, 'completed', completedResult)

    const row = await store.get(task.id)
    expect(row?.status).toBe('completed')
    expect(row?.result?.verdict).toBe('completed')
    expect(row?.usage?.totalTokens).toBe(30)
    expect(row?.completedAt).toBeDefined()
    expect(row?.durationMs).toBeGreaterThanOrEqual(0)
    expect(row?.pendingMessage).toBeUndefined()
  })

  it('sweep requeues under max_attempts and fails at the cap, per node', async () => {
    // Unique node names — the scratch schema is shared across this suite's
    // tests, so sweeping 'node-a' would catch rows earlier tests left running.
    const retryable = await store.create(input({ maxAttempts: 2 }))
    const capped = await store.create(input({ maxAttempts: 1 }))
    const other = await store.create(input({ maxAttempts: 1 }))
    await store.claim(retryable.id, 'sweep-node-a')
    await store.claim(capped.id, 'sweep-node-a')
    await store.claim(other.id, 'sweep-node-b')

    expect(await store.sweep('sweep-node-a')).toBe(2)
    expect((await store.get(retryable.id))?.status).toBe('queued')
    expect(await jobCount(retryable.id)).toBe(1)
    const failed = await store.get(capped.id)
    expect(failed?.status).toBe('failed')
    expect(failed?.error).toBe('worker_restarted')
    expect((await store.get(other.id))?.status).toBe('running')
  })

  it('claiming a task the sweep failed loses the CAS', async () => {
    const task = await store.create(input({ maxAttempts: 1 }))
    await store.claim(task.id, 'sweep-node-c')
    await store.sweep('sweep-node-c')
    expect(await store.claim(task.id, 'sweep-node-c')).toBeUndefined()
  })
})
