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
import { findCachedStepResult, readJournal } from './journal.js'
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

describe('step.parallel plumbing', () => {
  it('throws when called (slice G)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wf-par-'))
    const wfDir = await writeMinimalWorkflow(join(root, 'wf'))
    const workflow = await loadWorkflowDir(wfDir)
    const engine = new WorkflowEngine({
      caseDirRoot: join(root, 'runs'),
      executors: new MockExecutorRegistry(),
      workflowDirs: { [workflow.manifest.id]: wfDir },
    })
    const script: RunScript = async (step) => {
      await step.parallel('p')
    }
    const result = await engine.startRun(
      workflow.manifest.id,
      { message: 'x' },
      { type: 'human' },
      { runScript: script, workflow },
    )
    expect(result.run.status).toBe('failed')
    expect(result.run.error).toMatch(/not implemented/)
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
