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
  kind: 'conversation' | 'message' | 'task' | 'file' | 'url' | 'wiki'
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
  /**
   * System-prompt flavor. 'heartbeat' selects the workspace heartbeat prompt
   * with no task scaffold — prompt parity for cutover heartbeat tasks;
   * default 'task' is the chat system prompt + delegated-task scaffold.
   */
  promptMode?: 'task' | 'heartbeat'
  /**
   * Tool names to strip from the executor's toolset. Mesh-delegated tasks
   * exclude delegate_task — the noDelegation loop guard the legacy
   * /api/message path applied (Appendix E).
   */
  excludeTools?: string[]
  /**
   * Resume from awaiting-input: the steered message that drives the opening
   * turn INSTEAD of `goal` — the goal must never re-execute on resume.
   * Until memory-conversation rehydration lands (cutover step (c)),
   * executors still start a fresh conversation seeded with this message.
   */
  resumeMessage?: string
  session: SessionContext // session_key = `task:${taskId}`
}

/**
 * Default park for an unanswered headless `ui` permission prompt, in ms.
 * Boot passes `providers.claude-cli.permission_timeout_ms` when that key
 * is set; this is the fallback. Core's `TASK_PERMISSION_TIMEOUT_MS` aliases
 * this value. Lives here, not in the claude-cli plugin: boot only loads
 * that plugin dynamically, and a static import breaks boot's CommonJS build.
 */
export const PERMISSION_PROMPT_TIMEOUT_MS = 60_000

/** A longer park is a stuck card, not a decision. Ten minutes. */
export const PERMISSION_PROMPT_TIMEOUT_MAX_MS = 600_000

/**
 * One settled permission prompt, appended to the task row
 * (`spec.permissionDecisions`). `timeout` is a denial: nobody answered
 * before the bounded window.
 */
export interface TaskPermissionDecision {
  requestId: string
  tool: string
  decision: 'allow' | 'deny' | 'timeout'
  /** Epoch ms. */
  at: number
  message?: string
}

export type TaskEvent = { ts: number } & (
  | { type: 'den'; event: AgentEventBody }
  | { type: 'turn.start'; turn: number }
  | { type: 'turn.end'; turn: number; usage: TaskUsage; harnessSessionId?: string }
  | { type: 'cost'; deltaUsd: number; totalUsd: number }
  | { type: 'log'; level: 'debug' | 'info' | 'warn' | 'error'; message: string }
  | {
      /**
       * A headless CLI permission prompt is parked. Same fields as a harness
       * `approval-request` (requestId, name, input, toolCallId) plus the task
       * the prompt belongs to. Fail-closed: no answer before the window
       * denies.
       */
      type: 'approval-request'
      taskId: string
      requestId: string
      name: string
      input: unknown
      toolCallId?: string
    }
  | {
      type: 'approval-resolved'
      taskId: string
      requestId: string
      decision: TaskPermissionDecision['decision']
    }
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

// ---------------------------------------------------------------------------
// Phase 2 — evaluation (design: modernization-followups.md §Phase 2).
// A completed task with acceptance criteria gets an adversarial verifier pass
// (child task row, origin 'eval') before it goes terminal: refute → one
// steered retry → escalate. These are the row-level contracts; the loop
// itself lives in core's EvaluationCoordinator.
// ---------------------------------------------------------------------------

/** Per-criterion verdict from the verifier (evidence-backed, not self-report). */
export interface CriterionReport {
  id: string
  met: boolean
  evidence: string
}

/** Structured output of one verifier child task. */
export interface VerifierResult {
  verdict: 'verified' | 'refuted'
  summary: string
  criteriaReport: CriterionReport[]
  /** Steer text injected into the retry turn when refuted. */
  refutation?: string
}

/**
 * Terminal evaluation state on the PARENT row (`eval` column). The executor's
 * own verdict is never overwritten — an escalated task keeps its executor
 * terminal status with eval.verdict='escalated', so the scoreboard can show
 * both truths (and their divergence) instead of one.
 */
export interface EvalOutcome {
  verdict: 'verified' | 'refuted' | 'escalated'
  /** Verifier-driven retry count consumed (eval_attempt column mirror). */
  attempts: number
  verifierTaskIds: string[]
  criteriaReport: CriterionReport[]
  /** Executor claimed completed but the verifier refuted. */
  diverged: boolean
  escalatedAt?: string
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
