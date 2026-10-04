/**
 * The wiki on SQLite: a topic index over the git-backed page files, and the
 * job that mines conversation summaries into pages.
 *
 * Page content lives in `<wikiDir>/topics/<slug>.md` (written by
 * `WikiWriter`, the same writer the Postgres pipeline uses). The tables here
 * are the search, provenance and idempotency index over those files. The
 * prompts, the patch parser and the tag rules are shared with Postgres
 * through `@rivetos/memory-core`, so both backends extract the same way.
 */

import type { DatabaseSync, SQLInputValue } from 'node:sqlite'
import {
  HYBRID_RRF_K,
  WIKI_EXTRACT_MAX_TOKENS,
  WIKI_EXTRACT_SYSTEM_PROMPT,
  WIKI_MIN_SUMMARY_CHARS,
  WIKI_PIPELINE_VERSION,
  WIKI_TAGS_MAX,
  formatExtractionPrompt,
  mergeTagCandidates,
  parseWikiPatches,
  safeLiteral,
  tagCandidateQuery,
  withoutRuleEntities,
  type ExtractionCandidate,
  type WikiTag,
} from '@rivetos/memory-core'
import {
  WikiWriter,
  buildWikiSearchText,
  findStemMatch,
  normalizeSlug,
  type WikiCitation,
  type WikiPage,
} from '@rivetos/wiki-core'
import type { SqliteJobQueue } from './jobs.js'
import type { LlmClient } from './llm.js'
import type { SqliteTagStore } from './tags.js'
import type { VectorIndex } from './vectors.js'

export const EXTRACT_WIKI_TASK = 'extract-wiki'

/** Same threshold as the Postgres index: a search-only match needs two legs. */
const RESOLVE_SEARCH_SCORE_MIN = 0.06
/** Summaries queued per backfill pass. */
const BACKFILL_BATCH = 25
/** A failed extraction is retried by the backfill after this long. */
const FAILED_RETRY_MS = 24 * 60 * 60 * 1000
/** Tag sources a person or a model reviewed (the cwd rule tag is not one). */
const REVIEWED_TAG_SOURCES: ReadonlySet<string> = new Set(['user', 'model', 'import'])

export interface WikiTopicRow {
  slug: string
  title: string
  aliases: string[]
  tags: string[]
  entities: string[]
  currentState: string
  article: string
  related: string[]
  historyCount: number
  gitSha: string | null
  lastVerifiedAt?: string
  createdAt: string
  updatedAt: string
}

export interface WikiTopicHit extends WikiTopicRow {
  score: number
}

export type ResolveReason = 'exact' | 'alias' | 'redirect' | 'entity' | 'stem' | 'search' | 'none'

export interface TopicResolution {
  match?: WikiTopicRow
  reason: ResolveReason
  candidates: WikiTopicHit[]
}

export interface ExtractionMark {
  summaryId: string
  status: 'done' | 'skipped' | 'failed'
  pipelineVersion: number
  topicsTouched?: string[]
  gitSha?: string
  error?: string
}

interface TopicDbRow {
  slug: string
  title: string
  aliases: string
  tags: string
  entities: string
  related: string
  current_state: string
  article: string
  history_count: number
  git_sha: string | null
  last_verified_at: string | null
  created_at: string
  updated_at: string
}

const TOPIC_COLUMNS =
  'slug, title, aliases, tags, entities, related, current_state, article, history_count, git_sha, last_verified_at, created_at, updated_at'

function list(json: string): string[] {
  try {
    const parsed: unknown = JSON.parse(json)
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

function toRow(r: TopicDbRow): WikiTopicRow {
  return {
    slug: r.slug,
    title: r.title,
    aliases: list(r.aliases),
    tags: list(r.tags),
    entities: list(r.entities),
    currentState: r.current_state,
    article: r.article,
    related: list(r.related),
    historyCount: r.history_count,
    gitSha: r.git_sha,
    ...(r.last_verified_at === null ? {} : { lastVerifiedAt: r.last_verified_at }),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

/** FTS5 query: the query's word tokens, any of them. Null when there is none. */
function ftsAnyQuery(query: string): string | null {
  const tokens = query.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu)
  if (!tokens) return null
  return [...new Set(tokens)]
    .slice(0, 24)
    .map((t) => `"${t}"`)
    .join(' OR ')
}

function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (c) => `\\${c}`)
}

export interface SqliteWikiIndexOptions {
  /** Query vectors for the vector leg. Absent: full-text and literal legs only. */
  embedQuery?: (text: string) => Promise<number[]>
  /** The vector index over topic embeddings. */
  vectors?: VectorIndex
  /** Called when a topic's search text changed and its vector is stale. */
  onTopicChanged?: (slug: string) => void
  now?: () => Date
}

/* eslint-disable @typescript-eslint/require-await -- DatabaseSync is sync; the wiki routes' index interface is async. */
export class SqliteWikiIndex {
  private readonly now: () => Date

  constructor(
    private readonly db: DatabaseSync,
    private readonly opts: SqliteWikiIndexOptions = {},
  ) {
    this.now = opts.now ?? (() => new Date())
  }

  private stamp(): string {
    return this.now().toISOString()
  }

  private topic(slug: string): WikiTopicRow | undefined {
    const row = this.db
      .prepare(`SELECT ${TOPIC_COLUMNS} FROM ros_wiki_topics WHERE slug = ?`)
      .get(slug) as unknown as TopicDbRow | undefined
    return row ? toRow(row) : undefined
  }

  async getTopic(slug: string): Promise<WikiTopicRow | undefined> {
    return this.topic(this.redirectTarget(normalizeSlug(slug)))
  }

  async listTopics(opts?: {
    tag?: string
    entity?: string
    limit?: number
    offset?: number
  }): Promise<{ topics: WikiTopicRow[]; total: number }> {
    const conds: string[] = []
    const params: SQLInputValue[] = []
    if (opts?.tag) {
      conds.push(`EXISTS (SELECT 1 FROM json_each(t.tags) WHERE value = ?)`)
      params.push(opts.tag)
    }
    if (opts?.entity) {
      conds.push(`EXISTS (SELECT 1 FROM json_each(t.entities) WHERE value = ?)`)
      params.push(opts.entity)
    }
    const where = conds.length > 0 ? `WHERE ${conds.join(' AND ')}` : ''
    const total = (
      this.db.prepare(`SELECT count(*) AS n FROM ros_wiki_topics t ${where}`).get(...params) as {
        n: number
      }
    ).n
    const limit = Math.min(Math.max(Math.trunc(opts?.limit ?? 100), 1), 5000)
    const offset = Math.max(Math.trunc(opts?.offset ?? 0), 0)
    const rows = this.db
      .prepare(
        `SELECT ${TOPIC_COLUMNS} FROM ros_wiki_topics t ${where}
          ORDER BY updated_at DESC, slug LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset) as unknown as TopicDbRow[]
    return { topics: rows.map(toRow), total }
  }

  /**
   * Topics for a query: full-text, a literal match on slug / title / alias,
   * and (with an embedding endpoint) a vector leg, fused by reciprocal rank
   * with the constant the Postgres index uses. A leg that fails is skipped.
   */
  async searchTopics(query: string, opts?: { limit?: number }): Promise<WikiTopicHit[]> {
    const limit = Math.min(Math.max(Math.trunc(opts?.limit ?? 10), 1), 100)
    const perLeg = Math.max(limit * 3, 15)
    const text = query.trim()
    if (!text) return []
    const legs: string[][] = []

    const match = ftsAnyQuery(text)
    if (match) {
      try {
        const rows = this.db
          .prepare(
            `SELECT slug FROM ros_wiki_topics_fts WHERE ros_wiki_topics_fts MATCH ?
              ORDER BY bm25(ros_wiki_topics_fts) LIMIT ?`,
          )
          .all(match, perLeg) as unknown as Array<{ slug: string }>
        legs.push(rows.map((r) => r.slug))
      } catch {
        // skip the leg
      }
    }

    // The literal leg stands in for Postgres's trigram leg: a short query
    // that names a topic (its slug, title or an alias) should find it.
    const needle = text.slice(0, 120)
    if (needle.length >= 3) {
      const like = `%${escapeLike(needle.toLowerCase())}%`
      // A query with no ASCII letters or digits has no slug form: an empty
      // pattern would match every slug, so the slug arm is left out then.
      const slug = normalizeSlug(needle)
      const conds = [`lower(title) LIKE ? ESCAPE '\\'`, `lower(aliases) LIKE ? ESCAPE '\\'`]
      const params: SQLInputValue[] = [like, like]
      if (slug !== '') {
        conds.push(`slug LIKE ? ESCAPE '\\'`)
        params.push(`%${escapeLike(slug)}%`)
      }
      const rows = this.db
        .prepare(
          `SELECT slug FROM ros_wiki_topics WHERE ${conds.join(' OR ')}
            ORDER BY length(slug), slug LIMIT ?`,
        )
        .all(...params, perLeg) as unknown as Array<{ slug: string }>
      legs.push(rows.map((r) => r.slug))
    }

    if (this.opts.embedQuery && this.opts.vectors) {
      try {
        const vector = await this.opts.embedQuery(text.slice(0, 2000))
        legs.push(this.opts.vectors.search(vector, perLeg).map((h) => h.id))
      } catch {
        // skip the leg
      }
    }

    const fused = new Map<string, number>()
    for (const leg of legs) {
      leg.forEach((slug, rank) => {
        fused.set(slug, (fused.get(slug) ?? 0) + 1 / (HYBRID_RRF_K + rank + 1))
      })
    }
    const out: WikiTopicHit[] = []
    for (const [slug, score] of [...fused].sort((a, b) => b[1] - a[1]).slice(0, limit)) {
      const row = this.topic(slug)
      if (row) out.push({ ...row, score })
    }
    return out
  }

  async resolveTopic(
    slugOrTitle: string,
  ): Promise<{ exact?: WikiTopicRow; candidates: WikiTopicHit[] }> {
    const r = await this.resolveTopicIdentity(slugOrTitle)
    return { exact: r.match, candidates: r.candidates }
  }

  /**
   * Which existing topic a proposed slug means, in the order the Postgres
   * index tries: exact slug, redirect, alias, shared entities, a slug that is
   * a hyphen-prefix variant, then a confident search hit.
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
    const found = (match: WikiTopicRow, reason: ResolveReason): TopicResolution => ({
      match,
      reason,
      candidates: candidates.filter((c) => c.slug !== match.slug),
    })

    const exact = this.topic(slug)
    if (exact) return found(exact, 'exact')

    const to = this.redirectTarget(slug)
    if (to !== slug) {
      const target = this.topic(to)
      if (target) return found(target, 'redirect')
    }

    const alias = this.db
      .prepare(
        `SELECT slug FROM ros_wiki_topics t
          WHERE EXISTS (SELECT 1 FROM json_each(t.aliases) WHERE value = ?) LIMIT 1`,
      )
      .get(slug) as { slug: string } | undefined
    if (alias) {
      const row = this.topic(alias.slug)
      if (row) return found(row, 'alias')
    }

    const entities = [...new Set(opts?.entities ?? [])].slice(0, 64)
    if (entities.length > 0) {
      const marks = entities.map(() => '?').join(', ')
      const hit = this.db
        .prepare(
          `SELECT t.slug, count(DISTINCT e.value) AS shared FROM ros_wiki_topics t, json_each(t.entities) e
            WHERE e.value IN (${marks})
            GROUP BY t.slug ORDER BY shared DESC, t.updated_at DESC LIMIT 1`,
        )
        .get(...entities) as { slug: string } | undefined
      if (hit) {
        const row = this.topic(hit.slug)
        if (row) return found(row, 'entity')
      }
    }

    // Prefix compares by substr, not LIKE: LIKE ignores ASCII case and treats `_` as a wildcard.
    const variants = this.db
      .prepare(
        `SELECT slug FROM ros_wiki_topics
          WHERE slug = ? OR substr(slug, 1, length(?) + 1) = ? || '-'
             OR substr(?, 1, length(slug) + 1) = slug || '-'
          ORDER BY length(slug) LIMIT 50`,
      )
      .all(slug, slug, slug, slug) as unknown as Array<{ slug: string }>
    const stem = findStemMatch(
      slug,
      variants.map((r) => r.slug),
    )
    if (stem) {
      const row = this.topic(stem)
      if (row) return found(row, 'stem')
    }

    const top = candidates.at(0)
    if (top && top.score >= RESOLVE_SEARCH_SCORE_MIN) {
      if (
        findStemMatch(slug, [top.slug]) === top.slug ||
        top.score >= RESOLVE_SEARCH_SCORE_MIN * 1.5
      ) {
        return { match: top, reason: 'search', candidates: candidates.slice(1) }
      }
    }
    return { reason: 'none', candidates }
  }

  /** A write to a topic that already exists under another name updates that one. */
  async gateTopicWrite(
    proposedSlug: string,
    _action: 'create' | 'update',
    opts?: { entities?: string[]; title?: string },
  ): Promise<{ slug: string; action: 'create' | 'update'; reason: ResolveReason }> {
    const resolution = await this.resolveTopicIdentity(proposedSlug, opts)
    if (resolution.match) {
      return { slug: resolution.match.slug, action: 'update', reason: resolution.reason }
    }
    return { slug: normalizeSlug(proposedSlug), action: 'create', reason: 'none' }
  }

  /** Index a page as written to disk. A changed search text clears the vector. */
  upsertTopic(page: WikiPage, gitSha?: string): void {
    const related = page.meta.related.length > 0 ? page.meta.related : page.seeAlso
    const searchText = buildWikiSearchText(page)
    const now = this.stamp()
    const prior = this.db
      .prepare(`SELECT search_text FROM ros_wiki_topics WHERE slug = ?`)
      .get(page.meta.slug) as { search_text: string } | undefined
    const changed = prior?.search_text !== searchText
    this.db
      .prepare(
        `INSERT INTO ros_wiki_topics
           (slug, title, aliases, tags, entities, related, current_state, article, search_text,
            history_count, git_sha, last_verified_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (slug) DO UPDATE SET
           title = excluded.title, aliases = excluded.aliases, tags = excluded.tags,
           entities = excluded.entities, related = excluded.related,
           current_state = excluded.current_state, article = excluded.article,
           search_text = excluded.search_text, history_count = excluded.history_count,
           git_sha = excluded.git_sha, last_verified_at = excluded.last_verified_at,
           updated_at = excluded.updated_at,
           embedding = CASE WHEN ros_wiki_topics.search_text = excluded.search_text
                            THEN ros_wiki_topics.embedding END,
           embed_status = CASE WHEN ros_wiki_topics.search_text = excluded.search_text
                               THEN ros_wiki_topics.embed_status END,
           embed_error = CASE WHEN ros_wiki_topics.search_text = excluded.search_text
                              THEN ros_wiki_topics.embed_error END,
           embed_failures = CASE WHEN ros_wiki_topics.search_text = excluded.search_text
                                 THEN ros_wiki_topics.embed_failures ELSE 0 END`,
      )
      .run(
        page.meta.slug,
        page.meta.title,
        JSON.stringify(page.meta.aliases),
        JSON.stringify(page.meta.tags),
        JSON.stringify(page.meta.entities),
        JSON.stringify(related),
        page.currentState,
        page.article,
        searchText,
        page.history.length,
        gitSha ?? null,
        page.meta.lastVerified ?? null,
        now,
        now,
      )
    // The vector is cleared by the statement above when the text it was made
    // from changed (title, aliases, lead, article excerpt, related): one write.
    if (changed) {
      this.opts.vectors?.invalidate()
      this.opts.onTopicChanged?.(page.meta.slug)
    }
  }

  recordProvenance(
    slug: string,
    sources: Array<{ kind: string; ids: string[]; conversationId?: string }>,
    gitSha?: string,
  ): void {
    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO ros_wiki_provenance
         (topic_slug, source_kind, source_id, conversation_id, git_sha, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    const now = this.stamp()
    for (const source of sources) {
      for (const id of source.ids) {
        insert.run(slug, source.kind, id, source.conversationId ?? null, gitSha ?? null, now)
      }
    }
  }

  recordCitations(slug: string, citations: WikiCitation[]): void {
    const upsert = this.db.prepare(
      `INSERT INTO ros_wiki_citations (topic_slug, summary_id, kind, note, cited_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (topic_slug, summary_id) DO UPDATE SET
         kind = coalesce(excluded.kind, ros_wiki_citations.kind),
         note = coalesce(excluded.note, ros_wiki_citations.note)`,
    )
    const now = this.stamp()
    for (const c of citations) upsert.run(slug, c.summaryId, c.kind ?? null, c.note ?? null, now)
  }

  setRedirect(from: string, to: string): void {
    const f = normalizeSlug(from)
    const t = normalizeSlug(to)
    if (f === '' || t === '' || f === t) return
    this.db
      .prepare(
        `INSERT INTO ros_wiki_redirects (from_slug, to_slug, created_at) VALUES (?, ?, ?)
         ON CONFLICT (from_slug) DO UPDATE SET to_slug = excluded.to_slug`,
      )
      .run(f, t, this.stamp())
  }

  deleteTopic(slug: string): void {
    this.db.prepare(`DELETE FROM ros_wiki_topics WHERE slug = ?`).run(normalizeSlug(slug))
    this.opts.vectors?.invalidate()
  }

  /** Follow redirects from a slug, at most five hops (a loop ends where it started). */
  private redirectTarget(slug: string): string {
    let current = slug
    const seen = new Set([slug])
    for (let hop = 0; hop < 5; hop += 1) {
      const row = this.db
        .prepare(`SELECT to_slug FROM ros_wiki_redirects WHERE from_slug = ?`)
        .get(current) as { to_slug: string } | undefined
      if (!row || seen.has(row.to_slug)) break
      current = row.to_slug
      seen.add(current)
    }
    return current
  }

  async followRedirect(slug: string): Promise<string> {
    return this.redirectTarget(slug)
  }

  /** True when the summary needs no extraction at the current pipeline version. */
  extractionDone(summaryId: string, minVersion = WIKI_PIPELINE_VERSION): boolean {
    const row = this.db
      .prepare(`SELECT status, pipeline_version FROM ros_wiki_extractions WHERE summary_id = ?`)
      .get(summaryId) as { status: string; pipeline_version: number } | undefined
    if (!row) return false
    if (row.status === 'skipped') return true
    return row.status === 'done' && row.pipeline_version >= minVersion
  }

  markExtraction(mark: ExtractionMark): void {
    this.db
      .prepare(
        `INSERT INTO ros_wiki_extractions
           (summary_id, status, pipeline_version, topics_touched, git_sha, error, extracted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (summary_id) DO UPDATE SET
           status = excluded.status, pipeline_version = excluded.pipeline_version,
           topics_touched = excluded.topics_touched, git_sha = excluded.git_sha,
           error = excluded.error, extracted_at = excluded.extracted_at`,
      )
      .run(
        mark.summaryId,
        mark.status,
        mark.pipelineVersion,
        JSON.stringify(mark.topicsTouched ?? []),
        mark.gitSha ?? null,
        mark.error ?? null,
        this.stamp(),
      )
  }

  /** Red links (an entity one page names that has no page) and the stalest pages. */
  async gaps(opts?: { staleLimit?: number }): Promise<{
    redLinks: Array<{ entity: string; referencedBy: string[] }>
    stalest: WikiTopicRow[]
  }> {
    const red = this.db
      .prepare(
        `SELECT e.value AS entity, min(t.slug) AS slug FROM ros_wiki_topics t, json_each(t.entities) e
          GROUP BY e.value
         HAVING count(DISTINCT t.slug) = 1
            AND NOT EXISTS (
                  SELECT 1 FROM ros_wiki_topics t2
                   WHERE t2.slug = replace(
                           CASE WHEN instr(e.value, ':') > 0
                                THEN substr(e.value, instr(e.value, ':') + 1) ELSE '' END,
                           '_', '-')
                )
          ORDER BY e.value LIMIT 20`,
      )
      .all() as unknown as Array<{ entity: string; slug: string }>
    const stale = this.db
      .prepare(
        `SELECT ${TOPIC_COLUMNS} FROM ros_wiki_topics
          ORDER BY last_verified_at IS NOT NULL, last_verified_at ASC, slug LIMIT ?`,
      )
      .all(
        Math.min(Math.max(Math.trunc(opts?.staleLimit ?? 10), 1), 200),
      ) as unknown as TopicDbRow[]
    return {
      redLinks: red.map((r) => ({ entity: r.entity, referencedBy: [r.slug] })),
      stalest: stale.map(toRow),
    }
  }

  listAllSlugs(): string[] {
    return (
      this.db.prepare(`SELECT slug FROM ros_wiki_topics ORDER BY slug`).all() as unknown as Array<{
        slug: string
      }>
    ).map((r) => r.slug)
  }
}
/* eslint-enable @typescript-eslint/require-await */

export interface SqliteWikiExtractorOptions {
  log?: (line: string) => void
  now?: () => Date
}

interface SummaryRow {
  id: string
  conversation_id: string | null
  content: string
  kind: string
  latest_at: string | null
  created_at: string
  session_key: string | null
  agent: string | null
}

/** Mines leaf summaries into wiki pages, one `extract-wiki` job per summary. */
export class SqliteWikiExtractor {
  private readonly log: (line: string) => void
  private readonly now: () => Date
  readonly writer: WikiWriter

  constructor(
    private readonly db: DatabaseSync,
    readonly index: SqliteWikiIndex,
    wikiDir: string,
    private readonly llm: LlmClient,
    private readonly jobs: SqliteJobQueue,
    private readonly tags: () => SqliteTagStore,
    opts: SqliteWikiExtractorOptions = {},
  ) {
    this.writer = new WikiWriter(wikiDir)
    this.log = opts.log ?? (() => {})
    this.now = opts.now ?? (() => new Date())
  }

  /** Queue one summary (the compactor calls this for each leaf it writes). */
  enqueue(summaryId: string): boolean {
    return this.jobs.enqueue(
      EXTRACT_WIKI_TASK,
      { summaryId },
      { key: `wiki-ext-${summaryId}`, maxAttempts: 2 },
    )
  }

  /**
   * Sweep: queue leaves that were never mined, whose last attempt failed more
   * than a day ago, or that were mined by an older pipeline version. Never
   * tried first, then failed, then stale; oldest first within each.
   */
  enqueueBackfill(limit = BACKFILL_BATCH): number {
    const failedBefore = new Date(this.now().getTime() - FAILED_RETRY_MS).toISOString()
    const rows = this.db
      .prepare(
        `SELECT s.id, x.status FROM ros_summaries s
           LEFT JOIN ros_conversations c ON c.id = s.conversation_id
           LEFT JOIN ros_wiki_extractions x ON x.summary_id = s.id
          WHERE s.kind = 'leaf'
            AND (c.session_key IS NULL OR c.session_key NOT LIKE 'heartbeat:%')
            AND (x.summary_id IS NULL
                 OR (x.status = 'failed' AND x.extracted_at < ?)
                 OR (x.status = 'done' AND x.pipeline_version < ?))
            AND NOT EXISTS (SELECT 1 FROM ros_jobs j
                             WHERE j.job_key = 'wiki-ext-' || s.id AND j.state <> 'dead')
          ORDER BY CASE WHEN x.summary_id IS NULL THEN 0 WHEN x.status = 'failed' THEN 1 ELSE 2 END,
                   s.created_at ASC
          LIMIT ?`,
      )
      .all(failedBefore, WIKI_PIPELINE_VERSION, limit) as unknown as Array<{ id: string }>
    let queued = 0
    for (const { id } of rows) {
      const payload = { summaryId: id }
      const key = `wiki-ext-${id}`
      if (
        this.jobs.enqueue(EXTRACT_WIKI_TASK, payload, { key, maxAttempts: 2 }) ||
        this.jobs.revive(key, payload)
      ) {
        queued += 1
      }
    }
    return queued
  }

  /** Accepted tags on the summary and its conversation, reviewed ones first. */
  private tagsFor(summaryId: string, conversationId: string | null): WikiTag[] {
    try {
      const store = this.tags()
      const own = store.list({
        entityType: 'summary',
        entityId: summaryId,
        states: ['accepted'],
        limit: 100,
      })
      const inherited = conversationId
        ? store.list({
            entityType: 'conversation',
            entityId: conversationId,
            states: ['accepted'],
            limit: 100,
          })
        : []
      const byId = new Map<string, WikiTag>()
      for (const t of [...inherited, ...own]) {
        const id = `${t.key}:${t.value}`
        const reviewed = REVIEWED_TAG_SOURCES.has(t.source)
        const prior = byId.get(id)
        if (prior) prior.reviewed ||= reviewed
        else byId.set(id, { literal: safeLiteral(t), key: t.key, value: t.value, reviewed })
      }
      return [...byId.values()]
        .sort((a, b) => Number(b.reviewed) - Number(a.reviewed))
        .slice(0, WIKI_TAGS_MAX)
    } catch (err) {
      this.log(
        `[memory.sqlite] wiki: tag lookup failed, extracting without tags: ${err instanceof Error ? err.message : String(err)}`,
      )
      return []
    }
  }

  /** `extract-wiki` job. Throws on failure so the queue retries it. */
  async extract(payload: unknown): Promise<void> {
    const summaryId = (payload as { summaryId?: unknown } | null)?.summaryId
    if (typeof summaryId !== 'string' || summaryId === '') return
    const index = this.index
    if (index.extractionDone(summaryId)) return
    const summary = this.db
      .prepare(
        `SELECT s.id, s.conversation_id, s.content, s.kind, s.latest_at, s.created_at,
                c.session_key, c.agent
           FROM ros_summaries s LEFT JOIN ros_conversations c ON c.id = s.conversation_id
          WHERE s.id = ?`,
      )
      .get(summaryId) as unknown as SummaryRow | undefined
    if (!summary) return

    const skip = (reason: string): void => {
      index.markExtraction({
        summaryId,
        status: 'skipped',
        pipelineVersion: WIKI_PIPELINE_VERSION,
        error: reason,
      })
    }
    if (summary.kind !== 'leaf') return skip(`kind=${summary.kind} (leaves only)`)
    if (summary.content.length < WIKI_MIN_SUMMARY_CHARS) return skip('summary too short')
    if (summary.session_key?.startsWith('heartbeat:')) return skip('heartbeat conversation')

    try {
      const tags = this.tagsFor(summaryId, summary.conversation_id)
      const contentHits = await index.searchTopics(summary.content.slice(0, 500), { limit: 5 })
      const tagQuery = tagCandidateQuery(tags, summary.content)
      const hits = mergeTagCandidates(
        contentHits,
        tagQuery ? await index.searchTopics(tagQuery, { limit: 3 }) : [],
        3,
      )
      const candidates: ExtractionCandidate[] = hits.map((h) => ({
        slug: h.slug,
        title: h.title,
        aliases: h.aliases,
        entities: h.entities,
        currentState: h.currentState,
        article: h.article,
        ...(h.fromTag ? { fromTag: true as const } : {}),
      }))

      const verifiedAt = new Date(summary.latest_at ?? summary.created_at).toISOString()
      const summaryDate = verifiedAt.slice(0, 10)
      const answer = await this.llm.chat(
        WIKI_EXTRACT_SYSTEM_PROMPT,
        formatExtractionPrompt({
          summary: summary.content,
          summaryDate,
          agent: summary.agent ?? undefined,
          candidates,
          reviewedTags: tags.filter((t) => t.reviewed).map((t) => t.literal),
          ruleTags: tags.filter((t) => !t.reviewed).map((t) => t.literal),
        }),
        WIKI_EXTRACT_MAX_TOKENS,
        { minChars: 2 },
      )
      const { patches, rejected } = parseWikiPatches(answer.content, verifiedAt)
      for (const r of rejected) this.log(`[memory.sqlite] wiki: rejected patch — ${r}`)
      // An answer that is not JSON at all is a failed call, not "no topics".
      if (patches.length === 0 && rejected.some((r) => r.startsWith('unparseable JSON'))) {
        throw new Error('wiki extraction answer was not JSON')
      }
      if (patches.length === 0) {
        index.markExtraction({
          summaryId,
          status: 'done',
          pipelineVersion: WIKI_PIPELINE_VERSION,
          topicsTouched: [],
        })
        return
      }

      await this.writer.ensureRepo()
      const touched: string[] = []
      let lastSha: string | undefined
      for (const parsed of patches) {
        const patch = { ...parsed, addEntities: withoutRuleEntities(parsed.addEntities, tags) }
        const gated = await index.gateTopicWrite(patch.slug, patch.action, {
          entities: patch.addEntities,
          title: patch.title,
        })
        const citation: WikiCitation = {
          summaryId,
          date: summaryDate,
          kind: 'leaf',
          note: patch.historyEntry?.title || patch.title || patch.slug,
        }
        const source = {
          kind: 'summary' as const,
          ids: [summaryId],
          conversationId: summary.conversation_id ?? undefined,
        }
        const applied = await this.writer.apply(
          {
            ...patch,
            slug: gated.slug,
            action: gated.action,
            addAliases: [
              ...(patch.addAliases ?? []),
              ...(gated.slug !== patch.slug ? [patch.slug] : []),
            ],
            addCitations: [citation],
            addSources: [source],
          },
          { summaryId },
        )
        index.upsertTopic(applied.page, applied.gitSha)
        index.recordProvenance(gated.slug, [source], applied.gitSha)
        index.recordCitations(gated.slug, [citation])
        touched.push(gated.slug)
        lastSha = applied.gitSha
      }
      index.markExtraction({
        summaryId,
        status: 'done',
        pipelineVersion: WIKI_PIPELINE_VERSION,
        topicsTouched: touched,
        gitSha: lastSha,
      })
      this.log(`[memory.sqlite] wiki: ${summaryId.slice(0, 8)} → ${touched.join(', ')}`)
    } catch (err) {
      index.markExtraction({
        summaryId,
        status: 'failed',
        pipelineVersion: WIKI_PIPELINE_VERSION,
        error: (err instanceof Error ? err.message : String(err)).slice(0, 500),
      })
      throw err
    }
  }
}
