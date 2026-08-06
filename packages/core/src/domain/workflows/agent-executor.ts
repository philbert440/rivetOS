/**
 * Host `step.agent` executor.
 *
 * Preferred path: create a ros_task (chat-loop) and await terminal status via
 * TaskCompletionWaiter — same durable surface as RivetHub Tasks.
 *
 * Interim path (when task store is unavailable): throw a clear error so
 * misconfiguration fails loud. A pure provider-session path was considered
 * but the task engine is the product joint; shipping a half-wired session
 * loop would diverge from chat/tasks UX.
 *
 * Gap (NOTES): when tasks are disabled, agent steps cannot run. Reviewer
 * may wire a session-API fallback later.
 */

import type { AgentExecuteOpts, AgentExecutor } from '@rivetos/workflows'
import type { TaskStore, NewTaskInput } from '../task/store.js'
import type { TaskCompletionWaiter } from '../task/completion-waiter.js'
import { logger } from '../../logger.js'

const log = logger('WorkflowAgentExecutor')

export interface TaskAgentExecutorOptions {
  store: TaskStore
  waiter: TaskCompletionWaiter
  /** Default agent id when the step/agentDef doesn't pin one. */
  defaultAgentId: string
  /** Pin tasks to this node when set. */
  nodeId?: string
  /** Max wait for the task to finish (ms). Default 30 min. */
  defaultTimeoutMs?: number
}

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000

export function createTaskAgentExecutor(opts: TaskAgentExecutorOptions): AgentExecutor {
  const defaultTimeoutMs = opts.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS

  return {
    async execute(step: AgentExecuteOpts): Promise<Record<string, unknown>> {
      const agentId =
        (typeof step.extra?.agentId === 'string' && step.extra.agentId) ||
        (typeof step.agentDef?.config?.agentId === 'string'
          ? step.agentDef.config.agentId
          : undefined) ||
        opts.defaultAgentId

      const systemBits: string[] = []
      if (step.agentDef?.prompt) systemBits.push(step.agentDef.prompt)
      if (step.prompt) systemBits.push(step.prompt)
      const goal =
        systemBits.join('\n\n').trim() ||
        `Workflow agent step "${step.label}" (${step.stepId}) — no prompt provided.`

      const input: NewTaskInput = {
        goal,
        agentId,
        executor: 'chat-loop',
        origin: 'api',
        requestedBy: `workflow:${step.workflow.manifest.id}`,
        nodeAffinity: opts.nodeId,
        spec: {
          workflowStepId: step.stepId,
          workflowLabel: step.label,
          workflowCaseDir: step.caseDir,
          // chat-loop uses spec.workingDir as the session workspace — the
          // step's case dir, so "read pr.diff from the case dir" is guaranteed
          // rather than accidental.
          workingDir: step.caseDir,
          outFields: step.out,
          agentName: step.agent,
          agentConfig: step.agentDef?.config,
        },
        maxAttempts: 1,
      }

      const row = await opts.store.create(input)
      log.info(`workflow agent step ${step.stepId} → task ${row.id} (agent=${agentId})`)

      const timeoutMs = step.timeoutMs ?? defaultTimeoutMs
      const terminal = await opts.waiter.wait(row.id, { deadlineMs: timeoutMs })
      if (!terminal) {
        // Don't abandon the task to keep burning tokens — best-effort kill.
        try {
          await opts.store.requestKill(row.id)
        } catch (err) {
          log.warn(
            `failed to kill timed-out task ${row.id}: ${err instanceof Error ? err.message : String(err)}`,
          )
        }
        throw new Error(
          `Workflow agent step "${step.label}" timed out waiting for task ${row.id} after ${timeoutMs}ms (kill requested)`,
        )
      }
      if (terminal.status === 'killed' || terminal.status === 'timeout') {
        throw new Error(
          `Workflow agent step "${step.label}" task ${row.id} ended ${terminal.status}` +
            (terminal.error ? `: ${terminal.error}` : ''),
        )
      }
      if (terminal.status === 'failed') {
        throw new Error(
          `Workflow agent step "${step.label}" task ${row.id} failed` +
            (terminal.error ? `: ${terminal.error}` : '') +
            (terminal.result?.summary ? ` — ${terminal.result.summary}` : ''),
        )
      }

      // Map task result into declared out fields.
      return mapTaskResultToOut(step.out, terminal.result?.output, terminal.result?.summary)
    },
  }
}

/**
 * Interim stub when the task engine is not available — fails loud.
 */
export function createStubAgentExecutor(reason: string): AgentExecutor {
  return {
    execute(opts: AgentExecuteOpts): Promise<Record<string, unknown>> {
      return Promise.reject(
        new Error(
          `Workflow agent executor unavailable for step "${opts.label}": ${reason}. ` +
            `Enable the durable task engine (tasks + pg) or inject createTaskAgentExecutor.`,
        ),
      )
    },
  }
}

/**
 * Chat-loop TASK_RESULT carries `output` as a STRING; workflow agents are
 * instructed to make that string a JSON object of their declared out fields.
 * Parse it (or the summary) when it looks like an object so multi-field
 * contracts survive the live path, not just object-returning mocks.
 */
function parseJsonObject(text: unknown): Record<string, unknown> | null {
  if (typeof text !== 'string') return null
  const trimmed = text.trim().replace(/^```(?:json)?\s*\n?|\n?```$/g, '')
  const start = trimmed.indexOf('{')
  const end = trimmed.lastIndexOf('}')
  if (start === -1 || end <= start) return null
  try {
    const parsed: unknown = JSON.parse(trimmed.slice(start, end + 1))
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

export function mapTaskResultToOut(
  out: string[],
  output: unknown,
  summary?: string,
): Record<string, unknown> {
  // String output that encodes a JSON object (the live chat-loop shape) is
  // promoted to the object branch; summary is the fallback carrier.
  if (typeof output === 'string' && out.length > 0) {
    const parsed = parseJsonObject(output) ?? parseJsonObject(summary)
    if (parsed && out.some((k) => parsed[k] !== undefined)) {
      output = parsed
    }
  }
  const result: Record<string, unknown> = {}
  if (output && typeof output === 'object' && !Array.isArray(output)) {
    const obj = output as Record<string, unknown>
    // Passthrough when the step declared no out fields.
    if (out.length === 0) return { ...obj }
    for (const key of out) {
      if (obj[key] !== undefined) result[key] = obj[key]
    }
    // A single declared out field may be filled from the summary; multiple
    // missing fields stay null rather than all receiving the same blob.
    for (const key of out) {
      if (result[key] === undefined) {
        result[key] = out.length === 1 && summary !== undefined ? summary : null
      }
    }
    return result
  }
  if (out.length === 0) {
    return { result: output ?? summary ?? null }
  }
  for (const key of out) {
    result[key] = out.length === 1 ? (output ?? summary ?? null) : null
  }
  return result
}
