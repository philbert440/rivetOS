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
 * step.parallel is reserved (throws) — slice G.
 */

import {
  ContractValidationError,
  WorkflowKilled,
  WorkflowSuspension,
  isWorkflowSuspension,
} from './errors.js'
import type { ExecutorRegistry } from './executors.js'
import { appendJournal, findCachedStepResult, isOpenGate, nowIso } from './journal.js'
import { mergeFields, updateRun } from './case.js'
import type { CallRegistry } from './registry.js'
import type { Field, JournalEntry, LoadedWorkflow, StepKind } from './types.js'
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
 *
 * `parallel` exists so call sites type-check later; invoking it throws.
 */
export interface Step {
  agent(label: string, opts: AgentStepOpts): Promise<Record<string, unknown>>
  run(label: string, opts: RunStepOpts): Promise<unknown>
  human(label: string, opts: HumanStepOpts): Promise<Record<string, unknown>>
  call(label: string, ref: string, input?: Record<string, unknown>): Promise<unknown>
  done(output: Record<string, unknown>): Promise<void>
  /**
   * Reserved for slice G. Plumbing only — throws if called.
   * Future: step.parallel(label, branches) with per-branch subdirs + merge.
   */
  parallel(label: string, ..._args: unknown[]): Promise<never>
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
}

export function createStepRuntime(options: StepRuntimeOptions): {
  step: Step
  labelCounts: Map<string, number>
  getDoneOutput: () => Record<string, unknown> | undefined
} {
  const labelCounts = new Map<string, number>()
  let doneOutput: Record<string, unknown> | undefined

  // Working copy of journal for in-memory cache hits during a single execution.
  const liveJournal = [...options.journal]

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

  async function beginStep(
    label: string,
    kind: StepKind,
  ): Promise<
    | { mode: 'replay'; stepId: string; seq: number; result: unknown }
    | { mode: 'live'; stepId: string; seq: number }
  > {
    checkKill()
    const seq = nextSeq(label)
    const stepId = makeStepId(label, seq)
    const cached = findCachedStepResult(liveJournal, label, seq, kind)
    if (cached.hit) {
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
  ): Promise<void> {
    const entry = {
      type: 'step_finished' as const,
      ts: nowIso(),
      stepId,
      label,
      seq,
      kind,
      result,
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

  const step: Step = {
    async agent(label, opts) {
      const phase = await beginStep(label, 'agent')
      if (phase.mode === 'replay') {
        return phase.result as Record<string, unknown>
      }
      const { stepId, seq } = phase
      try {
        const agentDef = opts.agent ? options.workflow.agents[opts.agent] : undefined
        if (opts.agent && !agentDef) {
          throw new Error(
            `Unknown agent "${opts.agent}" in step "${label}" — no agents/${opts.agent}.md ` +
              `in workflow "${options.workflow.manifest.id}" (known: ${
                Object.keys(options.workflow.agents).join(', ') || 'none'
              })`,
          )
        }
        const result = await options.executors.agent.execute({
          label,
          stepId,
          agent: opts.agent,
          prompt: opts.prompt,
          out: opts.out,
          agentDef,
          caseDir: options.caseDir,
          workflow: options.workflow,
          timeoutMs: options.stepTimeoutMs,
          extra: opts,
        })

        // Merge only declared fields (opts.out) into case.json; warn on undeclared.
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
            label,
            seq,
            undeclared: und,
            message: `Agent step "${label}" returned undeclared fields (not merged): ${und.join(', ')}`,
          }
          await appendJournal(options.caseDir, warn)
          liveJournal.push(warn)

          console.warn(warn.message)
        }

        await finishStep(label, seq, stepId, 'agent', result)
        return result
      } catch (err) {
        if (isWorkflowSuspension(err)) throw err
        await failStep(label, seq, stepId, 'agent', err)
        throw err
      }
    },

    async run(label, opts) {
      const phase = await beginStep(label, 'run')
      if (phase.mode === 'replay') {
        return phase.result
      }
      const { stepId, seq } = phase
      try {
        const result = await options.executors.run.execute({
          label,
          stepId,
          script: opts.script,
          skill: opts.skill,
          in: opts.in,
          caseDir: options.caseDir,
          workflow: options.workflow,
          timeoutMs: options.stepTimeoutMs,
          extra: opts,
        })
        await finishStep(label, seq, stepId, 'run', result)
        return result
      } catch (err) {
        if (isWorkflowSuspension(err)) throw err
        await failStep(label, seq, stepId, 'run', err)
        throw err
      }
    },

    async human(label, opts) {
      const phase = await beginStep(label, 'human')
      if (phase.mode === 'replay') {
        return phase.result as Record<string, unknown>
      }
      const { stepId, seq } = phase

      // Live human gate: open gate, pause, suspend. Never resolve inline.
      // Crash re-entry: if this gate is already open in the journal, re-suspend
      // without appending a duplicate gate_opened.
      if (!isOpenGate(liveJournal, label, seq)) {
        const opened = {
          type: 'gate_opened' as const,
          ts: nowIso(),
          stepId,
          label,
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
      throw new WorkflowSuspension({ stepId, label, seq })
    },

    async call(label, ref, input = {}) {
      const phase = await beginStep(label, 'call')
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
        await finishStep(label, seq, stepId, 'call', result)
        return result
      } catch (err) {
        if (isWorkflowSuspension(err)) throw err
        await failStep(label, seq, stepId, 'call', err)
        throw err
      }
    },

    async done(output) {
      checkKill()
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

    parallel(label: string): Promise<never> {
      throw new Error(
        `step.parallel("${label}") is not implemented in v1 (slice G). ` +
          `Use sequential steps or step.call for composition.`,
      )
    },
  }

  return {
    step,
    labelCounts,
    getDoneOutput: () => doneOutput,
  }
}
