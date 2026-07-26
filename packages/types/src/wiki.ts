/**
 * Wiki gateway contract (phase 3a) — the response shapes /api/wiki serves
 * and RivetHub (phase 4) consumes. The page MODEL (parse/serialize/patch)
 * lives in @rivetos/wiki-core; these are the wire shapes only.
 * Design: /rivet-shared/plans/phase-3-memory-wiki-design.md §4.
 */

export interface WikiSourceRef {
  kind: 'summary' | 'message' | 'conversation' | 'task'
  ids: string[]
  conversationId?: string
  span?: { earliest: string; latest: string }
}

export interface WikiHistoryEntryWire {
  date: string
  title: string
  body: string
}

/** Leaf/branch summary cited as evidence on a durable topic (memory v6). */
export interface WikiCitationWire {
  summaryId: string
  date?: string
  kind?: string
  note?: string
}

export interface WikiPageResponse {
  slug: string
  title: string
  aliases: string[]
  tags: string[]
  entities: string[]
  /** The "## Current state" section only — UI renders without markdown surgery. */
  currentState: string
  history: WikiHistoryEntryWire[]
  /** Leaf summary citations (memory v6 durable topics). */
  citations: WikiCitationWire[]
  /** Full file, verbatim. */
  markdown: string
  sources: WikiSourceRef[]
  gitSha: string | null
  lastVerified?: string
  updatedAt: string
  /** Related slugs (entity/alias co-occurrence) — sidebar graph. */
  related?: string[]
}

export interface WikiIndexEntry {
  slug: string
  title: string
  tags: string[]
  entities: string[]
  updatedAt: string
  /** First ~200 chars of currentState. */
  excerpt: string
}

export interface WikiIndexResponse {
  topics: WikiIndexEntry[]
  total: number
}
