/**
 * Tag suggestions on SQLite: a `suggest-tags` job per leaf summary asks a
 * model for `key:value` tags and stores them as suggestions on the summary
 * and on its conversation, for a person to accept or reject. The prompt and
 * the answer parser are the Postgres tagger's (`@rivetos/memory-core`).
 */

import type { DatabaseSync } from 'node:sqlite'
import type { TokenSource } from '@rivetos/token-command'
import { formatTag } from '@rivetos/types'
import {
  TAG_MAX_PROPOSALS,
  TAG_MAX_TOKENS,
  TAG_SEED_KEYS,
  TAG_SYSTEM_PROMPT,
  boundTagSummary,
  cleanTagText,
  formatTagPrompt,
  parseTagProposals,
} from '@rivetos/memory-core'
import type { SqliteJobQueue } from './jobs.js'
import type { LlmClient } from './llm.js'
import type { SqliteTagVocabulary } from './tag-vocabulary.js'
import type { SqliteTagStore } from './tags.js'

export const SUGGEST_TAGS_TASK = 'suggest-tags'

/** Shorter summaries carry too little to label. */
const TAG_MIN_SUMMARY_CHARS = 120
/** Vocabulary entries shown to the model. */
const TAG_VOCAB_LIMIT = 80

interface SummaryRow {
  id: string
  conversation_id: string | null
  content: string
  kind: string
  title: string | null
  session_key: string | null
  agent: string | null
}

/**
 * A tagger that is a classifier service, not a chat model: one POST with the
 * summary and the vocabulary, answered with the proposals. The request body
 * is the one the Postgres worker sends (`callNativeTagger`).
 */
export interface NativeTagger {
  /** The full URL to POST to. */
  url: string
  model: string
  apiKey?: string
  /** Wins over `apiKey`. A rejected token (401) is re-minted once. */
  tokenSource?: TokenSource
  timeoutMs?: number
  fetch?: typeof globalThis.fetch
}

async function callNativeTagger(
  target: NativeTagger,
  input: {
    summary: string
    title?: string
    agent?: string
    vocabulary: string[]
    currentTags?: readonly string[]
  },
): Promise<string> {
  const body = JSON.stringify({
    model: target.model,
    text: boundTagSummary(input.summary),
    title: input.title ? cleanTagText(input.title, 200) : null,
    agent: input.agent ? cleanTagText(input.agent, 80) : null,
    keys: TAG_SEED_KEYS,
    vocabulary: input.vocabulary.slice(0, 200),
    current: (input.currentTags ?? []).slice(0, 40),
    max: TAG_MAX_PROPOSALS,
  })
  const post = async (token: string | undefined): Promise<Response> => {
    const ctrl = new AbortController()
    const timer = setTimeout(() => {
      ctrl.abort()
    }, target.timeoutMs ?? 60_000)
    try {
      return await (target.fetch ?? globalThis.fetch)(target.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        signal: ctrl.signal,
        body,
      })
    } finally {
      clearTimeout(timer)
    }
  }
  let token = target.tokenSource ? await target.tokenSource.getToken() : target.apiKey
  let response = await post(token)
  if (response.status === 401 && target.tokenSource) {
    await response.body?.cancel().catch(() => {})
    target.tokenSource.invalidate(token ?? '')
    token = await target.tokenSource.getToken()
    response = await post(token)
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {})
    throw new Error(`tagger HTTP ${String(response.status)}: ${response.statusText || 'error'}`)
  }
  return await response.text()
}

export class SqliteTagger {
  constructor(
    private readonly db: DatabaseSync,
    /** A chat model (the built-in prompt), or a native classifier endpoint. */
    private readonly llm: LlmClient | NativeTagger,
    private readonly jobs: SqliteJobQueue,
    private readonly tags: () => SqliteTagStore,
    private readonly vocabulary: SqliteTagVocabulary,
    private readonly tx: <T>(fn: () => T) => T,
    private readonly log: (line: string) => void = () => {},
    /** Suggest removing a tag a person added or accepted. Default: no. */
    private readonly allowProtectedRemovals = false,
  ) {}

  /** Queue one summary (the compactor calls this for each leaf it writes). */
  enqueue(summaryId: string): boolean {
    return this.jobs.enqueue(
      SUGGEST_TAGS_TASK,
      { summaryId },
      { key: `tags-${summaryId}`, maxAttempts: 2 },
    )
  }

  /** `suggest-tags` job. Throws on an LLM failure so the queue retries it. */
  async suggest(payload: unknown): Promise<number> {
    const summaryId = (payload as { summaryId?: unknown } | null)?.summaryId
    if (typeof summaryId !== 'string' || summaryId === '') return 0
    const summary = this.db
      .prepare(
        `SELECT s.id, s.conversation_id, s.content, s.kind, c.title, c.session_key, c.agent
           FROM ros_summaries s LEFT JOIN ros_conversations c ON c.id = s.conversation_id
          WHERE s.id = ?`,
      )
      .get(summaryId) as unknown as SummaryRow | undefined
    if (!summary) return 0
    if (summary.kind !== 'leaf') return 0
    if (summary.content.length < TAG_MIN_SUMMARY_CHARS) return 0
    if (summary.session_key?.startsWith('heartbeat:')) return 0

    const input = {
      summary: summary.content,
      title: summary.title ?? undefined,
      agent: summary.agent ?? undefined,
      currentTags: this.currentTagLiterals(summaryId, summary.conversation_id),
    }
    const answer =
      'chat' in this.llm
        ? await this.llm.chat(
            TAG_SYSTEM_PROMPT,
            formatTagPrompt({
              ...input,
              vocabulary: { accepted: this.vocabulary.forTagger(TAG_VOCAB_LIMIT) },
            }),
            TAG_MAX_TOKENS,
            { minChars: 2 },
          )
        : {
            content: await callNativeTagger(this.llm, {
              ...input,
              vocabulary: this.vocabulary.forTagger(TAG_VOCAB_LIMIT),
            }),
            model: this.llm.model,
          }
    const { proposals, rejected } = parseTagProposals(answer.content)
    for (const r of rejected) this.log(`[memory.sqlite] tags: rejected — ${r}`)
    if (proposals.length === 0) return 0

    const additions = proposals.filter((p) => p.action !== 'remove')
    const removals = proposals.filter((p) => p.action === 'remove')
    const by = { source: 'model', proposedBy: answer.model }
    const conversationId = summary.conversation_id
    const allowProtected = this.allowProtectedRemovals
    // One transaction: a tag is not left on the summary without its session.
    // Removals are only flagged; nothing is dropped until a person accepts.
    const written = this.tx(() => {
      const store = this.tags()
      const onSummary = store.propose('summary', summaryId, additions, by)
      const onConversation = conversationId
        ? store.propose('conversation', conversationId, additions, by)
        : 0
      const removed =
        store.proposeRemovals('summary', summaryId, removals, { allowProtected }) +
        (conversationId
          ? store.proposeRemovals('conversation', conversationId, removals, { allowProtected })
          : 0)
      this.vocabulary.propose(additions, answer.model)
      return onSummary + onConversation + removed
    })
    this.log(
      `[memory.sqlite] tags: ${summaryId.slice(0, 8)} — ${String(proposals.length)} proposed, ${String(written)} new`,
    )
    return written
  }

  /** Accepted tags on the summary and its conversation, for the prompt. */
  private currentTagLiterals(summaryId: string, conversationId: string | null): string[] {
    const rows = this.db
      .prepare(
        `SELECT key, value, display FROM ros_tags
          WHERE state = 'accepted'
            AND ((entity_type = 'summary' AND entity_id = ?)
              OR (entity_type = 'conversation' AND entity_id = ?))
          ORDER BY key, value
          LIMIT 40`,
      )
      .all(summaryId, conversationId) as unknown as Array<{
      key: string
      value: string
      display: string
    }>
    return rows.map((r) => formatTag(r))
  }
}
