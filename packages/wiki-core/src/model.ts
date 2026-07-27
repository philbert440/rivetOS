/**
 * Memory wiki page model (phase 3a + memory v6 durable topics + v7 articles).
 *
 * Shared contract between the extraction worker (writes), the gateway wiki
 * API (reads), and the MCP tools. One markdown file per durable topic under
 * /rivet-shared/wiki/topics/: YAML frontmatter, ## Summary (lead), optional
 * ## Article (structured body), ## See also, append-only ## History, and
 * ## Citations (leaf summary refs).
 *
 * Design: /rivet-shared/plans/phase-3-memory-wiki-design.md (§1),
 *         /rivet-shared/plans/memory-v6-durable-topics.md,
 *         /rivet-shared/plans/memory-v7-wikipedia-articles.md
 * Auto-merge everywhere (Phil 2026-07-07): prior Summary — human or
 * automated — archives to History on full rewrite; nothing is frozen.
 * v7: prefer summaryDelta + articlePatches so standing knowledge compounds.
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

/**
 * Leaf (or branch/root) summary cited as evidence for this durable topic.
 * Rendered under ## Citations; PG ros_wiki_citations is the index mirror.
 */
export interface WikiCitation {
  /** ros_summaries.id (UUID). */
  summaryId: string
  /** YYYY-MM-DD when known. */
  date?: string
  /** leaf | branch | root */
  kind?: string
  /** Short human label for the contribution. */
  note?: string
}

export interface WikiFrontmatter {
  title: string
  slug: string
  aliases: string[]
  tags: string[]
  entities: string[]
  /** Explicit related topic slugs (see also graph). */
  related: string[]
  /** ISO timestamp of the last extraction that verified Summary. */
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

/** One ### subsection under ## Article. */
export interface WikiArticleSection {
  /** Heading text without ### (e.g. "Configuration"). */
  heading: string
  body: string
}

/**
 * Patch a single article subsection (v7 extract).
 * mode "merge" integrates body under heading; "replace" overwrites that section.
 */
export interface WikiArticlePatch {
  heading: string
  mode: 'merge' | 'replace'
  body: string
}

export interface WikiPage {
  meta: WikiFrontmatter
  /**
   * Lead / Summary markdown (no heading). Wire field keeps the name
   * `currentState` for API/context compatibility. Parsed from ## Summary
   * or legacy ## Current state.
   */
  currentState: string
  /** Encyclopedia body under ## Article (may contain ### subsections). */
  article: string
  /** Newest-first dated entries under ## History. */
  history: WikiHistoryEntry[]
  /** Leaf/branch summary citations (memory v6) — newest-first. */
  citations: WikiCitation[]
  /** Slugs listed under ## See also (and/or meta.related). */
  seeAlso: string[]
  /** Body text before the first "##" heading — preserved verbatim. */
  preamble?: string
  /** Sections other than core headings — preserved. */
  extraSections?: Array<{ heading: string; body: string }>
}

/**
 * A structured patch from the extractor LLM, applied by applyPatch().
 * 'create' seeds a new page; 'update' merges Summary/Article and/or appends
 * History. Prefer summaryDelta + articlePatches over full rewrites (v7).
 */
export interface WikiPatch {
  action: 'create' | 'update'
  slug: string
  title?: string
  addAliases?: string[]
  addTags?: string[]
  addEntities?: string[]
  /** Explicit related slugs to union into meta.related + See also. */
  addRelated?: string[]
  /**
   * Full replacement Summary (markdown, no heading). Subject to shrink guard
   * unless allowShrink is true.
   */
  currentState?: string
  /** Sentences/paragraphs to fold into the existing Summary (preferred). */
  summaryDelta?: string
  /** Full replacement Article body. */
  article?: string
  /** Section-aware Article updates (preferred over full article). */
  articlePatches?: WikiArticlePatch[]
  historyEntry?: WikiHistoryEntry
  addSources?: WikiSource[]
  /** Append leaf citations (deduped by summaryId). */
  addCitations?: WikiCitation[]
  /** ISO timestamp stamped into lastVerified. */
  verifiedAt: string
  /**
   * Allow a full Summary rewrite shorter than 60% of the prior length
   * (contradiction correction). Default false — silent thrash refused.
   */
  allowShrink?: boolean
}

/** Slug rules: lowercase kebab, [a-z0-9-], no leading/trailing dash. */
export function normalizeSlug(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
}

/** Extract [[slug]] wiki links from markdown (outbound graph edges). */
export function extractWikiLinks(markdown: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  const re = /\[\[([a-z0-9-]+)\]\]/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(markdown)) !== null) {
    const slug = normalizeSlug(m[1])
    if (slug && !seen.has(slug)) {
      seen.add(slug)
      out.push(slug)
    }
  }
  return out
}
