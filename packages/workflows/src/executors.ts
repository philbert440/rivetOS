/**
 * Backend-neutral executor interfaces.
 *
 * The RivetOS host registry lives in @rivetos/core
 * (`domain/workflows/host-executors.ts`): agent steps run as ros_tasks and
 * script steps as child processes in the caseDir. Other deployments can back
 * these with any agent runtime; step SDK semantics are the same.
 *
 * This package ships the interfaces and MockExecutorRegistry (fixture tests).
 */

import type { AgentDef, LoadedWorkflow, StepUsage } from './types.js'

// ---------------------------------------------------------------------------
// Contexts passed to executors
// ---------------------------------------------------------------------------

/**
 * Optional callback for executors to report token/cost usage for the step.
 * The step runtime accumulates these for budget enforcement and journals them
 * on `step_finished`. Does not change the `execute()` return type.
 */
export type ReportUsageFn = (usage: StepUsage) => void

export interface AgentExecuteOpts {
  /** Step label (stable id base). */
  label: string
  stepId: string
  /** Agent name under agents/, or free-form prompt-only agent. */
  agent?: string
  prompt?: string
  /** Declared manifest output field names this agent may write. */
  out: string[]
  /** Agent definition from the workflow dir when agent name resolves. */
  agentDef?: AgentDef
  /** Absolute case directory for this run. */
  caseDir: string
  /** Loaded parent workflow (for reading instructions). */
  workflow: LoadedWorkflow
  /** Timeout hint from engine config (ms). Enforcement is executor responsibility when possible. */
  timeoutMs?: number
  /** Extra free-form opts from the step call. */
  extra?: Record<string, unknown>
  /**
   * Report usage for budget accounting. Optional — older executors may omit
   * calling it; budgets then only see zeros for that step.
   */
  reportUsage?: ReportUsageFn
}

export interface RunExecuteOpts {
  label: string
  stepId: string
  /** Script path relative to workflow dir, or absolute. */
  script?: string
  /** Skill name, API id, etc. — executor interprets. */
  skill?: string
  /** Structured input for the work unit. */
  in?: Record<string, unknown>
  caseDir: string
  workflow: LoadedWorkflow
  timeoutMs?: number
  extra?: Record<string, unknown>
  /** See AgentExecuteOpts.reportUsage. */
  reportUsage?: ReportUsageFn
}

export interface AgentExecutor {
  execute(opts: AgentExecuteOpts): Promise<Record<string, unknown>>
}

export interface RunExecutor {
  execute(opts: RunExecuteOpts): Promise<unknown>
}

export interface ExecutorRegistry {
  agent: AgentExecutor
  run: RunExecutor
}

// ---------------------------------------------------------------------------
// Mock executors (tests / fixtures)
// ---------------------------------------------------------------------------

export type MockAgentHandler = (
  opts: AgentExecuteOpts,
) => Promise<Record<string, unknown>> | Record<string, unknown>

export type MockRunHandler = (opts: RunExecuteOpts) => unknown

export interface MockExecutorRegistryOptions {
  agent?: MockAgentHandler
  run?: MockRunHandler
}

/**
 * Test double: scripted handlers return fixture results without side effects.
 */
export class MockExecutorRegistry implements ExecutorRegistry {
  readonly agent: AgentExecutor
  readonly run: RunExecutor
  /** Call log for assertions. */
  readonly calls: Array<{ kind: 'agent' | 'run'; opts: AgentExecuteOpts | RunExecuteOpts }> = []

  constructor(options: MockExecutorRegistryOptions = {}) {
    const agentHandler =
      options.agent ??
      ((opts: AgentExecuteOpts) => {
        const result: Record<string, unknown> = {}
        for (const key of opts.out) {
          result[key] = `mock:${key}`
        }
        return result
      })
    const runHandler = options.run ?? ((_opts: RunExecuteOpts) => ({ ok: true }))

    this.agent = {
      execute: async (opts) => {
        this.calls.push({ kind: 'agent', opts })
        return await agentHandler(opts)
      },
    }
    this.run = {
      execute: async (opts) => {
        this.calls.push({ kind: 'run', opts })
        return await runHandler(opts)
      },
    }
  }
}
