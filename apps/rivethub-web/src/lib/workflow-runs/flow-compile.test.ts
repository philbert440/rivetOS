import { describe, expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'
import { addFlowNode, connectFlowNodes, emptyFlowGraph, FLOW_START_ID } from './flow-graph.js'
import { compileFlow, FlowCompileError, parseFlowsFile, RUN_TS_MARKER } from './flow-compile.js'

const META = {
  id: 'demo',
  name: 'Demo',
  version: '0.1.0',
  input: [{ name: 'message', type: 'string' as const, required: true }],
  output: [{ name: 'result', type: 'string' as const }],
}

describe('compileFlow', () => {
  it('emits step.run for scripts and step.agent for agents', () => {
    let g = emptyFlowGraph()
    g = addFlowNode(g, 'run')
    g = addFlowNode(g, 'agent')
    g = addFlowNode(g, 'done')
    const script = g.nodes.find((n) => n.kind === 'run')!
    const agent = g.nodes.find((n) => n.kind === 'agent')!
    const done = g.nodes.find((n) => n.kind === 'done')!
    g = connectFlowNodes(g, FLOW_START_ID, script.id)
    g = connectFlowNodes(g, script.id, agent.id)
    g = connectFlowNodes(g, agent.id, done.id)
    const { files } = compileFlow(g, META)
    expect(files['run.ts']).toContain(RUN_TS_MARKER)
    expect(files['run.ts']).toContain('step.run')
    expect(files['run.ts']).toContain('script:')
    expect(files['run.ts']).toContain('step.agent')
    expect(files['run.ts']).toContain('step.done')
    expect(Object.keys(files).some((p) => p.startsWith('scripts/') && p.endsWith('.sh'))).toBe(true)
    expect(Object.keys(files).some((p) => p.startsWith('agents/') && p.endsWith('.md'))).toBe(true)
    expect(files['workflow.yaml']).toContain('kind: run')
    expect(files['workflow.yaml']).toContain('kind: agent')
    expect(files['flows.json']).toContain('"kind": "run"')
  })

  it('compiles parallel children as step.parallel branches', () => {
    let g = emptyFlowGraph()
    g = addFlowNode(g, 'parallel')
    g = addFlowNode(g, 'agent')
    g = addFlowNode(g, 'run')
    const par = g.nodes.find((n) => n.kind === 'parallel')!
    const a = g.nodes.find((n) => n.kind === 'agent')!
    const s = g.nodes.find((n) => n.kind === 'run')!
    g = connectFlowNodes(g, FLOW_START_ID, par.id)
    g = connectFlowNodes(g, par.id, a.id)
    g = connectFlowNodes(g, par.id, s.id)
    const { files } = compileFlow(g, META)
    expect(files['run.ts']).toContain('step.parallel')
    expect(files['run.ts']).toContain('step.agent')
    expect(files['run.ts']).toContain('step.run')
  })

  it('does not emit detached nodes', () => {
    let g = emptyFlowGraph()
    g = addFlowNode(g, 'agent')
    g = addFlowNode(g, 'run')
    const agent = g.nodes.find((n) => n.kind === 'agent')!
    const script = g.nodes.find((n) => n.kind === 'run')!
    g = connectFlowNodes(g, FLOW_START_ID, agent.id)
    const { files } = compileFlow(g, META)
    expect(files['run.ts']).toContain(JSON.stringify(agent.id))
    expect(files['run.ts']).not.toContain(JSON.stringify(script.id))
  })

  it('marks script stubs create-only', () => {
    let g = emptyFlowGraph()
    g = addFlowNode(g, 'run')
    const script = g.nodes.find((n) => n.kind === 'run')!
    g = connectFlowNodes(g, FLOW_START_ID, script.id)
    const { createOnly } = compileFlow(g, META)
    expect(createOnly).toContain(script.scriptPath)
  })

  it('rejects a gate as a parallel branch', () => {
    let g = emptyFlowGraph()
    g = addFlowNode(g, 'parallel')
    g = addFlowNode(g, 'agent')
    const par = g.nodes.find((n) => n.kind === 'parallel')!
    const agent = g.nodes.find((n) => n.kind === 'agent')!
    g = connectFlowNodes(g, FLOW_START_ID, par.id)
    g = { ...g, edges: [...g.edges, { id: `${par.id}→${agent.id}`, from: par.id, to: agent.id }] }
    // Force a human kid past canConnect for the compiler path.
    g = addFlowNode(g, 'human')
    const gate = g.nodes.find((n) => n.kind === 'human')!
    g = {
      ...g,
      edges: [...g.edges, { id: `${par.id}→${gate.id}`, from: par.id, to: gate.id }],
    }
    expect(() => compileFlow(g, META)).toThrow(FlowCompileError)
  })

  it('emits declared output fields in step.done', () => {
    let g = emptyFlowGraph()
    g = addFlowNode(g, 'done')
    const done = g.nodes.find((n) => n.kind === 'done')!
    g = connectFlowNodes(g, FLOW_START_ID, done.id)
    const { files } = compileFlow(g, {
      ...META,
      output: [{ name: 'verdict', type: 'string', required: true }],
    })
    expect(files['run.ts']).toContain('"verdict"')
    expect(files['run.ts']).not.toContain('"result": true')
  })

  it('parses emitted workflow.yaml and rejects duplicate agent files', () => {
    let g = emptyFlowGraph()
    g = addFlowNode(g, 'agent')
    const a = g.nodes.find((n) => n.kind === 'agent')!
    g = connectFlowNodes(g, FLOW_START_ID, a.id)
    const { files } = compileFlow(g, META)
    const doc = parseYaml(files['workflow.yaml']!) as { outline: { id: string }[] }
    expect(doc.outline.some((s) => s.id === a.id)).toBe(true)
    g = addFlowNode(g, 'agent')
    const b = g.nodes.find((n) => n.kind === 'agent' && n.id !== a.id)!
    g = {
      ...g,
      nodes: g.nodes.map((n) => (n.id === b.id ? { ...n, agentName: a.agentName } : n)),
      edges: [...g.edges, { id: `${a.id}→${b.id}`, from: a.id, to: b.id }],
    }
    expect(() => compileFlow(g, META)).toThrow(FlowCompileError)
  })

  it('compiles parallel join onto done without emitting kids twice', () => {
    let g = emptyFlowGraph()
    g = addFlowNode(g, 'parallel')
    g = addFlowNode(g, 'agent')
    g = addFlowNode(g, 'run')
    g = addFlowNode(g, 'done')
    const par = g.nodes.find((n) => n.kind === 'parallel')!
    const a = g.nodes.find((n) => n.kind === 'agent')!
    const s = g.nodes.find((n) => n.kind === 'run')!
    const d = g.nodes.find((n) => n.kind === 'done')!
    g = connectFlowNodes(g, FLOW_START_ID, par.id)
    g = connectFlowNodes(g, par.id, a.id)
    g = connectFlowNodes(g, par.id, s.id)
    g = connectFlowNodes(g, a.id, d.id)
    g = connectFlowNodes(g, s.id, d.id)
    const { files } = compileFlow(g, META)
    const run = files['run.ts']!
    expect(run.match(/step\.agent/g)?.length).toBe(1)
    expect(run.match(/step\.run/g)?.length).toBe(1)
    expect(run.match(/step\.done/g)?.length).toBe(1)
    expect(run.indexOf('step.parallel')).toBeLessThan(run.indexOf('step.done'))
  })

  it('rejects malformed flows.json coordinates', () => {
    expect(() =>
      parseFlowsFile(JSON.stringify({ nodes: [{ id: 'start', kind: 'start', label: 'Start' }], edges: [] })),
    ).toThrow(/node\.x/)
  })
})
