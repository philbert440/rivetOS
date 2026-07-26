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
import { CRITERIA_POLICY_OFF, normalizeCriteria, type CriteriaPolicy } from './criteria.js'
import type { TaskStore } from './store.js'
import type { TaskCompletionWaiter } from './completion-waiter.js'
import { logger } from '../../logger.js'

const log = logger('HeartbeatTask')

export interface HeartbeatTaskOptions {
  store: TaskStore
  /** Shared completion waiter (LISTEN + poll fallback). */
  waiter: TaskCompletionWaiter
  /** Turn wall-clock bound in ms (drives budget + wait deadline). */
  turnTimeoutMs: number
  /** Output delivery (silent-filter + channel fan-out live in the caller). */
  deliver: (hbConfig: HeartbeatConfig, response: string) => Promise<void>
  /** Criteria policy (phase 2b) — heartbeats are skip-listed by default. */
  criteriaPolicy?: CriteriaPolicy
  /**
   * Pin the heartbeat row to this node (mesh `node_name` / hostname).
   *
   * Required on multi-node fleets: unpinned rows enqueue under the global
   * `run-task` job and any node's worker can claim them. Claim then fails
   * (or chat-loop bombs) when the agent is not registered on the winner —
   * the 2026-07-26 fleet failure mode (~59% of heartbeat rows). The API
   * path already applies G4 `resolveAffinity`; heartbeats must do the same
   * pin. Prefer the scheduling node: the crontab only fires when the agent
   * is local to this runtime.
   */
  nodeAffinity?: string
}

/** Create the heartbeat task row and wait for its terminal state. */
export async function runHeartbeatViaTasks(
  hbConfig: HeartbeatConfig,
  opts: HeartbeatTaskOptions,
): Promise<void> {
  const { store, deliver } = opts

  const row = await store.create({
    goal: hbConfig.prompt,
    executor: 'chat-loop',
    agentId: hbConfig.agent,
    origin: 'heartbeat',
    acceptanceCriteria: normalizeCriteria(
      { goal: hbConfig.prompt, origin: 'heartbeat' },
      opts.criteriaPolicy ?? CRITERIA_POLICY_OFF,
    ),
    requestedBy: 'system:heartbeat',
    spec: { promptMode: 'heartbeat' },
    budget: { maxWallClockMs: opts.turnTimeoutMs },
    maxAttempts: 1,
    // Per-node job name (`run-task:<node>`) + claim guard — see options.
    nodeAffinity: opts.nodeAffinity,
  })

  const terminal = await opts.waiter.wait(row.id, {
    deadlineMs: opts.turnTimeoutMs + 60_000,
  })
  if (!terminal) {
    // Deadline or row vanished. Kill before the crontab slot is released —
    // the next tick must never overlap a still-running run; the runner
    // discards the killed row's outcome at turn end (step-(d) semantics).
    await store.requestKill(row.id)
    log.warn(`Heartbeat task ${row.id} exceeded its deadline — killed, no delivery`)
    return
  }
  if (terminal.status !== 'completed') {
    log.warn(
      `Heartbeat task ${row.id} ended ${terminal.status}${
        terminal.error ? `: ${terminal.error}` : ''
      }`,
    )
    return
  }
  await deliver(hbConfig, terminal.result?.output ?? terminal.result?.summary ?? '')
}
