/**
 * Nested DAG validation for Workflows IR v2.
 * Rules: ./VALIDATION.md — error codes must stay in sync with that index.
 */

import type {
  BodyPortMap,
  Expression,
  Graph,
  PortSpec,
  ValidateMode,
  ValidationIssueV2,
  WorkflowDefV2,
  WorkflowEdgeV2,
  WorkflowNodeV2,
} from './types.js'

const CAPS = new Set(['read-only', 'read-write', 'execute', 'all'])
const DIALECTS = new Set(['simple', 'cel'])

function issue(
  partial: Omit<ValidationIssueV2, 'severity'> & { severity?: ValidationIssueV2['severity'] },
): ValidationIssueV2 {
  return {
    severity: partial.severity ?? 'error',
    code: partial.code,
    message: partial.message,
    nodeId: partial.nodeId,
    edgeId: partial.edgeId,
    graphPath: partial.graphPath,
  }
}

function isExpr(v: unknown): v is Expression {
  return (
    typeof v === 'object' &&
    v !== null &&
    'dialect' in v &&
    'expr' in v &&
    typeof (v as Expression).expr === 'string'
  )
}

function checkExpression(
  expr: unknown,
  ctx: {
    nodeId?: string
    graphPath: string
    /** Explicit error code for missing/empty expr (not dialect). */
    badCode: string
  },
  issues: ValidationIssueV2[],
): void {
  if (!isExpr(expr)) {
    issues.push(
      issue({
        code: ctx.badCode,
        message: 'Expression must be { dialect, expr }',
        nodeId: ctx.nodeId,
        graphPath: ctx.graphPath,
      }),
    )
    return
  }
  if (!DIALECTS.has(expr.dialect)) {
    issues.push(
      issue({
        code: 'expr.unknown_dialect',
        message: `Unknown expression dialect "${expr.dialect}"`,
        nodeId: ctx.nodeId,
        graphPath: ctx.graphPath,
      }),
    )
  }
  if (!expr.expr.trim()) {
    issues.push(
      issue({
        code: ctx.badCode,
        message: 'Expression expr must be non-empty',
        nodeId: ctx.nodeId,
        graphPath: ctx.graphPath,
      }),
    )
  }
}

function asPortList(v: unknown): PortSpec[] {
  return Array.isArray(v) ? (v as PortSpec[]) : []
}

function portMap(node: WorkflowNodeV2): { inputs: PortSpec[]; outputs: PortSpec[] } {
  const n = node as { inputs?: unknown; outputs?: unknown }
  return { inputs: asPortList(n.inputs), outputs: asPortList(n.outputs) }
}

function findPort(node: WorkflowNodeV2, portId: string): PortSpec | undefined {
  const ports = portMap(node)
  return ports.inputs.find((p) => p?.id === portId) ?? ports.outputs.find((p) => p?.id === portId)
}

/** Collect node ids in this graph and all nested composite bodies. */
function collectDescendantNodeIds(graph: Graph, into: Set<string>): void {
  for (const node of graph.nodes ?? []) {
    if (!node?.id) continue
    into.add(node.id)
    if (node.kind === 'map' || node.kind === 'loop') {
      if (node.body && Array.isArray(node.body.nodes)) {
        collectDescendantNodeIds(node.body, into)
      }
    }
  }
}

/** Kahn cycle detect; true if cycle exists. */
function hasCycle(nodes: WorkflowNodeV2[], edges: WorkflowEdgeV2[]): boolean {
  const ids = new Set(nodes.map((n) => n.id).filter(Boolean))
  const indeg = new Map<string, number>()
  const adj = new Map<string, string[]>()
  for (const id of ids) {
    indeg.set(id, 0)
    adj.set(id, [])
  }
  for (const e of edges) {
    if (!ids.has(e.from?.nodeId) || !ids.has(e.to?.nodeId)) continue
    adj.get(e.from.nodeId)!.push(e.to.nodeId)
    indeg.set(e.to.nodeId, (indeg.get(e.to.nodeId) ?? 0) + 1)
  }
  const q: string[] = []
  for (const [id, d] of indeg) {
    if (d === 0) q.push(id)
  }
  let seen = 0
  while (q.length) {
    const u = q.shift()!
    seen++
    for (const v of adj.get(u) ?? []) {
      const nd = (indeg.get(v) ?? 0) - 1
      indeg.set(v, nd)
      if (nd === 0) q.push(v)
    }
  }
  return seen < ids.size
}

function parseBodyRef(ref: string): { nodeId: string; portId: string } | null {
  if (typeof ref !== 'string') return null
  const i = ref.indexOf('.')
  if (i <= 0 || i === ref.length - 1) return null
  return { nodeId: ref.slice(0, i), portId: ref.slice(i + 1) }
}

function checkBodyPortMap(
  map: BodyPortMap | undefined | null,
  composite: WorkflowNodeV2,
  body: Graph,
  graphPath: string,
  issues: ValidationIssueV2[],
): void {
  if (map == null || typeof map !== 'object') {
    issues.push(
      issue({
        code: 'composite.missing_body_port_map',
        message: `Composite "${composite.id}" requires bodyPortMap`,
        nodeId: composite.id,
        graphPath,
      }),
    )
    return
  }
  const boundary = portMap(composite)
  const bodyById = new Map((body.nodes ?? []).filter((n) => n?.id).map((n) => [n.id, n]))
  const code = 'composite.invalid_body_port_map'

  const checkSide = (
    side: 'inputs' | 'outputs',
    boundaryPorts: PortSpec[],
    expectedBodyDir: 'in' | 'out',
  ) => {
    const rec = map[side]
    if (rec == null || typeof rec !== 'object') {
      issues.push(
        issue({
          code,
          message: `bodyPortMap.${side} must be an object`,
          nodeId: composite.id,
          graphPath,
        }),
      )
      return
    }
    for (const [boundaryPortId, bodyRef] of Object.entries(rec)) {
      if (!boundaryPorts.some((p) => p.id === boundaryPortId)) {
        issues.push(
          issue({
            code,
            message: `bodyPortMap.${side} key "${boundaryPortId}" is not a boundary port on ${composite.id}`,
            nodeId: composite.id,
            graphPath,
          }),
        )
        continue
      }
      const parsed = parseBodyRef(String(bodyRef))
      if (!parsed) {
        issues.push(
          issue({
            code,
            message: `bodyPortMap.${side}.${boundaryPortId} must be "nodeId.portId"`,
            nodeId: composite.id,
            graphPath,
          }),
        )
        continue
      }
      const bn = bodyById.get(parsed.nodeId)
      if (!bn) {
        issues.push(
          issue({
            code,
            message: `bodyPortMap.${side}.${boundaryPortId} references unknown body node "${parsed.nodeId}"`,
            nodeId: composite.id,
            graphPath,
          }),
        )
        continue
      }
      const bp = findPort(bn, parsed.portId)
      if (!bp) {
        issues.push(
          issue({
            code,
            message: `bodyPortMap.${side}.${boundaryPortId} references unknown port "${String(bodyRef)}"`,
            nodeId: composite.id,
            graphPath,
          }),
        )
        continue
      }
      if (bp.direction !== expectedBodyDir) {
        issues.push(
          issue({
            code,
            message: `bodyPortMap.${side}.${boundaryPortId} must target a body ${expectedBodyDir} port`,
            nodeId: composite.id,
            graphPath,
          }),
        )
      }
    }
  }

  checkSide('inputs', boundary.inputs, 'in')
  checkSide('outputs', boundary.outputs, 'out')
}

function validateGraph(
  graph: Graph,
  graphPath: string,
  mode: ValidateMode,
  issues: ValidationIssueV2[],
): void {
  const nodes = Array.isArray(graph?.nodes) ? graph.nodes : []
  const edges = Array.isArray(graph?.edges) ? graph.edges : []

  const cycleCode = graphPath === '' ? 'graph.cycle' : 'graph.cycle_in_body'
  if (hasCycle(nodes, edges)) {
    issues.push(
      issue({
        code: cycleCode,
        message: `Graph has a cycle${graphPath ? ` at ${graphPath}` : ''}`,
        graphPath,
      }),
    )
  }

  const nodeIds = new Set<string>()
  for (const node of nodes) {
    if (!node || typeof node !== 'object') {
      issues.push(
        issue({
          code: 'def.malformed',
          message: 'Graph contains a non-object node',
          graphPath,
        }),
      )
      continue
    }
    if (typeof node.id !== 'string' || !node.id.trim()) {
      issues.push(
        issue({
          code: 'node.missing_id',
          message: 'Node is missing id',
          graphPath,
        }),
      )
      continue
    }
    if (nodeIds.has(node.id)) {
      issues.push(
        issue({
          code: 'node.duplicate_id',
          message: `Duplicate node id "${node.id}"`,
          nodeId: node.id,
          graphPath,
        }),
      )
    }
    nodeIds.add(node.id)

    const ports = portMap(node)
    const seen = new Set<string>()
    for (const p of [...ports.inputs, ...ports.outputs]) {
      if (!p || typeof p.id !== 'string') continue
      if (seen.has(p.id)) {
        issues.push(
          issue({
            code: 'port.duplicate_id',
            message: `Duplicate port "${p.id}" on node "${node.id}"`,
            nodeId: node.id,
            graphPath,
          }),
        )
      }
      seen.add(p.id)
    }
    for (const p of ports.inputs) {
      if (p && p.direction !== 'in') {
        issues.push(
          issue({
            code: 'port.direction_mismatch',
            message: `Input port "${p.id}" on "${node.id}" must have direction in`,
            nodeId: node.id,
            graphPath,
          }),
        )
      }
    }
    for (const p of ports.outputs) {
      if (p && p.direction !== 'out') {
        issues.push(
          issue({
            code: 'port.direction_mismatch',
            message: `Output port "${p.id}" on "${node.id}" must have direction out`,
            nodeId: node.id,
            graphPath,
          }),
        )
      }
    }

    validateNode(node, graphPath, mode, issues)
  }

  // First occurrence wins for edge resolution; duplicates already flagged.
  const byId = new Map<string, WorkflowNodeV2>()
  for (const n of nodes) {
    if (n?.id && !byId.has(n.id)) byId.set(n.id, n)
  }

  // For cross_boundary: ids that exist only in descendant bodies of this level's composites
  const descendantIds = new Set<string>()
  for (const n of nodes) {
    if (n.kind === 'map' || n.kind === 'loop') {
      if (n.body && Array.isArray(n.body.nodes)) {
        collectDescendantNodeIds(n.body, descendantIds)
      }
    }
  }
  // Parent-level ids are not "descendant-only"
  for (const id of nodeIds) descendantIds.delete(id)

  const edgeIds = new Set<string>()
  for (const edge of edges) {
    if (!edge || typeof edge !== 'object') {
      issues.push(issue({ code: 'def.malformed', message: 'Non-object edge', graphPath }))
      continue
    }
    if (typeof edge.id !== 'string' || !edge.id.trim()) {
      issues.push(issue({ code: 'edge.missing_id', message: 'Edge is missing id', graphPath }))
      continue
    }
    if (edgeIds.has(edge.id)) {
      issues.push(
        issue({
          code: 'edge.duplicate_id',
          message: `Duplicate edge id "${edge.id}"`,
          edgeId: edge.id,
          graphPath,
        }),
      )
    }
    edgeIds.add(edge.id)

    const fromId = edge.from?.nodeId
    const toId = edge.to?.nodeId
    const fromNode = fromId ? byId.get(fromId) : undefined
    const toNode = toId ? byId.get(toId) : undefined

    if (!fromNode || !toNode) {
      const missing = !fromNode ? fromId : toId
      issues.push(
        issue({
          code: 'edge.unknown_node',
          message: `Edge "${edge.id}" references unknown node "${String(missing)}" at this graph level`,
          edgeId: edge.id,
          graphPath,
        }),
      )
      // Only diagnose cross_boundary when the missing id exists inside a nested body.
      const inBody =
        (fromId && !fromNode && descendantIds.has(fromId)) ||
        (toId && !toNode && descendantIds.has(toId))
      if (inBody) {
        issues.push(
          issue({
            code: 'edge.cross_boundary',
            message: `Edge "${edge.id}" reaches into a composite body; use boundary ports + bodyPortMap`,
            edgeId: edge.id,
            graphPath,
          }),
        )
      }
      continue
    }

    const fromPort = findPort(fromNode, edge.from.portId)
    const toPort = findPort(toNode, edge.to.portId)
    if (!fromPort) {
      issues.push(
        issue({
          code: 'edge.unknown_from_port',
          message: `Edge "${edge.id}" unknown from port ${edge.from.nodeId}.${edge.from.portId}`,
          edgeId: edge.id,
          nodeId: edge.from.nodeId,
          graphPath,
        }),
      )
      continue
    }
    if (!toPort) {
      issues.push(
        issue({
          code: 'edge.unknown_to_port',
          message: `Edge "${edge.id}" unknown to port ${edge.to.nodeId}.${edge.to.portId}`,
          edgeId: edge.id,
          nodeId: edge.to.nodeId,
          graphPath,
        }),
      )
      continue
    }
    if (fromPort.direction !== 'out') {
      issues.push(
        issue({
          code: 'edge.from_not_out',
          message: `Edge "${edge.id}" must start at an out port`,
          edgeId: edge.id,
          graphPath,
        }),
      )
    }
    if (toPort.direction !== 'in') {
      issues.push(
        issue({
          code: 'edge.to_not_in',
          message: `Edge "${edge.id}" must end at an in port`,
          edgeId: edge.id,
          graphPath,
        }),
      )
    }
    if (fromPort.kind && toPort.kind && fromPort.kind !== toPort.kind) {
      issues.push(
        issue({
          code: 'edge.kind_mismatch',
          message: `Edge "${edge.id}" kind ${fromPort.kind} → ${toPort.kind}`,
          edgeId: edge.id,
          graphPath,
        }),
      )
    }
  }
}

function validateNode(
  node: WorkflowNodeV2,
  graphPath: string,
  mode: ValidateMode,
  issues: ValidationIssueV2[],
): void {
  switch (node.kind) {
    case 'agent': {
      if (mode === 'executable' && !(typeof node.prompt === 'string' && node.prompt.trim())) {
        issues.push(
          issue({
            code: 'agent.missing_prompt',
            message: `Agent "${node.id}" requires a non-empty prompt`,
            nodeId: node.id,
            graphPath,
          }),
        )
      }
      if (!node.exec || !CAPS.has(node.exec.capability)) {
        issues.push(
          issue({
            code: 'agent.bad_capability',
            message: `Agent "${node.id}" exec.capability is required`,
            nodeId: node.id,
            graphPath,
          }),
        )
      }
      break
    }
    case 'tool': {
      if (mode === 'executable' && !(typeof node.tool === 'string' && node.tool.trim())) {
        issues.push(
          issue({
            code: 'tool.missing_tool',
            message: `Tool node "${node.id}" requires a non-empty tool id`,
            nodeId: node.id,
            graphPath,
          }),
        )
      }
      break
    }
    case 'subworkflow': {
      if (
        mode === 'executable' &&
        !(typeof node.workflowId === 'string' && node.workflowId.trim())
      ) {
        issues.push(
          issue({
            code: 'subworkflow.missing_id',
            message: `Subworkflow "${node.id}" requires workflowId`,
            nodeId: node.id,
            graphPath,
          }),
        )
      }
      break
    }
    case 'gate': {
      checkExpression(
        node.predicate,
        {
          nodeId: node.id,
          graphPath,
          badCode: 'gate.bad_predicate',
        },
        issues,
      )
      const outs = portMap(node).outputs
      const controlOuts = outs.filter((p) => p?.kind === 'control')
      if (controlOuts.length < 2) {
        issues.push(
          issue({
            severity: 'warning',
            code: 'gate.missing_branches',
            message: `Gate "${node.id}" should expose at least two control outputs`,
            nodeId: node.id,
            graphPath,
          }),
        )
      }
      break
    }
    case 'map': {
      checkExpression(
        node.items,
        {
          nodeId: node.id,
          graphPath,
          badCode: 'map.bad_items',
        },
        issues,
      )
      if (!node.body || !Array.isArray(node.body.nodes) || !Array.isArray(node.body.edges)) {
        issues.push(
          issue({
            code: 'map.missing_body',
            message: `Map "${node.id}" requires a body graph`,
            nodeId: node.id,
            graphPath,
          }),
        )
      } else {
        const bodyPath = graphPath ? `${graphPath}/map:${node.id}` : `map:${node.id}`
        validateGraph(node.body, bodyPath, mode, issues)
        checkBodyPortMap(node.bodyPortMap, node, node.body, graphPath, issues)
      }
      const join = node.join
      if (!join || typeof join !== 'object' || !('policy' in join)) {
        issues.push(
          issue({
            code: 'map.bad_join_policy',
            message: `Map "${node.id}" join.policy required`,
            nodeId: node.id,
            graphPath,
          }),
        )
      } else if (join.policy !== 'all' && join.policy !== 'any' && join.policy !== 'quorum') {
        issues.push(
          issue({
            code: 'map.bad_join_policy',
            message: `Map "${node.id}" join.policy must be all|any|quorum`,
            nodeId: node.id,
            graphPath,
          }),
        )
      } else if (join.policy === 'quorum') {
        if (!Number.isInteger(join.n) || join.n < 1) {
          issues.push(
            issue({
              code: 'map.bad_quorum',
              message: `Map "${node.id}" quorum n must be integer >= 1`,
              nodeId: node.id,
              graphPath,
            }),
          )
        } else if (node.staticFanOut !== undefined) {
          if (!Number.isInteger(node.staticFanOut) || node.staticFanOut < 1) {
            issues.push(
              issue({
                code: 'map.bad_static_fanout',
                message: `Map "${node.id}" staticFanOut must be integer >= 1`,
                nodeId: node.id,
                graphPath,
              }),
            )
          } else if (join.n > node.staticFanOut) {
            issues.push(
              issue({
                code: 'map.quorum_exceeds_fanout',
                message: `Map "${node.id}" quorum ${join.n} > staticFanOut ${node.staticFanOut}`,
                nodeId: node.id,
                graphPath,
              }),
            )
          }
        } else {
          issues.push(
            issue({
              severity: 'warning',
              code: 'map.quorum_unbounded',
              message: `Map "${node.id}" quorum cannot be fully checked without staticFanOut`,
              nodeId: node.id,
              graphPath,
            }),
          )
        }
      }
      if (node.concurrency !== undefined) {
        if (!Number.isInteger(node.concurrency) || node.concurrency < 1) {
          issues.push(
            issue({
              code: 'map.bad_concurrency',
              message: `Map "${node.id}" concurrency must be integer >= 1`,
              nodeId: node.id,
              graphPath,
            }),
          )
        }
      }
      break
    }
    case 'loop': {
      if (node.maxIterations === undefined || node.maxIterations === null) {
        issues.push(
          issue({
            code: 'loop.missing_max_iterations',
            message: `Loop "${node.id}" requires maxIterations`,
            nodeId: node.id,
            graphPath,
          }),
        )
      } else if (!Number.isInteger(node.maxIterations) || node.maxIterations < 1) {
        issues.push(
          issue({
            code: 'loop.bad_max_iterations',
            message: `Loop "${node.id}" maxIterations must be integer >= 1`,
            nodeId: node.id,
            graphPath,
          }),
        )
      }
      const hasWhile = node.while !== undefined
      const hasUntil = node.until !== undefined
      if (!hasWhile && !hasUntil) {
        issues.push(
          issue({
            code: 'loop.missing_condition',
            message: `Loop "${node.id}" requires while or until`,
            nodeId: node.id,
            graphPath,
          }),
        )
      } else if (hasWhile && hasUntil) {
        issues.push(
          issue({
            code: 'loop.ambiguous_condition',
            message: `Loop "${node.id}" must have exactly one of while|until`,
            nodeId: node.id,
            graphPath,
          }),
        )
      } else if (hasWhile) {
        checkExpression(
          node.while,
          {
            nodeId: node.id,
            graphPath,
            badCode: 'loop.bad_expression',
          },
          issues,
        )
      } else {
        checkExpression(
          node.until,
          {
            nodeId: node.id,
            graphPath,
            badCode: 'loop.bad_expression',
          },
          issues,
        )
      }
      if (!node.body || !Array.isArray(node.body.nodes) || !Array.isArray(node.body.edges)) {
        issues.push(
          issue({
            code: 'loop.missing_body',
            message: `Loop "${node.id}" requires a body graph`,
            nodeId: node.id,
            graphPath,
          }),
        )
      } else {
        const bodyPath = graphPath ? `${graphPath}/loop:${node.id}` : `loop:${node.id}`
        validateGraph(node.body, bodyPath, mode, issues)
        checkBodyPortMap(node.bodyPortMap, node, node.body, graphPath, issues)
      }
      break
    }
    case 'approval': {
      if (mode === 'executable' && !(typeof node.prompt === 'string' && node.prompt.trim())) {
        issues.push(
          issue({
            code: 'approval.missing_prompt',
            message: `Approval "${node.id}" requires a non-empty prompt`,
            nodeId: node.id,
            graphPath,
          }),
        )
      }
      break
    }
    case 'script': {
      if (node.dialect !== 'rhai') {
        issues.push(
          issue({
            code: 'script.bad_dialect',
            message: `Script "${node.id}" dialect must be rhai`,
            nodeId: node.id,
            graphPath,
          }),
        )
      }
      if (!(typeof node.source === 'string' && node.source.trim())) {
        issues.push(
          issue({
            code: 'script.missing_source',
            message: `Script "${node.id}" source must be non-empty`,
            nodeId: node.id,
            graphPath,
          }),
        )
      }
      break
    }
    default:
      break
  }
}

/**
 * Validate a v2 workflow definition. Total over untrusted shapes: never throws
 * on missing fields (emits def.malformed / structural codes instead).
 */
export function validateWorkflowV2(
  def: WorkflowDefV2,
  mode: ValidateMode = 'executable',
): ValidationIssueV2[] {
  const issues: ValidationIssueV2[] = []
  try {
    if (!def || typeof def !== 'object') {
      return [issue({ code: 'def.malformed', message: 'Workflow def must be an object' })]
    }
    if (typeof def.id !== 'string' || !def.id.trim()) {
      issues.push(issue({ code: 'def.missing_id', message: 'Workflow id is required' }))
    }
    if (typeof def.name !== 'string' || !def.name.trim()) {
      issues.push(issue({ code: 'def.missing_name', message: 'Workflow name is required' }))
    }
    if (!Number.isInteger(def.version) || def.version < 1) {
      issues.push(issue({ code: 'def.bad_version', message: 'version must be integer >= 1' }))
    }
    if (!def.graph || typeof def.graph !== 'object') {
      issues.push(issue({ code: 'def.missing_graph', message: 'graph is required' }))
      return issues
    }
    if (!Array.isArray(def.graph.nodes) || !Array.isArray(def.graph.edges)) {
      issues.push(
        issue({
          code: 'def.malformed',
          message: 'graph.nodes and graph.edges must be arrays',
        }),
      )
      return issues
    }

    // Def-level I/O: deferred to scheduler slice — see VALIDATION.md § Deferred.
    // Reserved codes: def.port_map_missing, port.unwired_required

    validateGraph(def.graph, '', mode, issues)
  } catch (err) {
    issues.push(
      issue({
        code: 'def.malformed',
        message: `Validator aborted: ${err instanceof Error ? err.message : String(err)}`,
      }),
    )
  }
  return issues
}

export function isValidWorkflowV2(def: WorkflowDefV2, mode: ValidateMode = 'executable'): boolean {
  return validateWorkflowV2(def, mode).every((i) => i.severity !== 'error')
}
