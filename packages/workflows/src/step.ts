/**
 * Step SDK — code-first orchestration surface for run.ts.
 *
 * Every step call:
 *   1. Allocates (label, seq) — seq is monotonic per label within the run
 *   2. Checks journal — if step_finished / gate_resolved exists, return cached result (replay)
 *   3. Else execute via backend, append journal, return result
 *
 * step.human NEVER resolves inline: writes gate_opened, sets paused_human,
 * throws WorkflowSuspension (caught by engine).
 *
 * step.parallel (slice G): journaled parent step + branch-scoped Steps with
 * namespaced labels, serialized journal writes, per-branch caseDirs.
 */

import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import {
  BudgetExceededError,
  ContractValidationError,
  WorkflowKilled,
  WorkflowSuspension,
  isWorkflowSuspension,
} from './errors.js'
import type { ExecutorRegistry } from './executors.js'
import { appendJournal, findCachedStepResult, isOpenGate, nowIso } from './journal.js'
import { mergeFields, updateRun } from './case.js'
import type { CallRegistry } from './registry.js'
import type {
  Field,
  JournalEntry,
  LoadedWorkflow,
  StepKind,
  StepUsage,
  WorkflowBudgets,
} from './types.js'
import { makeStepId } from './types.js'

export interface AgentStepOpts {
  /** Agent directory name under agents/, optional if prompt-only. */
  agent?: string
  prompt?: string
  /** Declared output field names — only these merge into case.json. */
  out: string[]
  [key: string]: unknown
}

export interface RunStepOpts {
  script?: string
  skill?: string
  in?: Record<string, unknown>
  [key: string]: unknown
}

export interface HumanStepOpts {
  prompt?: string
  /** Field names the human must supply. */
  fields: string[]
  [key: string]: unknown
}

/**
 * Step handle injected into run.ts.
 */
export interface Step {
  agent(label: string, opts: AgentStepOpts): Promise<Record<string, unknown>>
  run(label: string, opts: RunStepOpts): Promise<unknown>
  human(label: string, opts: HumanStepOpts): Promise<Record<string, unknown>>
  call(label: string, ref: string, input?: Record<string, unknown>): Promise<unknown>
  done(output: Record<string, unknown>): Promise<void>
  /**
   * Run branches concurrently. Journaled as kind `parallel`; each branch gets
   * a scoped Step with namespaced labels and its own working subdirectory.
   * Result array is in branch-index order (not completion order).
   */
  parallel<T>(label: string, branches: Array<(step: Step) => Promise<T>>): Promise<T[]>
}

export interface StepRuntimeOptions {
  caseDir: string
  runId: string
  workflow: LoadedWorkflow
  journal: JournalEntry[]
  executors: ExecutorRegistry
  callRegistry: CallRegistry
  stepTimeoutMs: number
  /** Kill flag checked between steps. */
  isKilled: () => boolean
  /** Output contract fields from the workflow manifest — validated at step.done. */
  outputFields: Field[]
  /** Per-workflow budgets (optional). Absent / empty = unlimited. */
  budgets?: WorkflowBudgets
}

function mergeUsage(a: StepUsage | undefined, b: StepUsage): StepUsage {
  const out: StepUsage = { ...a }
  if (typeof b.tokens === 'number') {
    out.tokens = (out.tokens ?? 0) + b.tokens
  }
  if (typeof b.costUsd === 'number') {
    out.costUsd = (out.costUsd ?? 0) + b.costUsd
  }
  return out
}

export function createStepRuntime(options: StepRuntimeOptions): {
  step: Step
  labelCounts: Map<string, number>
  getDoneOutput: () => Record<string, unknown> | undefined
  getSpent: () => { tokens: number; costUsd: number }
} {
  const labelCounts = new Map<string, number>()
  let doneOutput: Record<string, unknown> | undefined

  // Working copy of journal for in-memory cache hits during a single execution.
  const liveJournal = [...options.journal]

  // Accumulated spend for this run (replay + live). Shared across parallel branches.
  let spentTokens = 0
  let spentCostUsd = 0

  function accumulateUsage(u?: StepUsage): void {
    if (!u) return
    if (typeof u.tokens === 'number') spentTokens += u.tokens
    if (typeof u.costUsd === 'number') spentCostUsd += u.costUsd
  }

  function checkBudget(): void {
    const budgets = options.budgets
    if (!budgets) return
    // zero / non-positive / non-finite = unlimited for that dimension
    if (
      typeof budgets.maxTokens === 'number' &&
      Number.isFinite(budgets.maxTokens) &&
      budgets.maxTokens > 0 &&
      spentTokens > budgets.maxTokens
    ) {
      throw new BudgetExceededError({
        budget: 'maxTokens',
        limit: budgets.maxTokens,
        spent: spentTokens,
      })
    }
    if (
      typeof budgets.maxCost === 'number' &&
      Number.isFinite(budgets.maxCost) &&
      budgets.maxCost > 0 &&
      spentCostUsd > budgets.maxCost
    ) {
      throw new BudgetExceededError({
        budget: 'maxCost',
        limit: budgets.maxCost,
        spent: spentCostUsd,
      })
    }
  }

  function nextSeq(label: string): number {
    const n = (labelCounts.get(label) ?? 0) + 1
    labelCounts.set(label, n)
    return n
  }

  function checkKill(): void {
    if (options.isKilled()) {
      throw new WorkflowKilled(options.runId)
    }
  }

  /**
   * Journal lookup for a finished step's usage (for replay accumulation).
   */
  function usageFromJournal(label: string, seq: number): StepUsage | undefined {
    for (const e of liveJournal) {
      if (e.type === 'step_finished' && e.label === label && e.seq === seq) {
        return e.usage
      }
    }
    return undefined
  }

  async function beginStep(
    label: string,
    kind: StepKind,
  ): Promise<
    | { mode: 'replay'; stepId: string; seq: number; result: unknown }
    | { mode: 'live'; stepId: string; seq: number }
  > {
    checkKill()
    checkBudget()
    const seq = nextSeq(label)
    const stepId = makeStepId(label, seq)
    const cached = findCachedStepResult(liveJournal, label, seq, kind)
    if (cached.hit) {
      // Replay: keep spent total by accumulating journaled usage.
      accumulateUsage(usageFromJournal(label, seq))
      return { mode: 'replay', stepId, seq, result: cached.result }
    }
    // Re-execute path after crash: step_started may already exist without a finish.
    // Avoid duplicate step_started lines for the same (label, seq).
    const alreadyStarted = liveJournal.some(
      (e) => e.type === 'step_started' && e.label === label && e.seq === seq,
    )
    if (!alreadyStarted) {
      const started = {
        type: 'step_started' as const,
        ts: nowIso(),
        stepId,
        label,
        seq,
        kind,
      }
      await appendJournal(options.caseDir, started)
      liveJournal.push(started)
    }
    await updateRun(options.caseDir, { current: stepId, status: 'running' })
    return { mode: 'live', stepId, seq }
  }

  async function finishStep(
    label: string,
    seq: number,
    stepId: string,
    kind: StepKind,
    result: unknown,
    usage?: StepUsage,
  ): Promise<void> {
    const entry = {
      type: 'step_finished' as const,
      ts: nowIso(),
      stepId,
      label,
      seq,
      kind,
      result,
      ...(usage && (usage.tokens !== undefined || usage.costUsd !== undefined) ? { usage } : {}),
    }
    await appendJournal(options.caseDir, entry)
    liveJournal.push(entry)
  }

  async function failStep(
    label: string,
    seq: number,
    stepId: string,
    kind: StepKind,
    error: unknown,
  ): Promise<void> {
    const message = error instanceof Error ? error.message : String(error)
    const entry = {
      type: 'step_failed' as const,
      ts: nowIso(),
      stepId,
      label,
      seq,
      kind,
      error: message,
    }
    await appendJournal(options.caseDir, entry)
    liveJournal.push(entry)
  }

  interface ScopeOpts {
    /** Prefix prepended to every inner label (branch namespace). */
    labelPrefix: string
    /** caseDir seen by agent/run executors (branch subdir or root). */
    executorCaseDir: string
    allowHuman: boolean
    allowParallel: boolean
    allowDone: boolean
    /** When false, agent out-fields are NOT merged into case.json (branch safety). */
    mergeAgentFields: boolean
  }

  function makeStep(scope: ScopeOpts): Step {
    function scopedLabel(label: string): string {
      return scope.labelPrefix ? `${scope.labelPrefix}${label}` : label
    }

    const step: Step = {
      async agent(label, opts) {
        const fullLabel = scopedLabel(label)
        const phase = await beginStep(fullLabel, 'agent')
        if (phase.mode === 'replay') {
          return phase.result as Record<string, unknown>
        }
        const { stepId, seq } = phase
        let stepUsage: StepUsage | undefined
        try {
          const agentDef = opts.agent ? options.workflow.agents[opts.agent] : undefined
          if (opts.agent && !agentDef) {
            throw new Error(
              `Unknown agent "${opts.agent}" in step "${fullLabel}" — no agents/${opts.agent}.md ` +
                `in workflow "${options.workflow.manifest.id}" (known: ${
                  Object.keys(options.workflow.agents).join(', ') || 'none'
                })`,
            )
          }
          const result = await options.executors.agent.execute({
            label: fullLabel,
            stepId,
            agent: opts.agent,
            prompt: opts.prompt,
            out: opts.out,
            agentDef,
            caseDir: scope.executorCaseDir,
            workflow: options.workflow,
            timeoutMs: options.stepTimeoutMs,
            extra: opts,
            reportUsage: (u) => {
              stepUsage = mergeUsage(stepUsage, u)
            },
          })

          // Merge only declared fields into case.json (root steps only).
          if (scope.mergeAgentFields) {
            const mergeDeclared: Record<string, unknown> = {}
            const und: string[] = []
            for (const [k, v] of Object.entries(result ?? {})) {
              if (opts.out.includes(k)) {
                mergeDeclared[k] = v
              } else {
                und.push(k)
              }
            }
            if (Object.keys(mergeDeclared).length > 0) {
              await mergeFields(options.caseDir, mergeDeclared)
            }
            if (und.length > 0) {
              const warn = {
                type: 'manifest_warn' as const,
                ts: nowIso(),
                stepId,
                label: fullLabel,
                seq,
                undeclared: und,
                message: `Agent step "${fullLabel}" returned undeclared fields (not merged): ${und.join(', ')}`,
              }
              await appendJournal(options.caseDir, warn)
              liveJournal.push(warn)
              console.warn(warn.message)
            }
          }

          accumulateUsage(stepUsage)
          await finishStep(fullLabel, seq, stepId, 'agent', result, stepUsage)
          return result
        } catch (err) {
          if (isWorkflowSuspension(err)) throw err
          await failStep(fullLabel, seq, stepId, 'agent', err)
          throw err
        }
      },

      async run(label, opts) {
        const fullLabel = scopedLabel(label)
        const phase = await beginStep(fullLabel, 'run')
        if (phase.mode === 'replay') {
          return phase.result
        }
        const { stepId, seq } = phase
        let stepUsage: StepUsage | undefined
        try {
          const result = await options.executors.run.execute({
            label: fullLabel,
            stepId,
            script: opts.script,
            skill: opts.skill,
            in: opts.in,
            caseDir: scope.executorCaseDir,
            workflow: options.workflow,
            timeoutMs: options.stepTimeoutMs,
            extra: opts,
            reportUsage: (u) => {
              stepUsage = mergeUsage(stepUsage, u)
            },
          })
          accumulateUsage(stepUsage)
          await finishStep(fullLabel, seq, stepId, 'run', result, stepUsage)
          return result
        } catch (err) {
          if (isWorkflowSuspension(err)) throw err
          await failStep(fullLabel, seq, stepId, 'run', err)
          throw err
        }
      },

      async human(label, opts) {
        if (!scope.allowHuman) {
          throw new Error(
            `step.human("${label}") is not allowed inside a step.parallel branch ` +
              `(partial suspension is undefined in v1)`,
          )
        }
        const fullLabel = scopedLabel(label)
        const phase = await beginStep(fullLabel, 'human')
        if (phase.mode === 'replay') {
          return phase.result as Record<string, unknown>
        }
        const { stepId, seq } = phase

        // Live human gate: open gate, pause, suspend. Never resolve inline.
        // Crash re-entry: if this gate is already open in the journal, re-suspend
        // without appending a duplicate gate_opened.
        if (!isOpenGate(liveJournal, fullLabel, seq)) {
          const opened = {
            type: 'gate_opened' as const,
            ts: nowIso(),
            stepId,
            label: fullLabel,
            seq,
            prompt: opts.prompt,
            fields: opts.fields,
          }
          await appendJournal(options.caseDir, opened)
          liveJournal.push(opened)
        }
        await updateRun(options.caseDir, {
          status: 'paused_human',
          current: stepId,
        })
        throw new WorkflowSuspension({ stepId, label: fullLabel, seq })
      },

      async call(label, ref, input = {}) {
        const fullLabel = scopedLabel(label)
        const phase = await beginStep(fullLabel, 'call')
        if (phase.mode === 'replay') {
          return phase.result
        }
        const { stepId, seq } = phase
        try {
          const result = await options.callRegistry.call(ref, input, {
            parentRunId: options.runId,
            parentStepId: stepId,
            parentCaseDir: options.caseDir,
            timeoutMs: options.stepTimeoutMs,
          })
          await finishStep(fullLabel, seq, stepId, 'call', result)
          return result
        } catch (err) {
          if (isWorkflowSuspension(err)) throw err
          await failStep(fullLabel, seq, stepId, 'call', err)
          throw err
        }
      },

      async done(output) {
        if (!scope.allowDone) {
          throw new Error(
            `step.done() is not allowed inside a step.parallel branch — ` +
              `return a value from the branch function instead`,
          )
        }
        checkKill()
        checkBudget()
        // Enforce the output contract: every required output field must be present.
        const missing = options.outputFields.filter(
          (f) => f.required !== false && (output[f.name] === undefined || output[f.name] === null),
        )
        if (missing.length > 0) {
          throw new ContractValidationError(
            missing.map((f) => ({
              field: f.name,
              reason: 'missing',
              message: `required ${f.type} output field "${f.name}" is missing from step.done()`,
            })),
          )
        }
        const seq = nextSeq('done')
        const stepId = makeStepId('done', seq)
        doneOutput = output
        await mergeFields(options.caseDir, output)
        await finishStep('done', seq, stepId, 'done', output)
      },

      async parallel<T>(label: string, branches: Array<(step: Step) => Promise<T>>): Promise<T[]> {
        if (!scope.allowParallel) {
          throw new Error(
            `nested step.parallel("${label}") is not allowed — ` +
              `parallel branches cannot contain step.parallel`,
          )
        }
        if (!Array.isArray(branches)) {
          throw new Error(
            `step.parallel("${label}") requires an array of branch functions as the second argument`,
          )
        }
        const fullLabel = scopedLabel(label)
        const phase = await beginStep(fullLabel, 'parallel')
        if (phase.mode === 'replay') {
          return phase.result as T[]
        }
        const { stepId, seq } = phase
        try {
          // Promise.all: branch-index order result; any rejection fails the whole step.
          // In-flight sibling executor work is not cancelled (AbortSignal is a follow-up).
          const results = await Promise.all(
            branches.map(async (fn, i) => {
              const branchCaseDir = join(options.caseDir, stepId, `b${i}`)
              await mkdir(branchCaseDir, { recursive: true })
              const branchStep = makeStep({
                // Namespace: `${parallelStepId}/b${i}:` + inner label
                labelPrefix: `${stepId}/b${i}:`,
                executorCaseDir: branchCaseDir,
                allowHuman: false,
                allowParallel: false,
                allowDone: false,
                mergeAgentFields: false,
              })
              return fn(branchStep)
            }),
          )
          await finishStep(fullLabel, seq, stepId, 'parallel', results)
          return results
        } catch (err) {
          if (isWorkflowSuspension(err)) throw err
          await failStep(fullLabel, seq, stepId, 'parallel', err)
          throw err
        }
      },
    }

    return step
  }

  const step = makeStep({
    labelPrefix: '',
    executorCaseDir: options.caseDir,
    allowHuman: true,
    allowParallel: true,
    allowDone: true,
    mergeAgentFields: true,
  })

  return {
    step,
    labelCounts,
    getDoneOutput: () => doneOutput,
    getSpent: () => ({ tokens: spentTokens, costUsd: spentCostUsd }),
  }
}
