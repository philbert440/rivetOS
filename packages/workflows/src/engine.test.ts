/**
 * Fixture tests for journal-replay engine, contracts, gates, loops, children, undeclared writes.
 * Uses temp dirs only — never writes under /rivet-shared.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtemp, mkdir, writeFile, readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { WorkflowEngine, type RunScript } from './engine.js'
import { MockExecutorRegistry } from './executors.js'
import { loadWorkflowDir } from './loader.js'
import { appendJournal, findCachedStepResult, readJournal } from './journal.js'
import { readCase, updateRun } from './case.js'
import { ContractValidationError, UnknownCallNamespaceError } from './errors.js'
import { parseManifest, validateStartInput } from './manifest.js'
import { checkRunScriptDeterminism } from './determinism.js'
import { scaffoldWorkflow } from './scaffold.js'
import { makeStepId } from './types.js'
import { parseCallRef, createCallRegistry } from './registry.js'

async function writeMinimalWorkflow(
  dir: string,
  opts?: { id?: string; yaml?: string },
): Promise<string> {
  const id = opts?.id ?? 'test-wf'
  await mkdir(join(dir, 'agents'), { recursive: true })
  await writeFile(
    join(dir, 'workflow.yaml'),
    opts?.yaml ??
      `id: ${id}
version: "1.0.0"
name: Test
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
  await writeFile(join(dir, 'run.ts'), 'export default async function run() {}', 'utf-8')
  await writeFile(join(dir, 'agents', 'example.md'), '---\ntools: []\n---\n\n# hi\n', 'utf-8')
  return dir
}

describe('manifest + contract validation', () => {
  it('parses workflow.yaml fields', () => {
    const m = parseManifest({
      id: 'x',
      version: '1',
      name: 'X',
      input: [{ name: 'a', type: 'string', required: true }],
      output: [{ name: 'b', type: 'number' }],
      budgets: { maxTokens: 10 },
    })
    expect(m.id).toBe('x')
    expect(m.input[0].name).toBe('a')
    expect(m.budgets?.maxTokens).toBe(10)
  })

  it('rejects missing required fields with structured issues', () => {
    const fields = [
      { name: 'message', type: 'string' as const, required: true },
      { name: 'count', type: 'number' as const, required: true },
    ]
    try {
      validateStartInput(fields, { message: 'hi' })
      expect.unreachable('should throw')
    } catch (e) {
      expect(e).toBeInstanceOf(ContractValidationError)
      const err = e as ContractValidationError
      expect(err.issues).toHaveLength(1)
      expect(err.issues[0].field).toBe('count')
      expect(err.issues[0].reason).toBe('missing')
    }
  })

  it('startRun rejects missing fields before creating work', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wf-contract-'))
    const wfDir = await writeMinimalWorkflow(join(root, 'wf'))
    const workflow = await loadWorkflowDir(wfDir)
    const engine = new WorkflowEngine({
      caseDirRoot: join(root, 'runs'),
      executors: new MockExecutorRegistry(),
      workflowDirs: { [workflow.manifest.id]: wfDir },
    })
    await expect(
      engine.startRun(
        workflow.manifest.id,
        {},
        { type: 'human' },
        { workflow, runScript: async () => {} },
      ),
    ).rejects.toBeInstanceOf(ContractValidationError)
  })
})

describe('journal-replay', () => {
  let root: string
  let wfDir: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'wf-replay-'))
    wfDir = await writeMinimalWorkflow(join(root, 'wf'))
  })

  it('skips executed steps on replay (agent not re-run after resume)', async () => {
    const workflow = await loadWorkflowDir(wfDir)
    let agentLiveCalls = 0
    const executors = new MockExecutorRegistry({
      agent: async () => {
        agentLiveCalls++
        return { result: `live-${agentLiveCalls}` }
      },
    })
    const engine = new WorkflowEngine({
      caseDirRoot: join(root, 'runs'),
      executors,
      workflowDirs: { [workflow.manifest.id]: wfDir },
    })

    const script: RunScript = async (step) => {
      const a = await step.agent('work', { out: ['result'] })
      await step.human('gate', { fields: ['ok'], prompt: 'go?' })
      await step.done({ result: a.result })
    }

    const started = await engine.startRun(
      workflow.manifest.id,
      { message: 'hi' },
      { type: 'human' },
      { runScript: script, workflow, runId: 'replay-1' },
    )
    expect(started.suspended).toBe(true)
    expect(agentLiveCalls).toBe(1)

    const resumed = await engine.resumeRun('replay-1', {
      gateResponse: { ok: true },
      runScript: script,
      workflow,
    })
    expect(resumed.suspended).toBe(false)
    expect(resumed.run.status).toBe('done')
    // Agent must NOT run again on resume — journal replay
    expect(agentLiveCalls).toBe(1)
    expect(resumed.run.output?.result).toBe('live-1')

    const journal = await readJournal(started.caseDir)
    const finished = journal.filter((e) => e.type === 'step_finished' && e.label === 'work')
    expect(finished).toHaveLength(1)
  })

  it('gate suspension + resume continues past the gate', async () => {
    const workflow = await loadWorkflowDir(wfDir)
    const engine = new WorkflowEngine({
      caseDirRoot: join(root, 'runs'),
      executors: new MockExecutorRegistry({
        run: async () => ({ loaded: true }),
      }),
      workflowDirs: { [workflow.manifest.id]: wfDir },
    })

    const script: RunScript = async (step) => {
      await step.run('load', { script: 'noop' })
      const g = await step.human('review-gate', {
        prompt: 'Approve?',
        fields: ['approved'],
      })
      await step.done({ approved: g.approved })
    }

    const started = await engine.startRun(
      workflow.manifest.id,
      { message: 'x' },
      { type: 'human' },
      { runScript: script, workflow },
    )
    expect(started.suspended).toBe(true)
    expect(started.run.status).toBe('paused_human')
    expect(started.suspension?.label).toBe('review-gate')

    const journal = await readJournal(started.caseDir)
    expect(journal.some((e) => e.type === 'gate_opened')).toBe(true)

    const resumed = await engine.resumeRun(started.run.id, {
      gateResponse: { approved: true },
      runScript: script,
      workflow,
    })
    expect(resumed.suspended).toBe(false)
    expect(resumed.run.status).toBe('done')
    expect(resumed.run.output?.approved).toBe(true)

    const j2 = await readJournal(started.caseDir)
    expect(j2.some((e) => e.type === 'gate_resolved')).toBe(true)
    expect(j2.some((e) => e.type === 'run_finished' && e.status === 'done')).toBe(true)
  })

  it('loop iterations get distinct seq ids', async () => {
    const workflow = await loadWorkflowDir(wfDir)
    const seqs: number[] = []
    const engine = new WorkflowEngine({
      caseDirRoot: join(root, 'runs'),
      executors: new MockExecutorRegistry({
        agent: async (opts) => {
          const seq = Number(opts.stepId.split('#')[1])
          seqs.push(seq)
          return { result: seq }
        },
      }),
      workflowDirs: { [workflow.manifest.id]: wfDir },
    })

    const script: RunScript = async (step) => {
      for (let i = 0; i < 3; i++) {
        await step.agent('loop-body', { out: ['result'] })
      }
      await step.done({ result: 'ok' })
    }

    const result = await engine.startRun(
      workflow.manifest.id,
      { message: 'x' },
      { type: 'human' },
      { runScript: script, workflow },
    )
    expect(result.run.status).toBe('done')
    expect(seqs).toEqual([1, 2, 3])
    expect(makeStepId('loop-body', 2)).toBe('loop-body#2')

    const journal = await readJournal(result.caseDir)
    const started = journal.filter(
      (e) => e.type === 'step_started' && e.label === 'loop-body',
    )
    expect(started.map((e) => (e.type === 'step_started' ? e.seq : 0))).toEqual([1, 2, 3])
  })
})

describe('child run nesting', () => {
  it('nests child caseDir under parent via step.call', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wf-child-'))
    const parentDir = await writeMinimalWorkflow(join(root, 'parent'), { id: 'parent' })
    const childDir = await writeMinimalWorkflow(join(root, 'child'), { id: 'child' })

    // Loader prefers run.mjs over run.ts — ESM runnable without tsx.
    await writeFile(
      join(childDir, 'run.mjs'),
      `
export default async function run(step) {
  const a = await step.agent('c', { out: ['result'] });
  await step.done({ result: a.result });
}
`,
      'utf-8',
    )

    const parentWf = await loadWorkflowDir(parentDir)
    const eng = new WorkflowEngine({
      caseDirRoot: join(root, 'runs'),
      executors: new MockExecutorRegistry({
        agent: async () => ({ result: 'nested-ok' }),
      }),
      workflowDirs: { parent: parentDir, child: childDir },
    })

    const parentScript: RunScript = async (step) => {
      const out = await step.call('child-call', 'child', { message: 'from-parent' })
      await step.done({ result: out })
    }

    const started = await eng.startRun(
      'parent',
      { message: 'p' },
      { type: 'human' },
      { runScript: parentScript, workflow: parentWf },
    )

    expect(started.run.status).toBe('done')

    const entries = await readdir(started.caseDir, { withFileTypes: true })
    const childDirs = entries.filter((e) => e.isDirectory() && e.name.startsWith('child-'))
    expect(childDirs.length).toBeGreaterThanOrEqual(1)

    const nested = join(started.caseDir, childDirs[0].name)
    const childCase = await readCase(nested)
    expect(childCase.run.workflowId).toBe('child')
    expect(childCase.run.parent?.runId).toBe(started.run.id)
    expect(childCase.run.status).toBe('done')
    expect(childCase.fields.result).toBe('nested-ok')
  })

  it('child failure fails the parent call', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wf-child-fail-'))
    const parentDir = await writeMinimalWorkflow(join(root, 'parent'), { id: 'parent' })
    const childDir = await writeMinimalWorkflow(join(root, 'child'), { id: 'child' })

    await writeFile(
      join(childDir, 'run.mjs'),
      `
export default async function run(step) {
  await step.agent('boom', { out: ['result'] });
  await step.done({ result: 'unreachable' });
}
`,
      'utf-8',
    )

    const parentWf = await loadWorkflowDir(parentDir)
    const eng = new WorkflowEngine({
      caseDirRoot: join(root, 'runs'),
      executors: new MockExecutorRegistry({
        agent: async () => {
          throw new Error('child agent exploded')
        },
      }),
      workflowDirs: { parent: parentDir, child: childDir },
    })

    const parentScript: RunScript = async (step) => {
      await step.call('child-call', 'child', { message: 'x' })
      await step.done({ result: 'parent-ok' })
    }

    const started = await eng.startRun(
      'parent',
      { message: 'p' },
      { type: 'human' },
      { runScript: parentScript, workflow: parentWf },
    )

    expect(started.run.status).toBe('failed')
    expect(started.run.error).toMatch(/child agent exploded|Child workflow/)
  })
})

describe('undeclared manifest writes', () => {
  it('warns and does not merge undeclared agent fields', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wf-undecl-'))
    const wfDir = await writeMinimalWorkflow(join(root, 'wf'))
    const workflow = await loadWorkflowDir(wfDir)
    const warns: string[] = []
    const origWarn = console.warn
    console.warn = (...args: unknown[]) => {
      warns.push(String(args[0]))
    }

    try {
      const engine = new WorkflowEngine({
        caseDirRoot: join(root, 'runs'),
        executors: new MockExecutorRegistry({
          agent: async () => ({
            result: 'declared',
            secretStuff: 'nope',
            extra: 1,
          }),
        }),
        workflowDirs: { [workflow.manifest.id]: wfDir },
      })

      const script: RunScript = async (step) => {
        const a = await step.agent('a', { out: ['result'] })
        await step.done({ result: a.result })
      }

      const started = await engine.startRun(
        workflow.manifest.id,
        { message: 'x' },
        { type: 'human' },
        { runScript: script, workflow },
      )
      expect(started.run.status).toBe('done')

      const st = await readCase(started.caseDir)
      expect(st.fields.result).toBe('declared')
      expect(st.fields.secretStuff).toBeUndefined()
      expect(st.fields.extra).toBeUndefined()

      const journal = await readJournal(started.caseDir)
      const mw = journal.filter((e) => e.type === 'manifest_warn')
      expect(mw.length).toBe(1)
      if (mw[0].type === 'manifest_warn') {
        expect(mw[0].undeclared.sort()).toEqual(['extra', 'secretStuff'])
      }
      expect(warns.some((w) => w.includes('undeclared'))).toBe(true)
    } finally {
      console.warn = origWarn
    }
  })
})

describe('call registry namespaces', () => {
  it('errors on unknown namespace listing known ones', async () => {
    const reg = createCallRegistry({
      resolve: async () => ({}),
    })
    reg.register('ext', { resolve: async () => ({ ok: true }) })
    await expect(
      reg.call('other:foo', {}, {
        parentRunId: 'r',
        parentStepId: 's',
        parentCaseDir: '/tmp',
      }),
    ).rejects.toBeInstanceOf(UnknownCallNamespaceError)

    const { namespace, name } = parseCallRef('ext:deploy')
    expect(namespace).toBe('ext')
    expect(name).toBe('deploy')
    expect(parseCallRef('bare').namespace).toBe('')
  })
})

describe('determinism check', () => {
  it('flags Date.now and Math.random', () => {
    const src = `
      const t = Date.now()
      const r = Math.random()
      await step.agent('x', { out: [] })
    `
    const findings = checkRunScriptDeterminism(src)
    expect(findings.some((f) => f.rule === 'no-date-now')).toBe(true)
    expect(findings.some((f) => f.rule === 'no-math-random')).toBe(true)
  })

  it('accepts clean step-only orchestration', () => {
    const src = `
      export default async function run(step, ctx) {
        const a = await step.agent('a', { out: ['x'] })
        await step.done({ x: a.x })
      }
    `
    expect(checkRunScriptDeterminism(src)).toEqual([])
  })
})

describe('scaffold', () => {
  it('creates the workflow directory layout', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wf-scaffold-'))
    const result = await scaffoldWorkflow('demo-flow', {
      dir: root,
      fixtureTest: true,
    })
    expect(result.files).toContain('workflow.yaml')
    expect(result.files).toContain('run.ts')
    expect(result.files).toContain('agents/example.md')

    const yaml = await readFile(join(result.workflowDir, 'workflow.yaml'), 'utf-8')
    expect(yaml).toContain('id: demo-flow')
    const loaded = await loadWorkflowDir(result.workflowDir)
    expect(loaded.agents.example).toBeDefined()
    expect(loaded.manifest.input[0].name).toBe('message')
  })
})

describe('loader', () => {
  it('loads agent frontmatter config and prompt body', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wf-load-'))
    const dir = await writeMinimalWorkflow(join(root, 'wf'))
    await writeFile(
      join(dir, 'agents', 'example.md'),
      '---\ntools:\n  - shell\nmodel: test-model\nmaxTurns: 3\n---\n\nYou are the example agent.\n',
      'utf-8',
    )
    const loaded = await loadWorkflowDir(dir)
    expect(loaded.agents.example.config.model).toBe('test-model')
    expect(loaded.agents.example.config.maxTurns).toBe(3)
    expect(loaded.agents.example.config.tools).toEqual(['shell'])
    expect(loaded.agents.example.prompt).toContain('You are the example agent.')
  })
})

describe('budgets (slice F)', () => {
  it('accumulates usage and fails mid-run when maxTokens exceeded', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wf-budget-'))
    const wfDir = await writeMinimalWorkflow(join(root, 'wf'), {
      id: 'budget-wf',
      yaml: `id: budget-wf
version: "1.0.0"
name: Budget
input:
  - name: message
    type: string
output:
  - name: result
    type: string
budgets:
  maxTokens: 150
`,
    })
    const workflow = await loadWorkflowDir(wfDir)
    const engine = new WorkflowEngine({
      caseDirRoot: join(root, 'runs'),
      executors: new MockExecutorRegistry({
        agent: async (opts) => {
          opts.reportUsage?.({ tokens: 100 })
          return { result: 'ok' }
        },
      }),
      workflowDirs: { 'budget-wf': wfDir },
    })
    // step1 (100) ok; step2 (100) begins at spent=100 <= 150, finishes spent=200;
    // step3 begins at 200 > 150 → BudgetExceededError
    const script: RunScript = async (step) => {
      await step.agent('a1', { out: ['result'] })
      await step.agent('a2', { out: ['result'] })
      await step.agent('a3', { out: ['result'] })
      await step.done({ result: 'never' })
    }
    const r = await engine.startRun(
      'budget-wf',
      { message: 'x' },
      { type: 'human' },
      { runScript: script, workflow },
    )
    expect(r.run.status).toBe('failed')
    expect(r.run.error).toMatch(/Budget exceeded.*maxTokens/)
    expect(r.run.error).toMatch(/150/)
    const journal = await readJournal(r.caseDir)
    const finished = journal.filter((e) => e.type === 'step_finished' && e.kind === 'agent')
    expect(finished).toHaveLength(2)
    for (const e of finished) {
      if (e.type === 'step_finished') expect(e.usage?.tokens).toBe(100)
    }
  })

  it('resumed run keeps spent total from journaled usage', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wf-budget-resume-'))
    const wfDir = await writeMinimalWorkflow(join(root, 'wf'), {
      id: 'budget-resume',
      yaml: `id: budget-resume
version: "1.0.0"
name: BudgetResume
input:
  - name: message
    type: string
output:
  - name: result
    type: string
budgets:
  maxTokens: 150
`,
    })
    const workflow = await loadWorkflowDir(wfDir)
    let liveAgentCalls = 0
    const engine = new WorkflowEngine({
      caseDirRoot: join(root, 'runs'),
      executors: new MockExecutorRegistry({
        agent: async (opts) => {
          liveAgentCalls++
          opts.reportUsage?.({ tokens: 100 })
          return { result: `live-${liveAgentCalls}` }
        },
      }),
      workflowDirs: { 'budget-resume': wfDir },
    })
    const script: RunScript = async (step) => {
      await step.agent('pre', { out: ['result'] })
      await step.human('gate', { fields: ['ok'] })
      // On resume, pre replays (accumulates 100 from journal); this live step
      // adds another 100 → spent 200; done then fails budget check.
      await step.agent('post', { out: ['result'] })
      await step.done({ result: 'ok' })
    }
    const started = await engine.startRun(
      'budget-resume',
      { message: 'x' },
      { type: 'human' },
      { runScript: script, workflow },
    )
    expect(started.suspended).toBe(true)
    expect(liveAgentCalls).toBe(1)

    const resumed = await engine.resumeRun(started.run.id, {
      gateResponse: { ok: true },
      runScript: script,
      workflow,
    })
    // post runs live (spent becomes 200), done fails budget
    expect(resumed.run.status).toBe('failed')
    expect(resumed.run.error).toMatch(/Budget exceeded.*maxTokens/)
    expect(liveAgentCalls).toBe(2) // pre not re-run
  })

  it('maxConcurrentRuns refuses a second start; allows after terminal', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wf-conc-'))
    const wfDir = await writeMinimalWorkflow(join(root, 'wf'), {
      id: 'conc-wf',
      yaml: `id: conc-wf
version: "1.0.0"
name: Conc
input:
  - name: message
    type: string
output:
  - name: result
    type: string
budgets:
  maxConcurrentRuns: 1
`,
    })
    const workflow = await loadWorkflowDir(wfDir)
    const engine = new WorkflowEngine({
      caseDirRoot: join(root, 'runs'),
      executors: new MockExecutorRegistry(),
      workflowDirs: { 'conc-wf': wfDir },
    })
    const gateScript: RunScript = async (step) => {
      await step.human('gate', { fields: ['ok'] })
      await step.done({ result: 'done' })
    }
    const first = await engine.startRun(
      'conc-wf',
      { message: 'a' },
      { type: 'human' },
      { runScript: gateScript, workflow, runId: 'conc-1' },
    )
    expect(first.suspended).toBe(true)

    await expect(
      engine.startRun(
        'conc-wf',
        { message: 'b' },
        { type: 'human' },
        { runScript: gateScript, workflow, runId: 'conc-2' },
      ),
    ).rejects.toMatchObject({ name: 'MaxConcurrentRunsError' })

    // Finish first
    const finished = await engine.resumeRun('conc-1', {
      gateResponse: { ok: true },
      runScript: gateScript,
      workflow,
    })
    expect(finished.run.status).toBe('done')

    // Now a new start passes
    const third = await engine.startRun(
      'conc-wf',
      { message: 'c' },
      { type: 'human' },
      {
        runScript: async (step) => {
          await step.done({ result: 'ok' })
        },
        workflow,
        runId: 'conc-3',
      },
    )
    expect(third.run.status).toBe('done')
  })

  it('zero / absent budgets are unlimited', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wf-nobudget-'))
    const wfDir = await writeMinimalWorkflow(join(root, 'wf'))
    const workflow = await loadWorkflowDir(wfDir)
    expect(workflow.manifest.budgets).toBeUndefined()
    const engine = new WorkflowEngine({
      caseDirRoot: join(root, 'runs'),
      executors: new MockExecutorRegistry({
        agent: async (opts) => {
          opts.reportUsage?.({ tokens: 1_000_000, costUsd: 999 })
          return { result: 'big' }
        },
      }),
      workflowDirs: { [workflow.manifest.id]: wfDir },
    })
    const r = await engine.startRun(
      workflow.manifest.id,
      { message: 'x' },
      { type: 'human' },
      {
        runScript: async (step) => {
          await step.agent('a', { out: ['result'] })
          await step.done({ result: 'ok' })
        },
        workflow,
      },
    )
    expect(r.run.status).toBe('done')
  })
})

describe('step.parallel (slice G)', () => {
  it('runs branches concurrently and returns results in branch-index order', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wf-par-'))
    const wfDir = await writeMinimalWorkflow(join(root, 'wf'))
    const workflow = await loadWorkflowDir(wfDir)

    // Deferred resolvers so we control completion order (b1 before b0).
    type Resolver = (v: unknown) => void
    const resolvers: Resolver[] = []
    const started: string[] = []
    const executors = new MockExecutorRegistry({
      run: (opts) =>
        new Promise((resolve) => {
          started.push(opts.label)
          resolvers.push(resolve)
        }),
    })
    const engine = new WorkflowEngine({
      caseDirRoot: join(root, 'runs'),
      executors,
      workflowDirs: { [workflow.manifest.id]: wfDir },
    })

    let parallelDone: Promise<unknown[]> | undefined
    const script: RunScript = async (step) => {
      parallelDone = step.parallel('fan', [
        async (s) => {
          const r = await s.run('work', { script: 'a' })
          return { i: 0, r }
        },
        async (s) => {
          const r = await s.run('work', { script: 'b' })
          return { i: 1, r }
        },
      ])
      const results = await parallelDone
      await step.done({ result: JSON.stringify(results) })
    }

    const startPromise = engine.startRun(
      workflow.manifest.id,
      { message: 'x' },
      { type: 'human' },
      { runScript: script, workflow },
    )

    // Wait until both branches have entered their run steps
    for (let i = 0; i < 50 && resolvers.length < 2; i++) {
      await new Promise((r) => setTimeout(r, 5))
    }
    expect(resolvers.length).toBe(2)
    // Resolve out of order: branch 1 first, then branch 0
    resolvers[1]!({ from: 'b1' })
    resolvers[0]!({ from: 'b0' })

    const result = await startPromise
    expect(result.run.status).toBe('done')
    const parsed = JSON.parse(String(result.run.output?.result)) as Array<{
      i: number
      r: { from: string }
    }>
    expect(parsed).toEqual([
      { i: 0, r: { from: 'b0' } },
      { i: 1, r: { from: 'b1' } },
    ])
  })

  it('replay skips completed branch steps', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wf-par-replay-'))
    const wfDir = await writeMinimalWorkflow(join(root, 'wf'))
    const workflow = await loadWorkflowDir(wfDir)
    let liveCalls = 0
    const engine = new WorkflowEngine({
      caseDirRoot: join(root, 'runs'),
      executors: new MockExecutorRegistry({
        agent: async (opts) => {
          liveCalls++
          // Value derives from the BRANCH (label carries /b<i>:), not call
          // arrival order — so the index-order assertion below stays exact
          // even though branches race.
          const branch = /\/b(\d+):/.exec(opts.label)?.[1] ?? '?'
          return { result: `live-b${branch}` }
        },
      }),
      workflowDirs: { [workflow.manifest.id]: wfDir },
    })
    const script: RunScript = async (step) => {
      const results = await step.parallel('fan', [
        async (s) => {
          const a = await s.agent('work', { out: ['result'] })
          return a.result
        },
        async (s) => {
          const a = await s.agent('work', { out: ['result'] })
          return a.result
        },
      ])
      await step.human('gate', { fields: ['ok'] })
      await step.done({ result: results.join(',') })
    }
    const started = await engine.startRun(
      workflow.manifest.id,
      { message: 'x' },
      { type: 'human' },
      { runScript: script, workflow },
    )
    expect(started.suspended).toBe(true)
    expect(liveCalls).toBe(2)

    const resumed = await engine.resumeRun(started.run.id, {
      gateResponse: { ok: true },
      runScript: script,
      workflow,
    })
    expect(resumed.run.status).toBe('done')
    expect(liveCalls).toBe(2) // branch agents not re-run
    expect(resumed.run.output?.result).toBe('live-b0,live-b1')
  })

  it('restricts human / nested parallel / done inside branches', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wf-par-gate-'))
    const wfDir = await writeMinimalWorkflow(join(root, 'wf'))
    const workflow = await loadWorkflowDir(wfDir)
    const engine = new WorkflowEngine({
      caseDirRoot: join(root, 'runs'),
      executors: new MockExecutorRegistry(),
      workflowDirs: { [workflow.manifest.id]: wfDir },
    })

    for (const [name, branchFn] of [
      [
        'human',
        async (s: import('./step.js').Step) => {
          await s.human('g', { fields: ['x'] })
          return 1
        },
      ],
      [
        'parallel',
        async (s: import('./step.js').Step) => {
          await s.parallel('inner', [async () => 1])
          return 1
        },
      ],
      [
        'done',
        async (s: import('./step.js').Step) => {
          await s.done({ result: 'nope' })
          return 1
        },
      ],
    ] as const) {
      const script: RunScript = async (step) => {
        await step.parallel('fan', [branchFn])
        await step.done({ result: 'ok' })
      }
      const r = await engine.startRun(
        workflow.manifest.id,
        { message: 'x' },
        { type: 'human' },
        { runScript: script, workflow, runId: `restrict-${name}` },
      )
      expect(r.run.status).toBe('failed')
      if (name === 'human') expect(r.run.error).toMatch(/not allowed inside a step\.parallel branch/)
      if (name === 'parallel') expect(r.run.error).toMatch(/nested step\.parallel/)
      if (name === 'done') expect(r.run.error).toMatch(/step\.done\(\) is not allowed/)
    }
  })

  it('creates branch subdirs and passes them to executors', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wf-par-dirs-'))
    const wfDir = await writeMinimalWorkflow(join(root, 'wf'))
    const workflow = await loadWorkflowDir(wfDir)
    const seenCaseDirs: string[] = []
    const engine = new WorkflowEngine({
      caseDirRoot: join(root, 'runs'),
      executors: new MockExecutorRegistry({
        run: (opts) => {
          seenCaseDirs.push(opts.caseDir)
          return { ok: true }
        },
      }),
      workflowDirs: { [workflow.manifest.id]: wfDir },
    })
    const script: RunScript = async (step) => {
      await step.parallel('fan', [
        async (s) => s.run('w', { script: 'a' }),
        async (s) => s.run('w', { script: 'b' }),
      ])
      await step.done({ result: 'ok' })
    }
    const r = await engine.startRun(
      workflow.manifest.id,
      { message: 'x' },
      { type: 'human' },
      { runScript: script, workflow },
    )
    expect(r.run.status).toBe('done')
    expect(seenCaseDirs).toHaveLength(2)
    // Branches run concurrently — executor arrival order is nondeterministic.
    expect([...seenCaseDirs].sort()).toEqual([
      join(r.caseDir, 'fan#1', 'b0'),
      join(r.caseDir, 'fan#1', 'b1'),
    ])
    // dirs exist on disk
    const { existsSync } = await import('node:fs')
    expect(existsSync(seenCaseDirs[0]!)).toBe(true)
    expect(existsSync(seenCaseDirs[1]!)).toBe(true)
  })

  it('serialized journal has no interleaved lines under concurrent branch writes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wf-par-stress-'))
    const wfDir = await writeMinimalWorkflow(join(root, 'wf'))
    const workflow = await loadWorkflowDir(wfDir)
    const engine = new WorkflowEngine({
      caseDirRoot: join(root, 'runs'),
      executors: new MockExecutorRegistry({
        run: async () => {
          // tiny yield so branches interleave appends
          await new Promise((r) => setTimeout(r, 0))
          return { ok: true }
        },
      }),
      workflowDirs: { [workflow.manifest.id]: wfDir },
    })
    const script: RunScript = async (step) => {
      await step.parallel('fan', [
        async (s) => {
          for (let i = 0; i < 5; i++) await s.run(`s${i}`, { script: 'x' })
          return 0
        },
        async (s) => {
          for (let i = 0; i < 5; i++) await s.run(`s${i}`, { script: 'x' })
          return 1
        },
        async (s) => {
          for (let i = 0; i < 5; i++) await s.run(`s${i}`, { script: 'x' })
          return 2
        },
      ])
      await step.done({ result: 'ok' })
    }
    const r = await engine.startRun(
      workflow.manifest.id,
      { message: 'x' },
      { type: 'human' },
      { runScript: script, workflow },
    )
    expect(r.run.status).toBe('done')
    const raw = await readFile(join(r.caseDir, 'journal.jsonl'), 'utf-8')
    const lines = raw.split('\n').filter((l) => l.trim())
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow()
    }
    // 3 branches × 5 steps × (started+finished) + parallel started/finished + done + run_started/finished
    expect(lines.length).toBeGreaterThan(30)
  })

  it('branch agent fields do not merge into case.json', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wf-par-nomerge-'))
    const wfDir = await writeMinimalWorkflow(join(root, 'wf'))
    const workflow = await loadWorkflowDir(wfDir)
    const engine = new WorkflowEngine({
      caseDirRoot: join(root, 'runs'),
      executors: new MockExecutorRegistry({
        agent: async () => ({ result: 'from-branch', leaked: true }),
      }),
      workflowDirs: { [workflow.manifest.id]: wfDir },
    })
    const script: RunScript = async (step) => {
      const results = await step.parallel('fan', [
        async (s) => {
          const a = await s.agent('w', { out: ['result'] })
          return a
        },
      ])
      await step.done({ result: String(results[0]?.result) })
    }
    const r = await engine.startRun(
      workflow.manifest.id,
      { message: 'x' },
      { type: 'human' },
      { runScript: script, workflow },
    )
    expect(r.run.status).toBe('done')
    const st = await readCase(r.caseDir)
    // branch result only via T[] → done, not via case field merge from agent
    expect(st.fields.result).toBe('from-branch')
    expect(st.fields.leaked).toBeUndefined()
  })
})

describe('review hardening', () => {
  let root: string
  let wfDir: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'wf-harden-'))
    wfDir = await writeMinimalWorkflow(join(root, 'wf'))
  })

  function makeEngine(workflowId: string) {
    return new WorkflowEngine({
      caseDirRoot: join(root, 'runs'),
      executors: new MockExecutorRegistry(),
      workflowDirs: { [workflowId]: wfDir },
    })
  }

  it('terminal runs are immutable — late writes are ignored', async () => {
    const workflow = await loadWorkflowDir(wfDir)
    const engine = makeEngine(workflow.manifest.id)
    const script: RunScript = async (step) => {
      await step.done({ result: 'ok' })
    }
    const r = await engine.startRun(
      workflow.manifest.id,
      { message: 'hi' },
      { type: 'human' },
      { runScript: script, workflow },
    )
    expect(r.run.status).toBe('done')
    await updateRun(r.caseDir, { status: 'running' })
    expect((await readCase(r.caseDir)).run.status).toBe('done')
  })

  it('resumeRun rejects a gateResponse missing declared gate fields', async () => {
    const workflow = await loadWorkflowDir(wfDir)
    const engine = makeEngine(workflow.manifest.id)
    const script: RunScript = async (step) => {
      const g = await step.human('gate', { fields: ['approved'], prompt: 'ok?' })
      await step.done({ result: String(g.approved) })
    }
    const started = await engine.startRun(
      workflow.manifest.id,
      { message: 'hi' },
      { type: 'human' },
      { runScript: script, workflow },
    )
    expect(started.suspended).toBe(true)
    await expect(
      engine.resumeRun(started.run.id, { gateResponse: {}, runScript: script, workflow }),
    ).rejects.toBeInstanceOf(ContractValidationError)
    const resumed = await engine.resumeRun(started.run.id, {
      gateResponse: { approved: true },
      runScript: script,
      workflow,
    })
    expect(resumed.run.status).toBe('done')
  })

  it('step.done enforces required output contract fields', async () => {
    const strictDir = await writeMinimalWorkflow(join(root, 'strict'), {
      id: 'strict-wf',
      yaml: `id: strict-wf
version: "1.0.0"
name: Strict
input:
  - name: message
    type: string
output:
  - name: result
    type: string
`,
    })
    const workflow = await loadWorkflowDir(strictDir)
    const engine = new WorkflowEngine({
      caseDirRoot: join(root, 'runs'),
      executors: new MockExecutorRegistry(),
      workflowDirs: { 'strict-wf': strictDir },
    })
    const script: RunScript = async (step) => {
      await step.done({})
    }
    const r = await engine.startRun(
      'strict-wf',
      { message: 'hi' },
      { type: 'human' },
      { runScript: script, workflow },
    )
    expect(r.run.status).toBe('failed')
    expect(r.run.error).toContain('output field')
  })

  it('continueRun re-enters a crashed running run; open gate is not double-appended', async () => {
    const workflow = await loadWorkflowDir(wfDir)
    const engine = makeEngine(workflow.manifest.id)
    const script: RunScript = async (step) => {
      const a = await step.agent('work', { out: ['result'] })
      await step.human('gate', { fields: ['ok'] })
      await step.done({ result: a.result })
    }
    const started = await engine.startRun(
      workflow.manifest.id,
      { message: 'hi' },
      { type: 'human' },
      { runScript: script, workflow },
    )
    expect(started.suspended).toBe(true)

    // continueRun refuses paused_human (that's resumeRun's job)
    await expect(
      engine.continueRun(started.run.id, { runScript: script, workflow }),
    ).rejects.toThrow(/paused at a human gate/)

    // Simulate a crash that left status flipped to running (post-resume, pre-completion)
    await updateRun(started.caseDir, { status: 'running' })
    const continued = await engine.continueRun(started.run.id, {
      runScript: script,
      workflow,
    })
    // Replays the agent from journal, hits the still-open gate, re-suspends
    expect(continued.suspended).toBe(true)
    const journal = await readJournal(started.caseDir)
    const opens = journal.filter((e) => e.type === 'gate_opened' && e.label === 'gate')
    expect(opens).toHaveLength(1)
  })

  it('journal cache throws on step kind mismatch', () => {
    const entries = [
      {
        type: 'step_finished' as const,
        ts: 'now',
        stepId: 'x#1',
        label: 'x',
        seq: 1,
        kind: 'run' as const,
        result: { ok: true },
      },
    ]
    expect(findCachedStepResult(entries, 'x', 1, 'run').hit).toBe(true)
    expect(() => findCachedStepResult(entries, 'x', 1, 'agent')).toThrow(/kind mismatch/)
  })

  it('unknown agent name fails loud', async () => {
    const workflow = await loadWorkflowDir(wfDir)
    const engine = makeEngine(workflow.manifest.id)
    const script: RunScript = async (step) => {
      await step.agent('work', { agent: 'nope', out: ['result'] })
      await step.done({ result: 'x' })
    }
    const r = await engine.startRun(
      workflow.manifest.id,
      { message: 'hi' },
      { type: 'human' },
      { runScript: script, workflow },
    )
    expect(r.run.status).toBe('failed')
    expect(r.run.error).toContain('Unknown agent "nope"')
  })
})

describe('frontmatter parsing', () => {
  it('handles CRLF and BOM', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wf-fm-'))
    const dir = await writeMinimalWorkflow(join(root, 'wf'))
    await writeFile(
      join(dir, 'agents', 'example.md'),
      '﻿---\r\nmodel: crlf-model\r\n---\r\n\r\nPrompt body here.\r\n',
      'utf-8',
    )
    const loaded = await loadWorkflowDir(dir)
    expect(loaded.agents.example.config.model).toBe('crlf-model')
    expect(loaded.agents.example.prompt).toContain('Prompt body here.')
  })

  it('throws on an unterminated frontmatter fence', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wf-fm2-'))
    const dir = await writeMinimalWorkflow(join(root, 'wf'))
    await writeFile(
      join(dir, 'agents', 'example.md'),
      '---\nmodel: broken\n\nNo closing fence, just prose.\n',
      'utf-8',
    )
    await expect(loadWorkflowDir(dir)).rejects.toThrow(/Unterminated frontmatter/)
  })
})

describe('re-review residuals', () => {
  let root: string
  let wfDir: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'wf-resid-'))
    wfDir = await writeMinimalWorkflow(join(root, 'wf'))
  })

  const gateScript: RunScript = async (step) => {
    const a = await step.agent('work', { out: ['result'] })
    const g = await step.human('gate', { fields: ['ok'] })
    await step.done({ result: a.result, ok: g.ok })
  }

  async function startToGate(engine: WorkflowEngine, workflow: Awaited<ReturnType<typeof loadWorkflowDir>>) {
    const started = await engine.startRun(
      workflow.manifest.id,
      { message: 'hi' },
      { type: 'human' },
      { runScript: gateScript, workflow },
    )
    expect(started.suspended).toBe(true)
    return started
  }

  async function simulateCrashedResume(caseDir: string) {
    // gate_resolved reached disk, but the process died before the status flip
    await appendJournal(caseDir, {
      type: 'gate_resolved',
      ts: 'crash',
      stepId: 'gate#1',
      label: 'gate',
      seq: 1,
      values: { ok: true },
    })
  }

  it('resumeRun recovers a run crashed between gate_resolved and the status flip', async () => {
    const workflow = await loadWorkflowDir(wfDir)
    const engine = new WorkflowEngine({
      caseDirRoot: join(root, 'runs'),
      executors: new MockExecutorRegistry(),
      workflowDirs: { [workflow.manifest.id]: wfDir },
    })
    const started = await startToGate(engine, workflow)
    await simulateCrashedResume(started.caseDir)

    const resumed = await engine.resumeRun(started.run.id, {
      runScript: gateScript,
      workflow,
    })
    expect(resumed.suspended).toBe(false)
    expect(resumed.run.status).toBe('done')
    expect(resumed.run.output?.ok).toBe(true)
  })

  it('continueRun recovers the same crash shape', async () => {
    const workflow = await loadWorkflowDir(wfDir)
    const engine = new WorkflowEngine({
      caseDirRoot: join(root, 'runs'),
      executors: new MockExecutorRegistry(),
      workflowDirs: { [workflow.manifest.id]: wfDir },
    })
    const started = await startToGate(engine, workflow)
    await simulateCrashedResume(started.caseDir)

    const continued = await engine.continueRun(started.run.id, {
      runScript: gateScript,
      workflow,
    })
    expect(continued.suspended).toBe(false)
    expect(continued.run.status).toBe('done')
  })

  it('reports terminal outcome, not suspended, when a kill wins during gate open', async () => {
    const workflow = await loadWorkflowDir(wfDir)
    const engine = new WorkflowEngine({
      caseDirRoot: join(root, 'runs'),
      executors: new MockExecutorRegistry({
        run: async (opts) => {
          // simulate an external kill landing mid-run, after this step
          await updateRun(opts.caseDir, { status: 'killed' })
          return { ok: true }
        },
      }),
      workflowDirs: { [workflow.manifest.id]: wfDir },
    })
    const script: RunScript = async (step) => {
      await step.run('pre', { script: 'noop' })
      await step.human('gate', { fields: ['ok'] })
      await step.done({ result: 'x' })
    }
    const r = await engine.startRun(
      workflow.manifest.id,
      { message: 'hi' },
      { type: 'human' },
      { runScript: script, workflow },
    )
    expect(r.suspended).toBe(false)
    expect(r.run.status).toBe('killed')
  })

  it('parses frontmatter preceded by blank lines', async () => {
    const dir = await writeMinimalWorkflow(join(root, 'wf2'), { id: 'ws-wf' })
    await writeFile(
      join(dir, 'agents', 'example.md'),
      '\n\n---\nmodel: padded-model\n---\n\nPadded prompt body.\n',
      'utf-8',
    )
    const loaded = await loadWorkflowDir(dir)
    expect(loaded.agents.example.config.model).toBe('padded-model')
    expect(loaded.agents.example.prompt).toContain('Padded prompt body.')
  })
})

describe('resume serialization', () => {
  it('concurrent resumes: exactly one wins, no double gate_resolved', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wf-race-'))
    const wfDir = await writeMinimalWorkflow(join(root, 'wf'))
    const workflow = await loadWorkflowDir(wfDir)
    const engine = new WorkflowEngine({
      caseDirRoot: join(root, 'runs'),
      executors: new MockExecutorRegistry(),
      workflowDirs: { [workflow.manifest.id]: wfDir },
    })
    const script: RunScript = async (step) => {
      const g = await step.human('gate', { fields: ['ok'] })
      await step.done({ result: String(g.ok) })
    }
    const started = await engine.startRun(
      workflow.manifest.id,
      { message: 'hi' },
      { type: 'human' },
      { runScript: script, workflow },
    )
    expect(started.suspended).toBe(true)

    const results = await Promise.allSettled([
      engine.resumeRun(started.run.id, { gateResponse: { ok: true }, runScript: script, workflow }),
      engine.resumeRun(started.run.id, { gateResponse: { ok: true }, runScript: script, workflow }),
    ])
    const fulfilled = results.filter((r) => r.status === 'fulfilled')
    const rejected = results.filter((r) => r.status === 'rejected')
    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({})

    const journal = await readJournal(started.caseDir)
    const resolved = journal.filter((e) => e.type === 'gate_resolved')
    expect(resolved).toHaveLength(1)
    const finished = journal.filter((e) => e.type === 'run_finished' && e.status === 'done')
    expect(finished).toHaveLength(1)
  })

  it('a broken run.ts marks a run failed instead of stranding it running', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wf-brokenscript-'))
    const wfDir = await writeMinimalWorkflow(join(root, 'wf'))
    await writeFile(join(wfDir, 'run.ts'), 'this is not valid javascript {{{', 'utf-8')
    const workflow = await loadWorkflowDir(wfDir)
    const engine = new WorkflowEngine({
      caseDirRoot: join(root, 'runs'),
      executors: new MockExecutorRegistry(),
      workflowDirs: { [workflow.manifest.id]: wfDir },
    })
    // No runScript injected — engine must load (and fail on) run.ts itself.
    const r = await engine.startRun(workflow.manifest.id, { message: 'x' }, { type: 'human' }, {
      workflow,
    })
    expect(r.run.status).toBe('failed')
    expect(r.suspended).toBe(false)
  })
})
