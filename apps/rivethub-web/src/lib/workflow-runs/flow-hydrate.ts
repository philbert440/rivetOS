import type { WorkflowOutlineStep } from '@rivetos/types'
import type { GraphEdge, GraphNode } from './graph-project.js'
import { layoutFlowGraph, FLOW_ENTRY_ID } from './flow-layout.js'
import {
  emptyFlowGraph,
  FLOW_START_ID,
  type FlowAuthorGraph,
  type FlowAuthorKind,
  type FlowAuthorNode,
} from './flow-graph.js'

const KINDS = new Set<FlowAuthorKind>([
  'agent',
  'call',
  'done',
  'human',
  'parallel',
  'run',
  'start',
])

function asKind(raw: string | undefined): FlowAuthorKind {
  if (raw === 'gate') return 'human'
  if (raw && KINDS.has(raw as FlowAuthorKind)) return raw as FlowAuthorKind
  if (!raw || raw === 'entry') return 'agent'
  return 'agent'
}

export function authorGraphFromProjection(nodes: GraphNode[], edges: GraphEdge[]): FlowAuthorGraph {
  if (nodes.length === 0) return emptyFlowGraph()
  const laid = layoutFlowGraph(nodes, edges)
  return graphFromLaid(laid)
}

export function authorGraphFromOutline(
  outline: WorkflowOutlineStep[] | undefined,
): FlowAuthorGraph {
  if (!outline || outline.length === 0) return emptyFlowGraph()
  const nodes: GraphNode[] = outline.map((s) => ({
    id: s.id,
    label: s.label ?? s.id,
    kind: s.kind,
    status: 'pending',
    fromOutline: true,
    fromJournal: false,
  }))
  const edges: GraphEdge[] = []
  for (let i = 0; i < outline.length - 1; i++) {
    const from = outline[i].id
    const to = outline[i + 1].id
    edges.push({ id: `${from}→${to}`, from, to, kind: 'declared' })
  }
  const laid = layoutFlowGraph(nodes, edges)
  return graphFromLaid(laid)
}

function graphFromLaid(laid: ReturnType<typeof layoutFlowGraph>): FlowAuthorGraph {
  const authorNodes: FlowAuthorNode[] = laid.nodes.map((n) => {
    if (n.id === FLOW_ENTRY_ID) {
      return { id: FLOW_START_ID, kind: 'start', label: 'Start', x: n.x, y: n.y }
    }
    const kind = asKind(n.source?.kind)
    const node: FlowAuthorNode = {
      id: n.id,
      kind,
      label: n.label,
      x: n.x,
      y: n.y,
    }
    if (kind === 'run') node.scriptPath = `scripts/${n.id}.sh`
    if (kind === 'agent') node.agentName = n.id
    return node
  })
  const authorEdges = laid.edges.map((e) => ({
    id: e.id,
    from: e.from === FLOW_ENTRY_ID ? FLOW_START_ID : e.from,
    to: e.to === FLOW_ENTRY_ID ? FLOW_START_ID : e.to,
  }))
  return { nodes: authorNodes, edges: authorEdges }
}
