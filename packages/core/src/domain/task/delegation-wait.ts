/**
 * Shared wait → DelegationResult mapping for durable delegate_task rows.
 *
 * Mesh config-agent delegation and RivetHub preset delegation both create a
 * `ros_tasks` row and then block the caller the same way: wait, kill on
 * deadline, map the terminal row. One helper so those paths cannot drift.
 */

import type { DelegationResult } from '@rivetos/types'
import type { TaskCompletionWaiter } from './completion-waiter.js'
import type { TaskStore } from './store.js'

export async function settleDelegatedTask(args: {
  store: TaskStore
  waiter: TaskCompletionWaiter
  rowId: string
  waitMs: number
  startTime: number
  /** Prefix for timeout / failure text, e.g. `Remote delegation to grok on ct112`. */
  describe: string
}): Promise<DelegationResult> {
  const { store, waiter, rowId, waitMs, startTime, describe } = args
  try {
    const terminal = await waiter.wait(rowId, { deadlineMs: waitMs })
    const durationMs = Date.now() - startTime

    if (!terminal) {
      // Deadline (or vanished row): kill before returning so the runner
      // discards the in-flight outcome — no zombie delegations.
      await store.requestKill(rowId)
      return {
        status: 'timeout',
        response: `${describe} timed out after ${String(waitMs)}ms (task ${rowId} killed)`,
        durationMs,
      }
    }

    if (terminal.status === 'completed') {
      return {
        status: 'completed',
        response:
          terminal.result?.output ?? terminal.result?.summary ?? '[no response from remote agent]',
        iterations: terminal.result?.usage.turns,
        durationMs,
      }
    }

    return {
      status: terminal.status === 'timeout' ? 'timeout' : 'failed',
      response: `${describe} ${terminal.status}${terminal.error ? `: ${terminal.error}` : ''}`,
      durationMs,
    }
  } catch (err: unknown) {
    return {
      status: 'failed',
      response: `${describe} failed: ${err instanceof Error ? err.message : String(err)}`,
      durationMs: Date.now() - startTime,
    }
  }
}
