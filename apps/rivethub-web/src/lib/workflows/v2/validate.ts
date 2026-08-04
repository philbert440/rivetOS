/**
 * Nested DAG validation for Workflows IR v2.
 * Rules: ./VALIDATION.md
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
  expr: Expression | undefined,
  ctx: { nodeId?: string; graphPath: string; field: string },
  issues: ValidationIssueV2[],
): void {
  if (!expr || !isExpr(expr)) {
    issues.push(
      issue({
        code: ctx.field.includes('predicate') ? 'gate.bad_predicate' : 'loop.bad_expression',
        message: `${ctx.field} must be { dialect, expr }`,
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
        code: ctx.field.includes('predicate') ? 'gate.bad_predicate' : 'loop.bad_expression',
        message: `${ctx.field} expr must be non-empty`,
        nodeId: ctx.nodeId,
        graphPath: ctx.graphPath,
      }),
    )
  }
}

function portMap(node: WorkflowNodeV2): { inputs: PortSpec[]; outputs: PortSpec[] } | null {
  if (!('inputs' in node) || !('outputs' in node)) return null
  return { inputs: node.inputs, outputs: node.outputs }
}

function findPort(node: WorkflowNodeV2, portId: string): PortSpec | undefined {
  const ports = portMap(node)
  if (!ports) return undefined
  return ports.inputs.find((p) => p.id === portId) ?? ports.outputs.find((p) => p.id === portId)
}

/** Kahn cycle detect; returns true if cycle exists. */
function hasCycle(nodes: WorkflowNodeV2[], edges: WorkflowEdgeV2[]): boolean {
  const ids = new Set(nodes.map((n) => n.id))
  const indeg = new Map<string, number>()
  const adj = new Map<string, string[]>()
  for (const id of ids) {
    indeg.set(id, 0)
    adj.set(id, [])
  }
  for (const e of edges) {
    if (!ids.has(e.from.nodeId) || !ids.has(e.to.nodeId)) continue
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
  const i = ref.indexOf('.')
  if (i <= 0 || i === ref.length - 1) return null
  return { nodeId: ref.slice(0, i), portId: ref.slice(i + 1) }
}

function checkBodyPortMap(
  map: BodyPortMap,
  composite: WorkflowNodeV2,
  body: Graph,
  graphPath: string,
  code: string,
  issues: ValidationIssueV2[],
): void {
  const boundary = portMap(composite)
  if (!boundary) return
  const bodyById = new Map(body.nodes.map((n) => [n.id, n]))

  const checkSide = (
    side: 'inputs' | 'outputs',
    boundaryPorts: PortSpec[],
    expectedBodyDir: 'in' | 'out',
  ) => {
    const rec = map[side] ?? {}
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
      const parsed = parseBodyRef(bodyRef)
      if (!parsed) {
        issues.push(
          issue({
            code,
            message: `bodyPortMap.${side}.${boundaryPortId} must be "nodeId.portId", got "${bodyRef}"`,
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
            message: `bodyPortMap.${side}.${boundaryPortId} references unknown port "${bodyRef}"`,
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
            message: `bodyPortMap.${side}.${boundaryPortId} → ${bodyRef} must be a body ${expectedBodyDir} port`,
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
  const cycleCode = graphPath === '' ? 'graph.cycle' : 'graph.cycle_in_body'
  if (hasCycle(graph.nodes, graph.edges)) {
    issues.push(
      issue({
        code: cycleCode,
        message: `Graph has a cycle${graphPath ? ` at ${graphPath}` : ''}`,
        graphPath,
      }),
    )
  }

  const nodeIds = new Set<string>()
  for (const node of graph.nodes) {
    if (!node.id?.trim()) {
      issues.push(issue({ code: 'node.duplicate_id', message: 'Node missing id', graphPath }))
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
    if (ports) {
      const seen = new Set<string>()
      for (const p of [...ports.inputs, ...ports.outputs]) {
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
        if (p.direction !== 'in') {
          issues.push(
            issue({
              code: 'port.duplicate_id',
              message: `Input port "${p.id}" on "${node.id}" must have direction in`,
              nodeId: node.id,
              graphPath,
            }),
          )
        }
      }
      for (const p of ports.outputs) {
        if (p.direction !== 'out') {
          issues.push(
            issue({
              code: 'port.duplicate_id',
              message: `Output port "${p.id}" on "${node.id}" must have direction out`,
              nodeId: node.id,
              graphPath,
            }),
          )
        }
      }
    }

    validateNode(node, graphPath, mode, issues)
  }

  const byId = new Map(graph.nodes.map((n) => [n.id, n]))
  const edgeIds = new Set<string>()
  for (const edge of graph.edges) {
    if (!edge.id?.trim()) {
      issues.push(issue({ code: 'edge.duplicate_id', message: 'Edge missing id', graphPath }))
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

    const fromNode = byId.get(edge.from.nodeId)
    const toNode = byId.get(edge.to.nodeId)
    if (!fromNode || !toNode) {
      issues.push(
        issue({
          code: 'edge.unknown_node',
          message: `Edge "${edge.id}" references a node not in this graph level${
            !fromNode ? ` (from ${edge.from.nodeId})` : ` (to ${edge.to.nodeId})`
          }`,
          edgeId: edge.id,
          graphPath,
        }),
      )
      // Could be attempted reach-through if id looks nested — still unknown at this level.
      if (!fromNode || !toNode) {
        issues.push(
          issue({
            code: 'edge.cross_boundary',
            message: `Edge "${edge.id}" cannot cross subgraph boundaries; use composite boundary ports`,
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
    if (fromPort.kind !== toPort.kind) {
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
      if (mode === 'executable' && !node.prompt?.trim()) {
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
    case 'gate': {
      checkExpression(
        node.predicate,
        {
          nodeId: node.id,
          graphPath,
          field: 'predicate',
        },
        issues,
      )
      const controlOuts = node.outputs.filter((p) => p.kind === 'control')
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
        checkBodyPortMap(node.bodyPortMap, node, node.body, graphPath, 'map.bad_port_map', issues)
      }
      checkExpression(node.items, { nodeId: node.id, graphPath, field: 'items' }, issues)
      const join = node.join
      if (!join || !('policy' in join)) {
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
        } else if (
          typeof node.staticFanOut === 'number' &&
          Number.isFinite(node.staticFanOut) &&
          join.n > node.staticFanOut
        ) {
          issues.push(
            issue({
              code: 'map.quorum_exceeds_fanout',
              message: `Map "${node.id}" quorum ${String(join.n)} > staticFanOut ${String(node.staticFanOut)}`,
              nodeId: node.id,
              graphPath,
            }),
          )
        } else if (node.staticFanOut === undefined) {
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
      if (hasWhile === hasUntil) {
        issues.push(
          issue({
            code: 'loop.missing_condition',
            message: `Loop "${node.id}" requires exactly one of while|until`,
            nodeId: node.id,
            graphPath,
          }),
        )
      } else if (hasWhile) {
        checkExpression(node.while, { nodeId: node.id, graphPath, field: 'while' }, issues)
      } else {
        checkExpression(node.until, { nodeId: node.id, graphPath, field: 'until' }, issues)
      }
      if (!node.body || !Array.isArray(node.body.nodes)) {
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
        checkBodyPortMap(node.bodyPortMap, node, node.body, graphPath, 'loop.bad_port_map', issues)
      }
      break
    }
    case 'approval': {
      if (mode === 'executable' && !node.prompt?.trim()) {
        issues.push(
          issue({
            code: 'agent.missing_prompt',
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
            code: 'expr.unknown_dialect',
            message: `Script "${node.id}" dialect must be rhai`,
            nodeId: node.id,
            graphPath,
          }),
        )
      }
      if (!node.source?.trim()) {
        issues.push(
          issue({
            code: 'loop.bad_expression',
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
 * Validate a v2 workflow definition.
 * @param mode `structure` skips agent prompt requirements; `executable` enforces them.
 */
export function validateWorkflowV2(
  def: WorkflowDefV2,
  mode: ValidateMode = 'executable',
): ValidationIssueV2[] {
  const issues: ValidationIssueV2[] = []

  if (!def.id?.trim()) {
    issues.push(issue({ code: 'def.missing_id', message: 'Workflow id is required' }))
  }
  if (!def.name?.trim()) {
    issues.push(issue({ code: 'def.missing_name', message: 'Workflow name is required' }))
  }
  if (!Number.isInteger(def.version) || def.version < 1) {
    issues.push(issue({ code: 'def.bad_version', message: 'version must be integer >= 1' }))
  }
  if (!def.graph || !Array.isArray(def.graph.nodes) || !Array.isArray(def.graph.edges)) {
    issues.push(issue({ code: 'def.missing_graph', message: 'graph is required' }))
    return issues
  }

  validateGraph(def.graph, '', mode, issues)
  return issues
}

export function isValidWorkflowV2(def: WorkflowDefV2, mode: ValidateMode = 'executable'): boolean {
  return validateWorkflowV2(def, mode).every((i) => i.severity !== 'error')
}
