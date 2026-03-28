/**
 * rivetos plugin init <type> <name>
 *
 * Scaffolds a new plugin. Wraps the @rivetos/nx:plugin generator
 * with a friendlier CLI interface.
 *
 * Usage:
 *   rivetos plugin init                          Interactive mode
 *   rivetos plugin init provider mistral          Direct mode
 *   rivetos plugin init --type=channel --name=slack --description="Slack integration"
 */

import { execSync } from 'node:child_process'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..', '..', '..', '..')

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

const VALID_TYPES = ['provider', 'channel', 'tool'] as const
type PluginType = (typeof VALID_TYPES)[number]

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export default function pluginInit(args: string[]): void {
  // Parse positional args: rivetos plugin init <type> <name>
  const positional = args.filter((a) => !a.startsWith('--'))
  const flags = parseFlags(args)

  const type = (flags.type ?? positional[0]) as PluginType | undefined
  const name = flags.name ?? positional[1]
  const description = flags.description

  // Validate type if provided
  if (type && !VALID_TYPES.includes(type)) {
    console.error(`\n  ✗ Invalid plugin type: "${type}"`)
    console.error(`    Valid types: ${VALID_TYPES.join(', ')}\n`)
    process.exit(1)
  }

  // Check that we're in the monorepo
  if (!existsSync(resolve(ROOT, 'nx.json'))) {
    console.error('\n  ✗ Not in a RivetOS monorepo.')
    console.error('    Run this from the root of your RivetOS clone.\n')
    process.exit(1)
  }

  // Build the nx generate command
  const nxArgs: string[] = ['nx', 'g', '@rivetos/nx:plugin']
  if (type) nxArgs.push(`--type=${type}`)
  if (name) nxArgs.push(`--name=${name}`)
  if (description) nxArgs.push(`--description=${description}`)

  console.log('\n  🔩 Scaffolding new plugin...\n')

  try {
    execSync(`npx ${nxArgs.join(' ')}`, {
      cwd: ROOT,
      stdio: 'inherit',
    })
  } catch {
    console.error('\n  ✗ Plugin scaffolding failed.')
    console.error('    Check the output above for details.\n')
    process.exit(1)
  }

  // Post-creation instructions
  const pluginPath =
    type && name
      ? `plugins/${type === 'provider' ? 'providers' : type === 'channel' ? 'channels' : 'tools'}/${name}/`
      : 'the new plugin directory'

  console.log(`
  ✓ Plugin created!

  Next steps:
    1. Implement the interface in ${pluginPath}src/index.ts
    2. Add your plugin to config.yaml
    3. Run tests: npx nx run ${type ? `${type}-` : ''}${name || '<name>'}:test
    4. Verify: npx nx graph (check dependency graph)

  See docs/PLUGINS.md for the full development guide.
`)
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseFlags(args: string[]): Record<string, string | undefined> {
  const flags: Record<string, string | undefined> = {}
  for (const arg of args) {
    const match = arg.match(/^--(\w+)=(.+)$/)
    if (match) {
      flags[match[1]] = match[2]
    }
  }
  return flags
}
