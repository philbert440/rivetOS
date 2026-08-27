import { describe, expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'
import {
  addFlowNode,
  connectFlowNodes,
  emptyFlowGraph,
  FLOW_START_ID,
  updateFlowNode,
  type FlowAuthorGraph,
  type FlowAuthorNode,
} from './flow-graph.js'
import {
  compileFlow,
  FlowCompileError,
  ownedPathsFromFlowsFile,
  parseFlowsFile,
  pathsToPrune,
  RUN_TS_MARKER,
  yamlScalar,
} from './flow-compile.js'

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
    const lines = files['run.ts']!.split('\n')
    const agentLine = lines.find((l) => l.includes('step.agent'))
    const promptLine = lines.find((l) => l.includes('prompt:'))
    expect(agentLine && promptLine).toBeTruthy()
    expect(promptLine!.match(/^ */)?.[0].length).toBeGreaterThan(agentLine!.match(/^ */)?.[0].length)
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

  it('emits authored agent prompt content in run.ts and the agent file', () => {
    let g = emptyFlowGraph()
    g = addFlowNode(g, 'agent')
    const agent = g.nodes.find((n) => n.kind === 'agent')!
    g = updateFlowNode(g, agent.id, { prompt: 'Review the PR and return findings.' })
    g = connectFlowNodes(g, FLOW_START_ID, agent.id)
    const { files } = compileFlow(g, META)
    expect(files['run.ts']).toContain('Review the PR and return findings.')
    expect(files['run.ts']).not.toContain(`prompt: ${JSON.stringify(agent.label)}`)
    const md = Object.entries(files).find(([p]) => p.startsWith('agents/') && p.endsWith('.md'))?.[1]
    expect(md).toContain('Review the PR and return findings.')
  })

  it('threads step results into step.done via the outputs record', () => {
    let g = emptyFlowGraph()
    g = addFlowNode(g, 'agent')
    g = addFlowNode(g, 'done')
    const agent = g.nodes.find((n) => n.kind === 'agent')!
    const done = g.nodes.find((n) => n.kind === 'done')!
    g = connectFlowNodes(g, FLOW_START_ID, agent.id)
    g = connectFlowNodes(g, agent.id, done.id)
    const { files } = compileFlow(g, META)
    const run = files['run.ts']!
    expect(run).toContain('__rivetOutputs')
    expect(run).toContain('Object.assign(__rivetOutputs')
    expect(run).toContain('__rivetOutputs["result"]')
    expect(run).not.toContain('ctx.input["result"]')
  })

  it('keeps compiling reachable nodes that sort after done', () => {
    let g = emptyFlowGraph()
    g = addFlowNode(g, 'agent')
    g = addFlowNode(g, 'run')
    g = addFlowNode(g, 'done')
    const a = g.nodes.find((n) => n.kind === 'agent')!
    const b = g.nodes.find((n) => n.kind === 'run')!
    const d = g.nodes.find((n) => n.kind === 'done')!
    g = connectFlowNodes(g, FLOW_START_ID, a.id)
    g = connectFlowNodes(g, a.id, d.id)
    g = connectFlowNodes(g, a.id, b.id)
    const { files } = compileFlow(g, META)
    const run = files['run.ts']!
    expect(run).toContain(JSON.stringify(b.id))
    expect(run).toContain('step.run')
    expect(run.match(/step\.done/g)?.length).toBe(1)
    expect(run.indexOf(JSON.stringify(b.id))).toBeLessThan(run.lastIndexOf('step.done'))
  })

  it('rejects unsafe scriptPath and agentName', () => {
    let g = emptyFlowGraph()
    g = addFlowNode(g, 'run')
    const script = g.nodes.find((n) => n.kind === 'run')!
    g = connectFlowNodes(g, FLOW_START_ID, script.id)
    g = updateFlowNode(g, script.id, { scriptPath: '../other-def/x.sh' })
    expect(() => compileFlow(g, META)).toThrow(FlowCompileError)
    g = updateFlowNode(g, script.id, { scriptPath: 'run.ts' })
    expect(() => compileFlow(g, META)).toThrow(FlowCompileError)

    let ag = emptyFlowGraph()
    ag = addFlowNode(ag, 'agent')
    const agent = ag.nodes.find((n) => n.kind === 'agent')!
    ag = connectFlowNodes(ag, FLOW_START_ID, agent.id)
    ag = updateFlowNode(ag, agent.id, { agentName: '../secret' })
    expect(() => compileFlow(ag, META)).toThrow(FlowCompileError)
  })

  it('rejects empty or unknown callRef', () => {
    let g = emptyFlowGraph()
    g = addFlowNode(g, 'call')
    const call = g.nodes.find((n) => n.kind === 'call')!
    g = connectFlowNodes(g, FLOW_START_ID, call.id)
    expect(() => compileFlow(g, META)).toThrow(/empty workflow id/)
    g = updateFlowNode(g, call.id, { callRef: 'other' })
    expect(() => compileFlow(g, { ...META, knownWorkflowIds: ['demo'] })).toThrow(/unknown workflow/)
    const { files } = compileFlow(g, { ...META, knownWorkflowIds: ['other'] })
    expect(files['run.ts']).toContain('step.call')
    expect(files['run.ts']).toContain('"other"')
  })

  it('rejects duplicate ids, missing start, cycles, ident collisions, duplicate scriptPath', () => {
    const base = (nodes: FlowAuthorNode[], edges: FlowAuthorGraph['edges']): FlowAuthorGraph => ({
      nodes,
      edges,
    })
    const start: FlowAuthorNode = { id: FLOW_START_ID, kind: 'start', label: 'Start', x: 0, y: 0 }
    expect(() =>
      compileFlow(
        base([{ id: 'x', kind: 'agent', label: 'X', x: 0, y: 0, agentName: 'x' }], []),
        META,
      ),
    ).toThrow(/missing a start node/)
    expect(() =>
      compileFlow(base([start, { ...start, kind: 'agent', agentName: 'dup' }], []), META),
    ).toThrow(/duplicate node id/)

    const a: FlowAuthorNode = { id: 'a', kind: 'agent', label: 'A', x: 0, y: 0, agentName: 'aa' }
    const b: FlowAuthorNode = { id: 'b', kind: 'agent', label: 'B', x: 0, y: 0, agentName: 'bb' }
    expect(() =>
      compileFlow(
        base([start, a, b], [
          { id: 'start→a', from: FLOW_START_ID, to: 'a' },
          { id: 'a→b', from: 'a', to: 'b' },
          { id: 'b→a', from: 'b', to: 'a' },
        ]),
        META,
      ),
    ).toThrow(/cycle/)

    const hyphen: FlowAuthorNode = {
      id: 'a-b',
      kind: 'agent',
      label: 'Hy',
      x: 0,
      y: 0,
      agentName: 'hy',
    }
    const under: FlowAuthorNode = {
      id: 'a_b',
      kind: 'agent',
      label: 'Un',
      x: 0,
      y: 0,
      agentName: 'un',
    }
    expect(() =>
      compileFlow(
        base([start, hyphen, under], [
          { id: 's1', from: FLOW_START_ID, to: 'a-b' },
          { id: 's2', from: FLOW_START_ID, to: 'a_b' },
        ]),
        META,
      ),
    ).toThrow(/ident collision/)

    const r1: FlowAuthorNode = {
      id: 'r1',
      kind: 'run',
      label: 'R1',
      x: 0,
      y: 0,
      scriptPath: 'scripts/shared.sh',
    }
    const r2: FlowAuthorNode = {
      id: 'r2',
      kind: 'run',
      label: 'R2',
      x: 0,
      y: 0,
      scriptPath: 'scripts/shared.sh',
    }
    expect(() =>
      compileFlow(
        base([start, r1, r2], [
          { id: 's1', from: FLOW_START_ID, to: 'r1' },
          { id: 's2', from: FLOW_START_ID, to: 'r2' },
        ]),
        META,
      ),
    ).toThrow(/duplicate scriptPath/)
  })

  it('records owned agent/script paths in flows.json', () => {
    let g = emptyFlowGraph()
    g = addFlowNode(g, 'agent')
    g = addFlowNode(g, 'run')
    const agent = g.nodes.find((n) => n.kind === 'agent')!
    const script = g.nodes.find((n) => n.kind === 'run')!
    g = connectFlowNodes(g, FLOW_START_ID, agent.id)
    g = connectFlowNodes(g, agent.id, script.id)
    const { files, owned } = compileFlow(g, META)
    const doc = JSON.parse(files['flows.json']!) as { owned: string[] }
    expect(doc.owned).toEqual(owned)
    expect(owned.some((p) => p.startsWith('agents/'))).toBe(true)
    expect(owned).toContain(script.scriptPath)
  })

  it('quotes YAML scalars that would round-trip as numbers or dates', () => {
    expect(yamlScalar('3.14')).toBe('"3.14"')
    expect(yamlScalar('1e5')).toBe('"1e5"')
    expect(yamlScalar('2026-08-27')).toBe('"2026-08-27"')
    expect(yamlScalar('.inf')).toBe('".inf"')
    expect(yamlScalar('hello-world')).toBe('hello-world')
    let g = emptyFlowGraph()
    g = addFlowNode(g, 'agent')
    const agent = g.nodes.find((n) => n.kind === 'agent')!
    g = updateFlowNode(g, agent.id, { label: '3.14' })
    g = connectFlowNodes(g, FLOW_START_ID, agent.id)
    const { files } = compileFlow(g, META)
    expect(files['workflow.yaml']).toContain('label: "3.14"')
  })

  it('parseFlowsFile copies optional fields with typeof/Array guards', () => {
    const g = parseFlowsFile(
      JSON.stringify({
        nodes: [
          {
            id: 'start',
            kind: 'start',
            label: 'Start',
            x: 1,
            y: 2,
            extra: 'drop-me',
          },
          {
            id: 'n1',
            kind: 'agent',
            label: 'A',
            x: 3,
            y: 4,
            agentName: 'reviewer',
            prompt: 'Be thorough.',
            model: 'grok',
            maxTurns: 4,
            tools: ['web'],
            agentNameBad: 1,
          },
        ],
        edges: [{ id: 'start→n1', from: 'start', to: 'n1' }],
      }),
    )
    expect(g.nodes).toHaveLength(2)
    expect(g.nodes[1]).toMatchObject({
      id: 'n1',
      kind: 'agent',
      agentName: 'reviewer',
      prompt: 'Be thorough.',
      model: 'grok',
      maxTurns: 4,
      tools: ['web'],
    })
    expect(g.nodes[0]).not.toHaveProperty('extra')
    expect(() =>
      parseFlowsFile(
        JSON.stringify({
          nodes: [
            { id: 'start', kind: 'start', label: 'Start', x: 0, y: 0 },
            { id: 'start', kind: 'agent', label: 'Dup', x: 1, y: 1 },
          ],
          edges: [],
        }),
      ),
    ).toThrow(/duplicate node id/)
    expect(() =>
      parseFlowsFile(
        JSON.stringify({
          nodes: [{ id: 'start', kind: 'start', label: 'Start', x: 0, y: 0 }],
          edges: [{ id: 'start→missing', from: 'start', to: 'missing' }],
        }),
      ),
    ).toThrow(/dangling edge/)
  })
})

describe('owned path prune', () => {
  it('prunes only previously owned paths missing from the next compile', () => {
    expect(pathsToPrune(['agents/old.md', 'scripts/n1.sh'], ['scripts/n1.sh'])).toEqual([
      'agents/old.md',
    ])
    expect(pathsToPrune(undefined, ['agents/a.md'])).toEqual([])
  })

  it('reads owned from flows.json or derives it from nodes', () => {
    expect(
      ownedPathsFromFlowsFile(
        JSON.stringify({ version: 1, nodes: [], edges: [], owned: ['agents/a.md', 'notes.txt'] }),
      ),
    ).toEqual(['agents/a.md'])
    expect(
      ownedPathsFromFlowsFile(
        JSON.stringify({
          nodes: [
            { id: 'start', kind: 'start', label: 'Start' },
            { id: 'n1', kind: 'agent', label: 'Reviewer', agentName: 'reviewer' },
            { id: 'n2', kind: 'run', label: 'Load', scriptPath: 'scripts/load.sh' },
          ],
          edges: [],
        }),
      ),
    ).toEqual(['agents/reviewer.md', 'scripts/load.sh'])
  })
})
