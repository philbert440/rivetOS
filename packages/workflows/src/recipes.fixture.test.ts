/**
 * Example-recipe fixture tests — hello-world.
 *
 * Loads the real dir under repo `workflows/` (path relative to this package).
 * Mock executors; no live LLM. Real recipes (and their gold fixtures) live in
 * the private defs repo — this keeps a shipped-directory fixture exercising
 * loader + engine + replay in public CI.
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
} from './index.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
/** packages/workflows/src → repo root → workflows/ */
const REPO_ROOT = join(__dirname, '..', '..', '..')
const HELLO_DIR = join(REPO_ROOT, 'workflows', 'hello-world')

describe('loadWorkflowDir — hello-world example', () => {
  it('loads manifest + greeter agent', async () => {
    const wf = await loadWorkflowDir(HELLO_DIR)
    expect(wf.manifest.id).toBe('hello-world')
    expect(wf.manifest.version).toBe('0.1.0')
    expect(wf.manifest.budgets?.maxTokens).toBe(20_000)
    expect(wf.manifest.input.map((f) => f.name)).toEqual(['name'])
    expect(wf.agents.greeter).toBeDefined()
    expect(wf.agents.greeter.prompt.length).toBeGreaterThan(40)
    expect(wf.agents.greeter.config.maxTurns).toBe(5)
  })
})

describe('hello-world fixture', () => {
  it('script → agent → suspend at gate → resume → done with declared output', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wf-hello-'))
    const workflow = await loadWorkflowDir(HELLO_DIR)

    // Load the real orchestration module (absolute path → file URL for ESM).
    const mod = (await import(pathToFileURL(join(HELLO_DIR, 'run.ts')).href)) as {
      default: RunScript
    }
    const runScript = mod.default

    const executors = new MockExecutorRegistry({
      run: async () => ({ bytes: 6 }),
      agent: async () => ({ greeting: 'Hello, Ada — welcome aboard!' }),
    })

    const engine = new WorkflowEngine({
      caseDirRoot: root,
      executors,
      workflowDirs: { 'hello-world': HELLO_DIR },
    })

    const started = await engine.startRun(
      'hello-world',
      { name: 'Ada' },
      { type: 'human', id: 'tester' },
      { runScript, workflow },
    )
    expect(started.suspended).toBe(true)
    expect(started.run.status).toBe('paused_human')
    expect(started.suspension?.label).toBe('approve-gate')
    expect(executors.calls.filter((c) => c.kind === 'run')).toHaveLength(1)
    expect(executors.calls.filter((c) => c.kind === 'agent')).toHaveLength(1)

    const resumed = await engine.resumeRun(started.run.id, {
      gateResponse: { approved: true },
      runScript,
      workflow,
    })
    expect(resumed.suspended).toBe(false)
    expect(resumed.run.status).toBe('done')
    expect(resumed.run.output?.greeting).toMatch(/Ada/)
    // replay: agent/run not re-executed
    expect(executors.calls.filter((c) => c.kind === 'agent')).toHaveLength(1)
    expect(executors.calls.filter((c) => c.kind === 'run')).toHaveLength(1)
  })
})
