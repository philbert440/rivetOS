/**
 * Tag suggestions on SQLite: a `suggest-tags` job per leaf summary asks a
 * model for `key:value` tags and stores them as suggestions on the summary
 * and on its conversation, for a person to accept or reject. The prompt and
 * the answer parser are the Postgres tagger's (`@rivetos/memory-core`).
 */

import type { DatabaseSync } from 'node:sqlite'
import {
  TAG_MAX_TOKENS,
  TAG_SYSTEM_PROMPT,
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

export class SqliteTagger {
  constructor(
    private readonly db: DatabaseSync,
    private readonly llm: LlmClient,
    private readonly jobs: SqliteJobQueue,
    private readonly tags: () => SqliteTagStore,
    private readonly vocabulary: SqliteTagVocabulary,
    private readonly tx: <T>(fn: () => T) => T,
    private readonly log: (line: string) => void = () => {},
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

    const answer = await this.llm.chat(
      TAG_SYSTEM_PROMPT,
      formatTagPrompt({
        summary: summary.content,
        title: summary.title ?? undefined,
        agent: summary.agent ?? undefined,
        vocabulary: { accepted: this.vocabulary.forTagger(TAG_VOCAB_LIMIT) },
      }),
      TAG_MAX_TOKENS,
      { minChars: 2 },
    )
    const { proposals, rejected } = parseTagProposals(answer.content)
    for (const r of rejected) this.log(`[memory.sqlite] tags: rejected — ${r}`)
    if (proposals.length === 0) return 0

    const by = { source: 'model', proposedBy: answer.model }
    const conversationId = summary.conversation_id
    // One transaction: a tag is not left on the summary without its session.
    const written = this.tx(() => {
      const store = this.tags()
      const onSummary = store.propose('summary', summaryId, proposals, by)
      const onConversation = conversationId
        ? store.propose('conversation', conversationId, proposals, by)
        : 0
      this.vocabulary.propose(proposals, answer.model)
      return onSummary + onConversation
    })
    this.log(
      `[memory.sqlite] tags: ${summaryId.slice(0, 8)} — ${String(proposals.length)} proposed, ${String(written)} new`,
    )
    return written
  }
}
