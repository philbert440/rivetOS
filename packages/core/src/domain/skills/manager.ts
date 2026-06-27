/**
 * Skill Manager — discovers, loads, matches, and manages skills.
 *
 * Skills are directories containing a SKILL.md file. The first few lines
 * are parsed for frontmatter (name, description, triggers) or extracted
 * from the markdown content.
 *
 * Matching uses keyword/trigger overlap scoring against user messages.
 */

import { readFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { Skill, SkillManager, HookPipeline, SkillBeforeContext } from '@rivetos/types'
import { logger } from '../../logger.js'
import { parseFrontmatter, extractTriggersFromDescription } from './frontmatter.js'

const log = logger('SkillManager')

export class SkillManagerImpl implements SkillManager {
  private skills: Map<string, Skill> = new Map()
  private pipeline?: HookPipeline
  private _skillDirs: string[] = []

  /** Set the hook pipeline for skill:before/after events (called after boot wiring) */
  setPipeline(pipeline: HookPipeline): void {
    this.pipeline = pipeline
  }

  async discover(skillDirs: string[]): Promise<Skill[]> {
    this.skills.clear()
    this._skillDirs = [...skillDirs]

    for (const dir of skillDirs) {
      await this._scanDir(dir)
    }

    log.info(`Discovered ${this.skills.size} skills`)
    return this.list()
  }

  async rediscover(skillDir: string): Promise<void> {
    // Remove skills whose location is under this dir
    for (const [name, skill] of this.skills.entries()) {
      if (skill.location.startsWith(skillDir)) {
        this.skills.delete(name)
      }
    }
    // Re-scan
    await this._scanDir(skillDir)
    log.info(`Rediscovered skills from ${skillDir} (total: ${this.skills.size})`)
  }

  getSkillDirs(): string[] {
    return [...this._skillDirs]
  }

  async load(skillName: string): Promise<string> {
    const skill = this.skills.get(skillName)
    if (!skill) {
      throw new Error(
        `Skill not found: "${skillName}". Available: ${[...this.skills.keys()].join(', ')}`,
      )
    }

    // Emit skill:before hook
    if (this.pipeline) {
      const ctx: SkillBeforeContext = {
        event: 'skill:before',
        skillName: skill.name,
        skillLocation: skill.location,
        matchedTriggers: skill.triggers ?? [],
        matchScore: 0,
        timestamp: Date.now(),
        metadata: {},
      }
      await this.pipeline.run(ctx)
      if (ctx.skip) {
        throw new Error(`Skill "${skillName}" skipped by hook: ${ctx.skipReason ?? 'no reason'}`)
      }
    }

    const content = await readFile(skill.location, 'utf-8')
    return content
  }

  list(): Skill[] {
    return [...this.skills.values()]
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  private async _scanDir(dir: string): Promise<void> {
    try {
      const entries = await readdir(dir, { withFileTypes: true })
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        // Skip hidden/internal dirs
        if (entry.name.startsWith('.')) continue

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
            version: frontmatter.version,
            category: frontmatter.category,
            tags: frontmatter.tags,
          }

          this.skills.set(name, skill)
          log.debug(`Discovered skill: ${name} (${triggers.length} triggers)`)
        } catch (err: unknown) {
          log.warn(`Failed to parse skill at ${skillMdPath}: ${(err as Error).message}`)
        }
      }
    } catch (_err: unknown) {
      // Directory doesn't exist — that's fine
      log.debug(`Skill directory not found: ${dir}`)
    }
  }
}
