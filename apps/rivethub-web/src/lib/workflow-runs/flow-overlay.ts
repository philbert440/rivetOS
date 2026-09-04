/**
 * Run-status overlay for the flows canvas. Kind fill stays identity;
 * journal status is stroke / dim / pulse on the same nodes.
 */

import type { GraphNode } from './graph-project.js'
import { FLOW_START_ID, type FlowAuthorGraph } from './flow-graph.js'
import type { GraphNodeStatus } from './status.js'
import type { ResolvedTheme } from '../theme.js'

/** Every literal the flows canvas paints with, for one resolved theme. */
export interface CanvasSceneColors {
  bg: string
  gridDot: string
  /** Selected node/edge stroke; also the hovered port fill. */
  selection: string
  /** In-progress wire while dragging a connection. */
  connect: string
  /** Failed-status wash over a node. */
  failed: string
  /** Node stroke when there is no status overlay at all. */
  dimStroke: string
  portRing: string
  label: string
  sublabel: string
  statusStroke: Record<GraphNodeStatus, string>
  statusEdge: Record<'active' | 'done' | 'failed' | 'pending', string>
}

/** Canvas 2d cannot use CSS vars — keep in lockstep with theme.css. */
const CANVAS_SCENE_DARK: CanvasSceneColors = {
  bg: '#0d1117',
  gridDot: 'rgba(52, 211, 153, 0.22)',
  selection: '#e6edf3',
  connect: '#34d399',
  failed: '#f87171',
  dimStroke: 'rgba(255,255,255,0.35)',
  portRing: '#ffffff',
  label: '#ffffff',
  sublabel: 'rgba(255,255,255,0.7)',
  statusStroke: {
    pending: '#253041',
    running: '#34d399',
    done: '#10b981',
    failed: '#f87171',
    'gate-open': '#34d399',
    'gate-resolved': '#10b981',
  },
  statusEdge: {
    active: '#34d399',
    done: 'rgba(16, 185, 129, 0.85)',
    failed: 'rgba(248, 113, 113, 0.9)',
    pending: 'rgba(139, 152, 169, 0.35)',
  },
}

/** Paper surfaces, dark ink, emerald one step darker (theme.css light set). */
const CANVAS_SCENE_LIGHT: CanvasSceneColors = {
  bg: '#f6f4ee',
  gridDot: 'rgba(5, 150, 105, 0.25)',
  selection: '#20293a',
  connect: '#059669',
  failed: '#dc2626',
  dimStroke: 'rgba(32, 41, 58, 0.35)',
  portRing: '#ffffff',
  label: '#ffffff',
  sublabel: 'rgba(255,255,255,0.75)',
  statusStroke: {
    pending: '#d6d1c2',
    running: '#059669',
    done: '#10b981',
    failed: '#dc2626',
    'gate-open': '#059669',
    'gate-resolved': '#10b981',
  },
  statusEdge: {
    active: '#059669',
    done: 'rgba(16, 185, 129, 0.9)',
    failed: 'rgba(220, 38, 38, 0.9)',
    pending: 'rgba(91, 104, 121, 0.45)',
  },
}

export function canvasSceneColors(theme: ResolvedTheme): CanvasSceneColors {
  return theme === 'light' ? CANVAS_SCENE_LIGHT : CANVAS_SCENE_DARK
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
/** Map journaled call-step childRunId onto canvas node ids. */
export function childRunIdByIdForCanvas(
  author: FlowAuthorGraph,
  projection: GraphNode[],
): Record<string, string> {
  const known = new Set(author.nodes.map((n) => n.id))
  const map: Record<string, string> = {}
  for (const p of projection) {
    if (!p.childRunId) continue
    if (known.has(p.id)) map[p.id] = p.childRunId
    const inner = branchInnerId(p.id)
    if (inner && known.has(inner)) map[inner] = p.childRunId
  }
  return map
}

export function statusByIdForCanvas(
  author: FlowAuthorGraph,
  projection: GraphNode[],
): Record<string, GraphNodeStatus> {
  const map = statusByIdFromProjection(projection)
  const doneStatus = Object.hasOwn(map, 'done') ? map.done : undefined
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
