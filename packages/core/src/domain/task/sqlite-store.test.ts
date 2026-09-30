/**
 * SqliteTaskStore contract — the same lifecycle as InMemoryTaskStore, plus
 * the file-backed cases (claim race, JSON round-trip, reopen).
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import type { NewTaskInput } from './store.js'
import { taskJobKey } from './store.js'
import { SqliteTaskStore } from './sqlite-store.js'

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

describe('SqliteTaskStore', () => {
  const dirs: string[] = []
  const openStores: SqliteTaskStore[] = []

  function open(enqueue?: (taskId: string) => void, tuning?: { sweepStaleMs?: number; awaitingInputTtlMs?: number }): {
    store: SqliteTaskStore
    path: string
  } {
    const dir = mkdtempSync(join(tmpdir(), 'ros-tasks-'))
    dirs.push(dir)
    const path = join(dir, 'tasks.db')
    const store = new SqliteTaskStore(path, enqueue, tuning)
    openStores.push(store)
    return { store, path }
  }

  afterEach(() => {
    for (const store of openStores) store.close()
    openStores.length = 0
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
    dirs.length = 0
  })

  it('runs the full lifecycle: create → claim → usage → finish', async () => {
    const enqueued: string[] = []
    const { store } = open((id) => enqueued.push(id))

    const task = await store.create(input())
    expect(task.status).toBe('queued')
    expect(task.sessionKey).toBe(taskJobKey(task.id))
    expect(enqueued).toEqual([task.id])

    const claimed = await store.claim(task.id, 'node-a')
    expect(claimed?.status).toBe('running')
    expect(claimed?.claimedBy).toBe('node-a')
    expect(claimed?.attempt).toBe(1)

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
    const { store } = open()
    const a = await store.create(input({ agentId: 'opus' }))
    await store.create(input({ agentId: 'grok' }))
    await store.claim(a.id, 'node-a')

    expect(await store.list({ agentId: 'grok' })).toHaveLength(1)
    expect(await store.list({ status: 'running' })).toHaveLength(1)
    expect(await store.list()).toHaveLength(2)
  })

  it('awaiting-input flip + send re-enqueues and stashes the message', async () => {
    const enqueued: string[] = []
    const { store } = open((id) => enqueued.push(id))
    const task = await store.create(input())
    await store.claim(task.id, 'node-a')
    await store.markAwaitingInput(task.id)
    expect((await store.get(task.id))?.status).toBe('awaiting-input')

    await store.send(task.id, 'continue please')
    expect((await store.get(task.id))?.pendingMessage).toBe('continue please')
    expect(enqueued).toEqual([task.id, task.id])

    const reclaimed = await store.claim(task.id, 'node-a')
    expect(reclaimed?.pendingMessage).toBe('continue please')
    expect(reclaimed?.attempt).toBe(2)
  })

  it('sweep requeues stale rows under max_attempts and fails at the cap', async () => {
    const enqueued: string[] = []
    const { store } = open((id) => enqueued.push(id), { sweepStaleMs: 0 })
    const retryable = await store.create(input({ maxAttempts: 2 }))
    const capped = await store.create(input({ maxAttempts: 1 }))
    const otherNode = await store.create(input({ maxAttempts: 1 }))
    await store.claim(retryable.id, 'node-a')
    await store.claim(capped.id, 'node-a')
    await store.claim(otherNode.id, 'node-b')
    enqueued.length = 0

    expect(await store.sweep('node-a')).toBe(2)
    expect((await store.get(retryable.id))?.status).toBe('queued')
    const failed = await store.get(capped.id)
    expect(failed?.status).toBe('failed')
    expect(failed?.error).toBe('worker_restarted')
    expect((await store.get(otherNode.id))?.status).toBe('running')
    expect(enqueued).toEqual([retryable.id])
  })

  it('sweep skips rows with a fresh heartbeat (overlapping old process)', async () => {
    const { store } = open()
    const task = await store.create(input({ maxAttempts: 2 }))
    await store.claim(task.id, 'node-a')

    expect(await store.sweep('node-a')).toBe(0)
    expect((await store.get(task.id))?.status).toBe('running')
  })

  it('markAwaitingInput refuses when a concurrent send stashed a message', async () => {
    const { store } = open()
    const task = await store.create(input())
    await store.claim(task.id, 'node-a')

    await store.send(task.id, 'raced message')
    expect(await store.markAwaitingInput(task.id)).toBe(false)
    expect(await store.takePendingMessage(task.id)).toBe('raced message')
    expect(await store.takePendingMessage(task.id)).toBeUndefined()
    expect(await store.markAwaitingInput(task.id)).toBe(true)
    expect((await store.get(task.id))?.status).toBe('awaiting-input')
  })

  it('recordTerminal inserts a terminal row with no enqueue; claim refuses it', async () => {
    const enqueued: string[] = []
    const { store } = open((id) => enqueued.push(id))
    const row = await store.recordTerminal(input({ goal: 'audited elsewhere' }), {
      status: 'completed',
      result: completedResult,
      startedAt: Date.now() - 500,
      durationMs: 500,
    })
    expect(enqueued).toHaveLength(0)
    expect(row.status).toBe('completed')
    expect(row.result?.summary).toBe('done')
    expect(row.durationMs).toBe(500)
    expect(await store.claim(row.id, 'node-a')).toBeUndefined()
  })

  it('markAwaitingInput persists the interim result snapshot', async () => {
    const { store } = open()
    const task = await store.create(input())
    await store.claim(task.id, 'node-a')
    expect(await store.markAwaitingInput(task.id, completedResult)).toBe(true)
    const row = await store.get(task.id)
    expect(row?.status).toBe('awaiting-input')
    expect(row?.result?.summary).toBe('done')
  })

  it('requestKill flips pre-terminal rows, returns prior status, no-ops on terminal', async () => {
    const { store } = open()
    const queued = await store.create(input())
    expect(await store.requestKill(queued.id)).toBe('queued')
    expect((await store.get(queued.id))?.status).toBe('killed')
    expect((await store.get(queued.id))?.error).toBe('Killed by parent')

    const parked = await store.create(input())
    await store.claim(parked.id, 'node-a')
    await store.markAwaitingInput(parked.id)
    expect(await store.requestKill(parked.id)).toBe('awaiting-input')

    const running = await store.create(input())
    await store.claim(running.id, 'node-a')
    expect(await store.requestKill(running.id)).toBe('running')
    const killedRow = await store.get(running.id)
    expect(killedRow?.error).toBe('Killed by parent')
    expect(killedRow?.durationMs).toBeDefined()

    expect(await store.requestKill(queued.id)).toBeUndefined()
    expect(await store.requestKill('nope')).toBeUndefined()
  })

  it('sweep times out expired awaiting-input rows and spares fresh ones', async () => {
    const expiring = open(undefined, { awaitingInputTtlMs: 0 }).store
    const expired = await expiring.create(input())
    await expiring.claim(expired.id, 'node-a')
    await expiring.markAwaitingInput(expired.id)
    expect(await expiring.sweep('node-a')).toBe(1)
    const row = await expiring.get(expired.id)
    expect(row?.status).toBe('timeout')
    expect(row?.error).toBe('awaiting-input expired')

    const fresh = open().store
    const parked = await fresh.create(input())
    await fresh.claim(parked.id, 'node-a')
    await fresh.markAwaitingInput(parked.id)
    expect(await fresh.sweep('node-a')).toBe(0)
    expect((await fresh.get(parked.id))?.status).toBe('awaiting-input')
  })

  it('budget.maxWallClockMs overrides the awaiting-input TTL', async () => {
    const { store } = open()
    const task = await store.create(input({ budget: { maxWallClockMs: 0 } }))
    await store.claim(task.id, 'node-a')
    await store.markAwaitingInput(task.id)
    expect(await store.sweep('node-a')).toBe(1)
    expect((await store.get(task.id))?.status).toBe('timeout')
  })

  it('onTerminal fires only when a row becomes terminal', async () => {
    const seen: Array<{ id: string; status: string }> = []
    const { store } = open(undefined, { sweepStaleMs: 0, awaitingInputTtlMs: 0 })
    store.onTerminal((id, status) => seen.push({ id, status }))

    const done = await store.create(input())
    await store.claim(done.id, 'node-a')
    await store.finish(done.id, 'completed', completedResult)

    const failed = await store.create(input())
    await store.claim(failed.id, 'node-a')
    await store.finish(failed.id, 'failed', {
      ...completedResult,
      verdict: 'failed',
      error: 'nope',
    })

    const killed = await store.create(input())
    await store.claim(killed.id, 'node-a')
    expect(await store.requestKill(killed.id)).toBe('running')
    expect(await store.requestKill(killed.id)).toBeUndefined()

    const requeued = await store.create(input({ maxAttempts: 2 }))
    await store.claim(requeued.id, 'node-a')
    const sweptFail = await store.create(input({ maxAttempts: 1 }))
    await store.claim(sweptFail.id, 'node-a')
    expect(await store.sweep('node-a')).toBe(2)

    const parked = await store.create(input())
    await store.claim(parked.id, 'node-a')
    expect(await store.markAwaitingInput(parked.id)).toBe(true)
    expect(seen.some((row) => row.id === parked.id)).toBe(false)
    expect(await store.sweep('node-a')).toBe(1)

    const audited = await store.recordTerminal(input({ goal: 'audited elsewhere' }), {
      status: 'completed',
      result: completedResult,
    })

    expect(seen).toEqual([
      { id: done.id, status: 'completed' },
      { id: failed.id, status: 'failed' },
      { id: killed.id, status: 'killed' },
      { id: sweptFail.id, status: 'failed' },
      { id: parked.id, status: 'timeout' },
    ])
    expect(seen.some((row) => row.id === requeued.id || row.id === audited.id)).toBe(false)
  })

  it('claim refuses a task pinned to another node and admits its own', async () => {
    const { store } = open()
    const pinned = await store.create(input({ nodeAffinity: 'node-b' }))
    expect(await store.claim(pinned.id, 'node-a')).toBeUndefined()
    const claimed = await store.claim(pinned.id, 'node-b')
    expect(claimed?.status).toBe('running')
  })

  it('two connections claim one row — exactly one wins', async () => {
    const { path } = open()
    const writer = openStores[0]
    const task = await writer?.create(input())
    if (!task) throw new Error('missing row')
    const a = new SqliteTaskStore(path)
    const b = new SqliteTaskStore(path)
    openStores.push(a, b)
    const [left, right] = await Promise.all([a.claim(task.id, 'node-a'), b.claim(task.id, 'node-b')])
    const winners = [left, right].filter((row) => row !== undefined)
    expect(winners).toHaveLength(1)
    expect(winners[0]?.status).toBe('running')
    expect(winners[0]?.attempt).toBe(1)
  })

  it('round-trips nested JSON and maps JSON null usage back to undefined', async () => {
    const { store } = open()
    const spec = { nested: { a: [1, 'x', null], ok: true }, auditOnly: false }
    const task = await store.create(
      input({
        spec,
        acceptanceCriteria: [{ id: 'c1', description: 'd', kind: 'manual' }],
        contextRefs: [{ kind: 'wiki', ref: 'page' }],
      }),
    )
    const back = await store.get(task.id)
    expect(back?.spec).toEqual(spec)
    expect(back?.acceptanceCriteria).toEqual([{ id: 'c1', description: 'd', kind: 'manual' }])
    expect(back?.contextRefs).toEqual([{ kind: 'wiki', ref: 'page' }])
    expect(back?.usage).toBeUndefined()
    expect(back?.result).toBeUndefined()
    expect(back?.eval).toBeUndefined()
  })

  it('recordEval and listOutcomes, including a diverged row', async () => {
    const { store } = open()
    const row = await store.create({
      goal: 'g',
      executor: 'chat-loop',
      agentId: 'outcome-agent',
      origin: 'api',
      acceptanceCriteria: [{ id: 'c1', description: 'd', kind: 'manual' }],
    })
    await store.claim(row.id, 'test-node')
    await store.finish(row.id, 'completed', {
      verdict: 'completed',
      summary: 's',
      artifacts: [],
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, turns: 1, wallClockMs: 1, costUsd: 0.02 },
    })
    await store.recordEval(row.id, {
      verdict: 'refuted',
      attempts: 1,
      verifierTaskIds: ['00000000-0000-0000-0000-000000000000'],
      criteriaReport: [{ id: 'c1', met: false, evidence: 'nope' }],
      diverged: true,
    })
    const back = await store.get(row.id)
    expect(back?.status).toBe('completed')
    expect(back?.result?.verdict).toBe('completed')
    expect(back?.eval?.verdict).toBe('refuted')
    expect(back?.evalAttempt).toBe(1)

    const rows = await store.listOutcomes({ agentId: 'outcome-agent' })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      agentId: 'outcome-agent',
      status: 'completed',
      executorVerdict: 'completed',
      evalVerdict: 'refuted',
      diverged: true,
      costUsd: 0.02,
    })
    expect(rows[0]?.day).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(await store.listOutcomes({ agentId: 'nobody' })).toHaveLength(0)
  })

  it('appends permission decisions and drops a forged log on create', async () => {
    const { store } = open()
    const task = await store.create(
      input({
        spec: { permissionDecisions: [{ decision: 'allow' }], keep: 1 },
      }),
    )
    expect(task.spec).toEqual({ keep: 1 })
    await store.appendPermissionDecision(task.id, {
      requestId: 'r1',
      tool: 'Bash',
      decision: 'deny',
      at: 1,
      message: 'no',
    })
    await store.appendPermissionDecision(task.id, {
      requestId: 'r2',
      tool: 'Edit',
      decision: 'timeout',
      at: 2,
    })
    expect((await store.get(task.id))?.spec.permissionDecisions).toEqual([
      { requestId: 'r1', tool: 'Bash', decision: 'deny', at: 1, message: 'no' },
      { requestId: 'r2', tool: 'Edit', decision: 'timeout', at: 2 },
    ])
    expect((await store.get(task.id))?.spec.keep).toBe(1)
  })

  it('dedupes harness session ids', async () => {
    const { store } = open()
    const task = await store.create(input())
    await store.appendHarnessSessionId(task.id, 'ses-1')
    await store.appendHarnessSessionId(task.id, 'ses-1')
    await store.appendHarnessSessionId(task.id, 'ses-2')
    expect((await store.get(task.id))?.harnessSessionIds).toEqual(['ses-1', 'ses-2'])
  })

  it('reenqueue wakes only a queued row; send on a missing id does not', async () => {
    const enqueued: string[] = []
    const { store } = open((id) => enqueued.push(id))
    const task = await store.create(input())
    enqueued.length = 0
    await store.reenqueue(task.id)
    expect(enqueued).toEqual([task.id])
    await store.claim(task.id, 'node-a')
    enqueued.length = 0
    await store.reenqueue(task.id)
    await store.send('missing', 'nope')
    expect(enqueued).toEqual([])
  })

  it('enqueue runs after the insert commits (a second connection can see the row)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ros-tasks-'))
    dirs.push(dir)
    const path = join(dir, 'tasks.db')
    const reader = new DatabaseSync(path)
    reader.exec('PRAGMA busy_timeout = 5000')
    const seen: string[] = []
    const store = new SqliteTaskStore(path, (id) => {
      const row = reader.prepare(`SELECT status FROM ros_tasks WHERE id = ?`).get(id) as
        | { status: string }
        | undefined
      expect(row?.status).toBe('queued')
      seen.push(id)
    })
    openStores.push(store)
    const task = await store.create(input())
    expect(seen).toEqual([task.id])
    reader.close()
  })

  it('reopen does not change the schema and keeps the row', async () => {
    const { store, path } = open()
    const task = await store.create(input({ goal: 'survives' }))
    store.close()

    const dump = (file: string): unknown[] => {
      const db = new DatabaseSync(file)
      try {
        return db
          .prepare(
            `SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY name`,
          )
          .all()
      } finally {
        db.close()
      }
    }
    const before = dump(path)
    const again = new SqliteTaskStore(path)
    openStores.push(again)
    expect(await again.isReady()).toBe(true)
    expect((await again.get(task.id))?.goal).toBe('survives')
    again.close()
    expect(dump(path)).toEqual(before)
  })

  it('listClaimable returns the oldest runnable row, not the newest list page', async () => {
    const { store, path } = open()
    const resume = await store.create(input({ goal: 'resume me' }))
    await store.claim(resume.id, 'n1')
    await store.markAwaitingInput(resume.id)
    await store.send(resume.id, 'go on')
    const fillers: string[] = []
    for (let i = 0; i < 500; i++) {
      const row = await store.create(input({ goal: `parked ${String(i)}` }))
      await store.claim(row.id, 'n1')
      await store.markAwaitingInput(row.id)
      fillers.push(row.id)
    }
    const db = new DatabaseSync(path)
    try {
      db.prepare(`UPDATE ros_tasks SET created_at = ? WHERE id = ?`).run(
        '2000-01-01T00:00:00.000Z',
        resume.id,
      )
      const later = db.prepare(`UPDATE ros_tasks SET created_at = ? WHERE id = ?`)
      fillers.forEach((id, i) => later.run(`2020-01-01T00:00:${String(i % 60).padStart(2, '0')}.000Z`, id))
    } finally {
      db.close()
    }
    const page = await store.list({ status: 'awaiting-input', limit: 500 })
    expect(page.some((row) => row.id === resume.id)).toBe(false)
    const claimable = await store.listClaimable('n1', 5)
    expect(claimable[0]?.id).toBe(resume.id)
    expect(claimable.every((row) => row.pendingMessage !== undefined)).toBe(true)

    const foreign = await store.create(input({ nodeAffinity: 'other' }))
    const local = await store.create(input({ nodeAffinity: 'n1' }))
    const ids = (await store.listClaimable('n1', 20)).map((row) => row.id)
    expect(ids).toContain(local.id)
    expect(ids).not.toContain(foreign.id)
  })

  it('opens in WAL mode', () => {
    const { path } = open()
    const db = new DatabaseSync(path)
    try {
      const mode = db.prepare(`PRAGMA journal_mode`).get() as { journal_mode: string }
      expect(mode.journal_mode).toBe('wal')
    } finally {
      db.close()
    }
  })
})
