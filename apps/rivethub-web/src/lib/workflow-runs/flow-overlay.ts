/**
 * Run-status overlay for the flows canvas. Kind fill stays identity;
 * journal status is stroke / dim / pulse on the same nodes.
 */

import type { GraphNode } from './graph-project.js'
import { FLOW_START_ID } from './flow-graph.js'
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
  if (to === 'running' || to === 'gate-open') return 'active'
  if (from === 'done' || from === 'gate-resolved' || to === 'done' || to === 'gate-resolved') {
    return 'done'
  }
  return 'pending'
}

export function isLiveNodeStatus(status: GraphNodeStatus | undefined): boolean {
  return status === 'running' || status === 'gate-open'
}
