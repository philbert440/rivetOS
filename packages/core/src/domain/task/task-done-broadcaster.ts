/**
 * Broadcast `task.done` on the notifications channel when a ros_tasks row
 * reaches a terminal status.
 *
 * Primary signal: one `LISTEN ros_task_done` client (the 0002 trigger
 * notifies with the task id). Every gateway listens, so a phone on any node
 * hears a completion that ran elsewhere. The row read is the source of truth
 * — a notification for a missing or non-terminal row is ignored.
 *
 * Embedded PGlite has no cross-process NOTIFY. Callers also invoke
 * {@link TaskDoneBroadcaster.onTaskFinished} from the in-process runner so
 * those deployments still broadcast. LISTEN and the hook share a dedupe
 * window so a row is emitted once.
 */

import pg from 'pg'
import type { NotificationFrame, TaskStatus } from '@rivetos/types'
import type { TaskStore } from './store.js'
import { logger } from '../../logger.js'

const log = logger('TaskDoneBroadcaster')

const TERMINAL = new Set<TaskStatus>(['completed', 'failed', 'killed', 'timeout'])
/** LISTEN + onTaskFinished for the same row must emit once. */
const DEDUPE_LIMIT = 500
const RECONNECT_MIN_MS = 1_000
const RECONNECT_MAX_MS = 30_000
/**
 * pg's default `connectionTimeoutMillis` is 0 (wait forever). A partition at
 * shutdown would otherwise sit in `connect()` until the TCP stack gives up.
 * `query_timeout` is the same bound for the LISTEN startup query (pg 8 types).
 */
const CONNECT_TIMEOUT_MS = 10_000
/** stop() races an in-flight connect/LISTEN against this instead of awaiting it. */
const STOP_CONNECT_WAIT_MS = 1_000

export interface TaskDoneBroadcasterOptions {
  store: TaskStore
  broadcast: (frame: NotificationFrame) => void
  /** Postgres URL for LISTEN; omit for in-memory / PGlite deployments (hook-only mode). */
  pgUrl?: string
  now?: () => number
  /**
   * Test seam for the LISTEN client. Ignored when `pgUrl` is omitted —
   * hook-only mode never opens a client.
   */
  clientFactory?: () => pg.Client
}

export interface TaskDoneBroadcaster {
  /** Call from any in-process code path that finished a task (runner/finish hook) — dedupes with LISTEN. */
  onTaskFinished(taskId: string): Promise<void>
  start(): Promise<void>
  stop(): Promise<void>
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export function createTaskDoneBroadcaster(opts: TaskDoneBroadcasterOptions): TaskDoneBroadcaster {
  const now = opts.now ?? ((): number => Date.now())

  const emittedOrder: string[] = []
  const emitted = new Set<string>()
  let client: pg.Client | undefined
  // Object fields, not bare lets: stop() flips them during an await, and a
  // narrowed boolean would hide those checks from the type checker.
  const life = { stopped: false, connecting: false }
  // Function call so the type checker cannot narrow the flag across awaits
  // (stop() sets it from another turn of the event loop).
  const isStopped = (): boolean => life.stopped
  let backoffMs = RECONNECT_MIN_MS
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined
  /** In-flight connect(). stop() races this; it must not await it unbounded. */
  let connectChain: Promise<void> = Promise.resolve()
  /**
   * Client passed to connect()/LISTEN but not yet `client`. Set before those
   * awaits so stop() can end() it while setup is still pending.
   */
  let connectingClient: pg.Client | undefined

  /** @returns false when this id was already emitted inside the dedupe window. */
  function remember(taskId: string): boolean {
    if (emitted.has(taskId)) return false
    emitted.add(taskId)
    emittedOrder.push(taskId)
    if (emittedOrder.length > DEDUPE_LIMIT) {
      const oldest = emittedOrder.shift()
      if (oldest !== undefined) emitted.delete(oldest)
    }
    return true
  }

  async function emit(taskId: string): Promise<void> {
    if (isStopped()) return
    if (taskId.length === 0) return
    try {
      const row = await opts.store.get(taskId)
      // An in-flight lookup can resolve after stop(); do not broadcast it.
      if (isStopped()) return
      if (!row || !TERMINAL.has(row.status)) return
      // Reserve before broadcast so a concurrent LISTEN and hook cannot both pass.
      if (!remember(taskId)) return
      try {
        opts.broadcast({
          kind: 'task.done',
          taskId,
          status: row.status,
          ts: now(),
        })
      } catch (err: unknown) {
        log.warn(`broadcast failed for task ${taskId}: ${errorMessage(err)}`)
      }
    } catch (err: unknown) {
      log.warn(`task.done lookup failed for ${taskId}: ${errorMessage(err)}`)
    }
  }

  function scheduleReconnect(): void {
    if (isStopped() || reconnectTimer !== undefined) return
    const delay = backoffMs
    backoffMs = Math.min(backoffMs * 2, RECONNECT_MAX_MS)
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined
      if (isStopped()) return
      // Assigned before the callback yields so stop() can bound this attempt.
      const pending = connect()
      connectChain = pending
      void pending
    }, delay)
    reconnectTimer.unref()
  }

  function openClient(): pg.Client {
    if (opts.clientFactory) return opts.clientFactory()
    return new pg.Client({
      connectionString: opts.pgUrl,
      connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
      query_timeout: CONNECT_TIMEOUT_MS,
    })
  }

  async function connect(): Promise<void> {
    if (isStopped() || !opts.pgUrl || client || life.connecting) return
    life.connecting = true
    let created: pg.Client | undefined
    try {
      created = openClient()
      // stop() must be able to end this client while connect() or LISTEN is pending.
      connectingClient = created
      const c = created
      await c.connect()
      if (isStopped()) {
        await c.end().catch(() => undefined)
        return
      }
      // Attached before LISTEN so a socket error cannot crash the process.
      // Stale clients (already replaced, or not yet current) must not schedule
      // another reconnect — setup failures are handled by the catch below.
      c.on('error', (err: Error) => {
        if (isStopped() || client !== c) return
        log.warn(`LISTEN client error — reconnecting: ${err.message}`)
        client = undefined
        void c.end().catch(() => undefined)
        scheduleReconnect()
      })
      await c.query('LISTEN ros_task_done')
      if (isStopped()) {
        await c.end().catch(() => undefined)
        return
      }
      c.on('notification', (msg) => {
        if (msg.channel !== 'ros_task_done' || !msg.payload) return
        void emit(msg.payload)
      })
      client = c
      backoffMs = RECONNECT_MIN_MS
      log.info('LISTEN ros_task_done active')
    } catch (err: unknown) {
      log.warn(`LISTEN unavailable — hook-only mode: ${errorMessage(err)}`)
      if (created) await created.end().catch(() => undefined)
      if (client === created) client = undefined
      if (!isStopped()) scheduleReconnect()
    } finally {
      connectingClient = undefined
      life.connecting = false
    }
  }

  return {
    onTaskFinished(taskId: string): Promise<void> {
      return emit(taskId)
    },

    async start(): Promise<void> {
      if (isStopped() || !opts.pgUrl) return
      try {
        const pending = connect()
        connectChain = pending
        await pending
      } catch (err: unknown) {
        // connect() already degrades to hook-only; never reject boot.
        log.warn(`task.done LISTEN start failed: ${errorMessage(err)}`)
      }
    },

    async stop(): Promise<void> {
      life.stopped = true
      if (reconnectTimer !== undefined) {
        clearTimeout(reconnectTimer)
        reconnectTimer = undefined
      }
      // Setup is a local inside connect() until it finishes. End that client
      // now (ignore errors) so a stalled connect/LISTEN cannot block shutdown.
      const pending = connectingClient
      connectingClient = undefined
      if (pending) void pending.end().catch(() => undefined)

      let timer: ReturnType<typeof setTimeout> | undefined
      await Promise.race([
        connectChain.catch(() => undefined),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, STOP_CONNECT_WAIT_MS)
          timer.unref()
        }),
      ])
      if (timer !== undefined) clearTimeout(timer)

      const current = client
      client = undefined
      // `pending` was already ended. Awaiting end() on it again can hang the
      // same way the connect did.
      if (!current || current === pending) return
      await current.end().catch(() => undefined)
    },
  }
}
