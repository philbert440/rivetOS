import { describe, expect, it } from 'vitest'
import { flowIssues } from './flow-compile.js'
import { addFlowNode, connectFlowNodes, emptyFlowGraph, FLOW_START_ID } from './flow-graph.js'
import { autoLayoutAuthorGraph } from './flow-layout.js'

describe('flowIssues', () => {
  it('is empty for a clean graph', () => {
    let g = addFlowNode(emptyFlowGraph(), 'done')
    g = connectFlowNodes(g, FLOW_START_ID, g.nodes[1].id)
    expect(flowIssues(g, {})).toEqual([])
  })

  it('warns about unwired nodes, empty agents, and field-less gates', () => {
    let g = addFlowNode(emptyFlowGraph(), 'agent')
    const agent = g.nodes[1].id
    g = connectFlowNodes(g, FLOW_START_ID, agent)
    g = { ...g, nodes: g.nodes.map((n) => (n.id === agent ? { ...n, prompt: ' ' } : n)) }
    g = addFlowNode(g, 'human')
    const gate = g.nodes[2].id
    g = connectFlowNodes(g, agent, gate)
    g = { ...g, nodes: g.nodes.map((n) => (n.id === gate ? { ...n, gateFields: [] } : n)) }
    g = addFlowNode(g, 'run')
    const loose = g.nodes[3].id
    const issues = flowIssues(g, {})
    expect(issues.map((i) => [i.severity, i.nodeId])).toEqual([
      ['warning', agent],
      ['warning', gate],
      ['warning', loose],
    ])
  })

  it('attributes errors to nodes', () => {
    let g = addFlowNode(emptyFlowGraph(), 'call')
    const call = g.nodes[1].id
    g = connectFlowNodes(g, FLOW_START_ID, call)
    expect(flowIssues(g, {})).toEqual([
      { severity: 'error', message: `call "${call}" has an empty workflow id`, nodeId: call },
    ])
    g = { ...g, nodes: g.nodes.map((n) => (n.id === call ? { ...n, callRef: 'nope' } : n)) }
    expect(flowIssues(g, { knownWorkflowIds: ['other'] })[0]).toMatchObject({
      severity: 'error',
      nodeId: call,
    })
  })
})

describe('autoLayoutAuthorGraph', () => {
  it('moves nodes into columns by depth and keeps their data', () => {
    let g = addFlowNode(emptyFlowGraph(), 'agent', { x: 900, y: 900 })
    const a = g.nodes[1].id
    g = addFlowNode(g, 'done', { x: -400, y: 5 })
    const d = g.nodes[2].id
    g = connectFlowNodes(g, FLOW_START_ID, a)
    g = connectFlowNodes(g, a, d)
    const laid = autoLayoutAuthorGraph(g, FLOW_START_ID)
    const pos = Object.fromEntries(laid.nodes.map((n) => [n.id, n]))
    expect(pos[FLOW_START_ID].x).toBeLessThan(pos[a].x)
    expect(pos[a].x).toBeLessThan(pos[d].x)
    expect(pos[a].y).toBe(pos[d].y)
    expect(pos[a].prompt).toBe(g.nodes[1].prompt)
    expect(laid.edges).toBe(g.edges)
  })
})
