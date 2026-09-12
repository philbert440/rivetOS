import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { validateSkill } from './skill-validate.js'

// packages/cli/src/commands/ -> repo root
const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url))

async function findSkillFiles(dir: string): Promise<string[]> {
  const found: string[] = []
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return found
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      found.push(...(await findSkillFiles(path)))
    } else if (entry.name === 'SKILL.md') {
      found.push(path)
    }
  }
  return found
}

describe('validateSkill frontmatter', () => {
  it('rejects a single-quoted description with a backslash-escaped apostrophe', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rivetos-skill-'))
    try {
      await writeFile(
        join(dir, 'SKILL.md'),
        [
          '---',
          'name: broken-skill',
          "description: 'it\\'s broken'",
          '---',
          '',
          '# Broken',
          '',
        ].join('\n'),
      )

      const result = await validateSkill(dir)

      expect(result.valid).toBe(false)
      expect(result.errors.join('\n')).toMatch(/not valid YAML/i)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('accepts a correctly escaped apostrophe', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rivetos-skill-'))
    try {
      await writeFile(
        join(dir, 'SKILL.md'),
        [
          '---',
          'name: good-skill',
          "description: 'it''s fine'",
          'version: 1',
          '---',
          '',
          '# Good',
          '',
        ].join('\n'),
      )

      const result = await validateSkill(dir)

      expect(result.errors).toEqual([])
      expect(result.valid).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('shipped integration skills', () => {
  it('all have frontmatter that strict YAML harnesses can load', async () => {
    const files = await findSkillFiles(join(REPO_ROOT, 'integrations'))
    expect(files.length).toBeGreaterThan(0)

    const failures: string[] = []
    for (const file of files) {
      const result = await validateSkill(dirname(file))
      if (!result.valid) failures.push(`${file}: ${result.errors.join('; ')}`)
    }

    expect(failures).toEqual([])
  })
})
