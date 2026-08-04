/**
 * Workflows IR v2 — types + nested DAG validation (no executor).
 */

export type {
  AgentStep,
  ApprovalNode,
  BodyPortMap,
  CapabilityMode,
  ExecSpec,
  ExprDialect,
  Expression,
  GateNode,
  Graph,
  JoinPolicy,
  JsonSchema,
  LoopNode,
  MapNode,
  PortDirection,
  PortKind,
  PortSpec,
  ScriptNode,
  SubworkflowNode,
  ToolStep,
  Trigger,
  ValidateMode,
  ValidationIssueV2,
  ValidationSeverity,
  WorkflowDefV2,
  WorkflowEdgeV2,
  WorkflowNodeV2,
} from './types.js'

export { isValidWorkflowV2, validateWorkflowV2 } from './validate.js'
export {
  ILLEGAL_CYCLE,
  ILLEGAL_LOOP_AND_QUORUM,
  ILLEGAL_REACH_THROUGH,
  LEGAL_GATE_JUDGE,
  LEGAL_MAP_VERIFY,
} from './fixtures.js'
