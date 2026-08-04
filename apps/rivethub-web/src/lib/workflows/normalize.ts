/**
 * Normalize a workflow definition for stable display and validation.
 */

import type { WorkflowDefinition, WorkflowNode, WorkflowPort } from './types.js'

function normalizePort(port: WorkflowPort): WorkflowPort {
  const required =
    port.required !== undefined ? port.required : port.direction === 'in' ? true : false
  return {
    id: port.id,
    name: port.name.trim() || port.id,
    direction: port.direction,
    kind: port.kind,
    required,
  }
}

function normalizeNode(node: WorkflowNode): WorkflowNode {
  const tools =
    node.tools && node.tools.length > 0
      ? [...new Set(node.tools.map((t) => t.trim()).filter(Boolean))].sort()
      : undefined
  const toolProfile = node.toolProfile?.trim() || undefined

  return {
    ...node,
    label: node.label.trim() || node.id,
    description: node.description?.trim() || undefined,
    tools,
    toolProfile,
    // Preserve author port order — layout anchors by array index (pass/fail slots).
    inputs: node.inputs.map(normalizePort),
    outputs: node.outputs.map(normalizePort),
    position: {
      x: Number.isFinite(node.position.x) ? node.position.x : 0,
      y: Number.isFinite(node.position.y) ? node.position.y : 0,
    },
  }
}

/**
 * Stable sort nodes/edges by id; fill port `required` defaults; drop empty tools.
 * Does not mutate the input.
 */
export function normalizeWorkflow(def: WorkflowDefinition): WorkflowDefinition {
  const nodes = def.nodes.map(normalizeNode).sort((a, b) => a.id.localeCompare(b.id))
  const edges = [...def.edges]
    .map((e) => ({
      id: e.id,
      from: { nodeId: e.from.nodeId, portId: e.from.portId },
      to: { nodeId: e.to.nodeId, portId: e.to.portId },
    }))
    .sort((a, b) => a.id.localeCompare(b.id))

  return {
    id: def.id,
    name: def.name.trim() || def.id,
    description: def.description?.trim() || undefined,
    version: def.version,
    nodes,
    edges,
  }
}
