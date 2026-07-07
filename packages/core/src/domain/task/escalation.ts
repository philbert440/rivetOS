/**
 * Task escalation (phase 2f) — a task that stays refuted after its retry
 * budget gets surfaced to a human. Channel-based (Telegram today, RivetHub
 * push later): the notifier is an interface, the coordinator never knows the
 * transport. Fire-and-forget by contract — escalation must never block or
 * fail the parent's finish path.
 */

import type { EvalOutcome, NotificationFrame, TaskResult } from '@rivetos/types'
import type { TaskRow } from './store.js'
import { logger } from '../../logger.js'

const log = logger('TaskEscalation')

export interface TaskEscalationPayload {
  task: TaskRow
  result: TaskResult
  outcome: EvalOutcome
  refutation?: string
  /** Gateway base for the drill-down link, e.g. http://ct115:5174. */
  gatewayBase?: string
}

export interface EscalationNotifier {
  notify(payload: TaskEscalationPayload): Promise<void>
}

export interface ChannelEscalationConfig {
  /** Channel id in HeartbeatConfig.outputChannel shape, e.g. `telegram:<chat>`. */
  channelId: string
  gatewayBase?: string
}

/**
 * Escalate over the runtime's channel fan-out (the heartbeat-delivery
 * pattern): every registered channel gets the send; the ones that don't own
 * the channelId ignore it.
 */
export function createChannelEscalationNotifier(
  send: (channelId: string, text: string) => Promise<void>,
  config: ChannelEscalationConfig,
): EscalationNotifier {
  return {
    async notify(payload: TaskEscalationPayload): Promise<void> {
      try {
        await send(
          config.channelId,
          formatEscalation({ ...payload, gatewayBase: config.gatewayBase }),
        )
      } catch (err: unknown) {
        log.error(
          `Escalation delivery for task ${payload.task.id} failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        )
      }
    },
  }
}

/**
 * Escalate to connected RivetHub clients over the notifications WS (4e).
 * Ephemeral by design — /api/outcomes is the durable inbox — so this
 * composes with (never replaces) the log/channel notifier.
 *
 * Wire exposure: the frame carries the truncated task GOAL (operational
 * text), not just metadata — on tokenless-LAN nodes any LAN client can read
 * it (same trust boundary as tokenless /api/sessions). The full payload
 * (criteria, refutation, artifacts) deliberately never rides this channel.
 */
export function createGatewayEscalationNotifier(
  broadcast: (frame: NotificationFrame) => void,
): EscalationNotifier {
  return {
    notify(payload: TaskEscalationPayload): Promise<void> {
      try {
        broadcast({
          kind: 'escalation',
          taskId: payload.task.id,
          agentId: payload.task.agentId,
          summary: `${trunc(payload.task.goal, 140)} — refuted after ${String(payload.outcome.attempts)} retr${payload.outcome.attempts === 1 ? 'y' : 'ies'}`,
          href: `/tasks/${payload.task.id}`,
          ts: Date.now(),
        })
      } catch (err: unknown) {
        log.error(
          `Gateway escalation broadcast for task ${payload.task.id} failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        )
      }
      return Promise.resolve()
    },
  }
}

/** Fan one escalation to several notifiers (log + gateway + channel…). */
export function composeEscalationNotifiers(...notifiers: EscalationNotifier[]): EscalationNotifier {
  return {
    async notify(payload: TaskEscalationPayload): Promise<void> {
      await Promise.all(
        notifiers.map((n) =>
          n.notify(payload).catch((err: unknown) => {
            log.debug(
              `escalation notifier rejected: ${err instanceof Error ? err.message : String(err)}`,
            )
          }),
        ),
      )
    },
  }
}

/** Log-only fallback when no escalation channel is configured. */
export function createLogEscalationNotifier(): EscalationNotifier {
  return {
    notify(payload: TaskEscalationPayload): Promise<void> {
      log.warn(`ESCALATED (no channel configured): ${formatEscalation(payload)}`)
      return Promise.resolve()
    },
  }
}

const trunc = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

/** Human-facing escalation message (markdown-ish; channels format further). */
export function formatEscalation(payload: TaskEscalationPayload): string {
  const { task, result, outcome, refutation } = payload
  const criteria = outcome.criteriaReport
    .map(
      (c) =>
        `  • [${c.id}] ${c.met ? 'MET' : 'NOT MET'}${c.evidence ? ` — ${trunc(c.evidence, 120)}` : ''}`,
    )
    .join('\n')
  const artifacts =
    result.artifacts.length > 0
      ? result.artifacts.map((a) => `  • ${a.kind}: ${a.ref}`).join('\n')
      : '  (none)'
  const lines = [
    '⚠️ Task evaluation escalated',
    '',
    `Task: ${task.id} (agent ${task.agentId}, ${task.executor}${task.executorTarget ? `/${task.executorTarget}` : ''})`,
    `Goal: ${trunc(task.goal, 200)}`,
    '',
    `Executor claimed: ${result.verdict} — ${trunc(result.summary, 200)}`,
    `Verifier: REFUTED after ${String(outcome.attempts)} retr${outcome.attempts === 1 ? 'y' : 'ies'}`,
    criteria ? `Criteria:\n${criteria}` : '',
    refutation ? `\nRefutation:\n${trunc(refutation, 500)}` : '',
    `\nArtifacts:\n${artifacts}`,
  ]
  if (payload.gatewayBase) lines.push('', `→ ${payload.gatewayBase}/api/tasks/${task.id}`)
  return lines.filter((l) => l !== '').join('\n')
}
