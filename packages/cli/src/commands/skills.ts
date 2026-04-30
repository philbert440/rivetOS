/**
 * rivetos skills <subcommand>
 *
 * Discover and inspect skills.
 *
 * Usage:
 *   rivetos skills list       Show all discovered skills with descriptions and trigger counts
 */

import { readFile, readdir, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { parse as parseYaml } from 'yaml'

// ---------------------------------------------------------------------------
// Skill discovery (mirrors SkillManagerImpl.discover from core)
// ---------------------------------------------------------------------------

interface DiscoveredSkill {
  name: string
  description: string
  location: string
  triggerCount: number
}

/**
 * Parse frontmatter from SKILL.md — supports YAML delimiters and quoted values.
 */
function parseFrontmatter(content: string): {
  name?: string
  description?: string
  triggers?: string[]
} {
  const result: { name?: string; description?: string; triggers?: string[] } = {}

  if (content.startsWith('---')) {
    const endIdx = content.indexOf('---', 3)
    if (endIdx !== -1) {
      const fmBlock = content.slice(3, endIdx).trim()

      // Try YAML parse first for complex frontmatter
      try {
        const parsed = parseYaml(fmBlock) as Record<string, unknown>
        if (parsed.name && typeof parsed.name === 'string') result.name = parsed.name
        if (parsed.description && typeof parsed.description === 'string') {
          // Strip quotes if present
          result.description = parsed.description.replace(/^["']|["']$/g, '')
        }
        if (parsed.triggers) {
          if (typeof parsed.triggers === 'string') {
            result.triggers = parsed.triggers
              .split(',')
              .map((t: string) => t.trim().toLowerCase())
              .filter(Boolean)
          } else if (Array.isArray(parsed.triggers)) {
            result.triggers = parsed.triggers
              .map((t: unknown) => String(t).trim().toLowerCase())
              .filter(Boolean)
          }
        }
        return result
      } catch {
        // Fall through to line-by-line parsing
      }

      // Line-by-line fallback
      for (const line of fmBlock.split('\n')) {
        const colonIdx = line.indexOf(':')
        if (colonIdx === -1) continue
        const key = line.slice(0, colonIdx).trim().toLowerCase()
        const value = line
          .slice(colonIdx + 1)
          .trim()
          .replace(/^["']|["']$/g, '')

        switch (key) {
          case 'name':
            result.name = value
            break
          case 'description':
            result.description = value
            break
          case 'triggers':
            result.triggers = value
              .split(',')
              .map((t) => t.trim().toLowerCase())
              .filter(Boolean)
            break
        }
      }
      return result
    }
  }

  // No frontmatter — extract from markdown
  const lines = content.split('\n')
  for (const line of lines) {
    const trimmed = line.trim()
    if (!result.name && trimmed.startsWith('#')) {
      result.name = trimmed.replace(/^#+\s*/, '').trim()
      continue
    }
    if (result.name && !result.description && trimmed && !trimmed.startsWith('#')) {
      result.description = trimmed
      break
    }
  }

  return result
}

/**
 * Count triggers from description text (same logic as core SkillManager).
 */
function countTriggersFromDescription(description: string): number {
  const stopWords = new Set([
    'a',
    'an',
    'the',
    'is',
    'are',
    'was',
    'were',
    'be',
    'been',
    'being',
    'have',
    'has',
    'had',
    'do',
    'does',
    'did',
    'will',
    'would',
    'could',
    'should',
    'may',
    'might',
    'can',
    'shall',
    'to',
    'of',
    'in',
    'for',
    'on',
    'with',
    'at',
    'by',
    'from',
    'as',
    'into',
    'about',
    'like',
    'through',
    'after',
    'over',
    'between',
    'out',
    'against',
    'during',
    'without',
    'before',
    'under',
    'around',
    'among',
    'and',
    'but',
    'or',
    'nor',
    'not',
    'so',
    'yet',
    'both',
    'either',
    'neither',
    'each',
    'every',
    'all',
    'any',
    'few',
    'more',
    'most',
    'other',
    'some',
    'such',
    'no',
    'only',
    'own',
    'same',
    'than',
    'too',
    'very',
    'just',
    'because',
    'this',
    'that',
    'these',
    'those',
    'it',
    'its',
    'use',
    'when',
    'what',
    'how',
    'where',
    'which',
    'who',
    'whom',
    'why',
    'if',
    'then',
    'else',
    'also',
    'up',
    'down',
  ])

  return description
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !stopWords.has(w)).length
}

async function discoverSkills(skillDirs: string[]): Promise<DiscoveredSkill[]> {
  const skills: DiscoveredSkill[] = []

  for (const dir of skillDirs) {
    try {
      const entries = await readdir(dir, { withFileTypes: true })
      for (const entry of entries) {
        if (!entry.isDirectory()) continue

        const skillMdPath = join(dir, entry.name, 'SKILL.md')
        try {
          await stat(skillMdPath)
        } catch {
          continue
        }

        try {
          const content = await readFile(skillMdPath, 'utf-8')
          const fm = parseFrontmatter(content)
          const name = fm.name ?? entry.name

          // Count triggers: explicit + extracted from description + name
          let triggerCount = (fm.triggers?.length ?? 0) + 1 // +1 for name
          if (fm.description) {
            triggerCount += countTriggersFromDescription(fm.description)
          }

          skills.push({
            name,
            description: fm.description ?? `Skill: ${name}`,
            location: skillMdPath,
            triggerCount,
          })
        } catch {
          // Failed to parse — skip
        }
      }
    } catch {
      // Directory doesn't exist — skip
    }
  }

  return skills.sort((a, b) => a.name.localeCompare(b.name))
}

// ---------------------------------------------------------------------------
// Config loading (lightweight — just reads YAML, no env resolution needed)
// ---------------------------------------------------------------------------

async function getSkillDirs(): Promise<string[]> {
  const configPath = resolve(process.env.HOME ?? '.', '.rivetos', 'config.yaml')
  const defaults = [resolve(process.env.HOME ?? '.', '.rivetos', 'workspace', 'skills')]

  try {
    const raw = await readFile(configPath, 'utf-8')
    const config = parseYaml(raw) as Record<string, unknown>
    const runtime = config.runtime as Record<string, unknown> | undefined
    const dirs = runtime?.skill_dirs as string[] | undefined
    if (dirs && dirs.length > 0) {
      return dirs.map((d) => d.replace('~', process.env.HOME ?? '.'))
    }
  } catch {
    /* expected */
  }

  return defaults
}

// ---------------------------------------------------------------------------
// Command handler
// ---------------------------------------------------------------------------

export default async function skills(): Promise<void> {
  const subcommand = process.argv[3]

  if (!subcommand || subcommand === 'help') {
    console.log('Usage: rivetos skills <subcommand>')
    console.log('')
    console.log('Subcommands:')
    console.log('  list       Show all discovered skills')
    return
  }

  switch (subcommand) {
    case 'list': {
      const dirs = await getSkillDirs()
      const discovered = await discoverSkills(dirs)

      if (discovered.length === 0) {
        console.log('No skills found.')
        console.log('')
        console.log(`Searched directories:`)
        for (const d of dirs) {
          console.log(`  ${d}`)
        }
        console.log('')
        console.log('Skills are directories containing a SKILL.md file.')
        return
      }

      console.log(`Found ${discovered.length} skills:\n`)

      // Calculate column widths
      const maxName = Math.max(...discovered.map((s) => s.name.length), 4)
      const maxTriggers = 8 // "Triggers" header

      // Header
      const header = `  ${'Name'.padEnd(maxName)}  ${'Triggers'.padEnd(maxTriggers)}  Description`
      const separator = `  ${'─'.repeat(maxName)}  ${'─'.repeat(maxTriggers)}  ${'─'.repeat(40)}`
      console.log(header)
      console.log(separator)

      for (const skill of discovered) {
        const triggerStr = String(skill.triggerCount).padEnd(maxTriggers)
        // Truncate description to fit terminal
        const maxDesc = Math.max(
          ((process.stdout.columns as number | undefined) ?? 100) - maxName - maxTriggers - 8,
          20,
        )
        const desc =
          skill.description.length > maxDesc
            ? skill.description.slice(0, maxDesc - 1) + '…'
            : skill.description
        console.log(`  ${skill.name.padEnd(maxName)}  ${triggerStr}  ${desc}`)
      }

      console.log('')
      console.log(`Searched: ${dirs.join(', ')}`)
      break
    }

    default:
      console.error(`Unknown subcommand: ${subcommand}`)
      process.exit(1)
  }
}
