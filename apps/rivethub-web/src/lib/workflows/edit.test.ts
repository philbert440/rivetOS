import { describe, it, expect } from 'vitest'
import { PR_REVIEW_GATE } from './fixtures.js'
import {
  addEdge,
  addNode,
  moveNode,
  parseToolsField,
  removeEdge,
  removeNode,
  updateNode,
  updateWorkflowMeta,
} from './edit.js'
import { validateWorkflow } from './validate.js'
import { normalizeWorkflow } from './normalize.js'

describe('edit mutators', () => {
  it('updates meta and node fields immutably', () => {
    const base = normalizeWorkflow(PR_REVIEW_GATE)
    const meta = updateWorkflowMeta(base, { name: 'Renamed', description: '  hi  ' })
    expect(meta.name).toBe('Renamed')
    expect(meta.description).toBe('  hi  ')
    expect(base.name).toBe(PR_REVIEW_GATE.name)

    const moved = moveNode(base, 'review', { x: 10.4, y: 20.6 })
    expect(moved.nodes.find((n) => n.id === 'review')!.position).toEqual({ x: 10, y: 21 })
    expect(base.nodes.find((n) => n.id === 'review')!.position.x).toBe(280)

    const labeled = updateNode(base, 'review', {
      label: 'Reviewer',
      capability: 'execute',
      tools: ['grep', 'read'],
    })
    const review = labeled.nodes.find((n) => n.id === 'review')!
    expect(review.label).toBe('Reviewer')
    expect(review.capability).toBe('execute')
    expect(review.tools).toEqual(['grep', 'read'])
  })

  it('adds and removes nodes (and dangling edges)', () => {
    const base = normalizeWorkflow(PR_REVIEW_GATE)
    const withNode = addNode(base, {
      label: 'Extra',
      position: { x: 100, y: 100 },
      kind: 'tool',
    })
    expect(withNode.nodes.length).toBe(base.nodes.length + 1)
    const id = withNode.nodes[withNode.nodes.length - 1]!.id

    const removed = removeNode(base, 'gate')
    expect(removed.nodes.some((n) => n.id === 'gate')).toBe(false)
    expect(removed.edges.some((e) => e.from.nodeId === 'gate' || e.to.nodeId === 'gate')).toBe(
      false,
    )
    expect(id).toBeTruthy()
  })

  it('adds and removes edges', () => {
    const base = normalizeWorkflow(PR_REVIEW_GATE)
    const withEdge = addEdge(base, {
      from: { nodeId: 'ingest', portId: 'doc' },
      to: { nodeId: 'review', portId: 'doc' },
    })
    expect(withEdge.edges.length).toBe(base.edges.length + 1)
    const drop = removeEdge(base, 'e-ingest-review')
    expect(drop.edges.some((e) => e.id === 'e-ingest-review')).toBe(false)
  })

  it('parseToolsField splits commas and newlines', () => {
    expect(parseToolsField(' a, b\nc ')).toEqual(['a', 'b', 'c'])
    expect(parseToolsField('')).toEqual([])
  })

  it('keeps fixture valid after move', () => {
    const moved = moveNode(normalizeWorkflow(PR_REVIEW_GATE), 'merge', { x: 1100, y: 40 })
    expect(validateWorkflow(moved).filter((i) => i.severity === 'error')).toEqual([])
  })
})
