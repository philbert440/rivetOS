import { describe, expect, it } from 'vitest'
import { disconnectFlowEdge, FLOW_START_ID } from './flow-graph.js'
import { authorGraphFromOutline } from './flow-hydrate.js'

describe('authorGraphFromOutline', () => {
  it('injects Start and maps gate → human', () => {
    const g = authorGraphFromOutline([
      { id: 'load', label: 'Load', kind: 'run' },
      { id: 'ask', label: 'Ask', kind: 'gate' },
    ])
    expect(g.nodes.some((n) => n.id === FLOW_START_ID && n.kind === 'start')).toBe(true)
    expect(g.nodes.find((n) => n.id === 'ask')?.kind).toBe('human')
    expect(g.nodes.find((n) => n.id === 'load')?.kind).toBe('run')
    expect(g.edges.some((e) => e.from === FLOW_START_ID && e.to === 'load')).toBe(true)
  })

  it('maps unknown outline kinds to script, not agent', () => {
    const g = authorGraphFromOutline([{ id: 'x', label: 'X', kind: 'transform' }])
    expect(g.nodes.find((n) => n.id === 'x')?.kind).toBe('run')
  })

  it('rewrites layout entry edge ids so disconnect matches from/to', () => {
    const g = authorGraphFromOutline([{ id: 'load', label: 'Load', kind: 'run' }])
    expect(g.edges.every((e) => e.id === `${e.from}→${e.to}`)).toBe(true)
    expect(g.edges.some((e) => e.id === `${FLOW_START_ID}→load` && e.from === FLOW_START_ID)).toBe(
      true,
    )
    const next = disconnectFlowEdge(g, `${FLOW_START_ID}→load`)
    expect(next.edges).toHaveLength(0)
  })
})
