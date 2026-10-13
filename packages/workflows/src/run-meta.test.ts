/**
 * Run labels (run-meta.json), list filters, and per-workflow stats.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { WorkflowEngine, type RunScript } from './engine.js'
import { MockExecutorRegistry } from './executors.js'
import { loadWorkflowDir } from './loader.js'
import { parseManifest } from './manifest.js'
import { listRuns, summarizeRunsByWorkflow, type RunSummary } from './list-runs.js'
import {
  RUN_LABEL_MAX,
  RUN_META_FILENAME,
  normalizeRunLabel,
  readRunMeta,
  renderRunLabel,
  resolveRunLabel,
  writeRunMeta,
} from './run-meta.js'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wf-meta-'))
})

describe('run label helpers', () => {
  it('normalizes whitespace, drops empties, caps length', () => {
    expect(normalizeRunLabel('  a \n  b ')).toBe('a b')
    expect(normalizeRunLabel('   ')).toBeUndefined()
    expect(normalizeRunLabel(42)).toBeUndefined()
    const long = normalizeRunLabel('x'.repeat(500))
    expect(long).toHaveLength(RUN_LABEL_MAX)
    expect(long?.endsWith('…')).toBe(true)
  })

  it('renders templates from scalar input only', () => {
    expect(renderRunLabel('{{repo}}#{{ pr }}', { repo: 'rivetOS', pr: 12 })).toBe('rivetOS#12')
    expect(renderRunLabel('{{obj}} {{missing}} done', { obj: { a: 1 } })).toBe('done')
    expect(renderRunLabel('{{missing}}', {})).toBeUndefined()
  })

  it('explicit label beats the template', () => {
    expect(resolveRunLabel('mine', '{{a}}', { a: 'tpl' })).toBe('mine')
    expect(resolveRunLabel('  ', '{{a}}', { a: 'tpl' })).toBe('tpl')
    expect(resolveRunLabel(undefined, undefined, { a: 'tpl' })).toBeUndefined()
  })

  it('reads missing or malformed meta as empty', async () => {
    expect(await readRunMeta(root)).toEqual({})
    await writeFile(join(root, RUN_META_FILENAME), '[1]', 'utf-8')
    expect(await readRunMeta(root)).toEqual({})
    await writeRunMeta(root, { label: 'ok' })
    expect(await readRunMeta(root)).toEqual({ label: 'ok' })
  })

  it('parses runLabel from workflow.yaml', () => {
    const m = parseManifest({ id: 'x', version: '1', name: 'X', input: [], runLabel: '{{a}}' })
    expect(m.runLabel).toBe('{{a}}')
    expect(() =>
      parseManifest({ id: 'x', version: '1', name: 'X', input: [], runLabel: 3 }),
    ).toThrow(/runLabel/)
  })
})

describe('engine start writes the label', () => {
  it('uses explicit label, else the manifest template', async () => {
    const wfDir = join(root, 'wf')
    await mkdir(join(wfDir, 'agents'), { recursive: true })
    await writeFile(
      join(wfDir, 'workflow.yaml'),
      `id: lbl
version: "1.0.0"
name: Labelled
runLabel: "msg: {{message}}"
input:
  - name: message
    type: string
    required: true
output: []
`,
      'utf-8',
    )
    await writeFile(join(wfDir, 'run.ts'), 'export default async function run() {}', 'utf-8')
    const workflow = await loadWorkflowDir(wfDir)
    const engine = new WorkflowEngine({
      caseDirRoot: join(root, 'runs'),
      executors: new MockExecutorRegistry({}),
      workflowDirs: { lbl: wfDir },
    })
    const script: RunScript = async (step) => {
      await step.done({})
    }

    await engine.startRun(
      'lbl',
      { message: 'hi' },
      { type: 'human' },
      {
        runScript: script,
        workflow,
        runId: 'r-tpl',
      },
    )
    await engine.startRun(
      'lbl',
      { message: 'hi' },
      { type: 'human' },
      {
        runScript: script,
        workflow,
        runId: 'r-explicit',
        label: 'Named run',
      },
    )

    const runs = await listRuns(join(root, 'runs'))
    const byId = Object.fromEntries(runs.map((r) => [r.id, r.label]))
    expect(byId).toEqual({ 'r-tpl': 'msg: hi', 'r-explicit': 'Named run' })
  })
})

describe('listRuns filters', () => {
  async function seed(id: string, workflowId: string, status: string, label?: string) {
    const dir = join(root, id)
    await mkdir(dir, { recursive: true })
    await writeFile(
      join(dir, 'case.json'),
      JSON.stringify({
        run: {
          id,
          workflowId,
          version: '1',
          startedBy: { type: 'human' },
          caseDir: dir,
          status,
          startedAt: `2026-01-0${id.slice(-1)}T00:00:00.000Z`,
        },
        fields: {},
      }),
      'utf-8',
    )
    if (label) await writeRunMeta(dir, { label })
  }

  beforeEach(async () => {
    await seed('run-1', 'alpha', 'done', 'Fix login')
    await seed('run-2', 'alpha', 'failed')
    await seed('run-3', 'beta', 'paused_human', 'Release notes')
  })

  it('filters by workflow, status, and query before the limit', async () => {
    expect((await listRuns(root, { workflowId: 'alpha' })).map((r) => r.id)).toEqual([
      'run-2',
      'run-1',
    ])
    expect((await listRuns(root, { statuses: ['done', 'paused_human'] })).map((r) => r.id)).toEqual(
      ['run-3', 'run-1'],
    )
    expect((await listRuns(root, { q: 'LOGIN' })).map((r) => r.id)).toEqual(['run-1'])
    expect((await listRuns(root, { q: 'beta' })).map((r) => r.id)).toEqual(['run-3'])
    expect((await listRuns(root, { workflowId: 'alpha', limit: 1 })).map((r) => r.id)).toEqual([
      'run-2',
    ])
  })
})

describe('summarizeRunsByWorkflow', () => {
  it('counts recent, failed, waiting and picks the newest run', () => {
    const now = Date.parse('2026-01-10T00:00:00.000Z')
    const run = (id: string, workflowId: string, status: RunSummary['status'], day: string) =>
      ({
        id,
        workflowId,
        status,
        startedAt: `2026-01-${day}T00:00:00.000Z`,
        caseDir: '',
      }) as RunSummary
    const stats = summarizeRunsByWorkflow(
      [
        run('a1', 'a', 'done', '09'),
        run('a2', 'a', 'failed', '08'),
        run('a0', 'a', 'failed', '01'), // outside 7 days
        run('b1', 'b', 'paused_human', '01'),
      ],
      now,
    )
    expect(stats.get('a')).toEqual({
      lastRun: { id: 'a1', status: 'done', startedAt: '2026-01-09T00:00:00.000Z' },
      recent: 2,
      recentFailed: 1,
      waiting: 0,
    })
    expect(stats.get('b')).toMatchObject({ recent: 0, waiting: 1, lastRun: { id: 'b1' } })
  })
})
