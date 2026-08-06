/**
 * Gold-recipe fixture tests — pr-review + change.
 *
 * Loads real dirs under repo `workflows/` (path relative to this package).
 * Mock executors + optional intercepting CallRegistry; no live gh/LLM.
 */
import { describe, it, expect } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  WorkflowEngine,
  MockExecutorRegistry,
  loadWorkflowDir,
  type RunScript,
  type CallRegistry,
  type CallContext,
} from './index.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
/** packages/workflows/src → repo root → workflows/ */
const REPO_ROOT = join(__dirname, '..', '..', '..')
const PR_REVIEW_DIR = join(REPO_ROOT, 'workflows', 'pr-review')
const CHANGE_DIR = join(REPO_ROOT, 'workflows', 'change')

/** Intercepting registry: engine still calls register('') but we ignore it. */
function interceptingCallRegistry(
  resolve: (name: string, input: Record<string, unknown>, ctx: CallContext) => Promise<unknown>,
): CallRegistry {
  return {
    register() {
      /* engine installs native resolver — ignore so tests control bare calls */
    },
    namespaces: () => ['(native)'],
    async call(ref: string, input: Record<string, unknown>, ctx: CallContext) {
      // bare ref only in these recipes
      return resolve(ref, input, ctx)
    },
  }
}

describe('loadWorkflowDir — gold recipes', () => {
  it('loads pr-review manifest + reviewer agent', async () => {
    const wf = await loadWorkflowDir(PR_REVIEW_DIR)
    expect(wf.manifest.id).toBe('pr-review')
    expect(wf.manifest.version).toBe('0.1.0')
    expect(wf.manifest.budgets?.maxTokens).toBe(200_000)
    expect(wf.manifest.input.map((f) => f.name)).toEqual(
      expect.arrayContaining(['repo', 'pr', 'focus']),
    )
    expect(wf.agents.reviewer).toBeDefined()
    expect(wf.agents.reviewer.prompt.length).toBeGreaterThan(40)
    expect(wf.agents.reviewer.config.maxTurns).toBe(40)
  })

  it('loads change manifest + planner/implementer agents', async () => {
    const wf = await loadWorkflowDir(CHANGE_DIR)
    expect(wf.manifest.id).toBe('change')
    expect(wf.manifest.budgets?.maxTokens).toBe(800_000)
    expect(wf.agents.planner).toBeDefined()
    expect(wf.agents.implementer).toBeDefined()
    expect(wf.agents.implementer.config.maxTurns).toBe(120)
  })
})

describe('pr-review fixture', () => {
  it('script → agent → suspend at gate → resume approved → done with declared outputs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wf-pr-review-'))
    const workflow = await loadWorkflowDir(PR_REVIEW_DIR)

    // Load the real orchestration module (absolute path → file URL for ESM).
    const mod = (await import(pathToFileURL(join(PR_REVIEW_DIR, 'run.ts')).href)) as {
      default: RunScript
    }
    const runScript = mod.default

    const executors = new MockExecutorRegistry({
      run: async () => ({ title: 'Test PR', diffBytes: 12 }),
      agent: async () => ({
        verdict: 'approve-with-nits',
        summary: 'Looks good overall; one minor style nit.',
      }),
    })

    const engine = new WorkflowEngine({
      caseDirRoot: root,
      executors,
      workflowDirs: { 'pr-review': PR_REVIEW_DIR },
    })

    const started = await engine.startRun(
      'pr-review',
      { repo: 'acme/widgets', pr: 42, focus: 'security' },
      { type: 'human', id: 'tester' },
      { runScript, workflow },
    )
    expect(started.suspended).toBe(true)
    expect(started.run.status).toBe('paused_human')
    expect(started.suspension?.label).toBe('verdict-gate')
    expect(executors.calls.filter((c) => c.kind === 'run')).toHaveLength(1)
    expect(executors.calls.filter((c) => c.kind === 'agent')).toHaveLength(1)

    const resumed = await engine.resumeRun(started.run.id, {
      gateResponse: { approved: true },
      runScript,
      workflow,
    })
    expect(resumed.suspended).toBe(false)
    expect(resumed.run.status).toBe('done')
    expect(resumed.run.output?.verdict).toBe('approve-with-nits')
    expect(resumed.run.output?.summary).toMatch(/Looks good/)
    expect(resumed.run.output?.approved).toBe(true)
    // replay: agent/run not re-executed
    expect(executors.calls.filter((c) => c.kind === 'agent')).toHaveLength(1)
    expect(executors.calls.filter((c) => c.kind === 'run')).toHaveLength(1)
  })
})

describe('pr-review fixture — ungated (composed) mode', () => {
  it('gated=false skips the human gate and derives approved from the verdict', async () => {
    const workflow = await loadWorkflowDir(PR_REVIEW_DIR)
    const mod = (await import(pathToFileURL(join(PR_REVIEW_DIR, 'run.ts')).href)) as {
      default: RunScript
    }
    const runScript = mod.default

    async function runUngated(verdict: string): Promise<Record<string, unknown> | undefined> {
      const root = await mkdtemp(join(tmpdir(), 'wf-pr-ungated-'))
      const engine = new WorkflowEngine({
        caseDirRoot: root,
        executors: new MockExecutorRegistry({
          run: async () => ({ title: 'x', diffBytes: 1 }),
          agent: async () => ({ verdict, summary: 's' }),
        }),
        workflowDirs: { 'pr-review': PR_REVIEW_DIR },
      })
      const r = await engine.startRun(
        'pr-review',
        { repo: 'acme/widgets', pr: 7, gated: false },
        { type: 'workflow', id: 'change' },
        { runScript, workflow },
      )
      expect(r.suspended).toBe(false)
      expect(r.run.status).toBe('done')
      return r.run.output
    }

    expect((await runUngated('approve'))?.approved).toBe(true)
    expect((await runUngated('approve-with-nits'))?.approved).toBe(true)
    expect((await runUngated('changes-needed'))?.approved).toBe(false)
  })
})

describe('change fixture', () => {
  async function loadChangeRunScript(): Promise<RunScript> {
    const mod = (await import(pathToFileURL(join(CHANGE_DIR, 'run.ts')).href)) as {
      default: RunScript
    }
    return mod.default
  }

  it('plan-gate reject ends done without pr', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wf-change-reject-'))
    const workflow = await loadWorkflowDir(CHANGE_DIR)
    const runScript = await loadChangeRunScript()

    const executors = new MockExecutorRegistry({
      agent: async (opts) => {
        if (opts.label === 'understand') return { plan: 'touch foo.ts' }
        return { pr: 'https://github.com/acme/r/pull/1', summary: 'should not run' }
      },
    })

    const engine = new WorkflowEngine({
      caseDirRoot: root,
      executors,
      workflowDirs: { change: CHANGE_DIR, 'pr-review': PR_REVIEW_DIR },
      callRegistry: interceptingCallRegistry(async () => {
        throw new Error('step.call must not run after plan reject')
      }),
    })

    const started = await engine.startRun(
      'change',
      {
        kind: 'feature',
        title: 'Add widget',
        goal: 'widgets work',
        repo: 'acme/widgets',
      },
      { type: 'human', id: 'tester' },
      { runScript, workflow },
    )
    expect(started.suspended).toBe(true)
    expect(started.suspension?.label).toBe('plan-gate')

    const resumed = await engine.resumeRun(started.run.id, {
      gateResponse: { approved: false },
      runScript,
      workflow,
    })
    expect(resumed.suspended).toBe(false)
    expect(resumed.run.status).toBe('done')
    expect(resumed.run.output?.summary).toBe('plan rejected')
    expect(resumed.run.output?.pr).toBeUndefined()
    // implement never called
    expect(executors.calls.filter((c) => c.kind === 'agent')).toHaveLength(1)
  })

  it('approve path → review loop breaks on approved; merge-gate false → merged=false', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wf-change-ok-'))
    const workflow = await loadWorkflowDir(CHANGE_DIR)
    const runScript = await loadChangeRunScript()

    let reviewCalls = 0
    const executors = new MockExecutorRegistry({
      agent: async (opts) => {
        if (opts.label === 'understand') return { plan: 'edit bar.ts' }
        if (opts.label === 'implement') {
          return {
            pr: 'https://github.com/acme/widgets/pull/99',
            summary: 'opened PR 99',
          }
        }
        // fixup should not run when first review is approved
        return { summary: 'unexpected fixup', pr: 'https://github.com/acme/widgets/pull/99' }
      },
      run: async () => ({ merged: true }),
    })

    const engine = new WorkflowEngine({
      caseDirRoot: root,
      executors,
      workflowDirs: { change: CHANGE_DIR, 'pr-review': PR_REVIEW_DIR },
      callRegistry: interceptingCallRegistry(async (name, input) => {
        expect(name).toBe('pr-review')
        expect(input.pr).toBe(99)
        // Composition contract: parent owns the human gates, child must not pause.
        expect(input.gated).toBe(false)
        reviewCalls++
        return {
          verdict: 'approve',
          summary: 'LGTM',
          approved: true,
        }
      }),
    })

    const input = {
      kind: 'bug',
      title: 'Fix crash',
      goal: 'no crash on empty list',
      repo: 'acme/widgets',
    }

    const started = await engine.startRun(
      'change',
      input,
      { type: 'human', id: 'tester' },
      { runScript, workflow },
    )
    expect(started.suspension?.label).toBe('plan-gate')

    const afterPlan = await engine.resumeRun(started.run.id, {
      gateResponse: { approved: true },
      runScript,
      workflow,
    })
    expect(afterPlan.suspended).toBe(true)
    expect(afterPlan.suspension?.label).toBe('merge-gate')
    expect(reviewCalls).toBe(1)
    // understand + implement only (no fixup)
    expect(
      executors.calls.filter((c) => c.kind === 'agent').map((c) => (c.opts as { label: string }).label),
    ).toEqual(['understand', 'implement'])

    const finished = await engine.resumeRun(started.run.id, {
      gateResponse: { merge: false },
      runScript,
      workflow,
    })
    expect(finished.suspended).toBe(false)
    expect(finished.run.status).toBe('done')
    expect(finished.run.output?.merged).toBe(false)
    expect(finished.run.output?.pr).toBe('https://github.com/acme/widgets/pull/99')
    expect(finished.run.output?.summary).toBeTruthy()
    // merge script not run
    expect(executors.calls.filter((c) => c.kind === 'run')).toHaveLength(0)
  })

  it('review loop runs fixup when first review is not approved, then breaks', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wf-change-fixup-'))
    const workflow = await loadWorkflowDir(CHANGE_DIR)
    const runScript = await loadChangeRunScript()

    let reviewCalls = 0
    const executors = new MockExecutorRegistry({
      agent: async (opts) => {
        if (opts.label === 'understand') return { plan: 'plan' }
        if (opts.label === 'implement') {
          return { pr: 'https://github.com/acme/widgets/pull/7', summary: 'impl' }
        }
        if (opts.label.startsWith('fixup-')) {
          return { summary: `fixed after ${opts.label}` }
        }
        return {}
      },
    })

    const engine = new WorkflowEngine({
      caseDirRoot: root,
      executors,
      workflowDirs: { change: CHANGE_DIR, 'pr-review': PR_REVIEW_DIR },
      callRegistry: interceptingCallRegistry(async () => {
        reviewCalls++
        if (reviewCalls === 1) {
          return { verdict: 'changes-needed', summary: 'missing tests', approved: false }
        }
        return { verdict: 'approve', summary: 'good now', approved: true }
      }),
    })

    const started = await engine.startRun(
      'change',
      {
        kind: 'feature',
        title: 'Add tests',
        goal: 'cover edge',
        repo: 'acme/widgets',
      },
      { type: 'human', id: 'tester' },
      { runScript, workflow },
    )
    await engine.resumeRun(started.run.id, {
      gateResponse: { approved: true },
      runScript,
      workflow,
    })
    // suspended at merge-gate after review/fixup/review
    const labels = executors.calls
      .filter((c) => c.kind === 'agent')
      .map((c) => (c.opts as { label: string }).label)
    expect(labels).toEqual(['understand', 'implement', 'fixup-1'])
    expect(reviewCalls).toBe(2)
  })
})

describe('prNumberFromUrl / slugifyTitle (change helpers)', () => {
  it('parses PR urls and bare numbers', async () => {
    const mod = (await import(pathToFileURL(join(CHANGE_DIR, 'run.ts')).href)) as {
      prNumberFromUrl: (u: string) => number
      slugifyTitle: (t: string) => string
    }
    expect(mod.prNumberFromUrl('https://github.com/a/b/pull/123')).toBe(123)
    expect(mod.prNumberFromUrl('https://github.com/a/b/pull/9/files')).toBe(9)
    expect(mod.prNumberFromUrl('42')).toBe(42)
    expect(mod.slugifyTitle('Fix Crash On Empty!')).toBe('fix-crash-on-empty')
  })
})
