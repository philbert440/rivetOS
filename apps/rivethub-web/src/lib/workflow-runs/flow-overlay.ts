/**
 * Run-status overlay for the flows canvas. Kind fill stays identity;
 * journal status is stroke / dim / pulse on the same nodes.
 */

import type { GraphNode } from './graph-project.js'
import { FLOW_START_ID, type FlowAuthorGraph } from './flow-graph.js'
import type { GraphNodeStatus } from './status.js'

/** Canvas 2d cannot use CSS vars — keep in lockstep with theme.css. */
export const CANVAS_STATUS_STROKE: Record<GraphNodeStatus, string> = {
  pending: '#253041',
  running: '#34d399',
  done: '#10b981',
  failed: '#f87171',
  'gate-open': '#34d399',
  'gate-resolved': '#10b981',
}

export const CANVAS_STATUS_EDGE: Record<'active' | 'done' | 'failed' | 'pending', string> = {
  active: '#34d399',
  done: 'rgba(16, 185, 129, 0.85)',
  failed: 'rgba(248, 113, 113, 0.9)',
  pending: 'rgba(139, 152, 169, 0.35)',
}

export function statusByIdFromProjection(nodes: GraphNode[]): Record<string, GraphNodeStatus> {
  const map: Record<string, GraphNodeStatus> = {}
  let anyStarted = false
  for (const n of nodes) {
    map[n.id] = n.status
    if (n.status !== 'pending') anyStarted = true
  }
  if (anyStarted) map[FLOW_START_ID] = 'done'
  return map
}

export function overlayEdgeKind(
  from: GraphNodeStatus | undefined,
  to: GraphNodeStatus | undefined,
): 'active' | 'done' | 'failed' | 'pending' {
  if (from === 'failed' || to === 'failed') return 'failed'
  if (to === 'running' || to === 'gate-open' || from === 'running' || from === 'gate-open') {
    return 'active'
  }
  if (from === 'done' || from === 'gate-resolved' || to === 'done' || to === 'gate-resolved') {
    return 'done'
  }
  return 'pending'
}

export function isLiveNodeStatus(status: GraphNodeStatus | undefined): boolean {
  return status === 'running' || status === 'gate-open'
}

/** Journal branch ids look like `n1#1/b0:n2` — canvas nodes are `n2`. */
function branchInnerId(id: string): string | undefined {
  const m = /\/b\d+:(.+)$/.exec(id)
  return m?.[1]
}

/**
 * Map projection/journal status onto canvas node ids (flows.json layout).
 * Folds engine `done` label and parallel-branch inner ids.
 */
export function statusByIdForCanvas(
  author: FlowAuthorGraph,
  projection: GraphNode[],
): Record<string, GraphNodeStatus> {
  const map = statusByIdFromProjection(projection)
  const doneStatus = map.done
  if (doneStatus) {
    for (const n of author.nodes) {
      if (n.kind === 'done') map[n.id] = doneStatus
    }
  }
  for (const p of projection) {
    const inner = branchInnerId(p.id)
    if (inner) map[inner] = p.status
  }
  return map
}
