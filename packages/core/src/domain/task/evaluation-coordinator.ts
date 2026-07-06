/**
 * EvaluationCoordinator (phase 2d) — the adversarial verifier pass.
 *
 * On executor completion of an evaluable parent task, spawn ONE verifier
 * child task (origin 'eval', parent_task_id set), wait for it, and map its
 * structured result onto a VerifierResult. The verifier reuses the whole
 * TASK_RESULT machinery (2c): its criteriaSelfReport over the PARENT's
 * criteria IS the criteria report — no second parser, no drift.
 *
 * Skeptical by construction: a criterion is met only when the verifier
 * explicitly reports it met with evidence. Missing entries, a failed/absent
 * verifier run, an unparseable result, or an infrastructure error all count
 * AGAINST verification (refuted, with the reason as the refutation) — an
 * unverifiable claim is not a verified one.
 *
 * 2d is VERIFY-ONLY: the outcome is recorded on the row (eval column); the
 * executor's verdict and terminal status are untouched. Retry (2e) and
 * escalation (2f) build on the refutation this produces.
 */

import type {
  AcceptanceCriterion,
  CriterionReport,
  EvalOutcome,
  TaskResult,
  VerifierResult,
} from '@rivetos/types'
import type { TaskRow, TaskStore } from './store.js'
import type { TaskCompletionWaiter } from './completion-waiter.js'
import type { EscalationNotifier } from './escalation.js'
import { logger } from '../../logger.js'

const log = logger('TaskEval')

export interface EvaluationConfig {
  /** Verifier-driven retries before giving up (default 1 — Phil's call). */
  maxRetries?: number
  /** Verifier agent — defaults to the parent task's agent. */
  agentId?: string
  executor?: 'chat-loop' | 'harness-session'
  executorTarget?: string
  /** Verifier child budget (default: 1 turn, $0.05, 5 min). */
  budget?: { maxUsd?: number; maxTurns?: number; maxWallClockMs?: number }
  /** Origins that never get evaluated (mirrors tasks.eval.skip_origins). */
  skipOrigins: string[]
}

export interface EvaluationCoordinatorOptions {
  store: TaskStore
  waiter: TaskCompletionWaiter
  nodeId: string
  config: EvaluationConfig
  /**
   * Run a task inline in the CALLING worker slot (late-bound to the node's
   * task handler). Without it the verifier child waits on the job queue —
   * which can deadlock when every slot is a parent blocked in eval-wait
   * (concurrency=1 is a guaranteed hang). With it, verification consumes no
   * extra slot: the CAS claim makes the inline run race-safe against the
   * child's queued job (the loser no-ops).
   */
  runTask?: (taskId: string) => Promise<void>
  /** Escalation delivery (2f) — refuted-after-retries pings a human. */
  escalation?: EscalationNotifier
}

export interface EvaluationContext {
  /** Verifier-driven retry number this pass follows (0 = first attempt). */
  attempts: number
  /** Verifier child ids from earlier passes — accumulated on the outcome. */
  priorVerifierIds: string[]
}

export interface EvaluationPass {
  outcome: EvalOutcome
  /** Steer text for the retry turn — set iff refuted. */
  refutation?: string
}

export interface EvaluationCoordinator {
  /** Verifier-driven retries the runner may spend (config, default 1). */
  readonly maxRetries: number
  /** Should this parent task get a verifier pass at all? */
  shouldEvaluate(task: TaskRow, result: TaskResult): boolean
  /**
   * Run one verifier pass and return the recorded outcome. Never throws —
   * verification failure must never take down the parent's finish path.
   */
  evaluate(task: TaskRow, result: TaskResult, ctx?: EvaluationContext): Promise<EvaluationPass>
  /**
   * Terminal refutation (retry budget spent): flip the outcome to
   * 'escalated' on the row and notify. Never throws.
   */
  escalate(task: TaskRow, result: TaskResult, pass: EvaluationPass): Promise<void>
}

const DEFAULT_VERIFIER_BUDGET = { maxTurns: 1, maxUsd: 0.05, maxWallClockMs: 300_000 }

export function createEvaluationCoordinator(
  opts: EvaluationCoordinatorOptions,
): EvaluationCoordinator {
  const { store, waiter, config } = opts

  return {
    maxRetries: config.maxRetries ?? 1,
    shouldEvaluate(task: TaskRow, result: TaskResult): boolean {
      if (task.origin === 'eval') return false // a verifier is never verified
      if (result.verdict !== 'completed') return false // failures speak for themselves
      if (task.acceptanceCriteria.length === 0) return false // unevaluated by design
      if (config.skipOrigins.includes(task.origin)) return false
      if (task.spec.interactive === true) return false // sessions park, not finish
      if (task.spec.auditOnly === true) return false
      return true
    },

    async evaluate(
      task: TaskRow,
      result: TaskResult,
      ctx: EvaluationContext = { attempts: 0, priorVerifierIds: [] },
    ): Promise<EvaluationPass> {
      try {
        const verifier = await runVerifierChild(task, result)
        const outcome: EvalOutcome = {
          verdict: verifier.verdict,
          attempts: ctx.attempts,
          verifierTaskIds: verifier.taskId
            ? [...ctx.priorVerifierIds, verifier.taskId]
            : ctx.priorVerifierIds,
          criteriaReport: verifier.criteriaReport,
          diverged: result.verdict === 'completed' && verifier.verdict === 'refuted',
        }
        await store.recordEval(task.id, outcome)
        if (outcome.diverged) {
          log.warn(
            `Task ${task.id} DIVERGED: executor claimed completed, verifier refuted — ${
              verifier.refutation ?? verifier.summary
            }`,
          )
        }
        return { outcome, refutation: verifier.refutation }
      } catch (err: unknown) {
        // Never let evaluation take down the parent's finish path.
        const msg = err instanceof Error ? err.message : String(err)
        log.error(`Task ${task.id} evaluation errored — recording refuted-by-error: ${msg}`)
        const outcome: EvalOutcome = {
          verdict: 'refuted',
          attempts: ctx.attempts,
          verifierTaskIds: ctx.priorVerifierIds,
          criteriaReport: [],
          diverged: result.verdict === 'completed',
        }
        await store.recordEval(task.id, outcome).catch(() => undefined)
        return { outcome, refutation: `evaluation infrastructure error: ${msg}` }
      }
    },

    escalate(task: TaskRow, result: TaskResult, pass: EvaluationPass): Promise<void> {
      return doEscalate(task, result, pass)
    },
  }

  async function doEscalate(
    task: TaskRow,
    result: TaskResult,
    pass: EvaluationPass,
  ): Promise<void> {
    try {
      const outcome: EvalOutcome = {
        ...pass.outcome,
        verdict: 'escalated',
        escalatedAt: new Date().toISOString(),
      }
      await store.recordEval(task.id, outcome)
      if (opts.escalation) {
        // Truly fire-and-forget with a hang guard: a stuck channel send must
        // never block the parent's finish path. 10s is generous for a ping;
        // past it we log and move on (the escalated verdict is already on
        // the row — the scoreboard still surfaces it).
        const timeout = new Promise<'timeout'>((r) => {
          const t = setTimeout(() => r('timeout'), 10_000)
          t.unref()
        })
        const sent = await Promise.race([
          opts.escalation.notify({ task, result, outcome, refutation: pass.refutation }),
          timeout,
        ])
        if (sent === 'timeout') {
          log.error(`Task ${task.id} escalation notify timed out (>10s) — continuing to finish`)
        }
      } else {
        log.warn(`Task ${task.id} escalated — no escalation notifier configured`)
      }
    } catch (err: unknown) {
      log.error(
        `Task ${task.id} escalation failed: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  async function runVerifierChild(
    task: TaskRow,
    result: TaskResult,
  ): Promise<VerifierResult & { taskId?: string }> {
    const budget = { ...DEFAULT_VERIFIER_BUDGET, ...config.budget }
    const child = await store.create({
      goal: buildVerifierGoal(task, result),
      executor: config.executor ?? 'chat-loop',
      executorTarget: config.executorTarget,
      agentId: config.agentId ?? task.agentId,
      origin: 'eval',
      requestedBy: `eval:${task.id}`,
      parentTaskId: task.id,
      chainDepth: task.chainDepth + 1,
      // Verify where the work happened — artifacts reference local state.
      nodeAffinity: opts.nodeId,
      spec: {
        role: 'verifier',
        // A verifier reads and checks; it must not spawn more work.
        excludeTools: ['delegate_task', 'subagent_spawn', 'subagent_send'],
      },
      budget,
      maxAttempts: 1,
    })

    // Inline-first: run the child in THIS worker slot. If the queued job
    // won the claim race instead, fall back to waiting on it.
    if (opts.runTask) {
      await opts.runTask(child.id).catch((err: unknown) => {
        log.warn(
          `Inline verifier run for ${child.id} errored — falling back to queue: ${
            err instanceof Error ? err.message : String(err)
          }`,
        )
      })
      const after = await store.get(child.id)
      if (after && isTerminal(after.status)) {
        if (after.status !== 'completed' || !after.result) {
          return refutedBy(child.id, `verifier run ${after.status}: ${after.error ?? 'no result'}`)
        }
        return mapVerifierResult(child.id, task.acceptanceCriteria, after.result)
      }
    }

    const deadlineMs = (budget.maxWallClockMs ?? 300_000) + 60_000
    const terminal = await waiter.wait(child.id, { deadlineMs })
    if (!terminal) {
      await store.requestKill(child.id).catch(() => undefined)
      return refutedBy(child.id, 'verifier did not finish within its deadline')
    }
    if (terminal.status !== 'completed' || !terminal.result) {
      return refutedBy(
        child.id,
        `verifier run ${terminal.status}: ${terminal.error ?? 'no result'}`,
      )
    }
    return mapVerifierResult(child.id, task.acceptanceCriteria, terminal.result)
  }
}

/**
 * Map the verifier child's structured TaskResult onto a VerifierResult.
 * Verified iff EVERY parent criterion has an explicit met=true entry in the
 * verifier's criteriaSelfReport. Anything less — missing entries, met=false,
 * no self-report at all — refutes (skeptical default).
 */
export function mapVerifierResult(
  taskId: string,
  criteria: AcceptanceCriterion[],
  result: TaskResult,
): VerifierResult & { taskId?: string } {
  const reported = new Map((result.criteriaSelfReport ?? []).map((c) => [c.id, c]))
  const criteriaReport: CriterionReport[] = criteria.map((c) => {
    const entry = reported.get(c.id)
    return {
      id: c.id,
      met: entry?.met === true,
      evidence: entry?.evidence ?? (entry ? '' : 'verifier did not report on this criterion'),
    }
  })
  const unmet = criteriaReport.filter((c) => !c.met)
  if (unmet.length === 0) {
    return { taskId, verdict: 'verified', summary: result.summary, criteriaReport }
  }
  const refutation = [
    `Unmet acceptance criteria (${unmet.length}/${criteria.length}):`,
    ...unmet.map((c) => `- [${c.id}] ${c.evidence || 'no evidence of completion'}`),
    '',
    `Verifier summary: ${result.summary}`,
  ].join('\n')
  return { taskId, verdict: 'refuted', summary: result.summary, criteriaReport, refutation }
}

function isTerminal(status: string): boolean {
  return (
    status === 'completed' || status === 'failed' || status === 'killed' || status === 'timeout'
  )
}

function refutedBy(taskId: string, reason: string): VerifierResult & { taskId?: string } {
  return {
    taskId,
    verdict: 'refuted',
    summary: reason,
    criteriaReport: [],
    refutation: reason,
  }
}

/** Steer message injected into the retry turn after a refutation (2e). */
export function buildRetryMessage(attempt: number, maxRetries: number, refutation: string): string {
  return [
    `## Verifier refutation (retry ${attempt}/${maxRetries})`,
    'An adversarial verifier reviewed your completed work against the acceptance criteria and REFUTED it:',
    '',
    refutation,
    '',
    'Address each unmet criterion with concrete evidence. Re-run checks where needed, fix what is actually missing, and finish with an updated TASK_RESULT (criteriaSelfReport for every criterion).',
  ].join('\n')
}

/** The verifier child's goal — an adversarial audit brief over the parent. */
function buildVerifierGoal(task: TaskRow, result: TaskResult): string {
  const artifacts =
    result.artifacts.length > 0
      ? result.artifacts
          .map((a) => `- ${a.kind}: ${a.ref}${a.note ? ` (${a.note})` : ''}`)
          .join('\n')
      : '(none listed)'
  const selfReport =
    result.criteriaSelfReport && result.criteriaSelfReport.length > 0
      ? result.criteriaSelfReport
          .map((c) => `- [${c.id}] met=${String(c.met)}${c.evidence ? ` — ${c.evidence}` : ''}`)
          .join('\n')
      : '(no self-report)'
  return [
    'You are an adversarial VERIFIER. Another agent claims to have completed a task; your job is to REFUTE that claim unless the evidence holds up. Do not take the claim at face value — check artifacts, run read-only checks, look for what is missing.',
    '',
    `## The claimed-complete task`,
    `Goal: ${task.goal}`,
    '',
    `## Acceptance criteria to verify (report on EVERY one by id)`,
    task.acceptanceCriteria
      .map((c) => `- [${c.id}] ${c.description}${c.check ? ` (check: ${c.check})` : ''}`)
      .join('\n'),
    '',
    `## The executor's claim`,
    `Summary: ${result.summary}`,
    `Artifacts:\n${artifacts}`,
    `Self-report:\n${selfReport}`,
    '',
    'In your TASK_RESULT criteriaSelfReport, report each criterion id with met=true ONLY when you found concrete evidence it is satisfied (state the evidence). If you cannot verify a criterion, report met=false and say why. Your verdict should be "completed" (meaning: you completed the verification) regardless of whether the criteria pass.',
  ].join('\n')
}
