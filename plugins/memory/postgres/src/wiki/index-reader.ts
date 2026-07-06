/**
 * WikiIndex (phase 3b) — the PG index over the git-backed wiki.
 *
 * Content canonical form is markdown in /rivet-shared/wiki (single writer:
 * the datahub compaction worker); this class is the search/provenance layer
 * every node reads — hybrid topic search for context injection (3f), topic
 * lookups for the gateway (3e), identity resolution + upserts for the
 * extractor (3c), extraction idempotency markers.
 *
 * Design: /rivet-shared/plans/phase-3-memory-wiki-design.md (§1–2, §5).
 */

import type pg from 'pg'
import type { WikiPage } from '@rivetos/wiki-core'

export interface WikiTopicRow {
  slug: string
  title: string
  aliases: string[]
  tags: string[]
  entities: string[]
  currentState: string
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

/** RRF constant — matches SearchEngine's tighter-than-canonical smoothing. */
const RRF_K = 20

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
    const { rows } = await this.pool.query<PgTopicRow>(
      'SELECT * FROM ros_wiki_topics WHERE slug = $1',
      [slug],
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
   * Topic-identity resolution for the extractor (3c): exact slug → alias →
   * best fuzzy candidates. Returns match plus runner-up candidates so the
   * extraction prompt can disambiguate instead of creating near-duplicates.
   */
  async resolveTopic(
    slugOrTitle: string,
  ): Promise<{ exact?: WikiTopicRow; candidates: WikiTopicHit[] }> {
    const exactRes = await this.pool.query<PgTopicRow>(
      'SELECT * FROM ros_wiki_topics WHERE slug = $1 OR $1 = ANY(aliases) LIMIT 1',
      [slugOrTitle],
    )
    const candidates = await this.searchTopics(slugOrTitle, { limit: 3 })
    return {
      exact: exactRes.rows[0] ? toRow(exactRes.rows[0]) : undefined,
      candidates: candidates.filter((c) => c.slug !== exactRes.rows[0]?.slug),
    }
  }

  /** Upsert the index row from a parsed page (extractor, post-commit). */
  async upsertTopic(page: WikiPage, gitSha?: string): Promise<void> {
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
         -- content changed → re-embed
         embed_status = CASE
           WHEN ros_wiki_topics.current_state IS DISTINCT FROM EXCLUDED.current_state
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
        `${page.meta.title} ${page.meta.aliases.join(' ')} ${page.currentState}`,
      ],
    )
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

  /** Extraction idempotency: has this summary been processed? */
  async extractionDone(summaryId: string): Promise<boolean> {
    const { rows } = await this.pool.query<{ status: string }>(
      `SELECT status FROM ros_wiki_extractions WHERE summary_id = $1`,
      [summaryId],
    )
    return rows[0]?.status === 'done' || rows[0]?.status === 'skipped'
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
      `SELECT e.entity, array_agg(t.slug) AS referenced_by
       FROM ros_wiki_topics t, unnest(t.entities) AS e(entity)
       WHERE NOT EXISTS (
         SELECT 1 FROM ros_wiki_topics t2
         WHERE t2.slug = replace(split_part(e.entity, ':', 2), '_', '-')
            OR e.entity = ANY(t2.entities) AND t2.slug <> t.slug
       )
       GROUP BY e.entity
       ORDER BY count(*) DESC
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
    historyCount: r.history_count,
    gitSha: r.git_sha,
    lastVerifiedAt: r.last_verified_at?.toISOString(),
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  }
}
