/**
 * Polling task runner — the SQLite (and in-memory) stand-in for graphile-worker.
 *
 * The store's enqueue callback calls {@link PollingTaskRunner.wake}. A timer
 * also scans queued rows, and awaiting-input rows that already have a
 * pending message (a `send()` whose wake was lost). At most `concurrency`
 * handlers run. `stop()` waits for the ones in flight.
 *
 * Defaults: RIVETOS_TASKS_CONCURRENCY (4), RIVETOS_TASKS_POLL_MS (2000).
 */

import type { TaskStore } from './store.js'
import type { TaskRunner } from './runner.js'
import { logger } from '../../logger.js'

const log = logger('TaskRunner')

export interface PollingTaskRunner extends TaskRunner {
  /** Run the poll loop now. Boot wires this to the store's enqueue callback. */
  wake(): void
}

export interface PollingTaskRunnerOptions {
  store: TaskStore
  handler: (taskId: string) => Promise<void>
  nodeId: string
  concurrency?: number
  pollIntervalMs?: number
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const n = Number.parseInt(raw, 10)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

export function createPollingTaskRunner(opts: PollingTaskRunnerOptions): PollingTaskRunner {
  const concurrency = opts.concurrency ?? envInt('RIVETOS_TASKS_CONCURRENCY', 4)
  const pollIntervalMs = opts.pollIntervalMs ?? envInt('RIVETOS_TASKS_POLL_MS', 2_000)
  const inFlight = new Map<string, Promise<void>>()
  let running = false
  let pumping = false
  let pumpAgain = false
  let timer: ReturnType<typeof setInterval> | undefined

  async function nextId(): Promise<string | undefined> {
    const queued = await opts.store.list({ status: 'queued', limit: 500 })
    const parked = await opts.store.list({ status: 'awaiting-input', limit: 500 })
    const rows = [...queued, ...parked].sort((a, b) => a.createdAt - b.createdAt)
    for (const row of rows) {
      if (inFlight.has(row.id)) continue
      if (row.nodeAffinity && row.nodeAffinity !== opts.nodeId) continue
      if (row.status === 'awaiting-input' && row.pendingMessage === undefined) continue
      return row.id
    }
    return undefined
  }

  async function pump(): Promise<void> {
    if (pumping) {
      pumpAgain = true
      return
    }
    pumping = true
    try {
      do {
        pumpAgain = false
        while (running && inFlight.size < concurrency) {
          const id = await nextId()
          // stop() flips `running` during the await above.
          // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- mutated across the await
          if (!id || !running) break
          if (inFlight.has(id)) continue
          // Register before the handler runs. Claim is synchronous on SQLite;
          // a placeholder closed over here still wins if a later handler
          // awaits before the CAS.
          let release: () => void = () => undefined
          const tracked = new Promise<void>((resolve) => {
            release = resolve
          })
          inFlight.set(id, tracked)
          void Promise.resolve()
            .then(() => opts.handler(id))
            .finally(() => {
              inFlight.delete(id)
              release()
              if (running) void pump()
            })
        }
        // A wake that arrives during nextId() sets pumpAgain from the re-entrant call.
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- pumpAgain is set re-entrantly
      } while (pumpAgain && running)
    } finally {
      pumping = false
      if (pumpAgain && running) void pump()
    }
  }

  return {
    handler: opts.handler,
    wake(): void {
      if (!running) return
      void pump()
    },
    async start(): Promise<void> {
      if (opts.store.isReady) {
        try {
          if (!(await opts.store.isReady())) {
            log.warn('ros_tasks missing — task engine disabled')
            return
          }
        } catch (err: unknown) {
          log.warn(`Task engine readiness check failed: ${(err as Error).message} — disabled`)
          return
        }
      }
      const swept = await opts.store.sweep(opts.nodeId)
      if (swept > 0) {
        log.warn(`Crash sweep: ${String(swept)} stale task(s) requeued, failed, or timed out`)
      }
      running = true
      timer = setInterval(() => {
        void pump()
      }, pollIntervalMs)
      timer.unref()
      await pump()
      log.info('Ready — polling runner watching ros_tasks')
    },
    async stop(): Promise<void> {
      running = false
      if (timer) {
        clearInterval(timer)
        timer = undefined
      }
      await Promise.all([...inFlight.values()])
      log.info('Stopped')
    },
  }
}
