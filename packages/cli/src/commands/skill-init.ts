/**
 * rivetos skill init <name>
 *
 * Scaffolds a new skill directory with a SKILL.md template.
 *
 * Usage:
 *   rivetos skill init weather
 *   rivetos skill init my-skill --description="Does useful things"
 *   rivetos skill init my-skill --category=utilities --triggers="keyword1,keyword2"
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { readFile } from 'node:fs/promises'
import { parse as parseYaml } from 'yaml'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..', '..', '..', '..')

export default async function skillInit(args: string[]): Promise<void> {
  const positional = args.filter((a) => !a.startsWith('--'))
  const flags = parseFlags(args)

  const name = positional[0]
  if (!name) {
    console.error(`
  Usage: rivetos skill init <name> [options]

  Options:
    --description="..."     Skill description
    --category="..."        Category (e.g., utilities, development, api)
    --triggers="k1,k2,k3"  Comma-separated trigger keywords
    --dir="..."             Target directory (default: first skill_dir from config, or ./skills)
`)
    process.exit(1)
  }

  // Validate name
  if (!/^[a-z0-9-]+$/.test(name)) {
    console.error(`\n  ✗ Invalid skill name: "${name}"`)
    console.error('    Use lowercase letters, numbers, and hyphens only.\n')
    process.exit(1)
  }

  // Determine skill directory
  const skillDir = flags.dir ?? (await getDefaultSkillDir())
  const skillPath = resolve(skillDir, name)

  if (existsSync(skillPath)) {
    console.error(`\n  ✗ Skill already exists: ${skillPath}`)
    console.error('    Use skill_manage edit to modify it.\n')
    process.exit(1)
  }

  // Build SKILL.md content
  const description = flags.description ?? `${name} skill`
  const category = flags.category ?? ''
  const triggers = flags.triggers ?? name.replace(/-/g, ', ')

  const content = `---
name: ${name}
description: ${description}
triggers: ${triggers}
version: 1${category ? `\ncategory: ${category}` : ''}
---

# ${name.charAt(0).toUpperCase() + name.slice(1).replace(/-/g, ' ')}

${description}

## Usage

<!-- Describe how the agent should use this skill -->

## Examples

<!-- Include concrete examples the agent can follow -->

## Notes

<!-- Any additional context, gotchas, or references -->
`

  // Create directory and file
  await mkdir(skillPath, { recursive: true })
  await writeFile(resolve(skillPath, 'SKILL.md'), content, 'utf-8')

  console.log(`
  ✓ Skill created: ${skillPath}/SKILL.md

  Next steps:
    1. Edit ${skillPath}/SKILL.md with your skill content
    2. Add reference files in ${skillPath}/references/ if needed
    3. Verify: rivetos skills list
    4. Test: mention a trigger keyword in conversation

  See docs/SKILLS.md for the full guide.
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

async function getDefaultSkillDir(): Promise<string> {
  // Try to read from config
  try {
    const configPaths = ['config.yaml', resolve(process.env.HOME ?? '', '.rivetos', 'config.yaml')]
    for (const configPath of configPaths) {
      if (existsSync(configPath)) {
        const raw = await readFile(configPath, 'utf-8')
        const config = parseYaml(raw) as { runtime?: { skill_dirs?: string[] } } | null
        const dirs = config?.runtime?.skill_dirs
        if (Array.isArray(dirs) && dirs.length > 0) {
          return resolve(dirs[0])
        }
      }
    }
  } catch {
    /* fall through */
  }
  // Default
  return resolve(ROOT, 'skills')
}
