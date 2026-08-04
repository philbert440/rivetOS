/**
 * Geometry helpers for rendering fixture-positioned workflow graphs.
 * No auto-layout — positions come from the definition.
 */

import type { WorkflowDefinition, WorkflowNode, WorkflowPort } from './types.js'

/** Default node card size on the canvas (matches CSS cards). */
export const NODE_WIDTH = 188
export const NODE_HEIGHT = 78

export function nodeCenter(node: WorkflowNode): { x: number; y: number } {
  return {
    x: node.position.x + NODE_WIDTH / 2,
    y: node.position.y + NODE_HEIGHT / 2,
  }
}

/**
 * Anchor point for a port on the node card edge.
 * Inputs attach on the left; outputs on the right. Control ports share
 * vertical slots when multiple exist.
 */
export function portAnchor(
  node: WorkflowNode,
  portId: string,
): { x: number; y: number; side: 'left' | 'right' } | undefined {
  const asIn = node.inputs.findIndex((p) => p.id === portId)
  if (asIn >= 0) {
    return {
      x: node.position.x,
      y: slotY(node.position.y, node.inputs.length, asIn),
      side: 'left',
    }
  }
  const asOut = node.outputs.findIndex((p) => p.id === portId)
  if (asOut >= 0) {
    return {
      x: node.position.x + NODE_WIDTH,
      y: slotY(node.position.y, node.outputs.length, asOut),
      side: 'right',
    }
  }
  return undefined
}

function slotY(top: number, count: number, index: number): number {
  if (count <= 1) return top + NODE_HEIGHT / 2
  const pad = 16
  const usable = NODE_HEIGHT - pad * 2
  const step = usable / (count - 1)
  return top + pad + step * index
}

export interface EdgePath {
  edgeId: string
  d: string
  from: { x: number; y: number }
  to: { x: number; y: number }
  control: boolean
}

/** Build SVG path `d` for each edge (cubic-ish horizontal curve). */
export function edgePaths(def: WorkflowDefinition): EdgePath[] {
  const byId = new Map(def.nodes.map((n) => [n.id, n]))
  const paths: EdgePath[] = []

  for (const edge of def.edges) {
    const fromNode = byId.get(edge.from.nodeId)
    const toNode = byId.get(edge.to.nodeId)
    if (!fromNode || !toNode) continue
    const a = portAnchor(fromNode, edge.from.portId)
    const b = portAnchor(toNode, edge.to.portId)
    if (!a || !b) continue

    const dx = Math.max(40, Math.abs(b.x - a.x) * 0.4)
    const c1x = a.x + dx
    const c2x = b.x - dx
    const d = `M ${a.x} ${a.y} C ${c1x} ${a.y}, ${c2x} ${b.y}, ${b.x} ${b.y}`

    const fromPort = findPort(fromNode, edge.from.portId)
    paths.push({
      edgeId: edge.id,
      d,
      from: { x: a.x, y: a.y },
      to: { x: b.x, y: b.y },
      control: fromPort?.kind === 'control' || false,
    })
  }
  return paths
}

function findPort(node: WorkflowNode, portId: string): WorkflowPort | undefined {
  return (
    node.inputs.find((p) => p.id === portId) ?? node.outputs.find((p) => p.id === portId)
  )
}

/** Bounding box of all nodes (for SVG viewBox / scroll area). */
export function graphBounds(
  def: WorkflowDefinition,
  pad = 48,
): { width: number; height: number; minX: number; minY: number } {
  if (def.nodes.length === 0) {
    return { width: 400, height: 240, minX: 0, minY: 0 }
  }
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const n of def.nodes) {
    minX = Math.min(minX, n.position.x)
    minY = Math.min(minY, n.position.y)
    maxX = Math.max(maxX, n.position.x + NODE_WIDTH)
    maxY = Math.max(maxY, n.position.y + NODE_HEIGHT)
  }
  return {
    minX: minX - pad,
    minY: minY - pad,
    width: maxX - minX + pad * 2,
    height: maxY - minY + pad * 2,
  }
}
