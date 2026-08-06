/**
 * Scaffold a workflow directory.
 *
 *   <target>/<name>/
 *     workflow.yaml
 *     run.ts
 *     agents/example.md        — frontmatter config + prompt body
 *     <name>.fixture.test.ts   (optional sibling test)
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

export interface ScaffoldOptions {
  /** Absolute or relative parent directory (default cwd). */
  dir?: string
  description?: string
  /** Also write a fixture test file next to the workflow dir. Default true. */
  fixtureTest?: boolean
}

export interface ScaffoldResult {
  workflowDir: string
  files: string[]
}

export async function scaffoldWorkflow(
  name: string,
  options: ScaffoldOptions = {},
): Promise<ScaffoldResult> {
  if (!/^[a-z0-9-]+$/.test(name)) {
    throw new Error(`Invalid workflow name "${name}": use lowercase letters, numbers, hyphens`)
  }

  const parent = options.dir ?? process.cwd()
  const workflowDir = join(parent, name)
  if (existsSync(workflowDir)) {
    throw new Error(`Workflow already exists: ${workflowDir}`)
  }

  const description = options.description ?? `${name} workflow`
  const files: string[] = []

  await mkdir(join(workflowDir, 'agents'), { recursive: true })

  const workflowYaml = `id: ${name}
version: "0.1.0"
name: ${name}
description: ${description}
input:
  - name: message
    type: string
    required: true
    description: Input message
output:
  - name: result
    type: string
    description: Final result
outline:
  - id: greet
    kind: agent
    label: Greet
  - id: approve
    kind: human
    label: Approve
budgets:
  maxTokens: 100000
`
  await writeFile(join(workflowDir, 'workflow.yaml'), workflowYaml, 'utf-8')
  files.push('workflow.yaml')

  const runTs = `/**
 * ${name} — orchestration script.
 *
 * DETERMINISM RULE: no Date.now(), Math.random(), or I/O outside step.* calls.
 * All nondeterminism must live inside steps (journaled).
 */
import type { Step } from '@rivetos/workflows'

export default async function run(
  step: Step,
  ctx: { input: Record<string, unknown> },
): Promise<void> {
  const greet = await step.agent('greet', {
    agent: 'example',
    prompt: \`Process: \${ctx.input.message}\`,
    out: ['result'],
  })

  const gate = await step.human('approve', {
    prompt: 'Approve the result?',
    fields: ['approved'],
  })

  await step.done({
    result: greet.result ?? greet,
    approved: gate.approved,
  })
}
`
  await writeFile(join(workflowDir, 'run.ts'), runTs, 'utf-8')
  files.push('run.ts')

  const agentMd = `---
tools: []
# model: claude-sonnet-4-20250514
# maxTurns: 8
---

# Example agent

You are a helpful workflow agent. Produce a concise result for the given prompt.

## Output

Write a short string result.
`
  await writeFile(join(workflowDir, 'agents', 'example.md'), agentMd, 'utf-8')
  files.push('agents/example.md')

  if (options.fixtureTest !== false) {
    const testPath = join(parent, `${name}.fixture.test.ts`)
    const fixtureBody = `/**
 * Fixture test for workflow "${name}".
 * Point workflowDirs at the scaffolded directory when running.
 */
import { describe, it, expect } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import {
  WorkflowEngine,
  MockExecutorRegistry,
  loadWorkflowDir,
  type RunScript,
} from '@rivetos/workflows'

const __dirname = dirname(fileURLToPath(import.meta.url))
const WORKFLOW_DIR = join(__dirname, '${name}')

const runScript: RunScript = async (step, ctx) => {
  const greet = await step.agent('greet', {
    agent: 'example',
    prompt: String(ctx.input.message),
    out: ['result'],
  })
  const gate = await step.human('approve', {
    prompt: 'Approve?',
    fields: ['approved'],
  })
  await step.done({ result: greet.result, approved: gate.approved })
}

describe('workflow ${name} fixture', () => {
  it('suspends at human gate and resumes to done', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wf-${name}-'))
    const workflow = await loadWorkflowDir(WORKFLOW_DIR)
    const engine = new WorkflowEngine({
      caseDirRoot: root,
      executors: new MockExecutorRegistry({
        agent: async () => ({ result: 'hello' }),
      }),
      workflowDirs: { [workflow.manifest.id]: WORKFLOW_DIR },
    })

    const started = await engine.startRun(
      workflow.manifest.id,
      { message: 'hi' },
      { type: 'human', id: 'test' },
      { runScript, workflow },
    )
    expect(started.suspended).toBe(true)
    expect(started.run.status).toBe('paused_human')

    const resumed = await engine.resumeRun(started.run.id, {
      gateResponse: { approved: true },
      runScript,
      workflow,
    })
    expect(resumed.suspended).toBe(false)
    expect(resumed.run.status).toBe('done')
    expect(resumed.run.output?.approved).toBe(true)
  })
})
`
    await writeFile(testPath, fixtureBody, 'utf-8')
    files.push(`${name}.fixture.test.ts`)
  }

  return { workflowDir, files }
}
