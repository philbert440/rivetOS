/**
 * Heartbeat-as-task — cutover step (f), Option A (grok design consult
 * 2026-07-06): each crontab tick creates a durable ros_tasks row, waits
 * in-process for the terminal row, and delivers the output. No new infra —
 * the gateway LISTEN consumer replaces the poll later.
 *
 * The crontab handler holds its graphile slot for the wait; heartbeat
 * concurrency is small and turnTimeout bounds it. On deadline the row is
 * requestKill()ed before the slot is released — otherwise the next tick
 * could overlap a still-running run (adversarial review of #265).
 *
 * Deliberate delta vs the legacy inline path: the chat-loop executor applies
 * the agent's tool include/exclude filters, which the legacy heartbeat
 * AgentLoop bypassed — heartbeats now see the same toolset as every other
 * run of that agent.
 */

import type { HeartbeatConfig } from '@rivetos/types'
import type { TaskStore } from './store.js'
import { logger } from '../../logger.js'

const log = logger('HeartbeatTask')

const TERMINAL = ['completed', 'failed', 'killed', 'timeout']

export interface HeartbeatTaskOptions {
  store: TaskStore
  /** Turn wall-clock bound in ms (drives budget + wait deadline). */
  turnTimeoutMs: number
  /** Output delivery (silent-filter + channel fan-out live in the caller). */
  deliver: (hbConfig: HeartbeatConfig, response: string) => Promise<void>
  /** Poll interval override for tests. */
  pollIntervalMs?: number
}

/** Create the heartbeat task row and wait for its terminal state. */
export async function runHeartbeatViaTasks(
  hbConfig: HeartbeatConfig,
  opts: HeartbeatTaskOptions,
): Promise<void> {
  const { store, deliver } = opts
  const pollMs = opts.pollIntervalMs ?? 2_000

  const row = await store.create({
    goal: hbConfig.prompt,
    executor: 'chat-loop',
    agentId: hbConfig.agent,
    origin: 'heartbeat',
    requestedBy: 'system:heartbeat',
    spec: { promptMode: 'heartbeat' },
    budget: { maxWallClockMs: opts.turnTimeoutMs },
    maxAttempts: 1,
  })

  const deadline = Date.now() + opts.turnTimeoutMs + 60_000
  for (;;) {
    await new Promise((r) => setTimeout(r, pollMs))
    const current = await store.get(row.id)
    if (!current) {
      log.warn(`Heartbeat task ${row.id} disappeared — no delivery`)
      return
    }
    if (TERMINAL.includes(current.status)) {
      if (current.status !== 'completed') {
        log.warn(
          `Heartbeat task ${row.id} ended ${current.status}${
            current.error ? `: ${current.error}` : ''
          }`,
        )
        return
      }
      await deliver(hbConfig, current.result?.output ?? current.result?.summary ?? '')
      return
    }
    if (Date.now() > deadline) {
      // Kill before releasing the crontab slot — the next tick must never
      // overlap a still-running run. The runner discards the outcome at
      // turn end (requestKill semantics from step (d)).
      await store.requestKill(row.id)
      log.warn(`Heartbeat task ${row.id} exceeded its deadline — killed, no delivery`)
      return
    }
  }
}
