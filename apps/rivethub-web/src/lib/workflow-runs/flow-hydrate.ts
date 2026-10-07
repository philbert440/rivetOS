import { parse as parseYaml } from 'yaml'
import type { WorkflowOutlineStep } from '@rivetos/types'
import { agentFieldsFromConfig, splitFrontmatter } from '../frontmatter.js'
import type { GraphEdge, GraphNode } from './graph-project.js'
import { layoutFlowGraph, FLOW_ENTRY_ID } from './flow-layout.js'
import {
  emptyFlowGraph,
  FLOW_START_ID,
  type FlowAuthorGraph,
  type FlowAuthorKind,
  type FlowAuthorNode,
} from './flow-graph.js'
import { RUN_TS_MARKER } from './flow-compile.js'

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
  // Unknown outline kinds are deterministic scripts, not token-spending agents.
  return 'run'
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
  const authorEdges = laid.edges.map((e) => {
    const from = e.from === FLOW_ENTRY_ID ? FLOW_START_ID : e.from
    const to = e.to === FLOW_ENTRY_ID ? FLOW_START_ID : e.to
    // Layout injects `entry→x` ids while rewriting from/to to `start`. The
    // inspector disconnects by `${from}→${to}` — keep those in lockstep.
    return { id: `${from}→${to}`, from, to }
  })
  return { nodes: authorNodes, edges: authorEdges }
}

/** Which agent file / script a hand-written run.ts step actually uses. */
export interface RunTsBinding {
  agent?: string
  script?: string
}

/**
 * Best-effort scan of a hand-written run.ts for `step.agent(label, { agent })`
 * and `step.run(label, { script })` bindings, keyed by step label. The outline
 * only carries ids, so without this a pre-canvas def hydrates every agent node
 * as `agents/<id>.md` — which need not exist (hello-world's `greet` step uses
 * `greeter`), and saving would then point run.ts at a new, empty agent.
 */
export function stepBindingsFromRunTs(src: string): Map<string, RunTsBinding> {
  const out = new Map<string, RunTsBinding>()
  const call = /step\.(agent|run)\(\s*(['"`])([^'"`]+)\2\s*,/g
  const matches = [...src.matchAll(call)]
  matches.forEach((m, i) => {
    const kind = m[1]
    const label = m[3]
    // Options for this call end where the next agent/run call begins.
    const rest = src.slice(m.index + m[0].length, matches[i + 1]?.index ?? src.length)
    const key = kind === 'agent' ? 'agent' : 'script'
    const value = new RegExp(`\\b${key}\\s*:\\s*(['"\`])([^'"\`]+)\\1`).exec(rest)?.[2]
    if (value) out.set(label, kind === 'agent' ? { agent: value } : { script: value })
  })
  return out
}

/** Point outline-hydrated agent/script nodes at the files run.ts really uses. */
export function applyRunTsBindings(
  graph: FlowAuthorGraph,
  bindings: Map<string, RunTsBinding>,
): FlowAuthorGraph {
  const nodes = graph.nodes.map((n) => {
    const b = bindings.get(n.id)
    if (n.kind === 'agent' && b?.agent) return { ...n, agentName: b.agent }
    if (n.kind === 'run' && b?.script) return { ...n, scriptPath: b.script }
    return n
  })
  return { ...graph, nodes }
}

/**
 * Fill an agent node's inspector fields from its `agents/<name>.md` file:
 * body → Instructions, frontmatter model / maxTurns / tools. Malformed
 * frontmatter leaves the node unchanged rather than blanking it.
 */
export function applyAgentFile(node: FlowAuthorNode, text: string): FlowAuthorNode {
  let split: ReturnType<typeof splitFrontmatter>
  let config: unknown
  try {
    split = splitFrontmatter(text)
    config = split.yaml ? parseYaml(split.yaml) : undefined
  } catch {
    return node
  }
  const fields = agentFieldsFromConfig(config)
  const prompt = split.body.replace(`<!-- ${RUN_TS_MARKER} -->`, '').trim()
  return {
    ...node,
    ...(prompt ? { prompt } : {}),
    ...(fields.model !== undefined ? { model: fields.model } : {}),
    ...(fields.maxTurns !== undefined ? { maxTurns: fields.maxTurns } : {}),
    ...(fields.tools !== undefined ? { tools: fields.tools } : {}),
  }
}
