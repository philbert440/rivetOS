/**
 * Task-backed delegation recorder — cutover step (e).
 *
 * delegate_task stays a synchronous in-process call (DelegationEngine is
 * untouched); only the audit trail moves: instead of ros_delegation_runs,
 * each invocation is recorded as an already-terminal ros_tasks row via
 * TaskStore.recordTerminal — no run-task job, nothing executes twice.
 *
 * Mapping notes:
 * - cached results record as 'completed' with spec.cached=true
 *   (ros_tasks has no 'cached' status; the flag preserves the signal).
 * - toolsUsed rides in spec.toolsUsed (TaskResult has no field yet —
 *   same gap as the subagent cutover, tracked on the backlog).
 * - Best-effort like the legacy recorder: failures are logged and swallowed,
 *   never failing the delegation itself.
 */

import type { DelegationResult, TaskResult } from '@rivetos/types'
import type { DelegationRunsRecorder } from '../delegation-recorder.js'
import type { TaskStore, TerminalOutcome } from './store.js'
import { logger } from '../../logger.js'

const log = logger('TaskDelegationRecorder')

function toOutcome(
  result: DelegationResult,
  opts: { cached: boolean; startedAt: number },
): TerminalOutcome {
  const usage = {
    inputTokens: result.usage?.promptTokens ?? 0,
    outputTokens: result.usage?.completionTokens ?? 0,
    totalTokens: (result.usage?.promptTokens ?? 0) + (result.usage?.completionTokens ?? 0),
    turns: result.iterations ?? 1,
    wallClockMs: result.durationMs ?? 0,
  }
  const status: TerminalOutcome['status'] =
    result.status === 'completed' || opts.cached
      ? 'completed'
      : result.status === 'timeout'
        ? 'timeout'
        : 'failed'
  const taskResult: TaskResult = {
    verdict: status,
    summary: result.response,
    output: result.response,
    artifacts: [],
    usage,
    error: result.status === 'failed' ? result.response : undefined,
  }
  return {
    status,
    result: taskResult,
    startedAt: opts.startedAt,
    durationMs: result.durationMs,
  }
}

export function createTaskDelegationRecorder(store: TaskStore): DelegationRunsRecorder {
  return {
    async record(request, result, opts): Promise<void> {
      try {
        await store.recordTerminal(
          {
            goal: request.task,
            executor: 'chat-loop',
            agentId: request.toAgent,
            origin: 'tool',
            requestedBy: request.fromAgent,
            chainDepth: opts.chainDepth,
            spec: {
              delegation: true,
              cached: opts.cached,
              ...(request.model ? { model: request.model } : {}),
              ...(result.toolsUsed?.length ? { toolsUsed: result.toolsUsed } : {}),
            },
          },
          toOutcome(result, opts),
        )
      } catch (err: unknown) {
        log.warn(`Failed to record delegation task row: ${(err as Error).message}`)
      }
    },
  }
}
