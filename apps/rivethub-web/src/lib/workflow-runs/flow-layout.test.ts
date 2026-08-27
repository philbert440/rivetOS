import { describe, expect, it } from 'vitest'
import { projectGraph } from './graph-project.js'
import { FLOW_ENTRY_ID, FLOW_NODE_SIZE, layoutFlowGraph } from './flow-layout.js'
import type { WorkflowOutlineStep } from '@rivetos/types'

const OUTLINE: WorkflowOutlineStep[] = [
  { id: 'load', label: 'Load PR', kind: 'run' },
  { id: 'review', label: 'Review', kind: 'agent' },
  { id: 'approve', label: 'Approve', kind: 'human' },
  { id: 'done', label: 'Done', kind: 'done' },
]

describe('layoutFlowGraph', () => {
  it('injects a Start entry to the left of outline roots', () => {
    const { nodes, edges } = projectGraph(OUTLINE, [])
    const laid = layoutFlowGraph(nodes, edges)
    const entry = laid.nodes.find((n) => n.id === FLOW_ENTRY_ID)
    expect(entry?.family).toBe('entry')
    expect(entry?.label).toBe('Start')
    const load = laid.nodes.find((n) => n.id === 'load')
    expect(load).toBeDefined()
    expect(entry!.x).toBeLessThan(load!.x)
    expect(laid.edges.some((e) => e.from === FLOW_ENTRY_ID && e.to === 'load')).toBe(true)
  })

  it('places later steps to the right and maps families', () => {
    const { nodes, edges } = projectGraph(OUTLINE, [])
    const laid = layoutFlowGraph(nodes, edges)
    const byId = new Map(laid.nodes.map((n) => [n.id, n]))
    expect(byId.get('load')!.family).toBe('action')
    expect(byId.get('review')!.family).toBe('action')
    expect(byId.get('approve')!.family).toBe('operator')
    expect(byId.get('done')!.family).toBe('operator')
    expect(byId.get('review')!.x).toBeGreaterThan(byId.get('load')!.x)
    expect(byId.get('approve')!.x).toBeGreaterThan(byId.get('review')!.x)
  })

  it('returns an empty scene for no nodes', () => {
    const laid = layoutFlowGraph([], [])
    expect(laid.nodes).toEqual([])
    expect(laid.width).toBeGreaterThanOrEqual(FLOW_NODE_SIZE)
  })
})
