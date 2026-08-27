import { describe, expect, it } from 'vitest'
import type { GraphNode } from './graph-project.js'
import { addFlowNode, emptyFlowGraph, FLOW_START_ID } from './flow-graph.js'
import {
  overlayEdgeKind,
  statusByIdForCanvas,
  statusByIdFromProjection,
} from './flow-overlay.js'

function node(partial: Partial<GraphNode> & Pick<GraphNode, 'id' | 'status'>): GraphNode {
  return {
    label: partial.id,
    fromOutline: true,
    fromJournal: partial.status !== 'pending',
    ...partial,
  }
}

describe('statusByIdFromProjection', () => {
  it('maps node ids and marks Start done once anything has started', () => {
    const map = statusByIdFromProjection([
      node({ id: 'load', status: 'done', kind: 'run' }),
      node({ id: 'review', status: 'running', kind: 'agent' }),
      node({ id: 'approve', status: 'pending', kind: 'human' }),
    ])
    expect(map.load).toBe('done')
    expect(map.review).toBe('running')
    expect(map.approve).toBe('pending')
    expect(map[FLOW_START_ID]).toBe('done')
  })

  it('does not mark Start when everything is pending', () => {
    const map = statusByIdFromProjection([node({ id: 'load', status: 'pending' })])
    expect(map[FLOW_START_ID]).toBeUndefined()
    expect(map.load).toBe('pending')
  })
})

describe('overlayEdgeKind', () => {
  it('lights the edge into the running node', () => {
    expect(overlayEdgeKind('done', 'running')).toBe('active')
    expect(overlayEdgeKind('done', 'done')).toBe('done')
    expect(overlayEdgeKind('pending', 'pending')).toBe('pending')
    expect(overlayEdgeKind('done', 'failed')).toBe('failed')
    expect(overlayEdgeKind('running', 'pending')).toBe('active')
    expect(overlayEdgeKind('gate-open', 'pending')).toBe('active')
  })
})

describe('statusByIdForCanvas', () => {
  it('folds journal done and parallel-branch inner ids onto canvas nodes', () => {
    let g = emptyFlowGraph()
    g = addFlowNode(g, 'done')
    g = addFlowNode(g, 'agent')
    const done = g.nodes.find((n) => n.kind === 'done')!
    const agent = g.nodes.find((n) => n.kind === 'agent')!
    const map = statusByIdForCanvas(g, [
      node({ id: 'done', status: 'done' }),
      node({ id: `par#1/b0:${agent.id}`, status: 'running' }),
    ])
    expect(map[done.id]).toBe('done')
    expect(map[agent.id]).toBe('running')
  })
})
