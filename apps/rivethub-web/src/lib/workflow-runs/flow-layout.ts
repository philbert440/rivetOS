/**
 * Left-to-right layout for the flows canvas. Pure data → positions.
 * Injects a synthetic entry node; does not persist coordinates.
 */

import type { GraphEdge, GraphNode } from './graph-project.js'
import { flowNodeFamily, type FlowNodeFamily } from './flow-kind.js'

export const FLOW_ENTRY_ID = '__entry__'

export const FLOW_NODE_SIZE = 120
export const FLOW_GAP_X = 72
export const FLOW_GAP_Y = 40
export const FLOW_PAD = 56

export interface LaidFlowNode {
  id: string
  label: string
  family: FlowNodeFamily
  x: number
  y: number
  /** Null only for the synthetic entry. */
  source: GraphNode | null
}

export interface LaidFlowGraph {
  nodes: LaidFlowNode[]
  edges: GraphEdge[]
  width: number
  height: number
}

function incomingCounts(nodes: GraphNode[], edges: GraphEdge[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const n of nodes) counts.set(n.id, 0)
  for (const e of edges) {
    if (!counts.has(e.to)) continue
    counts.set(e.to, (counts.get(e.to) ?? 0) + 1)
  }
  return counts
}

/** Longest-path column from roots; parallel siblings share a column. */
function assignColumns(nodes: GraphNode[], edges: GraphEdge[]): Map<string, number> {
  const cols = new Map<string, number>()
  const outgoing = new Map<string, string[]>()
  for (const n of nodes) outgoing.set(n.id, [])
  for (const e of edges) {
    const list = outgoing.get(e.from)
    if (list) list.push(e.to)
  }

  const counts = incomingCounts(nodes, edges)
  const queue: string[] = []
  for (const n of nodes) {
    if ((counts.get(n.id) ?? 0) === 0) {
      cols.set(n.id, 0)
      queue.push(n.id)
    }
  }

  while (queue.length > 0) {
    const id = queue.shift()!
    const col = cols.get(id) ?? 0
    for (const to of outgoing.get(id) ?? []) {
      cols.set(to, Math.max(cols.get(to) ?? 0, col + 1))
      const next = (counts.get(to) ?? 1) - 1
      counts.set(to, next)
      if (next === 0) queue.push(to)
    }
  }

  for (const n of nodes) {
    if (!cols.has(n.id)) cols.set(n.id, 0)
  }
  return cols
}

function assignRows(nodes: GraphNode[], cols: Map<string, number>): Map<string, number> {
  const byCol = new Map<number, GraphNode[]>()
  for (const n of nodes) {
    const c = cols.get(n.id) ?? 0
    const list = byCol.get(c) ?? []
    list.push(n)
    byCol.set(c, list)
  }

  const rows = new Map<string, number>()
  for (const list of byCol.values()) {
    list.sort((a, b) => {
      const ba = a.branchIndex ?? -1
      const bb = b.branchIndex ?? -1
      if (ba !== bb) return ba - bb
      return a.id.localeCompare(b.id)
    })
    list.forEach((n, i) => rows.set(n.id, i))
  }
  return rows
}

export function layoutFlowGraph(nodes: GraphNode[], edges: GraphEdge[]): LaidFlowGraph {
  if (nodes.length === 0) {
    return { nodes: [], edges: [], width: 320, height: 160 }
  }

  const cols = assignColumns(nodes, edges)
  const rows = assignRows(nodes, cols)
  const counts = incomingCounts(nodes, edges)
  const roots = nodes.filter((n) => (counts.get(n.id) ?? 0) === 0)

  const laid: LaidFlowNode[] = [
    {
      id: FLOW_ENTRY_ID,
      label: 'Start',
      family: 'entry',
      x: FLOW_PAD,
      y: FLOW_PAD,
      source: null,
    },
  ]

  for (const n of nodes) {
    const col = (cols.get(n.id) ?? 0) + 1
    const row = rows.get(n.id) ?? 0
    laid.push({
      id: n.id,
      label: n.label,
      family: flowNodeFamily(n.kind),
      x: FLOW_PAD + col * (FLOW_NODE_SIZE + FLOW_GAP_X),
      y: FLOW_PAD + row * (FLOW_NODE_SIZE + FLOW_GAP_Y),
      source: n,
    })
  }

  const extra: GraphEdge[] = roots.map((r) => ({
    id: `entry→${r.id}`,
    from: FLOW_ENTRY_ID,
    to: r.id,
    kind: 'declared',
  }))

  let maxX = 0
  let maxY = 0
  for (const n of laid) {
    maxX = Math.max(maxX, n.x + FLOW_NODE_SIZE)
    maxY = Math.max(maxY, n.y + FLOW_NODE_SIZE)
  }

  return {
    nodes: laid,
    edges: [...extra, ...edges],
    width: maxX + FLOW_PAD,
    height: maxY + FLOW_PAD,
  }
}
