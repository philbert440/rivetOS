/**
 * rivetos workflow <subcommand>
 *
 *   rivetos workflow new <name>   — scaffold a workflow directory
 *
 * Mirrors product plan: "rivetos workflow new <name> → runnable skeleton + fixture test".
 */

import { resolve } from 'node:path'
import { scaffoldWorkflow } from '@rivetos/workflows'

export default async function workflowCommand(): Promise<void> {
  const args = process.argv.slice(3)
  const sub = args[0]

  if (!sub || sub === '--help' || sub === '-h') {
    printHelp()
    return
  }

  if (sub === 'new' || sub === 'scaffold') {
    await scaffoldNew(args.slice(1))
    return
  }

  console.error(`Unknown workflow subcommand: ${sub}`)
  printHelp()
  process.exit(1)
}

function printHelp(): void {
  console.log(`
  rivetos workflow — workflow authoring helpers

  Usage:
    rivetos workflow new <name> [options]

  Options:
    --dir=<path>              Parent directory (default: ./workflows)
    --description="..."       Manifest description
    --no-fixture              Skip generating the fixture test file

  Example:
    rivetos workflow new pr-review --dir=./workflows
`)
}

async function scaffoldNew(args: string[]): Promise<void> {
  const positional = args.filter((a) => !a.startsWith('--'))
  const flags = parseFlags(args)
  const name = positional[0]

  if (!name) {
    console.error('Usage: rivetos workflow new <name>')
    process.exit(1)
  }

  const dir = resolve(flags.dir ?? './workflows')
  const description = flags.description
  const fixtureTest = flags['no-fixture'] === undefined

  try {
    const result = await scaffoldWorkflow(name, { dir, description, fixtureTest })
    console.log(`
  ✓ Workflow scaffolded: ${result.workflowDir}

  Files:
${result.files.map((f) => `    - ${f}`).join('\n')}

  Next steps:
    1. Edit workflow.yaml (input/output contract)
    2. Implement run.ts orchestration (deterministic — no Date.now/Math.random)
    3. Fill agents/*/instructions.md
    4. Run the fixture test with vitest
`)
  } catch (err: unknown) {
    console.error(`\n  ✗ ${(err as Error).message}\n`)
    process.exit(1)
  }
}

function parseFlags(args: string[]): Record<string, string | undefined> {
  const flags: Record<string, string | undefined> = {}
  for (const arg of args) {
    if (arg === '--no-fixture') {
      flags['no-fixture'] = '1'
      continue
    }
    const match = arg.match(/^--([a-zA-Z0-9-]+)=(.+)$/)
    if (match) {
      flags[match[1]] = match[2]
    }
  }
  return flags
}
