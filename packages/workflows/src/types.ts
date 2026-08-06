/**
 * Workflow document model — types for workflow.yaml, Run, journal, contracts.
 * Product SoT: /rivet-shared/plans/workflows-product-v1.md (rev 3).
 */

/** Field types in input/output contracts. `file` = path relative to caseDir must exist. */
export type FieldType = 'string' | 'number' | 'boolean' | 'json' | 'file'

export interface Field {
  name: string
  type: FieldType
  required?: boolean
  description?: string
}

/** Optional display-only step outline for UI; never used for logic. */
export interface OutlineStep {
  id: string
  label?: string
  /** Usually one of: agent, run, human, call, done — open for future step kinds. */
  kind?: string
  description?: string
}

export interface WorkflowBudgets {
  maxTokens?: number
  maxCost?: number
  maxConcurrentRuns?: number
}

/**
 * Workflow manifest (`workflow.yaml`).
 * Steps live in run.ts (code-first); outline is display-only.
 */
export interface WorkflowManifest {
  id: string
  version: string
  name: string
  description?: string
  input: Field[]
  output: Field[]
  outline?: OutlineStep[]
  budgets?: WorkflowBudgets
}

/** Loaded workflow directory. */
export interface LoadedWorkflow {
  dir: string
  manifest: WorkflowManifest
  /** Absolute path to run.ts (or run.js). */
  runPath: string
  agents: Record<string, AgentDef>
}

/**
 * Agent definition from `agents/<name>.md` — YAML frontmatter for config,
 * markdown body as the system prompt (same shape as Claude Code agent files).
 */
export interface AgentDef {
  name: string
  /** Absolute path to agents/<name>.md */
  path: string
  /** Markdown body — the agent's system prompt. */
  prompt: string
  /** Parsed frontmatter (tools list + optional model/maxTurns). */
  config: AgentConfig
}

export interface AgentConfig {
  tools?: string[]
  model?: string
  maxTurns?: number
  /** Forward-compat extras from frontmatter. */
  [key: string]: unknown
}

export type StartedByType = 'human' | 'agent' | 'workflow'

export interface StartedBy {
  type: StartedByType
  /** Human user id / agent id / parent workflow id — provenance. */
  id?: string
  /** Free-form provenance bag. */
  [key: string]: unknown
}

export interface ParentRef {
  runId: string
  stepId: string
}

export type RunStatus = 'running' | 'paused_human' | 'done' | 'failed' | 'killed'

/**
 * In-memory / case.json run record.
 * `current` is a free-form cursor for UI (e.g. last step label).
 */
export interface Run {
  id: string
  workflowId: string
  /** Pinned workflow version at start. */
  version: string
  startedBy: StartedBy
  parent?: ParentRef
  caseDir: string
  status: RunStatus
  current?: string
  /** Absolute path to the workflow directory used for this run. */
  workflowDir?: string
  error?: string
  output?: Record<string, unknown>
  startedAt?: string
  finishedAt?: string
}

export type StepKind = 'agent' | 'run' | 'human' | 'call' | 'done' | 'parallel'

/** Per-step usage reported by executors / journaled on step_finished. */
export interface StepUsage {
  tokens?: number
  costUsd?: number
}

/** Stable step identity: label + monotonic sequence for that label within the run. */
export function makeStepId(label: string, seq: number): string {
  return `${label}#${seq}`
}

// ---------------------------------------------------------------------------
// Journal entries (journal.jsonl — append-only, one JSON object per line)
// ---------------------------------------------------------------------------

export type JournalEntryType =
  | 'run_started'
  | 'run_finished'
  | 'step_started'
  | 'step_finished'
  | 'step_failed'
  | 'gate_opened'
  | 'gate_resolved'
  | 'manifest_warn'

export interface JournalEntryBase {
  type: JournalEntryType
  /** ISO-8601 timestamp (wall clock is fine in journal; not used for control flow). */
  ts: string
}

export interface RunStartedEntry extends JournalEntryBase {
  type: 'run_started'
  runId: string
  workflowId: string
  version: string
  input: Record<string, unknown>
  startedBy: StartedBy
  parent?: ParentRef
}

export interface RunFinishedEntry extends JournalEntryBase {
  type: 'run_finished'
  runId: string
  status: 'done' | 'failed' | 'killed'
  output?: Record<string, unknown>
  error?: string
}

export interface StepStartedEntry extends JournalEntryBase {
  type: 'step_started'
  stepId: string
  label: string
  seq: number
  kind: StepKind
}

export interface StepFinishedEntry extends JournalEntryBase {
  type: 'step_finished'
  stepId: string
  label: string
  seq: number
  kind: StepKind
  result: unknown
  /** Optional usage attributed to this step (tokens / cost). */
  usage?: StepUsage
}

export interface StepFailedEntry extends JournalEntryBase {
  type: 'step_failed'
  stepId: string
  label: string
  seq: number
  kind: StepKind
  error: string
}

export interface GateOpenedEntry extends JournalEntryBase {
  type: 'gate_opened'
  stepId: string
  label: string
  seq: number
  prompt?: string
  fields: string[]
}

export interface GateResolvedEntry extends JournalEntryBase {
  type: 'gate_resolved'
  stepId: string
  label: string
  seq: number
  values: Record<string, unknown>
}

/** Undeclared agent out-field writes — warn only, do not reject. */
export interface ManifestWarnEntry extends JournalEntryBase {
  type: 'manifest_warn'
  stepId: string
  label: string
  seq: number
  undeclared: string[]
  message: string
}

export type JournalEntry =
  | RunStartedEntry
  | RunFinishedEntry
  | StepStartedEntry
  | StepFinishedEntry
  | StepFailedEntry
  | GateOpenedEntry
  | GateResolvedEntry
  | ManifestWarnEntry

/** case.json on disk — Run metadata + contract field bag. */
export interface CaseState {
  run: Run
  /** Contract fields, gate choices, verdicts — seeded from input, merged by steps. */
  fields: Record<string, unknown>
}
