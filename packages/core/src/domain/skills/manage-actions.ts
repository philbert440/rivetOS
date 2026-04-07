/**
 * Skill manage action handlers — create, edit, patch, delete, retire, read, write_file.
 */

import { readFile, mkdir, rename } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import type { SkillManager } from '@rivetos/types'
import { logger } from '../../logger.js'
import { scanSkillContent } from './security.js'
import {
  ALLOWED_SUBDIRS,
  VALID_NAME_RE,
  atomicWrite,
  readMeta,
  writeMeta,
  listSubdir,
  parsePatchBlocks,
  bumpVersionInContent,
  checkDedup,
  type SkillMeta,
} from './manage-helpers.js'

const log = logger('SkillManage')

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export async function handleCreate(
  manager: SkillManager,
  targetDir: string,
  name: string,
  description: string | undefined,
  content: string | undefined,
  category: string | undefined,
  tags: string | undefined,
  force: boolean,
  embedEndpoint: string | undefined,
): Promise<string> {
  if (!VALID_NAME_RE.test(name)) {
    return `Invalid skill name: "${name}". Must be lowercase letters, digits, hyphens only (1-64 chars, start with letter or digit).`
  }

  const existing = manager.list().find((s) => s.name.toLowerCase() === name.toLowerCase())
  if (existing) {
    return `Skill "${name}" already exists at ${existing.location}`
  }

  // Embedding-based dedup check
  if (embedEndpoint && !force) {
    const desc = description ?? content?.slice(0, 500) ?? name
    const existingSkills = manager.list().map((s) => ({ name: s.name, description: s.description }))

    if (existingSkills.length > 0) {
      const dupMatch = await checkDedup(embedEndpoint, desc, existingSkills)
      if (dupMatch) {
        return (
          `Possible duplicate: "${dupMatch.name}" (similarity: ${dupMatch.similarity.toFixed(2)}). ` +
          `Use a different name, edit the existing skill, or pass force: true to create anyway.`
        )
      }
    }
  }

  // Build SKILL.md content
  let skillContent: string
  if (content) {
    if (!content.startsWith('---')) {
      const fmLines = [`---`, `name: ${name}`]
      if (description) fmLines.push(`description: ${description}`)
      if (category) fmLines.push(`category: ${category}`)
      if (tags) fmLines.push(`tags: ${tags}`)
      fmLines.push(`---`, '')
      skillContent = fmLines.join('\n') + content
    } else {
      skillContent = content
    }
  } else {
    const desc = description ?? `Skill: ${name}`
    const titleCase = name
      .split('-')
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ')
    const fmLines = [`---`, `name: ${name}`, `description: ${desc}`]
    if (category) fmLines.push(`category: ${category}`)
    if (tags) fmLines.push(`tags: ${tags}`)
    fmLines.push(`---`, '', `# ${titleCase}`, '', desc, '')
    skillContent = fmLines.join('\n')
  }

  const scan = scanSkillContent(skillContent)
  if (!scan.safe) {
    return `Security scan failed:\n${scan.issues.map((i) => `  - ${i}`).join('\n')}`
  }

  const skillDir = join(targetDir, name)
  await mkdir(skillDir, { recursive: true })

  const skillMdPath = join(skillDir, 'SKILL.md')
  await atomicWrite(skillMdPath, skillContent)

  const meta: SkillMeta = {
    created_by: 'agent',
    created_at: new Date().toISOString(),
    version: 1,
  }
  await writeMeta(skillDir, meta)
  await manager.rediscover(targetDir)

  log.info(`Created skill: ${name} at ${skillDir}`)
  return `Skill "${name}" created at ${skillDir}`
}

// ---------------------------------------------------------------------------
// Edit
// ---------------------------------------------------------------------------

export async function handleEdit(
  manager: SkillManager,
  name: string,
  content: string | undefined,
  reason?: string,
): Promise<string> {
  if (!content) {
    return 'Edit requires "content" — the new full SKILL.md content.'
  }

  const skill = manager.list().find((s) => s.name === name)
  if (!skill) {
    return `Skill "${name}" not found. Available: ${manager
      .list()
      .map((s) => s.name)
      .join(', ')}`
  }

  const skillDir = dirname(skill.location)
  const meta = (await readMeta(skillDir)) ?? {
    created_by: 'unknown',
    created_at: new Date().toISOString(),
    version: 0,
  }
  meta.version++
  meta.last_modified_at = new Date().toISOString()
  meta.last_modified_by = 'agent'

  const updatedContent = bumpVersionInContent(content, meta.version, reason)

  const scan = scanSkillContent(updatedContent)
  if (!scan.safe) {
    return `Security scan failed:\n${scan.issues.map((i) => `  - ${i}`).join('\n')}`
  }

  await atomicWrite(skill.location, updatedContent)
  await writeMeta(skillDir, meta)

  const parentDir = dirname(skillDir)
  await manager.rediscover(parentDir)

  log.info(`Updated skill: ${name} (version ${String(meta.version)})`)
  return `Skill "${name}" updated (version ${String(meta.version)})`
}

// ---------------------------------------------------------------------------
// Patch
// ---------------------------------------------------------------------------

export async function handlePatch(
  manager: SkillManager,
  name: string,
  patchContent: string | undefined,
  reason?: string,
): Promise<string> {
  if (!patchContent) {
    return 'Patch requires "content" with FIND/REPLACE blocks.'
  }

  const skill = manager.list().find((s) => s.name === name)
  if (!skill) {
    return `Skill "${name}" not found. Available: ${manager
      .list()
      .map((s) => s.name)
      .join(', ')}`
  }

  const blocks = parsePatchBlocks(patchContent)
  if (blocks.length === 0) {
    return 'No valid FIND/REPLACE blocks found in content.'
  }

  let current = await readFile(skill.location, 'utf-8')

  for (const block of blocks) {
    if (!current.includes(block.find)) {
      const preview = block.find.length > 50 ? block.find.slice(0, 50) + '...' : block.find
      return `Patch failed: text not found: "${preview}"`
    }
    current = current.replace(block.find, block.replace)
  }

  const skillDir = dirname(skill.location)
  const meta = (await readMeta(skillDir)) ?? {
    created_by: 'unknown',
    created_at: new Date().toISOString(),
    version: 0,
  }
  meta.version++
  meta.last_modified_at = new Date().toISOString()
  meta.last_modified_by = 'agent'

  current = bumpVersionInContent(current, meta.version, reason)

  const scan = scanSkillContent(current)
  if (!scan.safe) {
    return `Security scan failed after patching:\n${scan.issues.map((i) => `  - ${i}`).join('\n')}`
  }

  await atomicWrite(skill.location, current)
  await writeMeta(skillDir, meta)

  const parentDir = dirname(skillDir)
  await manager.rediscover(parentDir)

  log.info(`Patched skill: ${name} (${String(blocks.length)} replacements)`)
  return `Skill "${name}" patched (${String(blocks.length)} replacements, version ${String(meta.version)})`
}

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

export async function handleDelete(manager: SkillManager, name: string): Promise<string> {
  const skill = manager.list().find((s) => s.name === name)
  if (!skill) {
    return `Skill "${name}" not found. Available: ${manager
      .list()
      .map((s) => s.name)
      .join(', ')}`
  }

  const skillDir = dirname(skill.location)
  const parentDir = dirname(skillDir)

  const trashDir = join(parentDir, '.trash')
  await mkdir(trashDir, { recursive: true })

  const trashName = `${name}-${String(Date.now())}`
  const trashPath = join(trashDir, trashName)
  await rename(skillDir, trashPath)

  await manager.rediscover(parentDir)

  log.info(`Deleted skill: ${name} → .trash/${trashName}`)
  return `Skill "${name}" moved to trash (.trash/${trashName})`
}

// ---------------------------------------------------------------------------
// Retire
// ---------------------------------------------------------------------------

export async function handleRetire(
  manager: SkillManager,
  name: string,
  reason: string | undefined,
  skillDirs: string[],
): Promise<string> {
  const skill = manager.list().find((s) => s.name === name)
  if (!skill) {
    return `Skill "${name}" not found. Available: ${manager
      .list()
      .map((s) => s.name)
      .join(', ')}`
  }

  const skillDir = dirname(skill.location)
  const parentDir = dirname(skillDir)

  const retiredDir = join(skillDirs[0], 'retired')
  await mkdir(retiredDir, { recursive: true })

  const retiredPath = join(retiredDir, name)

  const meta = (await readMeta(skillDir)) ?? {
    created_by: 'unknown',
    created_at: new Date().toISOString(),
    version: 1,
  }
  meta.last_modified_at = new Date().toISOString()
  meta.last_modified_by = 'agent'
  meta.retired_at = new Date().toISOString()
  meta.retired_reason = reason ?? 'No longer useful'
  await writeMeta(skillDir, meta)

  await rename(skillDir, retiredPath)
  await manager.rediscover(parentDir)

  log.info(`Retired skill: ${name} → retired/${name}`)
  return `Skill "${name}" retired to ${retiredPath}${reason ? ` (reason: ${reason})` : ''}`
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

export async function handleRead(
  manager: SkillManager,
  name: string,
  level: number,
): Promise<string> {
  const skill = manager.list().find((s) => s.name === name)
  if (!skill) {
    return `Skill "${name}" not found. Available: ${manager
      .list()
      .map((s) => s.name)
      .join(', ')}`
  }

  const content = await readFile(skill.location, 'utf-8')
  const skillDir = dirname(skill.location)

  const files: string[] = []
  for (const subdir of ALLOWED_SUBDIRS) {
    const subFiles = await listSubdir(skillDir, subdir)
    files.push(...subFiles)
  }

  let result = `## ${name}\n\n${content}`
  if (files.length > 0) {
    result += `\n\n## Supporting Files\n${files.map((f) => `- ${f}`).join('\n')}`
  }

  const meta = await readMeta(skillDir)
  if (meta) {
    result += `\n\n## Metadata\n- Version: ${String(meta.version)}\n- Created: ${meta.created_at}\n- By: ${meta.created_by}`
    if (meta.last_modified_at) {
      result += `\n- Modified: ${meta.last_modified_at}`
    }
  }

  if (level >= 2 && files.length > 0) {
    result += '\n\n## File Contents'
    for (const filePath of files) {
      try {
        const fileContent = await readFile(join(skillDir, filePath), 'utf-8')
        result += `\n\n### ${filePath}\n\`\`\`\n${fileContent}\n\`\`\``
      } catch {
        result += `\n\n### ${filePath}\n*(unable to read)*`
      }
    }
  }

  return result
}

// ---------------------------------------------------------------------------
// Write File
// ---------------------------------------------------------------------------

export async function handleWriteFile(
  manager: SkillManager,
  name: string,
  filePath: string | undefined,
  fileContent: string | undefined,
): Promise<string> {
  if (!filePath || !fileContent) {
    return 'write_file requires both "file_path" and "file_content".'
  }

  const skill = manager.list().find((s) => s.name === name)
  if (!skill) {
    return `Skill "${name}" not found. Available: ${manager
      .list()
      .map((s) => s.name)
      .join(', ')}`
  }

  const normalizedPath = filePath.replace(/\\/g, '/')
  const firstSegment = normalizedPath.split('/')[0]
  if (!ALLOWED_SUBDIRS.includes(firstSegment)) {
    return `Invalid file path: "${filePath}". Must be under: ${ALLOWED_SUBDIRS.join(', ')}`
  }

  if (normalizedPath.includes('..')) {
    return `Invalid file path: "${filePath}". Path traversal not allowed.`
  }

  const scan = scanSkillContent(fileContent)
  if (!scan.safe) {
    return `Security scan failed:\n${scan.issues.map((i) => `  - ${i}`).join('\n')}`
  }

  const skillDir = dirname(skill.location)
  const fullPath = join(skillDir, normalizedPath)

  await mkdir(dirname(fullPath), { recursive: true })
  await atomicWrite(fullPath, fileContent)

  log.info(`Wrote file: ${name}/${filePath}`)
  return `File written: ${name}/${filePath}`
}
