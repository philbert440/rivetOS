/**
 * Workflows IR v2 — nested DAG definitions (graph is source of truth).
 * See VALIDATION.md and /rivet-shared/plans/workflows-ir-v2.md.
 */

/** Side-effect-free expression slot — dialect swap without IR churn. */
export type ExprDialect = 'simple' | 'cel'

export interface Expression {
  dialect: ExprDialect
  expr: string
}

export type CapabilityMode = 'read-only' | 'read-write' | 'execute' | 'all'

export type PortDirection = 'in' | 'out'
export type PortKind = 'data' | 'control'

/** Optional JSON Schema object (structural; not evaluated here). */
export type JsonSchema = Record<string, unknown>

export interface PortSpec {
  id: string
  name: string
  direction: PortDirection
  kind: PortKind
  required?: boolean
  /** When present, fail-closed structured contract for agent outputs / edges. */
  schema?: JsonSchema
}

export interface ExecSpec {
  /** Catalog ref, e.g. rivet-grok/reviewer — resolved at run time. */
  agent?: string
  model?: string
  effort?: string
  tools?: string[]
  toolProfile?: string
  capability: CapabilityMode
  placement?: { node?: string; require?: string[] }
  isolation?: 'none' | 'worktree' | 'container'
  timeoutMs?: number
  retry?: { max: number; backoff?: string }
  budget?: { tokens?: number }
}

export interface Graph {
  nodes: WorkflowNodeV2[]
  edges: WorkflowEdgeV2[]
}

/**
 * Maps a composite node's boundary port id → body endpoint `nodeId.portId`.
 * Parent edges only touch boundary ports; body edges stay inside body.
 */
export interface BodyPortMap {
  inputs: Record<string, string>
  outputs: Record<string, string>
}

export type JoinPolicy = { policy: 'all' } | { policy: 'any' } | { policy: 'quorum'; n: number }

interface NodeBase {
  id: string
  label: string
  description?: string
  /** Layout hint for IDE (optional in pure IR). */
  position?: { x: number; y: number }
}

export interface AgentStep extends NodeBase {
  kind: 'agent'
  prompt: string
  exec: ExecSpec
  inputs: PortSpec[]
  outputs: PortSpec[]
}

export interface ToolStep extends NodeBase {
  kind: 'tool'
  /** Deterministic tool / HTTP / shell identity. */
  tool: string
  config?: Record<string, unknown>
  exec?: Partial<ExecSpec>
  inputs: PortSpec[]
  outputs: PortSpec[]
}

export interface GateNode extends NodeBase {
  kind: 'gate'
  /** Predicate only — no LLM. */
  predicate: Expression
  inputs: PortSpec[]
  /** Control outs, e.g. pass / fail. */
  outputs: PortSpec[]
}

export interface MapNode extends NodeBase {
  kind: 'map'
  /** Path/expression selecting array to fan out (simple path or Expression later). */
  items: Expression
  body: Graph
  bodyPortMap: BodyPortMap
  join: JoinPolicy
  concurrency?: number
  /** Boundary ports on the map node (parent-facing). */
  inputs: PortSpec[]
  outputs: PortSpec[]
  /** When items length is a known constant, enables static quorum checks. */
  staticFanOut?: number
}

export interface LoopNode extends NodeBase {
  kind: 'loop'
  maxIterations: number
  while?: Expression
  until?: Expression
  body: Graph
  bodyPortMap: BodyPortMap
  inputs: PortSpec[]
  outputs: PortSpec[]
}

export interface ApprovalNode extends NodeBase {
  kind: 'approval'
  /** Message / prompt shown to human. */
  prompt: string
  inputs: PortSpec[]
  outputs: PortSpec[]
}

export interface SubworkflowNode extends NodeBase {
  kind: 'subworkflow'
  /** Ref to another WorkflowDef id (+ optional version pin). */
  workflowId: string
  version?: number
  inputs: PortSpec[]
  outputs: PortSpec[]
}

export interface ScriptNode extends NodeBase {
  kind: 'script'
  /** Host-side Rhai (not browser JS). */
  dialect: 'rhai'
  source: string
  inputs: PortSpec[]
  outputs: PortSpec[]
  exec?: Partial<ExecSpec>
}

export type WorkflowNodeV2 =
  AgentStep | ToolStep | GateNode | MapNode | LoopNode | ApprovalNode | SubworkflowNode | ScriptNode

export interface WorkflowEdgeV2 {
  id: string
  from: { nodeId: string; portId: string }
  to: { nodeId: string; portId: string }
}

export type Trigger =
  { type: 'manual' } | { type: 'cron'; cron: string } | { type: 'event'; event: string }

export interface WorkflowDefV2 {
  id: string
  version: number
  name: string
  description?: string
  inputs: PortSpec[]
  outputs: PortSpec[]
  triggers: Trigger[]
  graph: Graph
  defaults?: Partial<ExecSpec>
}

export type ValidationSeverity = 'error' | 'warning'

export interface ValidationIssueV2 {
  severity: ValidationSeverity
  code: string
  message: string
  nodeId?: string
  edgeId?: string
  /** Graph path, e.g. "" top-level or "map:verify/body" */
  graphPath?: string
}

export type ValidateMode = 'structure' | 'executable'
