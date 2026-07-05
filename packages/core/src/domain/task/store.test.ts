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

  it('sweep requeues stale rows under max_attempts and fails at the cap', async () => {
    // sweepStaleMs 0 → every heartbeat is already stale (claim stamps one).
    const store = new InMemoryTaskStore(undefined, { sweepStaleMs: 0 })
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

  it('sweep skips rows with a fresh heartbeat (overlapping old process)', async () => {
    const store = new InMemoryTaskStore() // default 90s window
    const task = await store.create(input({ maxAttempts: 2 }))
    await store.claim(task.id, 'node-a') // claim stamps last_heartbeat_at

    expect(await store.sweep('node-a')).toBe(0)
    expect((await store.get(task.id))?.status).toBe('running')
  })

  it('markAwaitingInput refuses when a concurrent send stashed a message', async () => {
    const store = new InMemoryTaskStore()
    const task = await store.create(input())
    await store.claim(task.id, 'node-a')

    // Interleaving: send() lands between the last turn and the park attempt.
    await store.send(task.id, 'raced message')
    expect(await store.markAwaitingInput(task.id)).toBe(false)
    // The message survives and is claimable exactly once.
    expect(await store.takePendingMessage(task.id)).toBe('raced message')
    expect(await store.takePendingMessage(task.id)).toBeUndefined()
    // With the message consumed, the park succeeds.
    expect(await store.markAwaitingInput(task.id)).toBe(true)
    expect((await store.get(task.id))?.status).toBe('awaiting-input')
  })

  it('sweep times out expired awaiting-input rows and spares fresh ones', async () => {
    // TTL 0 → parked rows expire immediately; fresh-branch store uses default.
    const expiring = new InMemoryTaskStore(undefined, { awaitingInputTtlMs: 0 })
    const expired = await expiring.create(input())
    await expiring.claim(expired.id, 'node-a')
    await expiring.markAwaitingInput(expired.id)
    expect(await expiring.sweep('node-a')).toBe(1)
    const row = await expiring.get(expired.id)
    expect(row?.status).toBe('timeout')
    expect(row?.error).toBe('awaiting-input expired')

    const fresh = new InMemoryTaskStore() // default 24h TTL
    const parked = await fresh.create(input())
    await fresh.claim(parked.id, 'node-a')
    await fresh.markAwaitingInput(parked.id)
    expect(await fresh.sweep('node-a')).toBe(0)
    expect((await fresh.get(parked.id))?.status).toBe('awaiting-input')
  })

  it('budget.maxWallClockMs overrides the awaiting-input TTL', async () => {
    const store = new InMemoryTaskStore() // default TTL 24h — budget wins
    const task = await store.create(input({ budget: { maxWallClockMs: 0 } }))
    await store.claim(task.id, 'node-a')
    await store.markAwaitingInput(task.id)
    expect(await store.sweep('node-a')).toBe(1)
    expect((await store.get(task.id))?.status).toBe('timeout')
  })
})

// ---------------------------------------------------------------------------
// Postgres store — scratch-schema integration, RIVETOS_TASKS_TEST_PG_URL only.
// ---------------------------------------------------------------------------

const TEST_PG_URL = process.env.RIVETOS_TASKS_TEST_PG_URL

describe('InMemoryTaskStore node affinity', () => {
  it('claim refuses a task pinned to another node and admits its own', async () => {
    const store = new InMemoryTaskStore()
    const pinned = await store.create(input({ nodeAffinity: 'node-b' }))
    expect(await store.claim(pinned.id, 'node-a')).toBeUndefined()
    const claimed = await store.claim(pinned.id, 'node-b')
    expect(claimed?.status).toBe('running')
  })
})

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

  it('claim refuses a task pinned to another node (affinity guard)', async () => {
    const pinned = await store.create(input({ nodeAffinity: 'node-b' }))
    expect(await store.claim(pinned.id, 'node-a')).toBeUndefined()
    const row = await store.get(pinned.id)
    expect(row?.status).toBe('queued')
    expect((await store.claim(pinned.id, 'node-b'))?.status).toBe('running')
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

  it('isReady is true with the migration applied', async () => {
    expect(await store.isReady()).toBe(true)
  })

  it('markAwaitingInput refuses when a concurrent send stashed a message', async () => {
    const task = await store.create(input())
    await store.claim(task.id, 'node-a')

    // Interleaving: send() lands between the last turn and the park attempt.
    await store.send(task.id, 'raced message')
    expect(await store.markAwaitingInput(task.id)).toBe(false)
    // The stashed message survives the refused park and is claimed once.
    expect(await store.takePendingMessage(task.id)).toBe('raced message')
    expect(await store.takePendingMessage(task.id)).toBeUndefined()
    // With the message consumed, the park succeeds.
    expect(await store.markAwaitingInput(task.id)).toBe(true)
    expect((await store.get(task.id))?.status).toBe('awaiting-input')
  })

  it('sweep requeues stale rows under max_attempts and fails at the cap, per node', async () => {
    // Unique node names — the scratch schema is shared across this suite's
    // tests, so sweeping 'node-a' would catch rows earlier tests left running.
    // staleStore: sweepStaleMs 0 → the claim-time heartbeat is already stale.
    const staleStore = new PgTaskStore(pool, { graphileSchema, sweepStaleMs: 0 })
    const retryable = await staleStore.create(input({ maxAttempts: 2 }))
    const capped = await staleStore.create(input({ maxAttempts: 1 }))
    const other = await staleStore.create(input({ maxAttempts: 1 }))
    await staleStore.claim(retryable.id, 'sweep-node-a')
    await staleStore.claim(capped.id, 'sweep-node-a')
    await staleStore.claim(other.id, 'sweep-node-b')

    expect(await staleStore.sweep('sweep-node-a')).toBe(2)
    expect((await staleStore.get(retryable.id))?.status).toBe('queued')
    expect(await jobCount(retryable.id)).toBe(1)
    const failed = await staleStore.get(capped.id)
    expect(failed?.status).toBe('failed')
    expect(failed?.error).toBe('worker_restarted')
    expect((await staleStore.get(other.id))?.status).toBe('running')
  })

  it('sweep skips running rows with a fresh heartbeat (overlapping old process)', async () => {
    // Default 90s window; claim stamps last_heartbeat_at = now().
    const task = await store.create(input({ maxAttempts: 2 }))
    await store.claim(task.id, 'sweep-node-fresh')
    expect(await store.sweep('sweep-node-fresh')).toBe(0)
    expect((await store.get(task.id))?.status).toBe('running')
  })

  it('sweep times out expired awaiting-input rows (budget TTL) and spares fresh ones', async () => {
    const expired = await store.create(input({ budget: { maxWallClockMs: 0 } }))
    await store.claim(expired.id, 'sweep-node-ttl')
    expect(await store.markAwaitingInput(expired.id)).toBe(true)

    const parked = await store.create(input()) // default 24h TTL
    await store.claim(parked.id, 'sweep-node-ttl')
    expect(await store.markAwaitingInput(parked.id)).toBe(true)

    expect(await store.sweep('sweep-node-ttl')).toBe(1)
    const row = await store.get(expired.id)
    expect(row?.status).toBe('timeout')
    expect(row?.error).toBe('awaiting-input expired')
    expect((await store.get(parked.id))?.status).toBe('awaiting-input')
  })

  it('claiming a task the sweep failed loses the CAS', async () => {
    const staleStore = new PgTaskStore(pool, { graphileSchema, sweepStaleMs: 0 })
    const task = await staleStore.create(input({ maxAttempts: 1 }))
    await staleStore.claim(task.id, 'sweep-node-c')
    await staleStore.sweep('sweep-node-c')
    expect(await staleStore.claim(task.id, 'sweep-node-c')).toBeUndefined()
  })
})
