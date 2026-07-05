/**
 * Task engine contract — durable `ros_tasks` model + HarnessExecutor.
 *
 * A task is one delegated unit of work executed by a harness (chat-loop
 * AgentLoop, headless CLI session, or a remote mesh node). The runner claims
 * queued tasks, resolves context, drives the executor, and enforces budgets
 * BETWEEN turns. Multi-turn transcript state lives in the task's memory
 * conversation (`session_key = task:<taskId>`), not in the task row.
 *
 * Authoritative design: /rivet-shared/plans/phase-1-task-engine-design.md
 * (Appendix B — this file is that contract).
 */

import type { AgentEventBody } from '@rivetos/den-protocol'
import type { SessionContext } from './session-context.js'

export type TaskExecutorKind = 'chat-loop' | 'harness-session' | 'mesh'
export type TaskStatus =
  'queued' | 'running' | 'awaiting-input' | 'completed' | 'failed' | 'killed' | 'timeout'

export interface ContextRef {
  kind: 'conversation' | 'message' | 'task' | 'file' | 'url'
  ref: string
  note?: string
}
export interface AcceptanceCriterion {
  id: string
  description: string
  kind: 'manual' | 'automated'
  check?: string
}
export interface TaskBudget {
  maxUsd?: number
  maxTokens?: number
  maxTurns?: number
  maxWallClockMs?: number
}
export interface TaskUsage {
  inputTokens: number
  outputTokens: number
  totalTokens: number
  costUsd?: number
  turns: number
  wallClockMs: number
}

export interface TaskSpec {
  taskId: string
  agentId: string
  goal: string
  resolvedContext: string
  acceptanceCriteria: AcceptanceCriterion[]
  budget: TaskBudget
  tools?: string[]
  workingDir?: string
  model?: string
  effort?: 'low' | 'medium' | 'high'
  systemPromptAppend?: string
  session: SessionContext // session_key = `task:${taskId}`
}

export type TaskEvent = { ts: number } & (
  | { type: 'den'; event: AgentEventBody }
  | { type: 'turn.start'; turn: number }
  | { type: 'turn.end'; turn: number; usage: TaskUsage; harnessSessionId?: string }
  | { type: 'cost'; deltaUsd: number; totalUsd: number }
  | { type: 'log'; level: 'debug' | 'info' | 'warn' | 'error'; message: string }
)

export type TaskVerdict = 'completed' | 'failed' | 'killed' | 'timeout' | 'budget-exceeded'

export interface TaskResult {
  verdict: TaskVerdict
  summary: string
  output?: string
  artifacts: Array<{ kind: 'file' | 'url' | 'commit' | 'message'; ref: string; note?: string }>
  criteriaSelfReport?: Array<{ id: string; met: boolean; evidence: string }>
  usage: TaskUsage
  error?: string
}

export interface TaskHandle {
  events: AsyncIterable<TaskEvent>
  steer(message: string): Promise<void>
  kill(reason?: string): Promise<void>
  result: Promise<TaskResult> // resolves on EVERY terminal path; never rejects
}

export interface HarnessExecutorCapabilities {
  steerable: boolean
  multiTurn: boolean
  structuredStream: boolean // hermes: false
  usageInResult: boolean // grok/hermes: false (async/post-hoc)
  sessionIdCapture: boolean
  slashCommands: boolean // claude only (headless)
  effortSelection: boolean // hermes: false
  mcpInjection: 'flag' | 'cwd-file' | 'persistent-config' | 'none'
}

export interface HarnessExecutor {
  readonly name: string
  capabilities(): HarnessExecutorCapabilities
  listCommands?(): Promise<
    Array<{ name: string; description: string; argHint?: string; source: string }>
  >
  start(spec: TaskSpec, opts: { signal: AbortSignal }): TaskHandle
}
