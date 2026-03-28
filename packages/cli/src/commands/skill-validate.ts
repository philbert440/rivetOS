/**
 * rivetos skill validate [name|path]
 *
 * Validates a skill's SKILL.md — checks frontmatter, triggers, file references.
 *
 * Usage:
 *   rivetos skill validate weather          Validate by name (searches skill_dirs)
 *   rivetos skill validate ./skills/weather Validate by path
 *   rivetos skill validate                  Validate all discovered skills
 */

import { readFile, readdir, access, stat } from 'node:fs/promises'
import { resolve, join, dirname, basename } from 'node:path'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parse as parseYaml } from 'yaml'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..', '..', '..', '..')

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ValidationResult {
  name: string
  path: string
  valid: boolean
  errors: string[]
  warnings: string[]
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export default async function skillValidate(args: string[]): Promise<void> {
  const target = args.filter((a) => !a.startsWith('--'))[0]
  const json = args.includes('--json')

  let results: ValidationResult[]

  if (target) {
    // Validate a single skill
    const skillPath = await resolveSkillPath(target)
    if (!skillPath) {
      console.error(`\n  ✗ Skill not found: "${target}"`)
      console.error('    Provide a skill name or path to a skill directory.\n')
      process.exit(1)
    }
    results = [await validateSkill(skillPath)]
  } else {
    // Validate all skills
    const skillDirs = await getSkillDirs()
    results = []
    for (const dir of skillDirs) {
      try {
        const entries = await readdir(dir, { withFileTypes: true })
        for (const entry of entries) {
          if (entry.isDirectory()) {
            const skillMd = join(dir, entry.name, 'SKILL.md')
            if (existsSync(skillMd)) {
              results.push(await validateSkill(join(dir, entry.name)))
            }
          }
        }
      } catch {
        /* dir doesn't exist, skip */
      }
    }
  }

  // Output
  if (json) {
    console.log(JSON.stringify(results, null, 2))
    return
  }

  if (results.length === 0) {
    console.log('\n  No skills found to validate.\n')
    return
  }

  console.log(`\n  Skill Validation Results`)
  console.log('  ' + '─'.repeat(50))

  let totalErrors = 0
  let totalWarnings = 0

  for (const result of results) {
    const icon = result.valid ? '✓' : '✗'
    console.log(`\n  ${icon} ${result.name} (${result.path})`)

    for (const error of result.errors) {
      console.log(`    ✗ ${error}`)
      totalErrors++
    }
    for (const warning of result.warnings) {
      console.log(`    ⚠ ${warning}`)
      totalWarnings++
    }
    if (result.errors.length === 0 && result.warnings.length === 0) {
      console.log('    All checks passed')
    }
  }

  console.log(`\n  ${'─'.repeat(50)}`)
  console.log(`  ${results.length} skills, ${totalErrors} errors, ${totalWarnings} warnings\n`)

  if (totalErrors > 0) process.exit(1)
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

async function validateSkill(skillPath: string): Promise<ValidationResult> {
  const name = basename(skillPath)
  const result: ValidationResult = { name, path: skillPath, valid: true, errors: [], warnings: [] }

  // Check SKILL.md exists
  const skillMd = join(skillPath, 'SKILL.md')
  try {
    await access(skillMd)
  } catch {
    result.errors.push('SKILL.md not found')
    result.valid = false
    return result
  }

  // Read and parse
  const content = await readFile(skillMd, 'utf-8')

  // Check size
  const size = Buffer.byteLength(content, 'utf-8')
  if (size > 50 * 1024) {
    result.warnings.push(`SKILL.md is large: ${(size / 1024).toFixed(1)}KB (recommended < 50KB)`)
  }
  if (size < 50) {
    result.warnings.push('SKILL.md is very short — consider adding more content')
  }

  // Parse frontmatter
  if (content.startsWith('---')) {
    const endIdx = content.indexOf('---', 3)
    if (endIdx === -1) {
      result.errors.push('Frontmatter opening --- without closing ---')
      result.valid = false
      return result
    }

    const frontmatter = content.slice(3, endIdx).trim()
    const parsed: Record<string, string> = {}
    for (const line of frontmatter.split('\n')) {
      const colonIdx = line.indexOf(':')
      if (colonIdx !== -1) {
        parsed[line.slice(0, colonIdx).trim().toLowerCase()] = line.slice(colonIdx + 1).trim()
      }
    }

    // Required fields
    if (!parsed.name) {
      result.errors.push('Frontmatter missing "name" field')
      result.valid = false
    } else if (!/^[a-z0-9-]+$/.test(parsed.name)) {
      result.errors.push(
        `Invalid name: "${parsed.name}" — use lowercase letters, numbers, and hyphens`,
      )
      result.valid = false
    }

    if (!parsed.description) {
      result.warnings.push('Frontmatter missing "description" — skill listing will show name only')
    }

    if (!parsed.triggers) {
      result.warnings.push('Frontmatter missing "triggers" — skill won\'t auto-match user messages')
    } else {
      const triggers = parsed.triggers
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean)
      if (triggers.length < 2) {
        result.warnings.push('Only 1 trigger keyword — consider adding more for better matching')
      }
      if (triggers.length > 20) {
        result.warnings.push(`${triggers.length} trigger keywords — consider narrowing focus`)
      }
    }

    // Optional but recommended
    if (!parsed.version) {
      result.warnings.push('No version field — recommended for tracking changes')
    }
  } else {
    result.warnings.push(
      'No YAML frontmatter — name and triggers will be auto-extracted from content',
    )
  }

  // Check for heading
  if (!content.match(/^#+\s+/m)) {
    result.warnings.push('No markdown heading found')
  }

  // Check references directory if it exists
  const refsDir = join(skillPath, 'references')
  try {
    const refsStat = await stat(refsDir)
    if (refsStat.isDirectory()) {
      const refs = await readdir(refsDir)
      if (refs.length === 0) {
        result.warnings.push('Empty references/ directory')
      }
    }
  } catch {
    /* no refs dir — fine */
  }

  return result
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function resolveSkillPath(target: string): Promise<string | null> {
  // Check if it's a direct path
  if (existsSync(join(target, 'SKILL.md'))) {
    return resolve(target)
  }

  // Search skill directories
  const dirs = await getSkillDirs()
  for (const dir of dirs) {
    const candidate = join(dir, target)
    if (existsSync(join(candidate, 'SKILL.md'))) {
      return candidate
    }
  }
  return null
}

async function getSkillDirs(): Promise<string[]> {
  const dirs: string[] = [resolve(ROOT, 'skills')]
  try {
    const configPaths = ['config.yaml', resolve(process.env.HOME ?? '', '.rivetos', 'config.yaml')]
    for (const configPath of configPaths) {
      if (existsSync(configPath)) {
        const raw = await readFile(configPath, 'utf-8')
        const config = parseYaml(raw) as { runtime?: { skill_dirs?: string[] } } | null
        const configDirs = config?.runtime?.skill_dirs
        if (Array.isArray(configDirs)) {
          dirs.push(...configDirs.map((d: string) => resolve(d)))
        }
        break
      }
    }
  } catch {
    /* fall through */
  }
  return dirs
}
