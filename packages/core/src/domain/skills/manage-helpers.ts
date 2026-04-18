/**
 * Skill management helpers — atomic writes, metadata, patching, dedup, changelog.
 */

import { readFile, writeFile, readdir, rename } from 'node:fs/promises'
import { join } from 'node:path'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Allowed subdirectories for supporting files */
export const ALLOWED_SUBDIRS = ['references', 'scripts', 'assets', 'templates']

/** Valid skill name: lowercase letters, digits, hyphens, 1-64 chars */
export const VALID_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/

/** Cosine similarity threshold for dedup warnings */
export const DEDUP_THRESHOLD = 0.85

// ---------------------------------------------------------------------------
// Provenance metadata
// ---------------------------------------------------------------------------

export interface SkillMeta {
  created_by: string
  created_at: string
  source?: string
  version: number
  last_modified_at?: string
  last_modified_by?: string
  retired_at?: string
  retired_reason?: string
}

// ---------------------------------------------------------------------------
// File operations
// ---------------------------------------------------------------------------

/** Atomic write — write to .tmp then rename. Never leaves a half-written file. */
export async function atomicWrite(filePath: string, content: string): Promise<void> {
  const tmpPath = filePath + '.tmp'
  await writeFile(tmpPath, content, 'utf-8')
  await rename(tmpPath, filePath)
}

/** Read and parse _meta.json from a skill directory, or return null. */
export async function readMeta(skillDir: string): Promise<SkillMeta | null> {
  try {
    const raw = await readFile(join(skillDir, '_meta.json'), 'utf-8')
    return JSON.parse(raw) as SkillMeta
  } catch {
    return null
  }
}

/** Write _meta.json to a skill directory. */
export async function writeMeta(skillDir: string, meta: SkillMeta): Promise<void> {
  await atomicWrite(join(skillDir, '_meta.json'), JSON.stringify(meta, null, 2) + '\n')
}

/** List files in a subdirectory, returning relative paths. */
export async function listSubdir(skillDir: string, subdir: string): Promise<string[]> {
  const dirPath = join(skillDir, subdir)
  try {
    const entries = await readdir(dirPath, { withFileTypes: true })
    return entries.filter((e) => e.isFile()).map((e) => join(subdir, e.name))
  } catch {
    return []
  }
}

// ---------------------------------------------------------------------------
// Patch parsing
// ---------------------------------------------------------------------------

/**
 * Parse FIND/REPLACE patch blocks from content.
 *
 * Format:
 *   FIND: <exact text>
 *   REPLACE: <replacement>
 *
 * Multiple blocks separated by blank lines.
 */
export function parsePatchBlocks(patchContent: string): Array<{ find: string; replace: string }> {
  const blocks: Array<{ find: string; replace: string }> = []
  const parts = patchContent.split(/(?=^FIND:)/m).filter((p) => p.trim())

  for (const part of parts) {
    const findMatch = part.match(/^FIND:\s*([\s\S]*?)(?=\nREPLACE:)/m)
    const replaceMatch = part.match(/\nREPLACE:\s*([\s\S]*?)$/m)

    if (findMatch && replaceMatch) {
      blocks.push({
        find: findMatch[1].trimEnd(),
        replace: replaceMatch[1].trimEnd(),
      })
    }
  }

  return blocks
}

// ---------------------------------------------------------------------------
// Changelog helpers
// ---------------------------------------------------------------------------

/** Build a changelog entry line */
export function changelogEntry(version: number, reason?: string): string {
  const date = new Date().toISOString().slice(0, 10)
  const msg = reason ?? 'Updated'
  return `- **v${String(version)}** (${date}): ${msg}`
}

/**
 * Bump the version in YAML frontmatter. If no version field exists, adds one.
 * Also appends a changelog entry to the end of the content.
 */
export function bumpVersionInContent(content: string, newVersion: number, reason?: string): string {
  let updated = content

  // Update or insert version in frontmatter
  if (content.startsWith('---')) {
    const endIdx = content.indexOf('---', 3)
    if (endIdx !== -1) {
      const frontmatter = content.slice(3, endIdx)
      const afterFm = content.slice(endIdx)

      if (/^version:\s*\d+/m.test(frontmatter)) {
        const newFm = frontmatter.replace(/^version:\s*\d+/m, `version: ${String(newVersion)}`)
        updated = '---' + newFm + afterFm
      } else {
        updated = '---' + frontmatter + `version: ${String(newVersion)}\n` + afterFm
      }
    }
  }

  // Append or extend changelog section
  const entry = changelogEntry(newVersion, reason)
  if (updated.includes('## Changelog')) {
    updated = updated.replace(/(## Changelog\n)/, `$1${entry}\n`)
  } else {
    updated = updated.trimEnd() + `\n\n## Changelog\n${entry}\n`
  }

  return updated
}

// ---------------------------------------------------------------------------
// Embedding helpers for dedup
// ---------------------------------------------------------------------------

/** Embed a single text via the embedding endpoint. Returns null on failure. */
export async function embedText(endpoint: string, text: string): Promise<number[] | null> {
  try {
    const response = await fetch(`${endpoint}/v1/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: text.slice(0, 8000), model: 'nemotron' }),
      signal: AbortSignal.timeout(10_000),
    })

    if (!response.ok) return null

    const data = (await response.json()) as {
      data?: Array<{ embedding?: number[] }>
    }

    const vec = data.data?.[0]?.embedding
    if (!vec) return null
    // Match stored-vector dim (pgvector halfvec 4000 cap). Nemotron returns 4096.
    const EMBED_DIMS = 4000
    return vec.length > EMBED_DIMS ? vec.slice(0, EMBED_DIMS) : vec
  } catch {
    return null
  }
}

/** Cosine similarity between two vectors. Returns 0 if either is empty. */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) return 0

  let dot = 0
  let normA = 0
  let normB = 0

  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }

  const denom = Math.sqrt(normA) * Math.sqrt(normB)
  return denom === 0 ? 0 : dot / denom
}

/**
 * Check if a new skill description is too similar to existing skills.
 * Returns the most similar skill info if above threshold, or null.
 */
export async function checkDedup(
  endpoint: string,
  newDescription: string,
  existingSkills: Array<{ name: string; description: string }>,
): Promise<{ name: string; similarity: number } | null> {
  const newVec = await embedText(endpoint, newDescription)
  if (!newVec) return null

  let bestMatch: { name: string; similarity: number } | null = null

  for (const skill of existingSkills) {
    const existingVec = await embedText(endpoint, skill.description)
    if (!existingVec) continue

    const sim = cosineSimilarity(newVec, existingVec)
    if (sim > DEDUP_THRESHOLD && (!bestMatch || sim > bestMatch.similarity)) {
      bestMatch = { name: skill.name, similarity: sim }
    }
  }

  return bestMatch
}
