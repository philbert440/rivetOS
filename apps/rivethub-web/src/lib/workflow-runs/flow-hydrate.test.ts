import { describe, expect, it } from 'vitest'
import { disconnectFlowEdge, FLOW_START_ID } from './flow-graph.js'
import {
  applyAgentFile,
  applyRunTsBindings,
  authorGraphFromOutline,
  stepBindingsFromRunTs,
} from './flow-hydrate.js'
import { RUN_TS_MARKER } from './flow-compile.js'

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

// Shape of workflows/hello-world/run.ts: the agent step's label differs from
// its agent file, and its options hold a multi-line templated prompt.
const HELLO_RUN_TS = `
  await step.run('prepare', {
    script: 'scripts/prepare.sh',
    in: { name },
  })
  const result = await step.agent('greet', {
    agent: 'greeter',
    prompt: ['Compose a greeting', \`for \${name}\`].join('\\n'),
    out: ['greeting'],
  })
  await step.human('approve-gate', { prompt: 'Approve?', fields: ['approved'] })
`

describe('stepBindingsFromRunTs', () => {
  it('maps step labels to the agent file and script run.ts uses', () => {
    const b = stepBindingsFromRunTs(HELLO_RUN_TS)
    expect(b.get('greet')).toEqual({ agent: 'greeter' })
    expect(b.get('prepare')).toEqual({ script: 'scripts/prepare.sh' })
    expect(b.has('approve-gate')).toBe(false)
  })

  it("does not borrow a later step's agent for a step that names none", () => {
    const b = stepBindingsFromRunTs(
      "await step.agent('a', { prompt: 'x' })\nawait step.agent('b', { agent: 'bee' })",
    )
    expect(b.has('a')).toBe(false)
    expect(b.get('b')).toEqual({ agent: 'bee' })
  })
})

describe('applyRunTsBindings', () => {
  it('replaces the outline guess with the real agent and script', () => {
    const g = applyRunTsBindings(
      authorGraphFromOutline([
        { id: 'prepare', label: 'Prepare', kind: 'run' },
        { id: 'greet', label: 'Greet', kind: 'agent' },
      ]),
      stepBindingsFromRunTs(HELLO_RUN_TS),
    )
    expect(g.nodes.find((n) => n.id === 'greet')?.agentName).toBe('greeter')
    expect(g.nodes.find((n) => n.id === 'prepare')?.scriptPath).toBe('scripts/prepare.sh')
  })
})

describe('applyAgentFile', () => {
  const node = { id: 'greet', kind: 'agent' as const, label: 'Greet', x: 0, y: 0 }

  it('fills instructions and frontmatter fields from the agent file', () => {
    const n = applyAgentFile(
      node,
      '---\nmaxTurns: 5\nmodel: opus\ntools: [read]\n---\n\n# Greeter\n\nBe friendly.\n',
    )
    expect(n.prompt).toBe('# Greeter\n\nBe friendly.')
    expect(n.maxTurns).toBe(5)
    expect(n.model).toBe('opus')
    expect(n.tools).toEqual(['read'])
  })

  it('drops the generated marker from canvas-written agent bodies', () => {
    const n = applyAgentFile(node, `---\ntools: []\n---\n\n<!-- ${RUN_TS_MARKER} -->\n\nHi.\n`)
    expect(n.prompt).toBe('Hi.')
  })

  it('leaves the node unchanged when frontmatter is malformed', () => {
    expect(applyAgentFile(node, '---\nmaxTurns: 5\nno closing fence')).toEqual(node)
  })
})
