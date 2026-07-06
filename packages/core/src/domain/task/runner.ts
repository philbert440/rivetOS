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
  /** Liveness heartbeat cadence while a task executes (default 30s). */
  heartbeatIntervalMs?: number
}

const HEARTBEAT_INTERVAL_MS_DEFAULT = 30_000

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

function addUsage(a: TaskUsage, b: TaskUsage): TaskUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    totalTokens: a.totalTokens + b.totalTokens,
    costUsd:
      a.costUsd !== undefined || b.costUsd !== undefined
        ? (a.costUsd ?? 0) + (b.costUsd ?? 0)
        : undefined,
    turns: a.turns + b.turns,
    wallClockMs: a.wallClockMs + b.wallClockMs,
  }
}

const ZERO_USAGE: TaskUsage = {
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  turns: 0,
  wallClockMs: 0,
}

export function createTaskHandler(opts: TaskHandlerOptions): (taskId: string) => Promise<void> {
  return async (taskId: string): Promise<void> => {
    const task = await opts.store.claim(taskId, opts.nodeId)
    if (!task) {
      log.warn(`Skipping task ${taskId} — already claimed, terminal, or removed`)
      return
    }

    // Anything that throws after a successful claim would strand the row in
    // 'running' forever (the graphile job has maxAttempts 1) — catch and
    // best-effort fail the task instead.
    try {
      await runClaimedTask(task, opts)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      log.error(`Task ${task.id} handler crashed: ${msg}`)
      try {
        await opts.store.finish(task.id, 'failed', {
          verdict: 'failed',
          summary: `Task handler crashed: ${msg}`,
          artifacts: [],
          usage: task.usage ?? ZERO_USAGE,
          error: msg,
        })
      } catch (finishErr: unknown) {
        log.error(
          `Task ${task.id} could not be marked failed after a handler crash: ` +
            `${(finishErr as Error).message} — the crash sweep will requeue or fail it`,
        )
      }
    }
  }
}

async function runClaimedTask(task: TaskRow, opts: TaskHandlerOptions): Promise<void> {
  const executor = opts.executors.resolve(task.executor, task.executorTarget)
  if (!executor) {
    await opts.store.finish(task.id, 'failed', {
      verdict: 'failed',
      summary: `No executor registered for (${task.executor}, ${task.executorTarget ?? '-'})`,
      artifacts: [],
      usage: ZERO_USAGE,
      error: 'executor_not_registered',
    })
    return
  }

  const resolvedContext = await resolveContext(task, opts)
  const spec = task.spec as {
    interactive?: boolean
    tools?: string[]
    model?: string
    promptMode?: 'task' | 'heartbeat'
  }

  // Resuming from awaiting-input: consume the stashed message atomically —
  // it must drive the opening turn INSTEAD of the goal (the goal must never
  // re-execute on resume; memory-conversation rehydration lands at step (c)).
  let resumeMessage =
    task.pendingMessage !== undefined ? await opts.store.takePendingMessage(task.id) : undefined

  // Periodic liveness heartbeat — the crash sweep only reaps rows whose
  // last_heartbeat_at is stale, so an overlapping old process's in-flight
  // tasks are not double-run across a restart.
  const heartbeatTimer = setInterval(() => {
    opts.store.heartbeat(task.id).catch((err: unknown) => {
      log.warn(`Heartbeat for task ${task.id} failed: ${(err as Error).message}`)
    })
  }, opts.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS_DEFAULT)
  heartbeatTimer.unref()

  try {
    let totalUsage = ZERO_USAGE

    // One iteration per executor run. Interactive tasks loop when a steered
    // message raced the park attempt (P2) — the reclaimed message seeds the
    // next run's resumeMessage.
    for (;;) {
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
          promptMode: spec.promptMode,
          workingDir: opts.workspaceDir,
          resumeMessage,
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

      let exceededReason: string | undefined
      for await (const event of handle.events) {
        if (event.type !== 'turn.end') continue
        // Harness executors surface the spawn's session id — append it to
        // the row so the task's CLI sessions stay traceable.
        if (event.harnessSessionId) {
          await opts.store.appendHarnessSessionId?.(task.id, event.harnessSessionId)
        }
        const runningTotal = addUsage(totalUsage, event.usage)
        await opts.store.updateUsage(task.id, runningTotal)
        // Budget is enforced BETWEEN turns — hard exceed aborts the executor.
        if (!exceededReason) {
          exceededReason = budgetExceeded(task.budget, runningTotal)
          if (exceededReason) {
            log.warn(`Task ${task.id} exceeded budget (${exceededReason}) — aborting`)
            abort.abort(`budget-exceeded: ${exceededReason}`)
          }
        }
      }

      const result = await handle.result
      totalUsage = addUsage(totalUsage, result.usage)
      const totalResult: TaskResult = { ...result, usage: totalUsage }

      if (exceededReason) {
        await opts.store.finish(task.id, 'killed', {
          ...totalResult,
          verdict: 'budget-exceeded',
          error: result.error ?? `budget-exceeded: ${exceededReason}`,
        })
        return
      }

      // Kill requested while the turn was in flight (requestKill flips the
      // row without aborting the executor): record the outcome as killed and
      // discard the result — legacy subagent "let it finish, drop the
      // result" semantics.
      const rowAfterTurn = await opts.store.get(task.id)
      if (rowAfterTurn?.status === 'killed') {
        await opts.store.finish(task.id, 'killed', {
          ...totalResult,
          verdict: 'killed',
          error: totalResult.error ?? 'killed',
        })
        return
      }

      // Interactive task turn ended without a queued message → park it,
      // snapshotting the turn's result so status readers see lastResponse
      // and usage while the row sits awaiting-input.
      if (result.verdict === 'completed' && spec.interactive === true) {
        if (await opts.store.markAwaitingInput(task.id, totalResult)) return
        // Park refused: a concurrent send() stashed a message between the
        // last turn and the flip. Claim it and keep the turn loop going —
        // parking would have wiped it.
        resumeMessage = await opts.store.takePendingMessage(task.id)
        if (resumeMessage !== undefined) continue
        // Raced with something that already consumed/cleared the message
        // (e.g. another park). Try once more; if still refused, fall through
        // to a terminal finish rather than loop forever.
        if (await opts.store.markAwaitingInput(task.id, totalResult)) return
        log.warn(`Task ${task.id} could not park or reclaim a message — finishing completed`)
      }

      await opts.store.finish(task.id, verdictToStatus(totalResult), totalResult)
      return
    }
  } finally {
    clearInterval(heartbeatTimer)
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

/** Postgres undefined_table (42P01) or a message that reads like it. */
function isRelationMissing(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  const code = (err as Error & { code?: string }).code
  return code === '42P01' || /relation .* does not exist/i.test(err.message)
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
      // Never crash boot for a missing ros_tasks table (0002 migration not
      // applied on this node yet) — disable the engine and say so clearly.
      const disable = (): void => {
        log.warn(
          'ros_tasks missing — task engine disabled; run rivetos-memory-migrate to enable it',
        )
      }
      if (opts.store.isReady) {
        try {
          if (!(await opts.store.isReady())) {
            disable()
            return
          }
        } catch (err: unknown) {
          log.warn(`Task engine readiness check failed: ${(err as Error).message} — disabled`)
          return
        }
      }

      let swept: number
      try {
        swept = await opts.store.sweep(opts.nodeId)
      } catch (err: unknown) {
        if (isRelationMissing(err)) {
          disable()
          return
        }
        throw err
      }
      if (swept > 0) {
        log.warn(`Crash sweep: ${String(swept)} stale task(s) requeued, failed, or timed out`)
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
