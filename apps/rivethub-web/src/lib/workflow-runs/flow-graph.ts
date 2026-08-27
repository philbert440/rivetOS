/**
 * Authoring IR for the flows canvas. Control-flow DAG only — no data pins.
 * `run` is a deterministic script step (step.run) so it does not spend tokens.
 */

export const FLOW_START_ID = 'start'

export type FlowAuthorKind = 'agent' | 'call' | 'done' | 'human' | 'parallel' | 'run' | 'start'

export interface FlowAuthorNode {
  id: string
  kind: FlowAuthorKind
  label: string
  x: number
  y: number
  /** agents/<name>.md stem. */
  agentName?: string
  /** System prompt written to agents/<stem>.md; also emitted as step.agent prompt. */
  prompt?: string
  model?: string
  maxTurns?: number
  tools?: string[]
  /** Workflow-relative script path for kind=run. */
  scriptPath?: string
  /** Human-gate prompt / fields. */
  gatePrompt?: string
  gateFields?: string[]
  /** Child workflow id for kind=call. */
  callRef?: string
}

export interface FlowAuthorEdge {
  id: string
  from: string
  to: string
}

export interface FlowAuthorGraph {
  nodes: FlowAuthorNode[]
  edges: FlowAuthorEdge[]
}

export const FLOW_PALETTE: { kind: Exclude<FlowAuthorKind, 'start'>; label: string }[] = [
  { kind: 'agent', label: 'Agent' },
  { kind: 'run', label: 'Script' },
  { kind: 'human', label: 'Gate' },
  { kind: 'parallel', label: 'Parallel' },
  { kind: 'call', label: 'Call' },
  { kind: 'done', label: 'Done' },
]

export function emptyFlowGraph(): FlowAuthorGraph {
  return {
    nodes: [{ id: FLOW_START_ID, kind: 'start', label: 'Start', x: 56, y: 56 }],
    edges: [],
  }
}

export function nodeById(graph: FlowAuthorGraph, id: string): FlowAuthorNode | undefined {
  return graph.nodes.find((n) => n.id === id)
}

function nextNodeId(graph: FlowAuthorGraph): string {
  let max = 0
  for (const n of graph.nodes) {
    const m = /^n(\d+)$/.exec(n.id)
    if (m) max = Math.max(max, Number(m[1]))
  }
  return `n${String(max + 1)}`
}

export function slugify(raw: string): string {
  const s = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return s.length > 0 ? s : 'step'
}

const DEFAULT_LABEL: Record<Exclude<FlowAuthorKind, 'start'>, string> = {
  agent: 'Agent',
  run: 'Script',
  human: 'Gate',
  parallel: 'Parallel',
  call: 'Call',
  done: 'Done',
}

export function addFlowNode(
  graph: FlowAuthorGraph,
  kind: Exclude<FlowAuthorKind, 'start'>,
  at?: { x: number; y: number },
): FlowAuthorGraph {
  const id = nextNodeId(graph)
  const offset = graph.nodes.length * 16
  const node: FlowAuthorNode = {
    id,
    kind,
    label: DEFAULT_LABEL[kind],
    x: at?.x ?? 200 + offset,
    y: at?.y ?? 80 + offset,
  }
  if (kind === 'agent') {
    node.agentName = id
    node.prompt = 'You are a workflow agent. Do the work for this step and write a concise result.'
    node.tools = []
  }
  if (kind === 'run') node.scriptPath = `scripts/${id}.sh`
  if (kind === 'human') {
    node.gatePrompt = 'Approve this step?'
    node.gateFields = ['approved']
  }
  if (kind === 'call') node.callRef = ''
  return { ...graph, nodes: [...graph.nodes, node] }
}

export function updateFlowNode(
  graph: FlowAuthorGraph,
  id: string,
  patch: Partial<FlowAuthorNode>,
): FlowAuthorGraph {
  return {
    ...graph,
    nodes: graph.nodes.map((n) => (n.id === id ? { ...n, ...patch, id: n.id, kind: n.kind } : n)),
  }
}

export function deleteFlowNode(graph: FlowAuthorGraph, id: string): FlowAuthorGraph {
  if (id === FLOW_START_ID) return graph
  return {
    nodes: graph.nodes.filter((n) => n.id !== id),
    edges: graph.edges.filter((e) => e.from !== id && e.to !== id),
  }
}

export function wouldCreateCycle(graph: FlowAuthorGraph, from: string, to: string): boolean {
  if (from === to) return true
  const outgoing = new Map<string, string[]>()
  for (const e of graph.edges) {
    const list = outgoing.get(e.from) ?? []
    list.push(e.to)
    outgoing.set(e.from, list)
  }
  const stack = [to]
  const seen = new Set<string>()
  while (stack.length > 0) {
    const cur = stack.pop()!
    if (cur === from) return true
    if (seen.has(cur)) continue
    seen.add(cur)
    for (const next of outgoing.get(cur) ?? []) stack.push(next)
  }
  return false
}

export function canConnect(
  graph: FlowAuthorGraph,
  from: string,
  to: string,
): { ok: true } | { ok: false; reason: string } {
  const src = nodeById(graph, from)
  const dst = nodeById(graph, to)
  if (!src || !dst) return { ok: false, reason: 'missing node' }
  if (from === to) return { ok: false, reason: 'self' }
  if (src.kind === 'done') return { ok: false, reason: 'done has no output' }
  if (dst.kind === 'start') return { ok: false, reason: 'start has no input' }
  if (graph.edges.some((e) => e.from === from && e.to === to)) {
    return { ok: false, reason: 'duplicate' }
  }
  if (wouldCreateCycle(graph, from, to)) return { ok: false, reason: 'cycle' }
  const branchKinds = new Set(['agent', 'run', 'call'])
  if (src.kind === 'parallel' && !branchKinds.has(dst.kind)) {
    return { ok: false, reason: 'parallel branches must be agent, script, or call' }
  }
  const existingIn = graph.edges.filter((e) => e.to === to)
  if (src.kind === 'parallel' && existingIn.length > 0) {
    return { ok: false, reason: 'parallel child cannot have other incoming wires' }
  }
  if (existingIn.some((e) => nodeById(graph, e.from)?.kind === 'parallel')) {
    return { ok: false, reason: 'node is already a parallel branch' }
  }
  return { ok: true }
}

export function connectFlowNodes(
  graph: FlowAuthorGraph,
  from: string,
  to: string,
): FlowAuthorGraph {
  const check = canConnect(graph, from, to)
  if (!check.ok) return graph
  const id = `${from}→${to}`
  return { ...graph, edges: [...graph.edges, { id, from, to }] }
}

export function disconnectFlowEdge(graph: FlowAuthorGraph, edgeId: string): FlowAuthorGraph {
  return { ...graph, edges: graph.edges.filter((e) => e.id !== edgeId) }
}

export function outgoingIds(graph: FlowAuthorGraph, id: string): string[] {
  return graph.edges.filter((e) => e.from === id).map((e) => e.to)
}

export function incomingIds(graph: FlowAuthorGraph, id: string): string[] {
  return graph.edges.filter((e) => e.to === id).map((e) => e.from)
}

/** Nodes reachable from Start (inclusive). Detached nodes are not compiled. */
export function reachableFromStart(graph: FlowAuthorGraph): Set<string> {
  const seen = new Set<string>([FLOW_START_ID])
  const stack = [FLOW_START_ID]
  while (stack.length > 0) {
    const id = stack.pop()!
    for (const nxt of outgoingIds(graph, id)) {
      if (!seen.has(nxt)) {
        seen.add(nxt)
        stack.push(nxt)
      }
    }
  }
  return seen
}

/** Kahn topological order. Isolated nodes follow start, then remaining. */
export function topoSort(graph: FlowAuthorGraph): string[] {
  const ids = graph.nodes.map((n) => n.id)
  const incoming = new Map<string, number>()
  const outgoing = new Map<string, string[]>()
  for (const id of ids) {
    incoming.set(id, 0)
    outgoing.set(id, [])
  }
  for (const e of graph.edges) {
    if (!incoming.has(e.to) || !outgoing.has(e.from)) continue
    incoming.set(e.to, (incoming.get(e.to) ?? 0) + 1)
    outgoing.get(e.from)!.push(e.to)
  }
  const queue: string[] = []
  if (incoming.get(FLOW_START_ID) === 0 && ids.includes(FLOW_START_ID)) {
    queue.push(FLOW_START_ID)
  }
  for (const id of ids) {
    if (id !== FLOW_START_ID && incoming.get(id) === 0) queue.push(id)
  }
  const out: string[] = []
  const queued = new Set(queue)
  while (queue.length > 0) {
    const id = queue.shift()!
    out.push(id)
    for (const nxt of outgoing.get(id) ?? []) {
      const n = (incoming.get(nxt) ?? 1) - 1
      incoming.set(nxt, n)
      if (n === 0 && !queued.has(nxt)) {
        queued.add(nxt)
        queue.push(nxt)
      }
    }
  }
  for (const id of ids) {
    if (!queued.has(id)) out.push(id)
  }
  return out
}
