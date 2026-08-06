/**
 * workflow_start / workflow_status — allowlist + detached start.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  WorkflowEngine,
  MockExecutorRegistry,
  type RunScript,
} from '@rivetos/workflows'
import { createWorkflowTools, isWorkflowAllowed } from './workflow-tools.js'

describe('isWorkflowAllowed', () => {
  it('fails closed when allowlist empty or absent', () => {
    expect(isWorkflowAllowed('change', undefined)).toBe(false)
    expect(isWorkflowAllowed('change', [])).toBe(false)
  })

  it('allows exact ids and *', () => {
    expect(isWorkflowAllowed('change', ['pr-review', 'change'])).toBe(true)
    expect(isWorkflowAllowed('other', ['pr-review', 'change'])).toBe(false)
    expect(isWorkflowAllowed('anything', ['*'])).toBe(true)
  })
})

describe('createWorkflowTools', () => {
  let caseRoot: string
  let defsRoot: string
  const cleanups: Array<() => Promise<void> | void> = []

  beforeEach(async () => {
    const root = await mkdtemp(join(tmpdir(), 'wf-tools-'))
    caseRoot = join(root, 'runs')
    defsRoot = join(root, 'defs')
    await mkdir(caseRoot, { recursive: true })
    await mkdir(join(defsRoot, 'demo'), { recursive: true })
    await writeFile(
      join(defsRoot, 'demo', 'workflow.yaml'),
      `id: demo
version: "1.0.0"
name: Demo
input:
  - name: message
    type: string
    required: true
output:
  - name: result
    type: string
    required: false
`,
      'utf-8',
    )
    await writeFile(
      join(defsRoot, 'demo', 'run.ts'),
      'export default async function run() {}',
      'utf-8',
    )
  })

  afterEach(async () => {
    for (const fn of cleanups.splice(0)) await fn()
  })

  it('workflow_start rejects when not allowlisted', async () => {
    const engine = new WorkflowEngine({
      caseDirRoot: caseRoot,
      workflowsRoots: [defsRoot],
      executors: new MockExecutorRegistry(),
    })
    const [start] = createWorkflowTools({
      engine,
      caseDirRoot: caseRoot,
      workflowsRoots: [defsRoot],
      agentAllowlist: ['pr-review'],
    })
    const raw = await start.execute(
      { workflow: 'demo', input: { message: 'hi' } },
      undefined,
      { agentId: 'rivet' },
    )
    const body = JSON.parse(String(raw)) as { error?: string }
    expect(body.error).toMatch(/not on the agent allowlist/)
  })

  it('workflow_start detached + workflow_status after completion', async () => {
    const script: RunScript = async (step, ctx) => {
      await step.done({ result: `echo:${String(ctx.input.message)}` })
    }
    // Engine loads run.ts from disk — inject via workflowDirs + override by
    // wrapping startRun is awkward; use a real script that finishes fast via
    // MockExecutorRegistry with runScript through a thin subclass.
    const engine = new WorkflowEngine({
      caseDirRoot: caseRoot,
      workflowsRoots: [defsRoot],
      executors: new MockExecutorRegistry(),
    })
    // Patch startRun to always pass runScript for the demo workflow.
    const orig = engine.startRun.bind(engine)
    engine.startRun = async (ref, input, startedBy, options = {}) =>
      orig(ref, input, startedBy, { ...options, runScript: script })

    const tools = createWorkflowTools({
      engine,
      caseDirRoot: caseRoot,
      workflowsRoots: [defsRoot],
      agentAllowlist: ['*'],
    })
    const start = tools.find((t) => t.name === 'workflow_start')!
    const status = tools.find((t) => t.name === 'workflow_status')!

    const startedRaw = await start.execute(
      { workflow: 'demo', input: { message: 'hi' } },
      undefined,
      { agentId: 'opus' },
    )
    const started = JSON.parse(String(startedRaw)) as {
      runId: string
      status: string
      suspended: boolean
    }
    expect(started.runId).toBeTruthy()
    expect(started.status).toBe('running')
    expect(started.suspended).toBe(false)

    // Poll until done (detached race)
    let final: { status: string; output?: { result?: string } } | null = null
    for (let i = 0; i < 50; i++) {
      await new Promise((r) => setTimeout(r, 20))
      const st = JSON.parse(
        String(await status.execute({ runId: started.runId })),
      ) as { status: string; output?: { result?: string }; error?: string }
      if (st.error && st.error.includes('not found')) continue
      if (st.status === 'done' || st.status === 'failed') {
        final = st
        break
      }
    }
    expect(final?.status).toBe('done')
    expect(final?.output?.result).toBe('echo:hi')
  })

  it('empty allowlist message mentions config path', async () => {
    const engine = new WorkflowEngine({
      caseDirRoot: caseRoot,
      workflowsRoots: [defsRoot],
      executors: new MockExecutorRegistry(),
    })
    const [start] = createWorkflowTools({
      engine,
      caseDirRoot: caseRoot,
      workflowsRoots: [defsRoot],
      // absent allowlist
    })
    const raw = await start.execute({ workflow: 'demo', input: { message: 'x' } })
    const body = JSON.parse(String(raw)) as { hint?: string }
    expect(body.hint).toMatch(/config\.workflows\.agent_allowlist/)
  })
})

describe('workflow_start pre-validation', () => {
  it('rejects unknown workflows and contract violations before detaching', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wf-tools-val-'))
    const caseRoot2 = join(root, 'runs')
    const defsRoot2 = join(root, 'defs')
    await mkdir(join(defsRoot2, 'demo'), { recursive: true })
    await writeFile(
      join(defsRoot2, 'demo', 'workflow.yaml'),
      'id: demo\nversion: "1.0.0"\nname: Demo\ninput:\n  - name: message\n    type: string\noutput: []\n',
      'utf-8',
    )
    await writeFile(join(defsRoot2, 'demo', 'run.ts'), 'export default async function run() {}', 'utf-8')
    const engine = new WorkflowEngine({
      caseDirRoot: caseRoot2,
      workflowsRoots: [defsRoot2],
      executors: new MockExecutorRegistry(),
    })
    const [start] = createWorkflowTools({
      engine,
      caseDirRoot: caseRoot2,
      workflowsRoots: [defsRoot2],
      agentAllowlist: ['*'],
    })

    const missing = JSON.parse(
      String(await start.execute({ workflow: 'nope', input: {} })),
    ) as { error?: string }
    expect(missing.error).toMatch(/not found/)

    const invalid = JSON.parse(
      String(await start.execute({ workflow: 'demo', input: {} })),
    ) as { error?: string; issues?: Array<{ field: string }> }
    expect(invalid.issues?.some((i) => i.field === 'message')).toBe(true)
  })
})

describe('workflow_start guards', () => {
  it('rejects gated:false from agents and path-shaped runIds', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wf-tools-guard-'))
    const caseRoot3 = join(root, 'runs')
    const defsRoot3 = join(root, 'defs')
    await mkdir(join(defsRoot3, 'demo'), { recursive: true })
    await writeFile(
      join(defsRoot3, 'demo', 'workflow.yaml'),
      'id: demo\nversion: "1.0.0"\nname: Demo\ninput:\n  - name: message\n    type: string\noutput: []\n',
      'utf-8',
    )
    await writeFile(join(defsRoot3, 'demo', 'run.ts'), 'export default async function run() {}', 'utf-8')
    const engine = new WorkflowEngine({
      caseDirRoot: caseRoot3,
      workflowsRoots: [defsRoot3],
      executors: new MockExecutorRegistry(),
    })
    const tools = createWorkflowTools({
      engine,
      caseDirRoot: caseRoot3,
      workflowsRoots: [defsRoot3],
      agentAllowlist: ['*'],
    })
    const start = tools.find((t) => t.name === 'workflow_start')!
    const status = tools.find((t) => t.name === 'workflow_status')!

    const gated = JSON.parse(
      String(await start.execute({ workflow: 'demo', input: { message: 'x', gated: false } })),
    ) as { error?: string }
    expect(gated.error).toMatch(/ungated/)

    const escape = JSON.parse(
      String(await status.execute({ runId: '/etc' })),
    ) as { error?: string }
    expect(escape.error).toMatch(/bare run id/)
    const dots = JSON.parse(
      String(await status.execute({ runId: '../other' })),
    ) as { error?: string }
    expect(dots.error).toMatch(/bare run id/)
  })
})
