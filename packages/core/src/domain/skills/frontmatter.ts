/**
 * Frontmatter parsing for SKILL.md files.
 *
 * Parses YAML-ish frontmatter (name, description, triggers) or
 * falls back to extracting from markdown headings and first paragraph.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ParsedFrontmatter {
  name?: string
  description?: string
  triggers?: string[]
  version?: number
  category?: string
  tags?: string[]
}

// ---------------------------------------------------------------------------
// Stop words for trigger extraction
// ---------------------------------------------------------------------------

const STOP_WORDS = new Set([
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

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

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
export function parseFrontmatter(content: string): ParsedFrontmatter {
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
          case 'version': {
            const parsed = parseInt(value, 10)
            if (!isNaN(parsed)) result.version = parsed
            break
          }
          case 'category':
            result.category = value
            break
          case 'tags':
            result.tags = value
              .split(',')
              .map((t) => t.trim())
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
export function extractTriggersFromDescription(description: string): string[] {
  return description
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w))
}
