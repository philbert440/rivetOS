import { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it } from 'vitest'
import { JobRunner, SqliteJobQueue, retryDelayMs } from './jobs.js'
import { SCHEMA } from './schema.js'

describe('SqliteJobQueue', () => {
  let db: DatabaseSync
  let clock: Date
  let queue: SqliteJobQueue

  beforeEach(() => {
    db = new DatabaseSync(':memory:')
    db.exec(SCHEMA)
    clock = new Date('2026-10-04T12:00:00Z')
    queue = new SqliteJobQueue(db, () => clock)
  })

  it('dedupes on the job key and claims the oldest due job first', () => {
    expect(queue.enqueue('embed-target', { id: 'a' }, { key: 'embed-a' })).toBe(true)
    expect(queue.enqueue('embed-target', { id: 'a2' }, { key: 'embed-a' })).toBe(false)
    clock = new Date(clock.getTime() + 1000)
    queue.enqueue('embed-target', { id: 'b' }, { key: 'embed-b' })
    queue.enqueue('other', {}, {})
    const job = queue.claim(['embed-target'])
    expect(job).toMatchObject({ task: 'embed-target', key: 'embed-a', payload: { id: 'a' }, attempts: 1 })
    // A running job is not claimed twice; the next due one is.
    expect(queue.claim(['embed-target'])?.key).toBe('embed-b')
    expect(queue.claim(['embed-target'])).toBeNull()
    expect(queue.claim([])).toBeNull()
  })

  it('does not claim a job before its run time', () => {
    queue.enqueue('t', {}, { runAt: new Date(clock.getTime() + 60_000) })
    expect(queue.claim(['t'])).toBeNull()
    clock = new Date(clock.getTime() + 61_000)
    expect(queue.claim(['t'])).not.toBeNull()
  })

  it('a failure retries with a growing delay, then goes dead and keeps its key', () => {
    queue.enqueue('t', {}, { key: 'k', maxAttempts: 2 })
    const first = queue.claim(['t'])
    expect(first).not.toBeNull()
    if (!first) return
    expect(queue.fail(first, 'boom')).toBe('retry')
    expect(queue.claim(['t'])).toBeNull()
    clock = new Date(clock.getTime() + retryDelayMs(1) + 1)
    const second = queue.claim(['t'])
    expect(second?.attempts).toBe(2)
    if (!second) return
    expect(queue.fail(second, 'boom again')).toBe('dead')
    clock = new Date(clock.getTime() + 24 * 3600 * 1000)
    expect(queue.claim(['t'])).toBeNull()
    // The dead row still holds the key: the same work is not queued again…
    expect(queue.enqueue('t', {}, { key: 'k' })).toBe(false)
    expect(queue.counts()).toEqual([{ task: 't', state: 'dead', count: 1 }])
    // …until it is requeued.
    expect(queue.requeueDead('t')).toBe(1)
    expect(queue.claim(['t'])?.attempts).toBe(1)
  })

  it('a finished job leaves no row, and an interrupted one is recovered', () => {
    queue.enqueue('t', {}, { key: 'done' })
    queue.enqueue('t', {}, { key: 'interrupted' })
    const a = queue.claim(['t'])
    if (a) queue.complete(a.id)
    queue.claim(['t'])
    expect(queue.counts()).toEqual([{ task: 't', state: 'running', count: 1 }])
    expect(queue.recoverRunning()).toBe(1)
    expect(queue.claim(['t'])?.key).toBe('interrupted')
  })

  it('retry delay doubles and is capped at an hour', () => {
    expect(retryDelayMs(1)).toBe(30_000)
    expect(retryDelayMs(2)).toBe(60_000)
    expect(retryDelayMs(30)).toBe(3_600_000)
  })
})

describe('JobRunner', () => {
  let db: DatabaseSync
  let clock: Date
  let queue: SqliteJobQueue

  beforeEach(() => {
    db = new DatabaseSync(':memory:')
    db.exec(SCHEMA)
    clock = new Date('2026-10-04T12:00:00Z')
    queue = new SqliteJobQueue(db, () => clock)
  })

  it('runs due jobs in order, completes them, and records failures without throwing', async () => {
    const seen: string[] = []
    const logs: string[] = []
    const runner = new JobRunner(queue, { log: (l) => logs.push(l), now: () => clock })
    runner.handle('ok', (payload) => {
      seen.push((payload as { n: string }).n)
    })
    runner.handle('bad', () => {
      throw new Error('nope')
    })
    queue.enqueue('ok', { n: '1' })
    clock = new Date(clock.getTime() + 1)
    queue.enqueue('bad', {}, { key: 'bad-1' })
    clock = new Date(clock.getTime() + 1)
    queue.enqueue('ok', { n: '2' })
    expect(await runner.tick()).toBe(3)
    expect(seen).toEqual(['1', '2'])
    expect(queue.counts()).toEqual([{ task: 'bad', state: 'queued', count: 1 }])
    expect(logs.join('\n')).toMatch(/bad bad-1 failed \(attempt 1\/5, retry\): nope/)
    // Nothing is due until the retry delay passes.
    expect(await runner.tick()).toBe(0)
  })

  it('runs a sweep on its interval and survives a sweep that throws', async () => {
    let sweeps = 0
    const runner = new JobRunner(queue, { now: () => clock })
    runner.sweep({ name: 'a', everyMs: 60_000, run: () => void (sweeps += 1) })
    runner.sweep({
      name: 'b',
      everyMs: 60_000,
      run: () => {
        throw new Error('sweep down')
      },
    })
    await runner.tick()
    await runner.tick()
    expect(sweeps).toBe(1)
    clock = new Date(clock.getTime() + 61_000)
    await runner.tick()
    expect(sweeps).toBe(2)
  })

  it('halt() stops claiming and leaves a job that was mid-flight for the next start', async () => {
    const runner = new JobRunner(queue, { now: () => clock })
    let release: () => void = () => {}
    runner.handle('slow', () => new Promise<void>((resolve) => (release = resolve)))
    queue.enqueue('slow', {}, { key: 's1' })
    queue.enqueue('slow', {}, { key: 's2' })
    const running = runner.tick()
    runner.halt()
    release()
    expect(await running).toBe(1)
    expect(queue.counts()).toEqual([
      { task: 'slow', state: 'queued', count: 1 },
      { task: 'slow', state: 'running', count: 1 },
    ])
    expect(await runner.tick()).toBe(0)
    expect(queue.recoverRunning()).toBe(1)
  })
})
