/**
 * MemoryBackend — what a memory store offers beyond the core `Memory`
 * contract: harness capture, the hub's Memory pages, and the memory tools
 * served over HTTP. The den's `/api/capture` and `/api/memory` routes are
 * typed on this, so they work on any backend that implements it.
 */

import type {
  MemoryBrowseResponse,
  MemoryHealthResponse,
  MemorySearchResponse,
  MemoryStatsResponse,
} from './gateway-api.js'
import type { Tag, TagEntityType, TagState, TagTaxonomyEntry } from './tags.js'
import type { Tool } from './tool.js'

/** A request the caller got wrong (bad filter, unknown window): HTTP 400. */
export class MemoryRequestError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MemoryRequestError'
  }
}

/** An operation this backend does not offer: HTTP 501. */
export class MemoryUnsupportedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MemoryUnsupportedError'
  }
}

/** One message of a harness capture batch. `event_id` makes delivery idempotent. */
export interface CaptureMessage {
  event_id: string
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  tool_name?: string
  tool_args?: unknown
  tool_result?: string
  metadata?: Record<string, unknown>
  /** ISO timestamp with an offset. */
  created_at?: string
}

/** Body of `POST /api/capture`. */
export interface CaptureBatchRequest {
  session_key: string
  agent: string
  channel?: string
  title?: string
  settings?: Record<string, unknown>
  task_id?: string
  finalize?: boolean
  messages: CaptureMessage[]
}

export interface CaptureBatchResult {
  ok: true
  conversation_id: string
  inserted: number
  skipped: number
}

export interface MemoryBrowseFilter {
  role?: string
  agent?: string
  toolName?: string
  /** `key:value`; only messages whose conversation carries the accepted tag. */
  tag?: string
  window?: string
  since?: string
  before?: string
  limit?: number
}

export interface MemoryTagListFilter {
  entityType?: TagEntityType
  entityId?: string
  key?: string
  value?: string
  states?: TagState[]
  limit?: number
}

export interface MemoryTagAddInput {
  entityType: TagEntityType
  entityId?: string
  sessionKey?: string
  agent?: string
  tag?: string
  key?: string
  value?: string
  display?: string
  reason?: string
}

export interface MemoryPendingTag extends Tag {
  sessionKey?: string | null
  title?: string | null
  agent?: string | null
  conversationId?: string | null
  excerpt?: string | null
}

export interface MemoryTagUsage {
  key: string
  value: string
  display: string
  conversations: number
}

export interface MemoryTaxonomyInput {
  key: string
  value: string
  display?: string
  parentValue?: string | null
  aliases?: string[]
  state?: TagState
  reason?: string
}

/** Session tags: the review loop and the vocabulary. */
export interface MemoryTagsBackend {
  list(filter: MemoryTagListFilter): Promise<Tag[]>
  pending(limit: number): Promise<MemoryPendingTag[]>
  counts(key: string | undefined, limit: number): Promise<MemoryTagUsage[]>
  /** Returns the ids whose state changed. */
  decide(ids: string[], state: 'accepted' | 'rejected', decidedBy: string): Promise<string[]>
  add(input: MemoryTagAddInput, decidedBy: string): Promise<Tag>
  forSessionKeys(keys: string[], states?: TagState[]): Promise<Map<string, Tag[]>>
  taxonomy(filter: {
    key?: string
    states?: TagState[]
    limit?: number
  }): Promise<TagTaxonomyEntry[]>
  /** Vocabulary edits. Absent when the backend does not edit its vocabulary. */
  upsertTaxonomy?(input: MemoryTaxonomyInput): Promise<TagTaxonomyEntry>
  decideTaxonomy?(
    entries: Array<{ key: string; value: string }>,
    state: 'accepted' | 'rejected',
  ): Promise<number>
  mergeTaxonomy?(
    key: string,
    from: string,
    into: string,
  ): Promise<{ moved: number; dropped: number; into: string }>
}

export interface MemoryBackend {
  /**
   * Write a capture batch. Idempotent on `event_id` within a conversation.
   * `allowFilesystem: false` for batches from another machine: nothing in
   * the batch may be resolved against this host's filesystem.
   */
  capture(
    batch: CaptureBatchRequest,
    options?: { allowFilesystem?: boolean },
  ): Promise<CaptureBatchResult>
  search(
    query: string,
    options: { scope: 'messages' | 'summaries' | 'both'; limit: number; tag?: string },
  ): Promise<MemorySearchResponse>
  browse(filter: MemoryBrowseFilter): Promise<MemoryBrowseResponse>
  stats(): Promise<MemoryStatsResponse>
  health(): Promise<MemoryHealthResponse>
  /** Tools served by `POST /api/memory/tool/<name>`. */
  tools(): Tool[]
  tags(): MemoryTagsBackend
  /**
   * The wiki: an index over the page files in `wikiDir`. Absent, or returning
   * undefined, when the backend has no wiki.
   */
  wiki?(): { index: MemoryWikiIndex; wikiDir: string } | undefined
}

/** A wiki topic as the index lists it. */
export interface MemoryWikiTopic {
  slug: string
  title: string
  aliases: string[]
  tags: string[]
  entities: string[]
  currentState: string
  gitSha: string | null
  updatedAt: string
  lastVerifiedAt?: string
}

/** What the den's wiki routes need from a topic index (page bodies are files). */
export interface MemoryWikiIndex {
  getTopic(slug: string): Promise<MemoryWikiTopic | undefined>
  listTopics(opts?: {
    tag?: string
    entity?: string
    limit?: number
    offset?: number
  }): Promise<{ topics: MemoryWikiTopic[]; total: number }>
  searchTopics(query: string, opts?: { limit?: number }): Promise<MemoryWikiTopic[]>
  gaps(opts?: { staleLimit?: number }): Promise<{
    redLinks: Array<{ entity: string; referencedBy: string[] }>
    stalest: MemoryWikiTopic[]
  }>
  resolveTopic?(slug: string): Promise<{ candidates: Array<{ slug: string; title: string }> }>
}

/** A `Memory` that also offers the wider surface. */
export interface WithMemoryBackend {
  backend(): MemoryBackend
}

export function hasMemoryBackend(memory: unknown): memory is WithMemoryBackend {
  return (
    typeof memory === 'object' &&
    memory !== null &&
    typeof (memory as { backend?: unknown }).backend === 'function'
  )
}
