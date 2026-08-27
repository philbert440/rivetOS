import { describe, expect, it } from 'vitest'
import {
  addFlowNode,
  canConnect,
  connectFlowNodes,
  emptyFlowGraph,
  FLOW_START_ID,
  wouldCreateCycle,
} from './flow-graph.js'

describe('flow graph connect', () => {
  it('starts with a Start node', () => {
    const g = emptyFlowGraph()
    expect(g.nodes).toHaveLength(1)
    expect(g.nodes[0]?.id).toBe(FLOW_START_ID)
  })

  it('connects start to a script and an agent', () => {
    let g = emptyFlowGraph()
    g = addFlowNode(g, 'run')
    g = addFlowNode(g, 'agent')
    const script = g.nodes.find((n) => n.kind === 'run')!
    const agent = g.nodes.find((n) => n.kind === 'agent')!
    g = connectFlowNodes(g, FLOW_START_ID, script.id)
    g = connectFlowNodes(g, script.id, agent.id)
    expect(g.edges).toHaveLength(2)
    expect(script.scriptPath).toMatch(/^scripts\//)
  })

  it('rejects cycles, self, done→, →start', () => {
    let g = emptyFlowGraph()
    g = addFlowNode(g, 'agent')
    g = addFlowNode(g, 'done')
    const agent = g.nodes.find((n) => n.kind === 'agent')!
    const done = g.nodes.find((n) => n.kind === 'done')!
    g = connectFlowNodes(g, FLOW_START_ID, agent.id)
    g = connectFlowNodes(g, agent.id, done.id)
    expect(canConnect(g, agent.id, agent.id).ok).toBe(false)
    expect(canConnect(g, done.id, agent.id).ok).toBe(false)
    expect(canConnect(g, agent.id, FLOW_START_ID).ok).toBe(false)
    expect(wouldCreateCycle(g, done.id, FLOW_START_ID)).toBe(true)
    expect(canConnect(g, done.id, FLOW_START_ID).ok).toBe(false)
  })

  it('rejects parallel branches that are not agent/script/call', () => {
    let g = emptyFlowGraph()
    g = addFlowNode(g, 'parallel')
    g = addFlowNode(g, 'human')
    const par = g.nodes.find((n) => n.kind === 'parallel')!
    const gate = g.nodes.find((n) => n.kind === 'human')!
    expect(canConnect(g, par.id, gate.id).ok).toBe(false)
  })
})
