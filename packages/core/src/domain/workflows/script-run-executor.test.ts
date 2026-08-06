/**
 * Script run executor — echo JSON fixture + timeout.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtemp, mkdir, writeFile, chmod } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createScriptRunExecutor, parseStdout } from './script-run-executor.js'
import type { LoadedWorkflow } from '@rivetos/workflows'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wf-script-'))
})

function fakeWorkflow(dir: string): LoadedWorkflow {
  return {
    dir,
    runPath: join(dir, 'run.ts'),
    manifest: {
      id: 't',
      version: '1',
      name: 't',
      input: [],
      output: [],
    },
    agents: {},
  }
}

describe('parseStdout', () => {
  it('parses JSON blob', () => {
    expect(parseStdout('{"ok":true}\n', 0)).toEqual({ ok: true })
  })
  it('falls back to {stdout, exitCode}', () => {
    expect(parseStdout('hello world', 0)).toEqual({ stdout: 'hello world', exitCode: 0 })
  })
})

describe('createScriptRunExecutor', () => {
  it('runs a script and returns parsed JSON stdout', async () => {
    const wfDir = join(root, 'wf')
    const caseDir = join(root, 'case')
    await mkdir(wfDir, { recursive: true })
    await mkdir(caseDir, { recursive: true })
    const script = join(wfDir, 'echo.sh')
    await writeFile(
      script,
      `#!/bin/sh
echo '{"hello":"world","n":1}'
`,
      'utf-8',
    )
    await chmod(script, 0o755)

    const exec = createScriptRunExecutor()
    const result = await exec.execute({
      label: 'echo',
      stepId: 'echo#1',
      script: 'echo.sh',
      caseDir,
      workflow: fakeWorkflow(wfDir),
    })
    expect(result).toEqual({ hello: 'world', n: 1 })
  })

  it('times out a hanging script', async () => {
    const wfDir = join(root, 'wf2')
    const caseDir = join(root, 'case2')
    await mkdir(wfDir, { recursive: true })
    await mkdir(caseDir, { recursive: true })
    const script = join(wfDir, 'hang.sh')
    await writeFile(script, '#!/bin/sh\nsleep 30\n', 'utf-8')
    await chmod(script, 0o755)

    const exec = createScriptRunExecutor({ defaultTimeoutMs: 200 })
    await expect(
      exec.execute({
        label: 'hang',
        stepId: 'hang#1',
        script: 'hang.sh',
        caseDir,
        workflow: fakeWorkflow(wfDir),
        timeoutMs: 200,
      }),
    ).rejects.toThrow(/timed out/)
  }, 10_000)
})
