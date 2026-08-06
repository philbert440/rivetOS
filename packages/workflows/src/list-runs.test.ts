/**
 * listRuns / listWorkflowDefs — skip malformed dirs, sort newest first.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { listChildRuns, listRuns, listWorkflowDefs } from './list-runs.js'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wf-list-'))
})

async function writeCase(
  dir: string,
  run: {
    id: string
    workflowId: string
    status?: string
    startedAt?: string
    version?: string
  },
): Promise<void> {
  await mkdir(dir, { recursive: true })
  await writeFile(
    join(dir, 'case.json'),
    JSON.stringify({
      run: {
        id: run.id,
        workflowId: run.workflowId,
        version: run.version ?? '1.0.0',
        startedBy: { type: 'human' },
        caseDir: dir,
        status: run.status ?? 'done',
        startedAt: run.startedAt ?? '2026-01-01T00:00:00.000Z',
      },
      fields: {},
    }),
    'utf-8',
  )
}

describe('listRuns', () => {
  it('returns top-level runs newest first and skips garbage', async () => {
    await writeCase(join(root, 'run-a'), {
      id: 'run-a',
      workflowId: 'wf',
      startedAt: '2026-01-02T00:00:00.000Z',
    })
    await writeCase(join(root, 'run-b'), {
      id: 'run-b',
      workflowId: 'wf',
      startedAt: '2026-01-03T00:00:00.000Z',
    })
    await mkdir(join(root, 'junk'), { recursive: true })
    await writeFile(join(root, 'junk', 'case.json'), '{not json', 'utf-8')
    await mkdir(join(root, 'empty'), { recursive: true })

    const warns: string[] = []
    const runs = await listRuns(root, { limit: 10 }, (m) => warns.push(m))
    expect(runs.map((r) => r.id)).toEqual(['run-b', 'run-a'])
    expect(warns.some((w) => w.includes('junk'))).toBe(true)
  })

  it('lists nested children', async () => {
    const parent = join(root, 'parent')
    await writeCase(parent, { id: 'parent', workflowId: 'wf' })
    await writeCase(join(parent, 'child-1'), {
      id: 'child-1',
      workflowId: 'child-wf',
      startedAt: '2026-01-04T00:00:00.000Z',
    })
    const children = await listChildRuns(parent)
    expect(children).toHaveLength(1)
    expect(children[0].id).toBe('child-1')
    expect(children[0].nested).toBe(true)
    expect(children[0].parentRunId).toBe('parent')
  })
})

describe('listWorkflowDefs', () => {
  it('loads valid dirs and skips broken ones', async () => {
    const defs = join(root, 'defs')
    const good = join(defs, 'hello')
    await mkdir(join(good, 'agents'), { recursive: true })
    await writeFile(
      join(good, 'workflow.yaml'),
      `id: hello
version: "0.1.0"
name: Hello
input: []
output: []
`,
      'utf-8',
    )
    await writeFile(join(good, 'run.ts'), 'export default async function run() {}', 'utf-8')
    const bad = join(defs, 'broken')
    await mkdir(bad, { recursive: true })
    await writeFile(join(bad, 'workflow.yaml'), 'id: only\n', 'utf-8')

    const warns: string[] = []
    const loaded = await listWorkflowDefs([defs], (m) => warns.push(m))
    expect(loaded).toHaveLength(1)
    expect(loaded[0].manifest.id).toBe('hello')
    expect(warns.some((w) => w.includes('broken'))).toBe(true)
  })
})
