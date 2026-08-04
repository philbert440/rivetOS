/**
 * Workflow IR — pure definition model for RivetHub Workflows (Product-Map-style).
 * Fixture/local only for MVP; not a gateway wire type yet.
 */

export type CapabilityMode = 'read-only' | 'read-write' | 'execute' | 'all'

export type PortDirection = 'in' | 'out'

/** data = payload handoff; control = pass/fail (or branch) edges from gates */
export type PortKind = 'data' | 'control'

export interface WorkflowPort {
  /** Unique within the node (e.g. "doc", "pass"). */
  id: string
  name: string
  direction: PortDirection
  kind: PortKind
  /** Default true for inputs when omitted (see normalize). */
  required?: boolean
}

export type NodeKind =
  | 'source'
  | 'agent'
  | 'tool'
  | 'verify'
  | 'gate'
  | 'action'
  | 'sink'

export interface WorkflowNode {
  id: string
  kind: NodeKind
  label: string
  description?: string
  /** Canvas position in px (fixture-authored; no auto-layout in MVP). */
  position: { x: number; y: number }
  capability: CapabilityMode
  /** Explicit tool names. Prefer this or toolProfile, not both for clarity. */
  tools?: string[]
  /** Named tool allowlist profile (e.g. "code-review"). */
  toolProfile?: string
  inputs: WorkflowPort[]
  outputs: WorkflowPort[]
}

export interface WorkflowEdge {
  id: string
  from: { nodeId: string; portId: string }
  to: { nodeId: string; portId: string }
}

export interface WorkflowDefinition {
  id: string
  name: string
  description?: string
  version: number
  nodes: WorkflowNode[]
  edges: WorkflowEdge[]
}

export type ValidationSeverity = 'error' | 'warning'

export interface ValidationIssue {
  severity: ValidationSeverity
  code: string
  message: string
  nodeId?: string
  edgeId?: string
}
