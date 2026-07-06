/**
 * TaskCompletionWaiter — wait for a ros_tasks row to reach a terminal state.
 *
 * Primary signal: `LISTEN ros_task_done` (the 0002 trigger notifies with the
 * task id on every transition into completed/failed/killed/timeout) on one
 * dedicated client shared by all concurrent waits. Poll is the safety net —
 * always on, at a relaxed cadence while LISTEN is healthy, and it tightens
 * automatically if the LISTEN client errors or was never available (in-memory
 * store, connection loss). A notification only wakes the check; the row read
 * is always the source of truth, so a missed NOTIFY costs latency, never
 * correctness.
 *
 * Shared by mesh delegation (step g1) and the future gateway task API;
 * heartbeat-task runs on the same waiter.
 */

import pg from 'pg'
import type { TaskRow, TaskStore } from './store.js'
import { logger } from '../../logger.js'

const log = logger('TaskWaiter')

const TERMINAL = ['completed', 'failed', 'killed', 'timeout']
/** Poll cadence while LISTEN is healthy (safety net only). */
const POLL_LISTEN_MS = 10_000
/** Poll cadence without LISTEN (pure-poll mode). */
const POLL_FALLBACK_MS = 2_000

export interface TaskCompletionWaiter {
  /**
   * Resolve with the terminal row, or undefined on deadline/missing row.
   * Never rejects.
   */
  wait(taskId: string, opts: { deadlineMs: number }): Promise<TaskRow | undefined>
  stop(): Promise<void>
}

export interface TaskCompletionWaiterOptions {
  store: TaskStore
  /** Postgres URL for LISTEN; omit for pure-poll mode (in-memory dev/tests). */
  pgUrl?: string
  /** Poll cadence overrides for tests. */
  pollListenMs?: number
  pollFallbackMs?: number
}

export function createTaskCompletionWaiter(
  opts: TaskCompletionWaiterOptions,
): TaskCompletionWaiter {
  const pollListenMs = opts.pollListenMs ?? POLL_LISTEN_MS
  const pollFallbackMs = opts.pollFallbackMs ?? POLL_FALLBACK_MS

  /** Pending wakeups by task id — notification fan-out. */
  const wakeups = new Map<string, Set<() => void>>()
  let client: pg.Client | undefined
  let listenHealthy = false
  let stopped = false

  const wake = (taskId: string): void => {
    const set = wakeups.get(taskId)
    if (set) for (const fn of set) fn()
  }

  async function ensureListener(): Promise<void> {
    if (listenHealthy || stopped || !opts.pgUrl) return
    try {
      const c = new pg.Client({ connectionString: opts.pgUrl })
      await c.connect()
      await c.query('LISTEN ros_task_done')
      c.on('notification', (msg) => {
        if (msg.channel === 'ros_task_done' && msg.payload) wake(msg.payload)
      })
      c.on('error', (err) => {
        // Degrade to pure poll; the next wait() attempts a reconnect.
        log.warn(`LISTEN client error — falling back to poll: ${err.message}`)
        listenHealthy = false
        client = undefined
        c.end().catch(() => undefined)
      })
      client = c
      listenHealthy = true
      log.info('LISTEN ros_task_done active')
    } catch (err: unknown) {
      listenHealthy = false
      log.warn(
        `LISTEN unavailable — pure poll mode: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  return {
    async wait(taskId, { deadlineMs }): Promise<TaskRow | undefined> {
      await ensureListener()
      const deadline = Date.now() + deadlineMs

      const subs = wakeups.get(taskId) ?? new Set<() => void>()
      wakeups.set(taskId, subs)

      try {
        for (;;) {
          if (stopped) return undefined
          const row = await opts.store.get(taskId)
          if (!row) return undefined
          if (TERMINAL.includes(row.status)) return row
          const remaining = deadline - Date.now()
          if (remaining <= 0) return undefined

          const pollMs = listenHealthy ? pollListenMs : pollFallbackMs
          await new Promise<void>((resolve) => {
            const timer = setTimeout(done, Math.min(pollMs, remaining))
            function done(): void {
              clearTimeout(timer)
              subs.delete(done)
              resolve()
            }
            subs.add(done)
          })
        }
      } finally {
        if (subs.size === 0) wakeups.delete(taskId)
      }
    },

    async stop(): Promise<void> {
      stopped = true
      listenHealthy = false
      // Cancel in-flight waits — a draining 30m mesh wait must not block
      // shutdown; callers get undefined and the durable row survives.
      for (const taskId of [...wakeups.keys()]) wake(taskId)
      await client?.end().catch(() => undefined)
      client = undefined
    },
  }
}
