/**
 * Structural validation of workflow IR (ports, edges, ids).
 */

import type { ValidationIssue, WorkflowDefinition, WorkflowNode, WorkflowPort } from './types.js'

function portKey(nodeId: string, portId: string): string {
  return `${nodeId}:${portId}`
}

function findPort(node: WorkflowNode, portId: string): WorkflowPort | undefined {
  return node.inputs.find((p) => p.id === portId) ?? node.outputs.find((p) => p.id === portId)
}

/**
 * Validate a workflow definition. Returns issues (empty = structurally sound).
 * Callers should normalize first for stable defaults, but validation works on either.
 */
export function validateWorkflow(def: WorkflowDefinition): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  const nodeIds = new Set<string>()
  const edgeIds = new Set<string>()

  if (!def.id.trim()) {
    issues.push({ severity: 'error', code: 'def.missing_id', message: 'Workflow id is required' })
  }
  if (!def.name.trim()) {
    issues.push({
      severity: 'error',
      code: 'def.missing_name',
      message: 'Workflow name is required',
    })
  }

  for (const node of def.nodes) {
    if (!node.id.trim()) {
      issues.push({
        severity: 'error',
        code: 'node.missing_id',
        message: 'Node is missing id',
      })
      continue
    }
    if (nodeIds.has(node.id)) {
      issues.push({
        severity: 'error',
        code: 'node.duplicate_id',
        message: `Duplicate node id "${node.id}"`,
        nodeId: node.id,
      })
    }
    nodeIds.add(node.id)

    if (!node.label.trim()) {
      issues.push({
        severity: 'warning',
        code: 'node.missing_label',
        message: `Node "${node.id}" has no label`,
        nodeId: node.id,
      })
    }

    const localPorts = new Set<string>()
    for (const port of [...node.inputs, ...node.outputs]) {
      if (localPorts.has(port.id)) {
        issues.push({
          severity: 'error',
          code: 'port.duplicate_id',
          message: `Duplicate port id "${port.id}" on node "${node.id}"`,
          nodeId: node.id,
        })
      }
      localPorts.add(port.id)

      if (node.inputs.includes(port) && port.direction !== 'in') {
        issues.push({
          severity: 'error',
          code: 'port.direction_mismatch',
          message: `Input port "${port.id}" on "${node.id}" must have direction "in"`,
          nodeId: node.id,
        })
      }
      if (node.outputs.includes(port) && port.direction !== 'out') {
        issues.push({
          severity: 'error',
          code: 'port.direction_mismatch',
          message: `Output port "${port.id}" on "${node.id}" must have direction "out"`,
          nodeId: node.id,
        })
      }
    }

    if (node.kind === 'gate') {
      const controlOuts = node.outputs.filter((p) => p.kind === 'control')
      if (controlOuts.length < 2) {
        issues.push({
          severity: 'warning',
          code: 'gate.missing_branches',
          message: `Gate "${node.id}" should expose at least two control outputs (e.g. pass/fail)`,
          nodeId: node.id,
        })
      }
    }
  }

  const nodeById = new Map(def.nodes.map((n) => [n.id, n]))

  for (const edge of def.edges) {
    if (!edge.id.trim()) {
      issues.push({
        severity: 'error',
        code: 'edge.missing_id',
        message: 'Edge is missing id',
      })
      continue
    }
    if (edgeIds.has(edge.id)) {
      issues.push({
        severity: 'error',
        code: 'edge.duplicate_id',
        message: `Duplicate edge id "${edge.id}"`,
        edgeId: edge.id,
      })
    }
    edgeIds.add(edge.id)

    if (edge.from.nodeId === edge.to.nodeId) {
      issues.push({
        severity: 'error',
        code: 'edge.self_loop',
        message: `Edge "${edge.id}" is a self-loop on "${edge.from.nodeId}"`,
        edgeId: edge.id,
        nodeId: edge.from.nodeId,
      })
    }

    const fromNode = nodeById.get(edge.from.nodeId)
    const toNode = nodeById.get(edge.to.nodeId)
    if (!fromNode) {
      issues.push({
        severity: 'error',
        code: 'edge.unknown_from_node',
        message: `Edge "${edge.id}" from unknown node "${edge.from.nodeId}"`,
        edgeId: edge.id,
      })
      continue
    }
    if (!toNode) {
      issues.push({
        severity: 'error',
        code: 'edge.unknown_to_node',
        message: `Edge "${edge.id}" to unknown node "${edge.to.nodeId}"`,
        edgeId: edge.id,
      })
      continue
    }

    const fromPort = findPort(fromNode, edge.from.portId)
    const toPort = findPort(toNode, edge.to.portId)
    if (!fromPort) {
      issues.push({
        severity: 'error',
        code: 'edge.unknown_from_port',
        message: `Edge "${edge.id}" from unknown port "${portKey(edge.from.nodeId, edge.from.portId)}"`,
        edgeId: edge.id,
        nodeId: edge.from.nodeId,
      })
      continue
    }
    if (!toPort) {
      issues.push({
        severity: 'error',
        code: 'edge.unknown_to_port',
        message: `Edge "${edge.id}" to unknown port "${portKey(edge.to.nodeId, edge.to.portId)}"`,
        edgeId: edge.id,
        nodeId: edge.to.nodeId,
      })
      continue
    }

    if (fromPort.direction !== 'out') {
      issues.push({
        severity: 'error',
        code: 'edge.from_not_out',
        message: `Edge "${edge.id}" must start at an out port (got ${fromPort.direction} on ${edge.from.portId})`,
        edgeId: edge.id,
        nodeId: edge.from.nodeId,
      })
    }
    if (toPort.direction !== 'in') {
      issues.push({
        severity: 'error',
        code: 'edge.to_not_in',
        message: `Edge "${edge.id}" must end at an in port (got ${toPort.direction} on ${edge.to.portId})`,
        edgeId: edge.id,
        nodeId: edge.to.nodeId,
      })
    }
    if (fromPort.kind !== toPort.kind) {
      issues.push({
        severity: 'error',
        code: 'edge.kind_mismatch',
        message: `Edge "${edge.id}" connects ${fromPort.kind} → ${toPort.kind} (kinds must match)`,
        edgeId: edge.id,
      })
    }
  }

  // Required inputs need ≥1 fully-resolved incoming edge (unknown/wrong-dir
  // endpoints do not count as wiring — those edges already error above).
  for (const node of def.nodes) {
    for (const port of node.inputs) {
      const required = port.required !== false && port.direction === 'in'
      if (!required) continue
      const wired = def.edges.some((e) => {
        if (e.to.nodeId !== node.id || e.to.portId !== port.id) return false
        const fromNode = nodeById.get(e.from.nodeId)
        if (!fromNode) return false
        const fromPort = findPort(fromNode, e.from.portId)
        if (!fromPort || fromPort.direction !== 'out') return false
        const toPort = findPort(node, e.to.portId)
        return Boolean(toPort && toPort.direction === 'in')
      })
      if (!wired) {
        issues.push({
          severity: 'error',
          code: 'port.unwired_required',
          message: `Required input "${port.id}" on node "${node.id}" has no incoming edge`,
          nodeId: node.id,
        })
      }
    }
  }

  return issues
}

export function isValidWorkflow(def: WorkflowDefinition): boolean {
  return validateWorkflow(def).every((i) => i.severity !== 'error')
}
