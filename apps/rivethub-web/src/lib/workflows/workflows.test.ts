import { describe, it, expect } from 'vitest'
import {
  PR_REVIEW_GATE,
  WIKI_RECOMPILE,
  edgePaths,
  getWorkflow,
  graphBounds,
  listWorkflows,
  normalizeWorkflow,
  portAnchor,
  validateWorkflow,
  isValidWorkflow,
  NODE_WIDTH,
  type WorkflowDefinition,
} from './index.js'

describe('listWorkflows / getWorkflow', () => {
  it('exposes multi-node fixtures with contract fields', () => {
    const all = listWorkflows()
    expect(all.length).toBeGreaterThanOrEqual(2)
    const pr = getWorkflow('pr-review-gate')
    expect(pr).toBeDefined()
    expect(pr!.nodes.length).toBe(6)
    expect(pr!.edges.length).toBe(5)

    for (const node of pr!.nodes) {
      expect(node.capability).toMatch(/^(read-only|read-write|execute|all)$/)
      expect(Array.isArray(node.inputs)).toBe(true)
      expect(Array.isArray(node.outputs)).toBe(true)
      // Every non-source node has inputs or is a pure sink with tools
      if (node.kind !== 'source') {
        expect(node.inputs.length + node.outputs.length).toBeGreaterThan(0)
      }
    }

    const review = pr!.nodes.find((n) => n.id === 'review')!
    expect(review.toolProfile).toBe('code-review')
    expect(review.inputs.some((p) => p.direction === 'in')).toBe(true)
    expect(review.outputs.some((p) => p.direction === 'out')).toBe(true)

    const verify = pr!.nodes.find((n) => n.id === 'verify')!
    expect(verify.tools).toEqual(expect.arrayContaining(['lint', 'typecheck']))
    expect(verify.capability).toBe('execute')
  })

  it('returns undefined for unknown id', () => {
    expect(getWorkflow('no-such-workflow')).toBeUndefined()
  })
})

describe('normalizeWorkflow', () => {
  it('preserves port author order so gate pass/fail layout does not cross', () => {
    const n = normalizeWorkflow(PR_REVIEW_GATE)
    const gate = n.nodes.find((x) => x.id === 'gate')!
    expect(gate.outputs.map((p) => p.id)).toEqual(['pass', 'fail'])
    const passY = portAnchor(gate, 'pass')!.y
    const failY = portAnchor(gate, 'fail')!.y
    // pass is first → higher on card (smaller y) than fail → merge above escalate
    expect(passY).toBeLessThan(failY)
  })

  it('sorts nodes and edges by id and fills required defaults', () => {
    const raw: WorkflowDefinition = {
      id: 't',
      name: '  Test  ',
      version: 1,
      nodes: [
        {
          id: 'b',
          kind: 'agent',
          label: 'B',
          position: { x: 0, y: 0 },
          capability: 'read-only',
          tools: ['z', 'a', 'a', ''],
          inputs: [{ id: 'in1', name: 'In', direction: 'in', kind: 'data' }],
          outputs: [],
        },
        {
          id: 'a',
          kind: 'source',
          label: 'A',
          position: { x: 10, y: 10 },
          capability: 'read-only',
          inputs: [],
          outputs: [{ id: 'out1', name: 'Out', direction: 'out', kind: 'data' }],
        },
      ],
      edges: [
        {
          id: 'e2',
          from: { nodeId: 'a', portId: 'out1' },
          to: { nodeId: 'b', portId: 'in1' },
        },
        {
          id: 'e1',
          from: { nodeId: 'a', portId: 'out1' },
          to: { nodeId: 'b', portId: 'in1' },
        },
      ],
    }
    const n = normalizeWorkflow(raw)
    expect(n.name).toBe('Test')
    expect(n.nodes.map((x) => x.id)).toEqual(['a', 'b'])
    expect(n.edges.map((x) => x.id)).toEqual(['e1', 'e2'])
    const bIn = n.nodes.find((x) => x.id === 'b')!.inputs[0]!
    expect(bIn.required).toBe(true)
    expect(n.nodes.find((x) => x.id === 'b')!.tools).toEqual(['a', 'z'])
  })

  it('does not mutate the input definition', () => {
    const copy = structuredClone(PR_REVIEW_GATE)
    const before = JSON.stringify(copy)
    normalizeWorkflow(copy)
    expect(JSON.stringify(copy)).toBe(before)
  })
})

describe('validateWorkflow', () => {
  it('accepts the PR review fixture cleanly (no errors)', () => {
    const issues = validateWorkflow(normalizeWorkflow(PR_REVIEW_GATE))
    const errors = issues.filter((i) => i.severity === 'error')
    expect(errors).toEqual([])
    expect(isValidWorkflow(PR_REVIEW_GATE)).toBe(true)
  })

  it('accepts the wiki recompile fixture', () => {
    expect(isValidWorkflow(WIKI_RECOMPILE)).toBe(true)
  })

  it('flags unknown edge endpoints and direction mistakes', () => {
    const broken: WorkflowDefinition = {
      id: 'broken',
      name: 'Broken',
      version: 1,
      nodes: [
        {
          id: 'a',
          kind: 'source',
          label: 'A',
          position: { x: 0, y: 0 },
          capability: 'read-only',
          inputs: [],
          outputs: [{ id: 'out', name: 'Out', direction: 'out', kind: 'data' }],
        },
        {
          id: 'b',
          kind: 'sink',
          label: 'B',
          position: { x: 100, y: 0 },
          capability: 'read-only',
          inputs: [{ id: 'in', name: 'In', direction: 'in', kind: 'data', required: true }],
          outputs: [],
        },
      ],
      edges: [
        {
          id: 'bad-node',
          from: { nodeId: 'missing', portId: 'out' },
          to: { nodeId: 'b', portId: 'in' },
        },
        {
          id: 'bad-port',
          from: { nodeId: 'a', portId: 'nope' },
          to: { nodeId: 'b', portId: 'in' },
        },
        {
          id: 'self',
          from: { nodeId: 'a', portId: 'out' },
          to: { nodeId: 'a', portId: 'out' },
        },
      ],
    }
    const codes = validateWorkflow(broken).map((i) => i.code)
    expect(codes).toContain('edge.unknown_from_node')
    expect(codes).toContain('edge.unknown_from_port')
    expect(codes).toContain('edge.self_loop')
    expect(codes).toContain('port.unwired_required')
  })

  it('flags kind mismatch on edges', () => {
    const bad: WorkflowDefinition = {
      id: 'kind',
      name: 'Kind',
      version: 1,
      nodes: [
        {
          id: 'a',
          kind: 'source',
          label: 'A',
          position: { x: 0, y: 0 },
          capability: 'read-only',
          inputs: [],
          outputs: [{ id: 'out', name: 'Out', direction: 'out', kind: 'data' }],
        },
        {
          id: 'b',
          kind: 'sink',
          label: 'B',
          position: { x: 100, y: 0 },
          capability: 'read-only',
          inputs: [{ id: 'in', name: 'In', direction: 'in', kind: 'control', required: true }],
          outputs: [],
        },
      ],
      edges: [
        {
          id: 'mismatch',
          from: { nodeId: 'a', portId: 'out' },
          to: { nodeId: 'b', portId: 'in' },
        },
      ],
    }
    expect(validateWorkflow(bad).some((i) => i.code === 'edge.kind_mismatch')).toBe(true)
  })

  it('flags duplicate node ids', () => {
    const dup: WorkflowDefinition = {
      id: 'dup',
      name: 'Dup',
      version: 1,
      nodes: [
        {
          id: 'same',
          kind: 'source',
          label: 'One',
          position: { x: 0, y: 0 },
          capability: 'read-only',
          inputs: [],
          outputs: [],
        },
        {
          id: 'same',
          kind: 'sink',
          label: 'Two',
          position: { x: 0, y: 0 },
          capability: 'read-only',
          inputs: [],
          outputs: [],
        },
      ],
      edges: [],
    }
    expect(validateWorkflow(dup).some((i) => i.code === 'node.duplicate_id')).toBe(true)
  })
})

describe('layout helpers', () => {
  it('computes port anchors and edge paths for the PR fixture', () => {
    const def = normalizeWorkflow(PR_REVIEW_GATE)
    const review = def.nodes.find((n) => n.id === 'review')!
    const inAnchor = portAnchor(review, 'doc')
    const outAnchor = portAnchor(review, 'findings')
    expect(inAnchor?.side).toBe('left')
    expect(outAnchor?.side).toBe('right')
    expect(outAnchor!.x).toBe(review.position.x + NODE_WIDTH)

    const paths = edgePaths(def)
    expect(paths.length).toBe(def.edges.length)
    for (const p of paths) {
      expect(p.d.startsWith('M ')).toBe(true)
      expect(p.d.includes('C ')).toBe(true)
    }

    const bounds = graphBounds(def)
    expect(bounds.width).toBeGreaterThan(NODE_WIDTH)
    expect(bounds.height).toBeGreaterThan(0)
  })
})
