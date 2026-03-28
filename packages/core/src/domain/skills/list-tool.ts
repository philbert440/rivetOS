/**
 * skill_list tool — Level 0 progressive disclosure.
 *
 * Returns all discovered skills with name, description, version, and
 * supporting file count. Lightweight enough to include in every prompt.
 */

import { readFile, readdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import type { Skill, SkillManager, Tool } from '@rivetos/types'

/** Allowed subdirectories for supporting files */
const ALLOWED_SUBDIRS = ['references', 'scripts', 'assets', 'templates']

/** Read _meta.json version, or return null */
async function getVersion(skill: Skill): Promise<number | null> {
  try {
    const raw = await readFile(join(dirname(skill.location), '_meta.json'), 'utf-8')
    const meta = JSON.parse(raw) as { version?: number }
    return meta.version ?? null
  } catch {
    return null
  }
}

/** Count supporting files across allowed subdirs */
async function countSupportingFiles(skill: Skill): Promise<number> {
  const skillDir = dirname(skill.location)
  let count = 0
  for (const subdir of ALLOWED_SUBDIRS) {
    try {
      const entries = await readdir(join(skillDir, subdir), { withFileTypes: true })
      count += entries.filter((e) => e.isFile()).length
    } catch {
      // Subdir doesn't exist — fine
    }
  }
  return count
}

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

      const lines: string[] = []
      for (const s of skills) {
        const version = await getVersion(s)
        const fileCount = await countSupportingFiles(s)

        let suffix = ''
        const parts: string[] = []
        if (version !== null) parts.push(`v${String(version)}`)
        if (fileCount > 0) parts.push(`${String(fileCount)} file${fileCount > 1 ? 's' : ''}`)
        if (parts.length > 0) suffix = ` [${parts.join(', ')}]`

        lines.push(`**${s.name}** — ${s.description}${suffix}`)
      }

      return lines.join('\n')
    },
  }
}
