import { describe, expect, it } from 'vitest'
import {
  HISTORY_LIMIT,
  createHistory,
  pushHistory,
  redoHistory,
  undoHistory,
} from './flow-history.js'

describe('flow history', () => {
  it('undoes and redoes, and a new push clears redo', () => {
    let h = createHistory('a')
    h = pushHistory(h, 'b')
    h = pushHistory(h, 'c')
    h = undoHistory(h)
    expect(h.present).toBe('b')
    h = undoHistory(h)
    expect(h.present).toBe('a')
    expect(undoHistory(h)).toBe(h)
    h = redoHistory(h)
    expect(h.present).toBe('b')
    h = pushHistory(h, 'd')
    expect(h.future).toEqual([])
    expect(redoHistory(h)).toBe(h)
  })

  it('coalesces consecutive pushes with the same key into one step', () => {
    let h = createHistory(0)
    h = pushHistory(h, 1, 'drag:a')
    h = pushHistory(h, 2, 'drag:a')
    h = pushHistory(h, 3, 'drag:a')
    h = pushHistory(h, 4, 'drag:b')
    expect(h.past).toEqual([0, 3])
    h = undoHistory(h)
    expect(h.present).toBe(3)
    // After undo, the same key starts a fresh step instead of merging.
    h = pushHistory(h, 9, 'drag:b')
    expect(h.past).toEqual([0, 3])
    expect(undoHistory(h).present).toBe(3)
  })

  it('ignores no-op pushes and caps the past', () => {
    const h0 = createHistory(0)
    expect(pushHistory(h0, 0)).toBe(h0)
    let h = h0
    for (let i = 1; i <= HISTORY_LIMIT + 10; i++) h = pushHistory(h, i)
    expect(h.past).toHaveLength(HISTORY_LIMIT)
    expect(h.past[0]).toBe(10)
  })
})

describe('duplicateFlowNode', async () => {
  const { addFlowNode, duplicateFlowNode, emptyFlowGraph, FLOW_START_ID } =
    await import('./flow-graph.js')
  it('copies data with a fresh id, agent file, and offset; never Start', () => {
    const g = addFlowNode(emptyFlowGraph(), 'agent')
    const src = g.nodes[1]
    const { graph, id } = duplicateFlowNode(g, src.id)
    const copy = graph.nodes.find((n) => n.id === id)!
    expect(copy).toMatchObject({ kind: 'agent', prompt: src.prompt, x: src.x + 32 })
    expect(copy.agentName).toBe(id)
    expect(copy.tools).not.toBe(src.tools)
    expect(graph.edges).toEqual(g.edges)
    expect(duplicateFlowNode(g, FLOW_START_ID).graph).toBe(g)
  })
})
