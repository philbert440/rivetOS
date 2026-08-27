import { describe, expect, it } from 'vitest'
import { addFlowNode, connectFlowNodes, emptyFlowGraph, FLOW_START_ID } from './flow-graph.js'
import { compileFlow, RUN_TS_MARKER } from './flow-compile.js'

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
})
