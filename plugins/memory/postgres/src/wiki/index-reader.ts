/**
 * WikiIndex (phase 3b + memory v6) — the PG index over the git-backed wiki.
 *
 * Content canonical form is markdown in /rivet-shared/wiki (single writer:
 * the datahub compaction worker); this class is the search/provenance layer
 * every node reads — hybrid topic search for context injection (3f), topic
 * lookups for the gateway (3e), identity resolution + upserts for the
 * extractor (3c/v6), extraction idempotency markers.
 *
 * Design: phase-3-memory-wiki-design.md, memory-v6-durable-topics.md
 */

import type pg from 'pg'
import {
  buildWikiSearchText,
  findStemMatch,
  normalizeSlug,
  type WikiCitation,
  type WikiPage,
} from '@rivetos/wiki-core'
import { WIKI_PIPELINE_VERSION } from './prompts.js'

export interface WikiTopicRow {
  slug: string
  title: string
  aliases: string[]
  tags: string[]
  entities: string[]
  /** Lead / Summary (## Summary or legacy Current state). */
  currentState: string
  /** Wikipedia-style body (## Article) — memory v7; empty when 0007 not applied. */
  article: string
  /** Explicit related slugs (v7). */
  related: string[]
  historyCount: number
  gitSha: string | null
  lastVerifiedAt?: string
  createdAt: string
  updatedAt: string
}

export interface WikiTopicHit extends WikiTopicRow {
  /** Fused relevance score (RRF over FTS + trigram + vector when embedded). */
  score: number
}

export interface WikiIndexConfig {
  /** Embedding endpoint for query vectors (same contract as SearchEngine). */
  embedEndpoint?: string
  embedModel?: string
}

export interface ExtractionMark {
  summaryId: string
  status: 'done' | 'skipped' | 'failed'
  pipelineVersion: number
  topicsTouched?: string[]
  gitSha?: string
  error?: string
}

/**
 * Pure policy for whether an extraction row is current enough to skip re-mine.
 * Used by `WikiIndex.extractionDone` and unit-tested without PG.
 */
export function isExtractionCurrent(
  row: { status: string; pipeline_version: number } | undefined,
  minPipelineVersion: number = WIKI_PIPELINE_VERSION,
): boolean {
  if (!row) return false
  if (row.status === 'failed') return false
  if (row.status === 'skipped') return true
  if (row.status === 'done') return row.pipeline_version >= minPipelineVersion
  return false
}

export type ResolveReason = 'exact' | 'alias' | 'redirect' | 'entity' | 'stem' | 'search' | 'none'

export interface TopicResolution {
  /** Canonical topic when identity matched an existing page. */
  match?: WikiTopicRow
  reason: ResolveReason
  /** Runner-up candidates for the extraction prompt. */
  candidates: WikiTopicHit[]
}

/** RRF constant — matches SearchEngine's tighter-than-canonical smoothing. */
const RRF_K = 20

/**
 * Minimum fused RRF score to treat top search hit as identity match.
 * Single top-1 hit from one retriever ≈ 1/(20+1) ≈ 0.0476; require a bit more
 * signal (or multi-retriever agreement) before forcing a merge.
 */
export const RESOLVE_SEARCH_SCORE_MIN = 0.06

export class WikiIndex {
  constructor(
    private pool: pg.Pool,
    private config: WikiIndexConfig = {},
  ) {}

  /** True once 0005 is applied — callers degrade gracefully when not. */
  async isReady(): Promise<boolean> {
    try {
      await this.pool.query('SELECT 1 FROM ros_wiki_topics LIMIT 1')
      return true
    } catch {
      return false
    }
  }

  async getTopic(slug: string): Promise<WikiTopicRow | undefined> {
    const resolved = await this.followRedirect(normalizeSlug(slug))
    const { rows } = await this.pool.query<PgTopicRow>(
      'SELECT * FROM ros_wiki_topics WHERE slug = $1',
      [resolved],
    )
    return rows[0] ? toRow(rows[0]) : undefined
  }

  async listTopics(opts?: {
    tag?: string
    entity?: string
    limit?: number
    offset?: number
  }): Promise<{ topics: WikiTopicRow[]; total: number }> {
    const clauses: string[] = []
    const params: unknown[] = []
    if (opts?.tag) {
      params.push(opts.tag)
      clauses.push(`$${String(params.length)} = ANY(tags)`)
    }
    if (opts?.entity) {
      params.push(opts.entity)
      clauses.push(`$${String(params.length)} = ANY(entities)`)
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''
    const { rows: countRows } = await this.pool.query<{ n: string }>(
      `SELECT count(*) AS n FROM ros_wiki_topics ${where}`,
      params,
    )
    params.push(opts?.limit ?? 100, opts?.offset ?? 0)
    const { rows } = await this.pool.query<PgTopicRow>(
      `SELECT * FROM ros_wiki_topics ${where}
       ORDER BY updated_at DESC
       LIMIT $${String(params.length - 1)} OFFSET $${String(params.length)}`,
      params,
    )
    return { topics: rows.map(toRow), total: Number(countRows[0]?.n ?? 0) }
  }

  /**
   * Hybrid topic search: RRF over FTS, trigram, and (when the query embeds
   * and pages are embedded) vector. Mirrors SearchEngine's fusion rationale —
   * each retriever fails differently; a hit any one finds survives.
   */
  async searchTopics(query: string, opts?: { limit?: number }): Promise<WikiTopicHit[]> {
    const limit = opts?.limit ?? 10
    const perMethod = Math.max(limit * 3, 15)

    const [fts, trgm, vec] = await Promise.all([
      this.pool
        .query<PgTopicRow & { r: number }>(
          `SELECT *, ts_rank(content_tsv, websearch_to_tsquery('english', $1)) AS r
           FROM ros_wiki_topics
           WHERE content_tsv @@ websearch_to_tsquery('english', $1)
           ORDER BY r DESC LIMIT $2`,
          [query, perMethod],
        )
        .then((res) => res.rows)
        .catch(() => []),
      this.pool
        .query<PgTopicRow & { r: number }>(
          // word_similarity: fuzzy queries match the best-aligned words in
          // the search text instead of being diluted by its full length.
          `SELECT *, word_similarity($1, search_text) AS r
           FROM ros_wiki_topics
           WHERE $1 <% search_text
           ORDER BY r DESC LIMIT $2`,
          [query, perMethod],
        )
        .then((res) => res.rows)
        .catch(() => []),
      this.vectorCandidates(query, perMethod),
    ])

    const fused = new Map<string, { row: PgTopicRow; score: number }>()
    for (const list of [fts, trgm, vec]) {
      list.forEach((row, rank) => {
        const entry = fused.get(row.slug) ?? { row, score: 0 }
        entry.score += 1 / (RRF_K + rank + 1)
        fused.set(row.slug, entry)
      })
    }
    return [...fused.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((e) => ({ ...toRow(e.row), score: e.score }))
  }

  /**
   * Legacy helper (phase 3c): exact slug → alias, plus fuzzy candidates.
   * Prefer resolveTopicIdentity for extraction create-gates.
   */
  async resolveTopic(
    slugOrTitle: string,
  ): Promise<{ exact?: WikiTopicRow; candidates: WikiTopicHit[] }> {
    const r = await this.resolveTopicIdentity(slugOrTitle)
    return {
      exact: r.match,
      candidates: r.candidates,
    }
  }

  /**
   * Durable topic identity (memory v6):
   * exact slug → redirect → alias → entity overlap → stem parent/child →
   * high-score search. Fuzzy candidates always returned for the prompt.
   */
  async resolveTopicIdentity(
    slugOrTitle: string,
    opts?: { entities?: string[]; title?: string },
  ): Promise<TopicResolution> {
    const slug = normalizeSlug(slugOrTitle)
    const searchQuery = [slugOrTitle, opts?.title, ...(opts?.entities ?? [])]
      .filter(Boolean)
      .join(' ')
      .slice(0, 400)

    const candidates = await this.searchTopics(searchQuery || slugOrTitle, { limit: 5 })

    // 1. Exact slug
    {
      const { rows } = await this.pool.query<PgTopicRow>(
        'SELECT * FROM ros_wiki_topics WHERE slug = $1 LIMIT 1',
        [slug],
      )
      if (rows[0]) {
        return {
          match: toRow(rows[0]),
          reason: 'exact',
          candidates: candidates.filter((c) => c.slug !== rows[0].slug),
        }
      }
    }

    // 2. Redirect table (post-consolidation)
    {
      const to = await this.followRedirect(slug)
      if (to !== slug) {
        const { rows } = await this.pool.query<PgTopicRow>(
          'SELECT * FROM ros_wiki_topics WHERE slug = $1 LIMIT 1',
          [to],
        )
        if (rows[0]) {
          return {
            match: toRow(rows[0]),
            reason: 'redirect',
            candidates: candidates.filter((c) => c.slug !== rows[0].slug),
          }
        }
      }
    }

    // 3. Alias
    {
      const { rows } = await this.pool.query<PgTopicRow>(
        'SELECT * FROM ros_wiki_topics WHERE $1 = ANY(aliases) LIMIT 1',
        [slug],
      )
      if (rows[0]) {
        return {
          match: toRow(rows[0]),
          reason: 'alias',
          candidates: candidates.filter((c) => c.slug !== rows[0].slug),
        }
      }
    }

    // 4. Entity overlap
    if (opts?.entities && opts.entities.length > 0) {
      // Prefer topics that share the most entities. Use unnest + ANY for the
      // intersection size — Postgres has no `text[] & text[]` (that is intarray
      // only); the old `cardinality(entities & $1)` form raised
      // "operator does not exist: text[] & text[]" and killed every extract-wiki
      // job whose patch shared entities with an existing topic (~9.5k dead jobs).
      const { rows } = await this.pool.query<PgTopicRow>(
        `SELECT * FROM ros_wiki_topics
         WHERE entities && $1::text[]
         ORDER BY (
           SELECT COUNT(*)::int
           FROM unnest(entities) AS e(val)
           WHERE val = ANY($1::text[])
         ) DESC, updated_at DESC
         LIMIT 3`,
        [opts.entities],
      )
      if (rows[0]) {
        return {
          match: toRow(rows[0]),
          reason: 'entity',
          candidates: candidates.filter((c) => c.slug !== rows[0].slug),
        }
      }
    }

    // 5. Stem parent/child among inventory (prefix variants)
    {
      const { rows } = await this.pool.query<{ slug: string }>(
        `SELECT slug FROM ros_wiki_topics
         WHERE slug = $1
            OR slug LIKE $1 || '-%'
            OR $1 LIKE slug || '-%'
         ORDER BY length(slug) ASC
         LIMIT 50`,
        [slug],
      )
      const stem = findStemMatch(
        slug,
        rows.map((r) => r.slug),
      )
      if (stem) {
        const { rows: full } = await this.pool.query<PgTopicRow>(
          'SELECT * FROM ros_wiki_topics WHERE slug = $1 LIMIT 1',
          [stem],
        )
        if (full[0]) {
          return {
            match: toRow(full[0]),
            reason: 'stem',
            candidates: candidates.filter((c) => c.slug !== full[0].slug),
          }
        }
      }
    }

    // 6. Strong search hit
    if (candidates[0] && candidates[0].score >= RESOLVE_SEARCH_SCORE_MIN) {
      const top = candidates[0]
      // Prefer stem agreement between proposed slug and top hit
      const stemHit = findStemMatch(slug, [top.slug])
      if (stemHit === top.slug || candidates[0].score >= RESOLVE_SEARCH_SCORE_MIN * 1.5) {
        return {
          match: top,
          reason: 'search',
          candidates: candidates.slice(1),
        }
      }
    }

    return { reason: 'none', candidates }
  }

  /**
   * Force create→update onto a resolved canonical slug; returns the slug to
   * write and the action the writer should use.
   */
  async gateTopicWrite(
    proposedSlug: string,
    action: 'create' | 'update',
    opts?: { entities?: string[]; title?: string },
  ): Promise<{ slug: string; action: 'create' | 'update'; reason: ResolveReason }> {
    const resolution = await this.resolveTopicIdentity(proposedSlug, opts)
    if (resolution.match) {
      return {
        slug: resolution.match.slug,
        action: 'update',
        reason: resolution.reason,
      }
    }
    // No match: allow create only when the LLM asked for create, else create
    // the proposed slug anyway (first writer for that subject).
    return {
      slug: normalizeSlug(proposedSlug),
      action: action === 'create' ? 'create' : 'create',
      reason: 'none',
    }
  }

  /** Upsert the index row from a parsed page (extractor, post-commit). */
  async upsertTopic(page: WikiPage, gitSha?: string): Promise<void> {
    // Lean search/embed surface (lead + short article excerpt) — full article
    // lives in the markdown file / article column, not the embedding centroid.
    const article = page.article
    const related = page.meta.related.length > 0 ? page.meta.related : page.seeAlso
    const searchText = buildWikiSearchText(page)

    // Prefer v7 columns (article, related); fall back if 0007 not applied yet.
    try {
      await this.pool.query(
        `INSERT INTO ros_wiki_topics
           (slug, title, aliases, tags, entities, current_state, article, related, search_text,
            history_count, git_sha, last_verified_at, updated_at, embed_status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, now(), NULL)
         ON CONFLICT (slug) DO UPDATE SET
           title = EXCLUDED.title,
           aliases = EXCLUDED.aliases,
           tags = EXCLUDED.tags,
           entities = EXCLUDED.entities,
           current_state = EXCLUDED.current_state,
           article = EXCLUDED.article,
           related = EXCLUDED.related,
           search_text = EXCLUDED.search_text,
           history_count = EXCLUDED.history_count,
           git_sha = EXCLUDED.git_sha,
           last_verified_at = EXCLUDED.last_verified_at,
           updated_at = now(),
           embed_status = CASE
             WHEN ros_wiki_topics.search_text IS DISTINCT FROM EXCLUDED.search_text
               THEN NULL ELSE ros_wiki_topics.embed_status END`,
        [
          page.meta.slug,
          page.meta.title,
          page.meta.aliases,
          page.meta.tags,
          page.meta.entities,
          page.currentState,
          article,
          related,
          searchText,
          page.history.length,
          gitSha ?? null,
          page.meta.lastVerified ?? null,
        ],
      )
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      if (!/column .*article|column .*related/i.test(msg)) throw err
      await this.pool.query(
        `INSERT INTO ros_wiki_topics
           (slug, title, aliases, tags, entities, current_state, search_text,
            history_count, git_sha, last_verified_at, updated_at, embed_status)
         VALUES ($1,$2,$3,$4,$5,$6,$10,$7,$8,$9, now(), NULL)
         ON CONFLICT (slug) DO UPDATE SET
           title = EXCLUDED.title,
           aliases = EXCLUDED.aliases,
           tags = EXCLUDED.tags,
           entities = EXCLUDED.entities,
           current_state = EXCLUDED.current_state,
           search_text = EXCLUDED.search_text,
           history_count = EXCLUDED.history_count,
           git_sha = EXCLUDED.git_sha,
           last_verified_at = EXCLUDED.last_verified_at,
           updated_at = now(),
           embed_status = CASE
             WHEN ros_wiki_topics.search_text IS DISTINCT FROM EXCLUDED.search_text
               THEN NULL ELSE ros_wiki_topics.embed_status END`,
        [
          page.meta.slug,
          page.meta.title,
          page.meta.aliases,
          page.meta.tags,
          page.meta.entities,
          page.currentState,
          page.history.length,
          gitSha ?? null,
          page.meta.lastVerified ?? null,
          searchText,
        ],
      )
    }
  }

  /** Record provenance rows (idempotent on the composite PK). */
  async recordProvenance(
    slug: string,
    sources: Array<{
      kind: 'summary' | 'message' | 'conversation' | 'task'
      ids: string[]
      conversationId?: string
    }>,
    gitSha?: string,
  ): Promise<void> {
    for (const src of sources) {
      for (const id of src.ids) {
        await this.pool.query(
          `INSERT INTO ros_wiki_provenance (topic_slug, source_kind, source_id, conversation_id, git_sha)
           VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT (topic_slug, source_kind, source_id) DO NOTHING`,
          [slug, src.kind, id, src.conversationId ?? null, gitSha ?? null],
        )
      }
    }
  }

  /** Record leaf citations (memory v6) — idempotent. Degrades if 0006 missing. */
  async recordCitations(slug: string, citations: WikiCitation[]): Promise<void> {
    for (const c of citations) {
      if (!c.summaryId) continue
      try {
        await this.pool.query(
          `INSERT INTO ros_wiki_citations (topic_slug, summary_id, kind, note)
           VALUES ($1,$2,$3,$4)
           ON CONFLICT (topic_slug, summary_id) DO UPDATE SET
             kind = COALESCE(EXCLUDED.kind, ros_wiki_citations.kind),
             note = COALESCE(EXCLUDED.note, ros_wiki_citations.note)`,
          [slug, c.summaryId, c.kind ?? null, c.note ?? null],
        )
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        if (/ros_wiki_citations/i.test(msg)) return // 0006 not applied
        throw err
      }
    }
  }

  async setRedirect(fromSlug: string, toSlug: string): Promise<void> {
    const from = normalizeSlug(fromSlug)
    const to = normalizeSlug(toSlug)
    if (from === '' || to === '' || from === to) return
    try {
      await this.pool.query(
        `INSERT INTO ros_wiki_redirects (from_slug, to_slug)
         VALUES ($1,$2)
         ON CONFLICT (from_slug) DO UPDATE SET to_slug = EXCLUDED.to_slug`,
        [from, to],
      )
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      if (/ros_wiki_redirects/i.test(msg)) return
      throw err
    }
  }

  async deleteTopic(slug: string): Promise<void> {
    await this.pool.query('DELETE FROM ros_wiki_topics WHERE slug = $1', [normalizeSlug(slug)])
  }

  /** Follow redirect chain (max 5 hops). */
  async followRedirect(slug: string): Promise<string> {
    let cur = normalizeSlug(slug)
    for (let i = 0; i < 5; i++) {
      try {
        const { rows } = await this.pool.query<{ to_slug: string }>(
          'SELECT to_slug FROM ros_wiki_redirects WHERE from_slug = $1',
          [cur],
        )
        if (!rows[0]) return cur
        cur = rows[0].to_slug
      } catch {
        return cur
      }
    }
    return cur
  }

  /**
   * Extraction idempotency: has this summary been processed at a usable
   * pipeline version?
   *
   * - `skipped` is terminal regardless of version (too-short / heartbeat /
   *   non-leaf reasons do not change when prompts bump).
   * - `done` only counts when `pipeline_version >= minPipelineVersion`. A
   *   bump of `WIKI_PIPELINE_VERSION` must re-mine leaves already marked
   *   done under an older contract (explicit residual from #420 — backfill
   *   used to filter on status alone, so article quality rested entirely
   *   on recompile-wiki).
   * - `failed` is never done (re-eligible after backoff).
   */
  async extractionDone(
    summaryId: string,
    minPipelineVersion: number = WIKI_PIPELINE_VERSION,
  ): Promise<boolean> {
    const { rows } = await this.pool.query<{ status: string; pipeline_version: number }>(
      `SELECT status, pipeline_version FROM ros_wiki_extractions WHERE summary_id = $1`,
      [summaryId],
    )
    return isExtractionCurrent(rows[0], minPipelineVersion)
  }

  async markExtraction(mark: ExtractionMark): Promise<void> {
    await this.pool.query(
      `INSERT INTO ros_wiki_extractions
         (summary_id, status, pipeline_version, topics_touched, git_sha, error)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (summary_id) DO UPDATE SET
         status = EXCLUDED.status,
         pipeline_version = EXCLUDED.pipeline_version,
         topics_touched = EXCLUDED.topics_touched,
         git_sha = EXCLUDED.git_sha,
         error = EXCLUDED.error,
         extracted_at = now()`,
      [
        mark.summaryId,
        mark.status,
        mark.pipelineVersion,
        mark.topicsTouched ?? [],
        mark.gitSha ?? null,
        mark.error ?? null,
      ],
    )
  }

  /**
   * Gap surfacing (Phil 2026-07-07): red links — entities referenced by
   * pages that have no page of their own — plus stalest pages. Cheap index
   * queries for the landing view (3e).
   */
  async gaps(opts?: { staleLimit?: number }): Promise<{
    redLinks: Array<{ entity: string; referencedBy: string[] }>
    stalest: WikiTopicRow[]
  }> {
    const { rows: red } = await this.pool.query<{ entity: string; referenced_by: string[] }>(
      `WITH refs AS (
         SELECT t.slug, e.entity
         FROM ros_wiki_topics t, unnest(t.entities) AS e(entity)
       ), grouped AS (
         SELECT entity,
                array_agg(DISTINCT slug) AS referenced_by,
                count(DISTINCT slug) AS n
         FROM refs
         GROUP BY entity
       )
       SELECT entity, referenced_by
       FROM grouped g
       WHERE n = 1
         AND NOT EXISTS (
           SELECT 1 FROM ros_wiki_topics t2
           WHERE t2.slug = replace(split_part(g.entity, ':', 2), '_', '-')
         )
       ORDER BY entity
       LIMIT 20`,
    )
    const { rows: stale } = await this.pool.query<PgTopicRow>(
      `SELECT * FROM ros_wiki_topics
       ORDER BY last_verified_at ASC NULLS FIRST
       LIMIT $1`,
      [opts?.staleLimit ?? 10],
    )
    return {
      redLinks: red.map((r) => ({ entity: r.entity, referencedBy: r.referenced_by })),
      stalest: stale.map(toRow),
    }
  }

  /** All slugs (for consolidation clustering). */
  async listAllSlugs(): Promise<string[]> {
    const { rows } = await this.pool.query<{ slug: string }>(
      'SELECT slug FROM ros_wiki_topics ORDER BY slug',
    )
    return rows.map((r) => r.slug)
  }

  private async vectorCandidates(
    query: string,
    limit: number,
  ): Promise<Array<PgTopicRow & { r: number }>> {
    const qvec = await this.embedQuery(query)
    if (!qvec) return []
    return this.pool
      .query<PgTopicRow & { r: number }>(
        `SELECT *, 1 - (embedding <=> $1::halfvec) AS r
         FROM ros_wiki_topics
         WHERE embedding IS NOT NULL
         ORDER BY embedding <=> $1::halfvec
         LIMIT $2`,
        [`[${qvec.join(',')}]`, limit],
      )
      .then((res) => res.rows)
      .catch(() => [])
  }

  private async embedQuery(text: string): Promise<number[] | null> {
    if (!this.config.embedEndpoint) return null
    try {
      const res = await fetch(`${this.config.embedEndpoint}/v1/embeddings`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: this.config.embedModel ?? 'nemotron', input: text }),
      })
      if (!res.ok) return null
      const body = (await res.json()) as { data?: Array<{ embedding?: number[] }> }
      return body.data?.[0]?.embedding ?? null
    } catch {
      return null
    }
  }
}

// ---------------------------------------------------------------------------

interface PgTopicRow {
  slug: string
  title: string
  aliases: string[]
  tags: string[]
  entities: string[]
  current_state: string
  article?: string | null
  related?: string[] | null
  history_count: number
  git_sha: string | null
  last_verified_at: Date | null
  created_at: Date
  updated_at: Date
}

function toRow(r: PgTopicRow): WikiTopicRow {
  return {
    slug: r.slug,
    title: r.title,
    aliases: r.aliases,
    tags: r.tags,
    entities: r.entities,
    currentState: r.current_state,
    article: r.article ?? '',
    related: r.related ?? [],
    historyCount: r.history_count,
    gitSha: r.git_sha,
    lastVerifiedAt: r.last_verified_at?.toISOString(),
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  }
}
