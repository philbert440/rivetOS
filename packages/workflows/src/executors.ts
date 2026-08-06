/**
 * Backend-neutral executor interfaces.
 *
 * At home: agent → ros_task on the mesh (reviewer wires real impl).
 * Other deployments can back these with any agent runtime (cloud SDKs, etc.).
 * Same step SDK semantics; only the registry differs.
 *
 * This package ships:
 *  - interfaces
 *  - MockExecutorRegistry (for fixture tests)
 *  - LocalExecutorRegistry with TODO stubs for real ros_task / script backends
 */

import type { AgentDef, LoadedWorkflow } from './types.js'

// ---------------------------------------------------------------------------
// Contexts passed to executors
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Local / production stubs (reviewer wires real backends)
// ---------------------------------------------------------------------------

/**
 * LocalExecutorRegistry — interface-complete stub for host RivetOS.
 *
 * TODO(reviewer): wire agent executor to ros_task / mesh task API.
 * TODO(reviewer): wire run executor to shell/skill/API dispatch.
 *
 * Until wired, both throw so misconfiguration fails loud rather than silent.
 */
export class LocalExecutorRegistry implements ExecutorRegistry {
  readonly agent: AgentExecutor = {
    execute(opts: AgentExecuteOpts): Promise<Record<string, unknown>> {
      // TODO: dispatch ros_task with agent instructions + tools from opts.agentDef
      // and return structured out-fields. See product plan §Orchestration.
      throw new Error(
        `LocalExecutorRegistry.agent is a stub (step "${opts.label}"). ` +
          `Wire ros_task-backed executor before production use.`,
      )
    },
  }

  readonly run: RunExecutor = {
    execute(opts: RunExecuteOpts): Promise<unknown> {
      // TODO: run script/skill/API work unit; capture result blob.
      throw new Error(
        `LocalExecutorRegistry.run is a stub (step "${opts.label}"). ` +
          `Wire script/skill/API executor before production use.`,
      )
    },
  }
}
