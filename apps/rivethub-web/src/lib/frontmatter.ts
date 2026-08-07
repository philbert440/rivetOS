/**
 * YAML frontmatter split/join for agents/*.md — mirrors
 * packages/workflows/src/loader.ts parseFrontmatter semantics (BOM/CRLF
 * tolerant; opening fence without close throws).
 *
 * Pure string helpers; callers that need structured config parse the
 * frontmatter block with `yaml` separately.
 */

export interface FrontmatterSplit {
  /** Raw YAML between fences (no ---); empty string when fence present but empty. */
  yaml: string | null
  /** Markdown body after the closing fence (or the whole file when no frontmatter). */
  body: string
  /** True when the file opened with a --- fence. */
  hasFrontmatter: boolean
}

/**
 * Split optional `---` YAML frontmatter from a markdown body.
 * Tolerates BOM and leading whitespace before the opening fence.
 * An opening fence without a closing fence throws.
 */
export function splitFrontmatter(text: string): FrontmatterSplit {
  const src = text.replace(/^\uFEFF/, '').replace(/^\s+(?=---)/, '')
  if (!/^---[ \t]*\r?\n/.test(src)) {
    return { yaml: null, body: src, hasFrontmatter: false }
  }
  const closeMatch = /\r?\n---[ \t]*(\r?\n|$)/.exec(src)
  if (!closeMatch) {
    throw new Error('Unterminated frontmatter (missing closing ---)')
  }
  const yamlStart = src.indexOf('\n') + 1
  const rawYaml = src.slice(yamlStart, closeMatch.index)
  const body = src.slice(closeMatch.index + closeMatch[0].length)
  return { yaml: rawYaml, body, hasFrontmatter: true }
}

/**
 * Join a YAML frontmatter block + body back into an agents/*.md file.
 * When `yaml` is null/undefined, emits body only (no fences).
 * Ensures a trailing newline on the closed fence section.
 */
export function joinFrontmatter(yaml: string | null | undefined, body: string): string {
  if (yaml === null || yaml === undefined) {
    return body
  }
  const y = yaml.replace(/\r\n/g, '\n').replace(/\s+$/, '')
  const b = body.replace(/^\uFEFF/, '')
  // Prefer a blank line after the closing fence when body is non-empty and
  // doesn't already start with a newline — matches common agent file style.
  const bodyOut = b.length === 0 || b.startsWith('\n') ? b : `\n${b}`
  return `---\n${y}\n---${bodyOut.startsWith('\n') ? bodyOut : `\n${bodyOut}`}`
}

/** Structured agent frontmatter fields the overlay edits. */
export interface AgentFrontmatterFields {
  model?: string
  maxTurns?: number
  tools?: string[]
  /** Unknown keys preserved as parsed values for round-trip. */
  extras?: Record<string, unknown>
}

/**
 * Parse frontmatter YAML text into known agent fields + extras.
 * Accepts a pre-parsed object (from yaml.parse) to keep this pure of the
 * yaml dependency in unit tests that pass objects directly.
 */
export function agentFieldsFromConfig(raw: unknown): AgentFrontmatterFields {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { extras: {} }
  }
  const o = raw as Record<string, unknown>
  const extras: Record<string, unknown> = {}
  let model: string | undefined
  let maxTurns: number | undefined
  let tools: string[] | undefined

  for (const [k, v] of Object.entries(o)) {
    if (k === 'model' && typeof v === 'string') {
      model = v
    } else if (k === 'maxTurns' && typeof v === 'number' && Number.isFinite(v)) {
      maxTurns = v
    } else if (k === 'tools' && Array.isArray(v) && v.every((x) => typeof x === 'string')) {
      tools = v
    } else {
      extras[k] = v
    }
  }
  return { model, maxTurns, tools, extras }
}

/** Build a config object for YAML serialization from agent fields. */
export function configFromAgentFields(fields: AgentFrontmatterFields): Record<string, unknown> {
  const out: Record<string, unknown> = { ...(fields.extras ?? {}) }
  if (fields.tools !== undefined) out.tools = fields.tools
  if (fields.model !== undefined && fields.model !== '') out.model = fields.model
  else delete out.model
  if (fields.maxTurns !== undefined && Number.isFinite(fields.maxTurns)) {
    out.maxTurns = fields.maxTurns
  } else {
    delete out.maxTurns
  }
  return out
}
