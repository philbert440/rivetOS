/**
 * Skill Manager — discovers, loads, and matches skills.
 *
 * Skills are directories containing a SKILL.md file. The first few lines
 * are parsed for frontmatter (name, description, triggers) or extracted
 * from the markdown content.
 *
 * Matching uses keyword/trigger overlap scoring against user messages.
 */

import { readFile, readdir, stat } from 'node:fs/promises'
import { join, basename } from 'node:path'
import type { Skill, SkillManager, Tool } from '@rivetos/types'
import { logger } from '../logger.js'

const log = logger('SkillManager')

// ---------------------------------------------------------------------------
// Frontmatter parsing
// ---------------------------------------------------------------------------

interface ParsedFrontmatter {
  name?: string
  description?: string
  triggers?: string[]
}

/**
 * Parse YAML-ish frontmatter from the beginning of a SKILL.md file.
 * Supports:
 *   ---
 *   name: my-skill
 *   description: Does things
 *   triggers: keyword1, keyword2, keyword3
 *   ---
 *
 * Falls back to extracting from markdown headings and first paragraph.
 */
function parseFrontmatter(content: string): ParsedFrontmatter {
  const result: ParsedFrontmatter = {}

  // Check for YAML frontmatter delimiters
  if (content.startsWith('---')) {
    const endIdx = content.indexOf('---', 3)
    if (endIdx !== -1) {
      const frontmatter = content.slice(3, endIdx).trim()
      for (const line of frontmatter.split('\n')) {
        const colonIdx = line.indexOf(':')
        if (colonIdx === -1) continue
        const key = line.slice(0, colonIdx).trim().toLowerCase()
        const value = line.slice(colonIdx + 1).trim()

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

  // No frontmatter — extract from markdown content
  const lines = content.split('\n')
  for (const line of lines) {
    const trimmed = line.trim()
    // First heading as name
    if (!result.name && trimmed.startsWith('#')) {
      result.name = trimmed.replace(/^#+\s*/, '').trim()
      continue
    }
    // First non-empty, non-heading line as description
    if (result.name && !result.description && trimmed && !trimmed.startsWith('#')) {
      result.description = trimmed
      break
    }
  }

  return result
}

/**
 * Extract trigger keywords from description text.
 * Splits on common delimiters and filters short/common words.
 */
function extractTriggersFromDescription(description: string): string[] {
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
    .filter((w) => w.length > 2 && !stopWords.has(w))
}

// ---------------------------------------------------------------------------
// Skill Manager Implementation
// ---------------------------------------------------------------------------

export class SkillManagerImpl implements SkillManager {
  private skills: Map<string, Skill> = new Map()

  async discover(skillDirs: string[]): Promise<Skill[]> {
    this.skills.clear()

    for (const dir of skillDirs) {
      try {
        const entries = await readdir(dir, { withFileTypes: true })
        for (const entry of entries) {
          if (!entry.isDirectory()) continue

          const skillMdPath = join(dir, entry.name, 'SKILL.md')
          try {
            await stat(skillMdPath)
          } catch {
            continue // No SKILL.md — skip
          }

          try {
            const content = await readFile(skillMdPath, 'utf-8')
            const frontmatter = parseFrontmatter(content)
            const name = frontmatter.name ?? entry.name

            // Build triggers: explicit triggers + extracted from description
            let triggers = frontmatter.triggers ?? []
            if (frontmatter.description) {
              const extracted = extractTriggersFromDescription(frontmatter.description)
              triggers = [...new Set([...triggers, ...extracted])]
            }
            // Always include the skill name as a trigger
            triggers = [...new Set([...triggers, name.toLowerCase()])]

            const skill: Skill = {
              name,
              description: frontmatter.description ?? `Skill: ${name}`,
              location: skillMdPath,
              triggers,
            }

            this.skills.set(name, skill)
            log.debug(`Discovered skill: ${name} (${triggers.length} triggers)`)
          } catch (err: any) {
            log.warn(`Failed to parse skill at ${skillMdPath}: ${err.message}`)
          }
        }
      } catch (err: any) {
        // Directory doesn't exist — that's fine
        log.debug(`Skill directory not found: ${dir}`)
      }
    }

    log.info(`Discovered ${this.skills.size} skills`)
    return this.list()
  }

  async load(skillName: string): Promise<string> {
    const skill = this.skills.get(skillName)
    if (!skill) {
      throw new Error(
        `Skill not found: "${skillName}". Available: ${[...this.skills.keys()].join(', ')}`,
      )
    }

    const content = await readFile(skill.location, 'utf-8')
    return content
  }

  match(query: string): Skill | null {
    if (this.skills.size === 0) return null

    const queryLower = query.toLowerCase()
    const queryWords = queryLower
      .replace(/[^a-z0-9\s-]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 2)

    let bestSkill: Skill | null = null
    let bestScore = 0

    // Minimum score threshold — avoid weak matches
    const MIN_SCORE = 0.15

    for (const skill of this.skills.values()) {
      const triggers = skill.triggers ?? []
      if (triggers.length === 0) continue

      let score = 0

      // Exact name match — strong signal
      if (queryLower.includes(skill.name.toLowerCase())) {
        score += 2.0
      }

      // Trigger word matches
      let triggerHits = 0
      for (const trigger of triggers) {
        // Full trigger phrase match in query
        if (queryLower.includes(trigger)) {
          triggerHits++
          // Longer triggers are more specific = higher value
          score += 0.5 + trigger.length * 0.05
        }
        // Word-level overlap
        for (const word of queryWords) {
          if (trigger === word) {
            triggerHits++
            score += 0.3
          } else if (trigger.includes(word) || word.includes(trigger)) {
            score += 0.1
          }
        }
      }

      // Normalize by trigger count to avoid skills with many triggers dominating
      if (triggers.length > 0) {
        score = score * (1 + triggerHits / triggers.length)
      }

      if (score > bestScore) {
        bestScore = score
        bestSkill = skill
      }
    }

    if (bestScore < MIN_SCORE) {
      return null
    }

    log.debug(`Matched skill "${bestSkill?.name}" with score ${bestScore.toFixed(2)}`)
    return bestSkill
  }

  list(): Skill[] {
    return [...this.skills.values()]
  }
}

// ---------------------------------------------------------------------------
// Skill List Tool
// ---------------------------------------------------------------------------

export function createSkillListTool(manager: SkillManager): Tool {
  return {
    name: 'skill_list',
    description: 'List all available skills with their names and descriptions.',
    parameters: {
      type: 'object',
      properties: {},
    },
    execute: async () => {
      const skills = manager.list()
      if (skills.length === 0) {
        return 'No skills discovered.'
      }
      return skills.map((s) => `**${s.name}**: ${s.description}`).join('\n')
    },
  }
}
