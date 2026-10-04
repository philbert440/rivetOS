/**
 * In-process job queue and runner for the SQLite backend.
 *
 * The Postgres backend runs its background work (embedding, compaction, wiki
 * extraction, tagging) as graphile-worker jobs in separate services. A
 * single-file store has no second process to hand work to, so the same job
 * names run here on one small loop inside the runtime: a `ros_jobs` table and
 * a runner that claims one due job at a time.
 *
 * Single writer, single process: a claim is one `BEGIN IMMEDIATE` transaction,
 * there is no row locking to coordinate. A job that was running when the
 * process died is returned to the queue on the next start.
 */

import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'

export interface Job {
  id: string
  task: string
  key: string | null
  payload: unknown
  /** Attempt number of this run, starting at 1. */
  attempts: number
  maxAttempts: number
}

export interface EnqueueOptions {
  /** Dedupe key: a queued or running job with the same key is left as it is. */
  key?: string
  /** Earliest run time. Default: now. */
  runAt?: Date
  /** Default 5. */
  maxAttempts?: number
}

export type JobHandler = (payload: unknown, job: Job) => Promise<void> | void

interface JobRow {
  id: string
  task: string
  job_key: string | null
  payload: string
  attempts: number
  max_attempts: number
}

const DEFAULT_MAX_ATTEMPTS = 5
/** First retry after 30 s, doubling, capped at one hour. */
const RETRY_BASE_MS = 30_000
const RETRY_MAX_MS = 60 * 60 * 1000

export function retryDelayMs(attempts: number): number {
  return Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1))
}

export class SqliteJobQueue {
  constructor(
    private readonly db: DatabaseSync,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Queue a job. Returns false when a job with the same key is already pending. */
  enqueue(task: string, payload: unknown, opts: EnqueueOptions = {}): boolean {
    const now = this.now().toISOString()
    const r = this.db
      .prepare(
        `INSERT INTO ros_jobs
           (id, task, job_key, payload, run_at, attempts, max_attempts, state, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 0, ?, 'queued', ?, ?)
         ON CONFLICT (job_key) DO NOTHING`,
      )
      .run(
        randomUUID(),
        task,
        opts.key ?? null,
        JSON.stringify(payload ?? null),
        (opts.runAt ?? this.now()).toISOString(),
        opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
        now,
        now,
      )
    return Number(r.changes) > 0
  }

  /** Take the oldest due job among `tasks`, marking it running. Null when none is due. */
  claim(tasks: readonly string[]): Job | null {
    if (tasks.length === 0) return null
    const now = this.now().toISOString()
    const marks = tasks.map(() => '?').join(', ')
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const row = this.db
        .prepare(
          `SELECT id, task, job_key, payload, attempts, max_attempts FROM ros_jobs
            WHERE state = 'queued' AND run_at <= ? AND task IN (${marks})
            ORDER BY run_at, created_at
            LIMIT 1`,
        )
        .get(now, ...tasks) as unknown as JobRow | undefined
      if (!row) {
        this.db.exec('COMMIT')
        return null
      }
      this.db
        .prepare(
          `UPDATE ros_jobs SET state = 'running', attempts = attempts + 1, locked_at = ?, updated_at = ?
            WHERE id = ?`,
        )
        .run(now, now, row.id)
      this.db.exec('COMMIT')
      let payload: unknown = null
      try {
        payload = JSON.parse(row.payload) as unknown
      } catch {
        payload = null
      }
      return {
        id: row.id,
        task: row.task,
        key: row.job_key,
        payload,
        attempts: row.attempts + 1,
        maxAttempts: row.max_attempts,
      }
    } catch (err) {
      try {
        this.db.exec('ROLLBACK')
      } catch {
        // ignore
      }
      throw err
    }
  }

  /** A finished job leaves no row. */
  complete(id: string): void {
    this.db.prepare(`DELETE FROM ros_jobs WHERE id = ?`).run(id)
  }

  /**
   * Record a failed run: back to the queue with a delay, or `dead` once the
   * attempts are used up. A dead job keeps its key, so the same work is not
   * queued again until it is requeued or removed.
   */
  fail(job: Pick<Job, 'id' | 'attempts' | 'maxAttempts'>, error: string): 'retry' | 'dead' {
    const now = this.now()
    const dead = job.attempts >= job.maxAttempts
    this.db
      .prepare(
        `UPDATE ros_jobs
            SET state = ?, run_at = ?, last_error = ?, locked_at = NULL, updated_at = ?
          WHERE id = ?`,
      )
      .run(
        dead ? 'dead' : 'queued',
        new Date(now.getTime() + retryDelayMs(job.attempts)).toISOString(),
        error.slice(0, 2000),
        now.toISOString(),
        job.id,
      )
    return dead ? 'dead' : 'retry'
  }

  /** Jobs left `running` by a process that died go back to the queue. */
  recoverRunning(): number {
    const now = this.now().toISOString()
    const r = this.db
      .prepare(
        `UPDATE ros_jobs SET state = 'queued', locked_at = NULL, updated_at = ? WHERE state = 'running'`,
      )
      .run(now)
    return Number(r.changes)
  }

  /**
   * A dead job holds its key, so `enqueue` with that key is a no-op. Give it
   * fresh attempts (and the new payload) instead. False when no dead job has
   * that key.
   */
  revive(key: string, payload: unknown): boolean {
    const now = this.now().toISOString()
    return (
      Number(
        this.db
          .prepare(
            `UPDATE ros_jobs SET state = 'queued', attempts = 0, run_at = ?, updated_at = ?, payload = ?
              WHERE job_key = ? AND state = 'dead'`,
          )
          .run(now, now, JSON.stringify(payload ?? null), key).changes,
      ) > 0
    )
  }

  /** Dead jobs back to the queue with fresh attempts. Returns how many. */
  requeueDead(task?: string): number {
    const now = this.now().toISOString()
    const r = task
      ? this.db
          .prepare(
            `UPDATE ros_jobs SET state = 'queued', attempts = 0, run_at = ?, updated_at = ?
              WHERE state = 'dead' AND task = ?`,
          )
          .run(now, now, task)
      : this.db
          .prepare(
            `UPDATE ros_jobs SET state = 'queued', attempts = 0, run_at = ?, updated_at = ?
              WHERE state = 'dead'`,
          )
          .run(now, now)
    return Number(r.changes)
  }

  /** Job counts by task and state, for stats and health. */
  counts(): Array<{ task: string; state: string; count: number }> {
    return this.db
      .prepare(
        `SELECT task, state, count(*) AS count FROM ros_jobs GROUP BY task, state ORDER BY task, state`,
      )
      .all() as unknown as Array<{ task: string; state: string; count: number }>
  }
}

export interface Sweep {
  name: string
  everyMs: number
  run: () => Promise<void> | void
}

export interface JobRunnerOptions {
  /** How often the loop looks for work. Default 2 s. */
  intervalMs?: number
  /** Jobs run per tick at most, so one tick cannot starve the event loop. Default 10. */
  batch?: number
  log?: (line: string) => void
  now?: () => Date
}

/**
 * Runs queued jobs one at a time, and periodic sweeps that enqueue more. One
 * job runs at a time by design: every handler writes to the same file, and
 * the embedding or LLM endpoint behind it is the real bottleneck.
 */
export class JobRunner {
  private readonly handlers = new Map<string, JobHandler>()
  private readonly sweeps: Array<Sweep & { last: number }> = []
  private timer: ReturnType<typeof setInterval> | undefined
  private busy = false
  private halted = false
  private recovered = false
  private readonly log: (line: string) => void
  private readonly now: () => Date

  constructor(
    private readonly queue: SqliteJobQueue,
    private readonly opts: JobRunnerOptions = {},
  ) {
    this.log = opts.log ?? (() => {})
    this.now = opts.now ?? (() => new Date())
  }

  handle(task: string, handler: JobHandler): void {
    this.handlers.set(task, handler)
  }

  /** True between `start()` and `stop()`. */
  isRunning(): boolean {
    return this.timer !== undefined
  }

  sweep(sweep: Sweep): void {
    this.sweeps.push({ ...sweep, last: 0 })
  }

  start(): void {
    if (this.timer) return
    this.recovered = true
    const recovered = this.queue.recoverRunning()
    if (recovered > 0) this.log(`[sqlite-jobs] ${String(recovered)} interrupted job(s) requeued`)
    this.timer = setInterval(() => {
      void this.tick()
    }, this.opts.intervalMs ?? 2000)
    // Background work must never keep the process alive.
    this.timer.unref()
  }

  /**
   * Stop at once, without waiting: no new job is claimed, and a job that is
   * mid-flight does not touch the queue when it returns (it stays `running`
   * and is requeued by the next start). For closing the file synchronously.
   */
  halt(): void {
    this.halted = true
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }

  /** Read through a method: `halted` changes while a handler is awaited. */
  private isHalted(): boolean {
    return this.halted
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    // Let a job that is mid-flight finish its write before the file closes.
    for (let i = 0; i < 200 && this.busy; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
  }

  /** One pass: due sweeps, then up to `batch` due jobs. Returns jobs run. Never throws. */
  async tick(): Promise<number> {
    if (this.busy || this.halted) return 0
    this.busy = true
    // A process that drains by hand (no timer) still has to pick up jobs a
    // crash left `running`. Once: later ticks would requeue their own work.
    if (!this.timer && !this.recovered) {
      this.recovered = true
      try {
        this.queue.recoverRunning()
      } catch (err) {
        this.log(`[sqlite-jobs] recovering interrupted jobs failed: ${message(err)}`)
      }
    }
    let ran = 0
    try {
      const nowMs = this.now().getTime()
      for (const sweep of this.sweeps) {
        if (this.halted) break
        if (nowMs - sweep.last < sweep.everyMs) continue
        sweep.last = nowMs
        try {
          await sweep.run()
        } catch (err) {
          this.log(`[sqlite-jobs] sweep ${sweep.name} failed: ${message(err)}`)
        }
      }
      const tasks = [...this.handlers.keys()]
      const batch = this.opts.batch ?? 10
      while (ran < batch && !this.isHalted()) {
        const job = this.queue.claim(tasks)
        if (!job) break
        ran += 1
        const handler = this.handlers.get(job.task)
        try {
          if (!handler) throw new Error(`no handler for task ${job.task}`)
          await handler(job.payload, job)
          if (this.isHalted()) break
          this.queue.complete(job.id)
        } catch (err) {
          if (this.isHalted()) break
          const outcome = this.queue.fail(job, message(err))
          this.log(
            `[sqlite-jobs] ${job.task} ${job.key ?? job.id} failed (attempt ${String(job.attempts)}/${String(job.maxAttempts)}, ${outcome}): ${message(err)}`,
          )
        }
      }
    } catch (err) {
      this.log(`[sqlite-jobs] tick failed: ${message(err)}`)
    } finally {
      this.busy = false
    }
    return ran
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
