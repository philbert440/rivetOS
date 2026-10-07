/**
 * createWorkflowDef — blank + duplicate, validation, no partial dirs.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  WorkflowCreateError,
  createWorkflowDef,
  slugifyWorkflowId,
  validateNewWorkflowId,
} from './create.js'
import { checkRunScriptDeterminism } from './determinism.js'
import { listWorkflowDefs } from './list-runs.js'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wf-create-'))
})

describe('ids', () => {
  it('validates and slugifies', () => {
    expect(validateNewWorkflowId('pr-review')).toBeUndefined()
    expect(validateNewWorkflowId('PR')).toMatch(/lowercase/)
    expect(validateNewWorkflowId('-x')).toMatch(/lowercase/)
    expect(validateNewWorkflowId('runs')).toMatch(/reserved/)
    expect(slugifyWorkflowId('  PR Review — v2! ')).toBe('pr-review-v2')
    expect(slugifyWorkflowId('!!!')).toBe('')
  })
})

describe('createWorkflowDef', () => {
  it('creates a blank def that loads, lists, and passes the determinism lint', async () => {
    const wf = await createWorkflowDef({ root, id: 'blank', name: ' My  flow ', description: 'd' })
    expect(wf.manifest).toMatchObject({ id: 'blank', name: 'My flow', description: 'd', input: [] })
    expect(existsSync(join(root, 'blank', 'agents'))).toBe(true)
    const runTs = await readFile(join(root, 'blank', 'run.ts'), 'utf-8')
    expect(checkRunScriptDeterminism(runTs)).toEqual([])
    expect((await listWorkflowDefs([root])).map((w) => w.manifest.id)).toEqual(['blank'])
    // Staging parent is cleaned up.
    expect(await readdir(root)).toEqual(['blank'])
  })

  it('duplicates a def, rewriting identity and keeping comments + files', async () => {
    const src = join(root, 'src')
    await mkdir(join(src, 'agents'), { recursive: true })
    await mkdir(join(src, 'node_modules', 'x'), { recursive: true })
    await writeFile(
      join(src, 'workflow.yaml'),
      `# keep me
id: src
version: "2.0.0"
name: Source
input:
  - name: message
    type: string
    required: true
output: []
`,
      'utf-8',
    )
    await writeFile(join(src, 'run.ts'), 'export default async function run() {}', 'utf-8')
    await writeFile(join(src, 'agents', 'a.md'), '---\ntools: []\n---\n\nhi\n', 'utf-8')

    const wf = await createWorkflowDef({ root, id: 'copy', name: 'Copy', fromDir: src })
    expect(wf.manifest).toMatchObject({ id: 'copy', name: 'Copy', version: '2.0.0' })
    expect(wf.manifest.input[0].name).toBe('message')
    expect(Object.keys(wf.agents)).toEqual(['a'])
    expect(await readFile(join(root, 'copy', 'workflow.yaml'), 'utf-8')).toContain('# keep me')
    expect(existsSync(join(root, 'copy', 'node_modules'))).toBe(false)
    // Source untouched.
    expect(await readFile(join(src, 'workflow.yaml'), 'utf-8')).toContain('id: src')
  })

  it('rejects bad input and existing dirs without leaving anything behind', async () => {
    await expect(createWorkflowDef({ root, id: 'Bad', name: 'x' })).rejects.toBeInstanceOf(
      WorkflowCreateError,
    )
    await expect(createWorkflowDef({ root, id: 'ok', name: '  ' })).rejects.toThrow(/name/)
    await mkdir(join(root, 'taken'))
    await expect(createWorkflowDef({ root, id: 'taken', name: 'T' })).rejects.toMatchObject({
      code: 'exists',
    })

    const broken = join(root, 'broken')
    await mkdir(broken)
    await writeFile(join(broken, 'workflow.yaml'), 'id: broken\n', 'utf-8') // no version/name
    await expect(
      createWorkflowDef({ root, id: 'from-broken', name: 'F', fromDir: broken }),
    ).rejects.toThrow()
    expect((await readdir(root)).sort()).toEqual(['broken', 'taken'])
  })
})
