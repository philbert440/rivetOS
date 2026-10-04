/**
 * Session tagger — turn one leaf summary into `key:value` tag proposals.
 *
 * Two wire shapes, chosen by RIVETOS_TAGGER_WIRE_SHAPE:
 *
 *   openai  — any chat-completions model with the prompt below. This is the
 *             default and, with no RIVETOS_TAGGER_URL at all, runs against the
 *             compactor model: every node that summarizes also tags.
 *   native  — a classifier service e.g. a hosted text classifier: POST <url> with
 *             { text, title, agent, keys, vocabulary, max } and read back
 *             { tags: [{ key, value, confidence?, reason? }] }.
 *
 * Both paths end in `parseTagProposals`, which normalizes, dedupes, drops
 * malformed rows and caps the list. Proposals are suggestions: the
 * suggest-tags task writes them `state=suggested` for the hub to accept or
 * reject. The rule-based `project:` tag (capture path) is not produced here.
 */

import type { TagProposal } from '@rivetos/types'
import {
  TAG_LLM_RETRIES,
  TAG_MAX_PROPOSALS,
  TAG_MAX_TOKENS,
  TAG_SEED_KEYS,
  TAG_SYSTEM_PROMPT,
  boundTagSummary,
  cleanTagText,
  formatTagPrompt,
  parseTagProposals,
  type TaggerInput,
} from '@rivetos/memory-core'
import { fetch as undiciFetch } from 'undici'
import type { LlmEndpoint } from './config.js'
import { authHeadersFor, callLlm } from './llm.js'

// The prompt, bounds and parser live in @rivetos/memory-core (shared with the
// SQLite backend) and are re-exported here under their old names.
export {
  TAG_SEED_KEYS,
  TAG_MAX_PROPOSALS,
  TAG_SUMMARY_MAX_CHARS,
  TAG_LLM_RETRIES,
  TAG_MAX_TOKENS,
  TAG_SYSTEM_PROMPT,
  formatTagPrompt,
  parseTagProposals,
} from '@rivetos/memory-core'
export type { TaggerVocabulary, TaggerInput } from '@rivetos/memory-core'

export interface TaggerConfig {
  wireShape: 'openai' | 'native'
  target: LlmEndpoint
  /** Per-attempt timeout. Default 60 s. */
  timeoutMs?: number
}

/**
 * Native classifier call. Same auth convention as the chat path, including
 * one re-mint when a minted token is rejected with 401.
 */
export async function callNativeTagger(
  target: LlmEndpoint,
  input: TaggerInput,
  opts: { timeoutMs?: number } = {},
): Promise<string> {
  const body = JSON.stringify({
    model: target.model,
    // Same bounds and cleaning as the chat prompt: captured text is untrusted.
    text: boundTagSummary(input.summary),
    title: input.title ? cleanTagText(input.title, 200) : null,
    agent: input.agent ? cleanTagText(input.agent, 80) : null,
    keys: TAG_SEED_KEYS,
    vocabulary: input.vocabulary.accepted.slice(0, 200),
    max: TAG_MAX_PROPOSALS,
  })
  for (let attempt = 0; ; attempt += 1) {
    const auth = await authHeadersFor(target)
    const ctrl = new AbortController()
    const timeout = setTimeout(() => {
      ctrl.abort()
    }, opts.timeoutMs ?? 60_000)
    try {
      const response = await undiciFetch(target.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...auth },
        signal: ctrl.signal,
        body,
      })
      if (response.status === 401 && target.tokenSource && attempt === 0) {
        target.tokenSource.invalidate(auth.Authorization?.replace(/^Bearer /, ''))
        // Release the rejected response's socket before retrying.
        await response.body?.cancel().catch(() => {})
        continue
      }
      if (!response.ok) {
        throw new Error(`tagger HTTP ${String(response.status)}: ${response.statusText || 'error'}`)
      }
      return await response.text()
    } finally {
      clearTimeout(timeout)
    }
  }
}

/** One summary in, clean proposals out. Throws on transport/LLM failure. */
export async function suggestTags(
  cfg: TaggerConfig,
  input: TaggerInput,
): Promise<{ proposals: TagProposal[]; rejected: string[] }> {
  const raw =
    cfg.wireShape === 'native'
      ? await callNativeTagger(cfg.target, input, { timeoutMs: cfg.timeoutMs })
      : await callLlm(TAG_SYSTEM_PROMPT, formatTagPrompt(input), TAG_MAX_TOKENS, {
          minChars: 2,
          endpoint: cfg.target,
          timeoutMs: cfg.timeoutMs ?? 60_000,
          maxRetries: TAG_LLM_RETRIES,
        })
  return parseTagProposals(raw)
}
