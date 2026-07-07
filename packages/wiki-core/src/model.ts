/**
 * Memory wiki page model (phase 3a) — the shared contract between the
 * extraction worker (writes), the gateway wiki API (reads), and the MCP
 * tools. One markdown file per topic under /rivet-shared/wiki/topics/:
 * YAML frontmatter, a single replaceable "## Current state" section, and an
 * append-only dated "## History".
 *
 * Design: /rivet-shared/plans/phase-3-memory-wiki-design.md (§1).
 * Auto-merge everywhere (Phil 2026-07-07): prior Current state — human or
 * automated — archives to History on update; nothing is frozen.
 */

/** Provenance back to the memory store. PG UUIDs are canonical; the git sha
 *  on the topic row is supplementary (file-snapshot pointer). */
export interface WikiSource {
  kind: 'summary' | 'message' | 'conversation' | 'task'
  ids: string[]
  /** Optional conversation the ids belong to (summary/message kinds). */
  conversationId?: string
  /** Time span the sourced content covers (ISO). */
  span?: { earliest: string; latest: string }
}

export interface WikiFrontmatter {
  title: string
  slug: string
  aliases: string[]
  tags: string[]
  entities: string[]
  /** ISO timestamp of the last extraction that verified Current state. */
  lastVerified?: string
  sources: WikiSource[]
  /** Unknown frontmatter keys — preserved verbatim (forward compat). */
  extra?: Record<string, unknown>
}

export interface WikiHistoryEntry {
  /** YYYY-MM-DD (heading date). */
  date: string
  /** Heading text after the date (e.g. "Phase 1 cutover shipped"). */
  title: string
  /** Markdown body of the entry (bullets etc., provenance line included). */
  body: string
}

export interface WikiPage {
  meta: WikiFrontmatter
  /** Markdown body of the "## Current state" section (no heading). */
  currentState: string
  /** Newest-first dated entries under "## History". */
  history: WikiHistoryEntry[]
  /** Body text before the first "##" heading — preserved verbatim. */
  preamble?: string
  /** Sections other than Current state/History — preserved verbatim. */
  extraSections?: Array<{ heading: string; body: string }>
}

/**
 * A structured patch from the extractor LLM, applied by applyPatch().
 * 'create' seeds a new page; 'update' replaces Current state (archiving the
 * prior one as a dated History entry when it changed) and/or appends a
 * History entry.
 */
export interface WikiPatch {
  action: 'create' | 'update'
  slug: string
  title?: string
  addAliases?: string[]
  addTags?: string[]
  addEntities?: string[]
  /** Full replacement Current state (markdown, no heading). */
  currentState?: string
  historyEntry?: WikiHistoryEntry
  addSources?: WikiSource[]
  /** ISO timestamp stamped into lastVerified. */
  verifiedAt: string
}

/** Slug rules: lowercase kebab, [a-z0-9-], no leading/trailing dash. */
export function normalizeSlug(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
}
