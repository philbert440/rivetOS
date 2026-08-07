/**
 * /api/workflows + /api/workflow-runs — temp caseDir + fixture workflow dir.
 */
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  WorkflowEngine,
  MockExecutorRegistry,
  type RunScript,
} from '@rivetos/workflows'
import {
  createWorkflowApiRoutes,
  editPathForDefDir,
  diagnosticsFromLoadError,
  resolveDefDirForValidate,
  validateWorkflowDir,
} from './workflow-api.js'
import type { NotificationFrame } from '@rivetos/types'

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn()
})

let caseRoot: string
let defsRoot: string

beforeEach(async () => {
  const root = await mkdtemp(join(tmpdir(), 'wf-api-'))
  caseRoot = join(root, 'runs')
  defsRoot = join(root, 'defs')
  await mkdir(caseRoot, { recursive: true })
  await mkdir(defsRoot, { recursive: true })
})

async function writeFixtureWorkflow(
  id: string,
  opts?: { withGate?: boolean },
): Promise<string> {
  const dir = join(defsRoot, id)
  await mkdir(join(dir, 'agents'), { recursive: true })
  await writeFile(
    join(dir, 'workflow.yaml'),
    `id: ${id}
version: "1.0.0"
name: ${id}
description: fixture
input:
  - name: message
    type: string
    required: true
    description: A message
  - name: count
    type: number
    required: false
output:
  - name: result
    type: string
`,
    'utf-8',
  )
  await writeFile(join(dir, 'run.ts'), 'export default async function run() {}', 'utf-8')
  await writeFile(join(dir, 'agents', 'example.md'), '---\ntools: []\n---\n\nhi\n', 'utf-8')
  void opts
  return dir
}

async function startApi(opts?: {
  runScript?: RunScript
  onGate?: (f: Extract<NotificationFrame, { kind: 'workflow.gate' }>) => void
  /** Override files root for editPath (default: parent of defsRoot so defs are editable). */
  filesRoot?: string
}): Promise<{ base: string; engine: WorkflowEngine }> {
  await writeFixtureWorkflow('demo')
  const engine = new WorkflowEngine({
    caseDirRoot: caseRoot,
    workflowsRoots: [defsRoot],
    executors: new MockExecutorRegistry({
      run: () => ({ ok: true }),
      agent: () => ({ result: 'mock' }),
    }),
  })

  // Inject runScript via wrapping start/resume is hard; instead use engine with
  // default load — we pass runScript only through start by monkeypatching:
  const origStart = engine.startRun.bind(engine)
  engine.startRun = async (ref, input, startedBy, options = {}) =>
    origStart(ref, input, startedBy, {
      ...options,
      runScript:
        options.runScript ??
        opts?.runScript ??
        (async (step, ctx) => {
          await step.run('noop', { script: 'x', in: ctx.input })
          await step.done({ result: String(ctx.input.message ?? '') })
        }),
    })
  const origResume = engine.resumeRun.bind(engine)
  engine.resumeRun = async (runId, options = {}) =>
    origResume(runId, {
      ...options,
      runScript:
        options.runScript ??
        opts?.runScript ??
        (async (step, ctx) => {
          await step.run('noop', { script: 'x', in: ctx.input })
          const gate = await step.human('approve', {
            prompt: 'Approve?',
            fields: ['approved'],
          })
          await step.done({ result: String(ctx.input.message ?? ''), approved: gate.approved })
        }),
    })

  // filesRoot defaults so demo sits under it → editPath = `defs/demo` when
  // defsRoot is `<tmp>/defs` and filesRoot is `<tmp>`.
  const filesRoot = opts?.filesRoot ?? join(defsRoot, '..')

  const routes = createWorkflowApiRoutes({
    engine,
    workflowsRoots: [defsRoot],
    caseDirRoot: caseRoot,
    filesRoot,
    onGatePaused: opts?.onGate,
  })

  const server: Server = createServer((req, res) => {
    const url = req.url ?? '/'
    if (url.startsWith('/api/workflow-runs')) {
      void routes.workflowRuns.handler(req, res)
      return
    }
    if (url.startsWith('/api/workflows')) {
      void routes.workflows.handler(req, res)
      return
    }
    res.writeHead(404).end()
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as AddressInfo).port
  cleanups.push(async () => {
    await new Promise((r) => server.close(r))
  })
  return { base: `http://127.0.0.1:${port}`, engine }
}

describe('workflow API', () => {
  it('GET /api/workflows lists defs', async () => {
    const { base } = await startApi()
    const res = await fetch(`${base}/api/workflows`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { workflows: Array<{ id: string }> }
    expect(body.workflows.some((w) => w.id === 'demo')).toBe(true)
  })

  it('POST start run + GET list/detail + kill', async () => {
    const { base } = await startApi()
    const start = await fetch(`${base}/api/workflows/demo/runs?wait=true`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input: { message: 'hi' } }),
    })
    expect(start.status).toBe(201)
    const started = (await start.json()) as {
      run: { id: string; status: string }
      suspended: boolean
    }
    expect(started.run.id).toBeTruthy()
    expect(started.suspended).toBe(false)
    expect(started.run.status).toBe('done')

    const list = await fetch(`${base}/api/workflow-runs`)
    expect(list.status).toBe(200)
    const listed = (await list.json()) as { runs: Array<{ id: string }> }
    expect(listed.runs.some((r) => r.id === started.run.id)).toBe(true)

    const detail = await fetch(`${base}/api/workflow-runs/${started.run.id}`)
    expect(detail.status).toBe(200)
    const d = (await detail.json()) as { run: { journal: unknown[]; fields: { message: string } } }
    expect(d.run.fields.message).toBe('hi')
    expect(d.run.journal.length).toBeGreaterThan(0)
  })

  it('POST start returns 422 on bad contract', async () => {
    const { base } = await startApi()
    const res = await fetch(`${base}/api/workflows/demo/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input: {} }),
    })
    expect(res.status).toBe(422)
    const body = (await res.json()) as { issues: Array<{ field: string }> }
    expect(body.issues.some((i) => i.field === 'message')).toBe(true)
  })

  it('resume at human gate + notify', async () => {
    const gates: Array<Extract<NotificationFrame, { kind: 'workflow.gate' }>> = []
    const script: RunScript = async (step, ctx) => {
      await step.run('noop', { script: 'x', in: ctx.input })
      const gate = await step.human('approve', {
        prompt: 'Approve?',
        fields: ['approved'],
      })
      await step.done({ result: 'ok', approved: gate.approved })
    }
    const { base } = await startApi({ runScript: script, onGate: (f) => gates.push(f) })

    const start = await fetch(`${base}/api/workflows/demo/runs?wait=true`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'gate-me' }),
    })
    expect(start.status).toBe(201)
    const started = (await start.json()) as {
      run: { id: string; status: string }
      suspended: boolean
    }
    expect(started.suspended).toBe(true)
    expect(started.run.status).toBe('paused_human')

    // notify is fire-and-forget async
    await new Promise((r) => setTimeout(r, 50))
    expect(gates.length).toBeGreaterThanOrEqual(1)
    expect(gates[0].kind).toBe('workflow.gate')
    expect(gates[0].runId).toBe(started.run.id)

    const detail = await fetch(`${base}/api/workflow-runs/${started.run.id}`)
    const d = (await detail.json()) as {
      run: { openGate: { fields: string[]; prompt?: string } }
    }
    expect(d.run.openGate.fields).toContain('approved')

    const badResume = await fetch(`${base}/api/workflow-runs/${started.run.id}/resume`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ gateResponse: {} }),
    })
    expect(badResume.status).toBe(422)

    const resume = await fetch(`${base}/api/workflow-runs/${started.run.id}/resume?wait=true`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ gateResponse: { approved: true } }),
    })
    expect(resume.status).toBe(200)
    const resumed = (await resume.json()) as { run: { status: string }; suspended: boolean }
    expect(resumed.suspended).toBe(false)
    expect(resumed.run.status).toBe('done')
  })

  it('detached start (default) returns 202 and the run completes in background', async () => {
    const { base } = await startApi()
    const start = await fetch(`${base}/api/workflows/demo/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input: { message: 'bg' } }),
    })
    expect(start.status).toBe(202)
    const started = (await start.json()) as {
      run: { id: string; status: string }
      detached?: boolean
    }
    expect(started.detached).toBe(true)
    expect(started.run.status).toBe('running')

    // Contract errors still reject BEFORE detaching
    const bad = await fetch(`${base}/api/workflows/demo/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input: {} }),
    })
    expect(bad.status).toBe(422)

    // Poll detail until the background execution finishes
    let status = 'running'
    for (let i = 0; i < 50 && status === 'running'; i++) {
      await new Promise((r) => setTimeout(r, 20))
      const detail = await fetch(`${base}/api/workflow-runs/${started.run.id}`)
      if (detail.status !== 200) continue
      const d = (await detail.json()) as { run: { run: { status: string } } }
      status = d.run.run.status
    }
    expect(status).toBe('done')
  })

  it('kill a paused run', async () => {
    const script: RunScript = async (step) => {
      await step.human('wait', { prompt: 'x', fields: ['ok'] })
      await step.done({})
    }
    const { base } = await startApi({ runScript: script })
    const start = await fetch(`${base}/api/workflows/demo/runs?wait=true`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input: { message: 'k' } }),
    })
    const started = (await start.json()) as { run: { id: string } }
    const kill = await fetch(`${base}/api/workflow-runs/${started.run.id}/kill`, {
      method: 'POST',
    })
    expect(kill.status).toBe(200)
    const detail = await fetch(`${base}/api/workflow-runs/${started.run.id}`)
    const d = (await detail.json()) as { run: { run: { status: string } } }
    expect(d.run.run.status).toBe('killed')
  })

  it('GET /api/workflows/:id exposes editPath when under files root', async () => {
    const { base } = await startApi()
    const res = await fetch(`${base}/api/workflows/demo`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { workflow: { id: string; editPath?: string } }
    expect(body.workflow.id).toBe('demo')
    expect(body.workflow.editPath).toBe('defs/demo')

    // Outside files root → no editPath
    const { base: base2 } = await startApi({ filesRoot: '/no/such/files/root' })
    const res2 = await fetch(`${base2}/api/workflows/demo`)
    const body2 = (await res2.json()) as { workflow: { editPath?: string } }
    expect(body2.workflow.editPath).toBeUndefined()
  })

  it('POST /api/workflows/:id/validate returns ok for clean fixture', async () => {
    const { base } = await startApi()
    const res = await fetch(`${base}/api/workflows/demo/validate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      ok: boolean
      diagnostics: Array<{ file: string; severity: string; message: string }>
    }
    expect(body.ok).toBe(true)
    expect(body.diagnostics).toEqual([])
  })

  it('POST /api/workflows/:id/validate flags nondeterministic run.ts', async () => {
    const { base } = await startApi()
    // Mutate the fixture on disk after API start
    await writeFile(
      join(defsRoot, 'demo', 'run.ts'),
      'export default async function run() {\n  const t = Date.now()\n  return t\n}\n',
      'utf-8',
    )
    const res = await fetch(`${base}/api/workflows/demo/validate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      ok: boolean
      diagnostics: Array<{ file: string; line?: number; severity: string; message: string }>
    }
    expect(body.ok).toBe(false)
    expect(body.diagnostics.some((d) => /Date\.now|no-date-now/i.test(d.message))).toBe(true)
    expect(body.diagnostics[0]?.file).toMatch(/run\.ts/)
  })

  it('POST /api/workflows/:id/validate 404s for unknown id', async () => {
    const { base } = await startApi()
    const res = await fetch(`${base}/api/workflows/nope/validate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    expect(res.status).toBe(404)
  })

  it('POST /api/workflows/:id/validate returns diagnostics (not 404) for a def that no longer loads', async () => {
    const { base } = await startApi()
    // Break the manifest on disk after API start — the def disappears from
    // listWorkflowDefs, but validate must still find the dir and report.
    await writeFile(join(defsRoot, 'demo', 'workflow.yaml'), 'id: [broken\n', 'utf-8')
    const res = await fetch(`${base}/api/workflows/demo/validate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      ok: boolean
      diagnostics: Array<{ file: string; severity: string; message: string }>
    }
    expect(body.ok).toBe(false)
    expect(body.diagnostics.length).toBeGreaterThan(0)
    expect(body.diagnostics[0]?.severity).toBe('error')
  })

  it('POST /api/workflows/:id/validate reports an empty agent prompt as a diagnostic', async () => {
    const { base } = await startApi()
    await writeFile(join(defsRoot, 'demo', 'agents', 'example.md'), '---\ntools: []\n---\n\n', 'utf-8')
    const res = await fetch(`${base}/api/workflows/demo/validate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      ok: boolean
      diagnostics: Array<{ file: string; severity: string; message: string }>
    }
    expect(body.ok).toBe(false)
    expect(body.diagnostics.some((d) => /example\.md|agents/.test(d.file))).toBe(true)
  })
})

describe('resolveDefDirForValidate', () => {
  it('resolves by manifest id via yaml scan when the dir basename differs', async () => {
    const dir = await writeFixtureWorkflow('odd-dirname')
    // Manifest id inside stays the basename by fixture; rewrite id to differ.
    const yaml = await readFile(join(dir, 'workflow.yaml'), 'utf-8')
    await writeFile(join(dir, 'workflow.yaml'), yaml.replace(/^id: .*$/m, 'id: renamed-id'), 'utf-8')
    expect(await resolveDefDirForValidate([defsRoot], 'renamed-id')).toBe(dir)
  })

  it('resolves a broken def by directory basename', async () => {
    const dir = await writeFixtureWorkflow('broken-def')
    await writeFile(join(dir, 'workflow.yaml'), 'id: [broken\n', 'utf-8')
    expect(await resolveDefDirForValidate([defsRoot], 'broken-def')).toBe(dir)
  })

  it('returns undefined for unknown ids and missing roots', async () => {
    expect(await resolveDefDirForValidate([defsRoot], 'no-such-def')).toBeUndefined()
    expect(await resolveDefDirForValidate(['/nonexistent-root'], 'x')).toBeUndefined()
  })
})

describe('editPathForDefDir', () => {
  it('maps under files root to relative path', () => {
    expect(editPathForDefDir('/rivet-shared/workflows/defs/demo', '/rivet-shared')).toBe(
      'workflows/defs/demo',
    )
    expect(editPathForDefDir('/rivet-shared', '/rivet-shared')).toBe('')
    expect(editPathForDefDir('/other/place', '/rivet-shared')).toBeUndefined()
    expect(editPathForDefDir('/rivet-shared/workflows/defs/demo', '')).toBeUndefined()
  })

  it('rejects prefix look-alikes and dot-dot escapes', () => {
    // Sibling dir sharing the root as a string prefix must not match.
    expect(editPathForDefDir('/rivet-shared-evil/defs/demo', '/rivet-shared')).toBeUndefined()
    // Paths that normalize outside the root must not match.
    expect(editPathForDefDir('/rivet-shared/../etc', '/rivet-shared')).toBeUndefined()
    // Trailing slashes on either side are tolerated.
    expect(editPathForDefDir('/rivet-shared/defs/', '/rivet-shared/')).toBe('defs')
  })
})

describe('diagnosticsFromLoadError / validateWorkflowDir', () => {
  it('shapes load errors to diagnostics', () => {
    const d = diagnosticsFromLoadError(new Error('workflow.yaml: "id" must be a non-empty string'))
    expect(d[0]?.file).toBe('workflow.yaml')
    expect(d[0]?.severity).toBe('error')
  })

  it('validateWorkflowDir reports clean fixture', async () => {
    const dir = await writeFixtureWorkflow('clean-v')
    const r = await validateWorkflowDir(dir)
    expect(r.ok).toBe(true)
  })
})
