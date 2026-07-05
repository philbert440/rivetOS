/**
 * Task runner — claims queued `ros_tasks` rows and drives a HarnessExecutor.
 *
 * Embedded graphile-worker runner (same pattern as subagent-worker): consumes
 * `run-task` jobs (payload `{taskId}`), CAS-claims the row, resolves context
 * refs, looks up the executor by (executor, executor_target), pumps events
 * (usage + last_heartbeat_at on turn.end), enforces the budget BETWEEN turns
 * (hard exceed → abort, verdict 'budget-exceeded', status 'killed'), and
 * records the terminal outcome.
 *
 * awaiting-input (Appendix C): an interactive task (spec.interactive === true)
 * whose turn completes without a queued message flips to 'awaiting-input' and
 * the job completes; TaskStore.send() stashes the pending message and
 * re-enqueues under the same jobKey (jobKeyMode 'replace').
 *
 * On startup the runner crash-sweeps rows this node left 'running': requeue
 * while attempt < max_attempts, else fail with error='worker_restarted'.
 *
 * Env knobs: RIVETOS_TASKS_CONCURRENCY (default 4), RIVETOS_TASKS_POLL_MS
 * (default 2000).
 */

import { run, type Runner } from 'graphile-worker'
import type {
  HarnessExecutor,
  Memory,
  TaskBudget,
  TaskExecutorKind,
  TaskResult,
  TaskStatus,
  TaskUsage,
} from '@rivetos/types'
import { buildLocalSessionContext } from '@rivetos/types'
import type { TaskRow, TaskStore } from './store.js'
import { TASK_JOB_NAME } from './store.js'
import { logger } from '../../logger.js'

const log = logger('TaskRunner')

// ---------------------------------------------------------------------------
// Executor registry — keyed by (executor, executor_target).
// ---------------------------------------------------------------------------

export interface TaskExecutorRegistry {
  register(kind: TaskExecutorKind, executor: HarnessExecutor, target?: string): void
  /** Target-specific registration wins; falls back to the kind-level one. */
  resolve(kind: TaskExecutorKind, target?: string): HarnessExecutor | undefined
}

export function createExecutorRegistry(): TaskExecutorRegistry {
  const executors = new Map<string, HarnessExecutor>()
  const key = (kind: TaskExecutorKind, target?: string): string =>
    target ? `${kind}:${target}` : kind
  return {
    register(kind, executor, target): void {
      executors.set(key(kind, target), executor)
    },
    resolve(kind, target): HarnessExecutor | undefined {
      return executors.get(key(kind, target)) ?? executors.get(key(kind))
    },
  }
}

// ---------------------------------------------------------------------------
// Handler — one claimed task, start to terminal (or awaiting-input).
// ---------------------------------------------------------------------------

export interface TaskHandlerOptions {
  store: TaskStore
  executors: TaskExecutorRegistry
  /** Stable node identity for claimed_by / crash sweep. */
  nodeId: string
  /** Context resolution — optional; without it resolvedContext is ''. */
  memory?: Pick<Memory, 'getContextForTurn'>
  /** Default working directory for task tools. */
  workspaceDir?: string
}

function budgetExceeded(budget: TaskBudget, usage: TaskUsage): string | undefined {
  if (budget.maxTurns !== undefined && usage.turns >= budget.maxTurns) {
    return `maxTurns (${String(budget.maxTurns)}) reached`
  }
  if (budget.maxTokens !== undefined && usage.totalTokens >= budget.maxTokens) {
    return `maxTokens (${String(budget.maxTokens)}) reached`
  }
  if (
    budget.maxUsd !== undefined &&
    usage.costUsd !== undefined &&
    usage.costUsd >= budget.maxUsd
  ) {
    return `maxUsd (${String(budget.maxUsd)}) reached`
  }
  if (budget.maxWallClockMs !== undefined && usage.wallClockMs >= budget.maxWallClockMs) {
    return `maxWallClockMs (${String(budget.maxWallClockMs)}) reached`
  }
  return undefined
}

async function resolveContext(task: TaskRow, opts: TaskHandlerOptions): Promise<string> {
  if (!opts.memory || task.contextRefs.length === 0) return ''
  try {
    const memoryContext = await opts.memory.getContextForTurn(task.goal, task.agentId)
    const refs = task.contextRefs
      .map((r) => `- ${r.kind}: ${r.ref}${r.note ? ` — ${r.note}` : ''}`)
      .join('\n')
    return [`### Referenced context\n${refs}`, memoryContext].filter(Boolean).join('\n\n')
  } catch (err: unknown) {
    log.warn(`Context resolution for task ${task.id} failed: ${(err as Error).message}`)
    return ''
  }
}

export function createTaskHandler(opts: TaskHandlerOptions): (taskId: string) => Promise<void> {
  return async (taskId: string): Promise<void> => {
    const task = await opts.store.claim(taskId, opts.nodeId)
    if (!task) {
      log.warn(`Skipping task ${taskId} — already claimed, terminal, or removed`)
      return
    }

    const executor = opts.executors.resolve(task.executor, task.executorTarget)
    if (!executor) {
      await opts.store.finish(task.id, 'failed', {
        verdict: 'failed',
        summary: `No executor registered for (${task.executor}, ${task.executorTarget ?? '-'})`,
        artifacts: [],
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, turns: 0, wallClockMs: 0 },
        error: 'executor_not_registered',
      })
      return
    }

    const resolvedContext = await resolveContext(task, opts)
    const spec = task.spec as { interactive?: boolean; tools?: string[]; model?: string }
    const abort = new AbortController()

    const handle = executor.start(
      {
        taskId: task.id,
        agentId: task.agentId,
        goal: task.goal,
        resolvedContext,
        acceptanceCriteria: task.acceptanceCriteria,
        budget: task.budget,
        tools: spec.tools,
        model: spec.model,
        workingDir: opts.workspaceDir,
        session: buildLocalSessionContext({
          agentId: task.agentId,
          nodeId: opts.nodeId,
          conversationId: task.conversationId ?? task.id,
          userId: task.requestedBy ?? 'task-runner',
          workingDir: opts.workspaceDir,
        }),
      },
      { signal: abort.signal },
    )

    // Resuming from awaiting-input: the stashed message drives the next turn.
    if (task.pendingMessage) await handle.steer(task.pendingMessage)

    let exceededReason: string | undefined
    for await (const event of handle.events) {
      if (event.type !== 'turn.end') continue
      await opts.store.updateUsage(task.id, event.usage)
      // Budget is enforced BETWEEN turns — hard exceed aborts the executor.
      if (!exceededReason) {
        exceededReason = budgetExceeded(task.budget, event.usage)
        if (exceededReason) {
          log.warn(`Task ${task.id} exceeded budget (${exceededReason}) — aborting`)
          abort.abort(`budget-exceeded: ${exceededReason}`)
        }
      }
    }

    const result = await handle.result

    if (exceededReason) {
      await opts.store.finish(task.id, 'killed', {
        ...result,
        verdict: 'budget-exceeded',
        error: result.error ?? `budget-exceeded: ${exceededReason}`,
      })
      return
    }

    // Interactive task turn ended without a queued message → park it.
    if (result.verdict === 'completed' && spec.interactive === true) {
      await opts.store.markAwaitingInput(task.id)
      return
    }

    await opts.store.finish(task.id, verdictToStatus(result), result)
  }
}

function verdictToStatus(result: TaskResult): TaskStatus {
  switch (result.verdict) {
    case 'completed':
      return 'completed'
    case 'killed':
    case 'budget-exceeded':
      return 'killed'
    case 'timeout':
      return 'timeout'
    case 'failed':
      return 'failed'
  }
}

// ---------------------------------------------------------------------------
// Embedded graphile-worker runner — production path.
// ---------------------------------------------------------------------------

export interface TaskRunner {
  start(): Promise<void>
  stop(): Promise<void>
}

export interface TaskRunnerOptions extends TaskHandlerOptions {
  pgUrl: string
  concurrency?: number
  pollIntervalMs?: number
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const n = Number.parseInt(raw, 10)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

export function createTaskRunner(opts: TaskRunnerOptions): TaskRunner {
  const handler = createTaskHandler(opts)
  let runner: Runner | undefined

  return {
    async start(): Promise<void> {
      const swept = await opts.store.sweep(opts.nodeId)
      if (swept > 0) {
        log.warn(`Crash sweep: ${String(swept)} stale 'running' task(s) requeued or failed`)
      }

      runner = await run({
        connectionString: opts.pgUrl,
        concurrency: opts.concurrency ?? envInt('RIVETOS_TASKS_CONCURRENCY', 4),
        pollInterval: opts.pollIntervalMs ?? envInt('RIVETOS_TASKS_POLL_MS', 2_000),
        noHandleSignals: true,
        taskList: {
          [TASK_JOB_NAME]: async (payload) => {
            const taskId = (payload as { taskId?: string } | null)?.taskId
            if (typeof taskId !== 'string' || taskId.length === 0) {
              log.warn(`run-task fired with invalid payload: ${JSON.stringify(payload)}`)
              return
            }
            await handler(taskId)
          },
        },
      })

      log.info('Ready — graphile-worker listening for run-task jobs')
    },

    async stop(): Promise<void> {
      if (runner) {
        await runner.stop()
        runner = undefined
      }
      log.info('Stopped')
    },
  }
}
