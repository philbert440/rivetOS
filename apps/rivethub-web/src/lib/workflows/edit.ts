/**
 * Pure mutators for workflow definitions (immutable updates).
 */

import type {
  CapabilityMode,
  NodeKind,
  WorkflowDefinition,
  WorkflowEdge,
  WorkflowNode,
  WorkflowPort,
} from './types.js'

function clone<T>(v: T): T {
  return structuredClone(v)
}

export function updateWorkflowMeta(
  def: WorkflowDefinition,
  patch: Partial<Pick<WorkflowDefinition, 'name' | 'description'>>,
): WorkflowDefinition {
  const next = clone(def)
  if (patch.name !== undefined) next.name = patch.name
  if (patch.description !== undefined) {
    next.description = patch.description.trim() ? patch.description : undefined
  }
  return next
}

export function updateNode(
  def: WorkflowDefinition,
  nodeId: string,
  patch: Partial<
    Pick<
      WorkflowNode,
      | 'label'
      | 'description'
      | 'kind'
      | 'capability'
      | 'tools'
      | 'toolProfile'
      | 'inputs'
      | 'outputs'
    >
  >,
): WorkflowDefinition {
  const next = clone(def)
  const node = next.nodes.find((n) => n.id === nodeId)
  if (!node) return def
  if (patch.label !== undefined) node.label = patch.label
  if (patch.description !== undefined) {
    node.description = patch.description.trim() ? patch.description : undefined
  }
  if (patch.kind !== undefined) node.kind = patch.kind
  if (patch.capability !== undefined) node.capability = patch.capability
  if (patch.tools !== undefined) {
    node.tools = patch.tools.length > 0 ? patch.tools : undefined
  }
  if (patch.toolProfile !== undefined) {
    node.toolProfile = patch.toolProfile.trim() ? patch.toolProfile : undefined
  }
  if (patch.inputs !== undefined) node.inputs = patch.inputs
  if (patch.outputs !== undefined) node.outputs = patch.outputs
  return next
}

export function moveNode(
  def: WorkflowDefinition,
  nodeId: string,
  position: { x: number; y: number },
): WorkflowDefinition {
  const next = clone(def)
  const node = next.nodes.find((n) => n.id === nodeId)
  if (!node) return def
  node.position = {
    x: Math.round(position.x),
    y: Math.round(position.y),
  }
  return next
}

let nodeSeq = 0

export function newNodeId(def: WorkflowDefinition, prefix = 'node'): string {
  let id = `${prefix}-${String(++nodeSeq)}`
  while (def.nodes.some((n) => n.id === id)) {
    id = `${prefix}-${String(++nodeSeq)}`
  }
  return id
}

export function createDefaultNode(
  def: WorkflowDefinition,
  overrides?: Partial<WorkflowNode>,
): WorkflowNode {
  const id = overrides?.id ?? newNodeId(def)
  return {
    id,
    kind: overrides?.kind ?? 'agent',
    label: overrides?.label ?? 'New node',
    description: overrides?.description,
    position: overrides?.position ?? { x: 80, y: 80 },
    capability: overrides?.capability ?? 'read-only',
    tools: overrides?.tools,
    toolProfile: overrides?.toolProfile,
    inputs: overrides?.inputs ?? [
      { id: 'in', name: 'Input', direction: 'in', kind: 'data', required: true },
    ],
    outputs: overrides?.outputs ?? [{ id: 'out', name: 'Output', direction: 'out', kind: 'data' }],
  }
}

export function addNode(def: WorkflowDefinition, node?: Partial<WorkflowNode>): WorkflowDefinition {
  const next = clone(def)
  next.nodes.push(createDefaultNode(next, node))
  return next
}

export function removeNode(def: WorkflowDefinition, nodeId: string): WorkflowDefinition {
  const next = clone(def)
  next.nodes = next.nodes.filter((n) => n.id !== nodeId)
  next.edges = next.edges.filter((e) => e.from.nodeId !== nodeId && e.to.nodeId !== nodeId)
  return next
}

export function addPort(
  def: WorkflowDefinition,
  nodeId: string,
  port: WorkflowPort,
): WorkflowDefinition {
  const next = clone(def)
  const node = next.nodes.find((n) => n.id === nodeId)
  if (!node) return def
  if (port.direction === 'in') {
    if (node.inputs.some((p) => p.id === port.id)) return def
    node.inputs.push(port)
  } else {
    if (node.outputs.some((p) => p.id === port.id)) return def
    node.outputs.push(port)
  }
  return next
}

export function removePort(
  def: WorkflowDefinition,
  nodeId: string,
  portId: string,
): WorkflowDefinition {
  const next = clone(def)
  const node = next.nodes.find((n) => n.id === nodeId)
  if (!node) return def
  node.inputs = node.inputs.filter((p) => p.id !== portId)
  node.outputs = node.outputs.filter((p) => p.id !== portId)
  next.edges = next.edges.filter(
    (e) =>
      !(e.from.nodeId === nodeId && e.from.portId === portId) &&
      !(e.to.nodeId === nodeId && e.to.portId === portId),
  )
  return next
}

export function updatePort(
  def: WorkflowDefinition,
  nodeId: string,
  portId: string,
  patch: Partial<Pick<WorkflowPort, 'id' | 'name' | 'kind' | 'required'>>,
): WorkflowDefinition {
  const next = clone(def)
  const node = next.nodes.find((n) => n.id === nodeId)
  if (!node) return def
  const port = node.inputs.find((p) => p.id === portId) ?? node.outputs.find((p) => p.id === portId)
  if (!port) return def
  const oldId = port.id
  if (patch.name !== undefined) port.name = patch.name
  if (patch.kind !== undefined) port.kind = patch.kind
  if (patch.required !== undefined) port.required = patch.required
  if (patch.id !== undefined && patch.id !== oldId) {
    if (node.inputs.some((p) => p.id === patch.id) || node.outputs.some((p) => p.id === patch.id)) {
      return def
    }
    port.id = patch.id
    for (const e of next.edges) {
      if (e.from.nodeId === nodeId && e.from.portId === oldId) e.from.portId = patch.id
      if (e.to.nodeId === nodeId && e.to.portId === oldId) e.to.portId = patch.id
    }
  }
  return next
}

let edgeSeq = 0

export function newEdgeId(def: WorkflowDefinition): string {
  let id = `e-${String(++edgeSeq)}`
  while (def.edges.some((e) => e.id === id)) {
    id = `e-${String(++edgeSeq)}`
  }
  return id
}

export function addEdge(
  def: WorkflowDefinition,
  edge: Omit<WorkflowEdge, 'id'> & { id?: string },
): WorkflowDefinition {
  const next = clone(def)
  const id = edge.id ?? newEdgeId(next)
  if (next.edges.some((e) => e.id === id)) return def
  next.edges.push({
    id,
    from: { ...edge.from },
    to: { ...edge.to },
  })
  return next
}

export function removeEdge(def: WorkflowDefinition, edgeId: string): WorkflowDefinition {
  const next = clone(def)
  next.edges = next.edges.filter((e) => e.id !== edgeId)
  return next
}

export const NODE_KINDS: NodeKind[] = [
  'source',
  'agent',
  'tool',
  'verify',
  'gate',
  'action',
  'sink',
]

export const CAPABILITY_MODES: CapabilityMode[] = ['read-only', 'read-write', 'execute', 'all']

/** Parse comma/space-separated tools field into string[]. */
export function parseToolsField(text: string): string[] {
  return text
    .split(/[,\n]+/)
    .map((t) => t.trim())
    .filter(Boolean)
}
