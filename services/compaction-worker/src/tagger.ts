/**
 * Session tagger — turn one leaf summary into `key:value` tag proposals.
 *
 * Two wire shapes, chosen by RIVETOS_TAGGER_WIRE_SHAPE:
 *
 *   openai  — any chat-completions model with the prompt below. This is the
 *             default and, with no RIVETOS_TAGGER_URL at all, runs against the
 *             compactor model: every node that summarizes also tags.
 *   native  — a classifier service (Jev, Kaya, …): POST <url> with
 *             { text, title, agent, keys, vocabulary, max } and read back
 *             { tags: [{ key, value, confidence?, reason? }] }.
 *
 * Both paths end in `parseTagProposals`, which normalizes, dedupes, drops
 * malformed rows and caps the list. Proposals are suggestions: the
 * suggest-tags task writes them `state=suggested` for the hub to accept or
 * reject. The rule-based `project:` tag (capture path) is not produced here.
 */

import { normalizeTagKey, normalizeTagValue, type TagProposal } from '@rivetos/types'
import { fetch as undiciFetch } from 'undici'
import type { LlmEndpoint } from './config.js'
import { authHeadersFor, callLlm } from './llm.js'

/** Seed keys the prompt always offers. Free-form keys are still accepted. */
export const TAG_SEED_KEYS = ['project', 'topic'] as const

/** Hard cap on proposals per summary, after dedupe. */
export const TAG_MAX_PROPOSALS = 8

/** Summary text offered to the tagger, at most. Leaves are far smaller; this is a backstop. */
export const TAG_SUMMARY_MAX_CHARS = 12_000

/** In-call retries for the tagger: one, not the compactor's LLM_RETRIES. */
export const TAG_LLM_RETRIES = 1

/** Model output budget. A JSON array of ≤8 short objects fits comfortably. */
export const TAG_MAX_TOKENS = 400

const KEY_RE = /^[a-z][a-z0-9-]{0,31}$/
const VALUE_MAX = 64

export interface TaggerVocabulary {
  /** Accepted `key:value` literals already in use, most common first. */
  accepted: string[]
}

export interface TaggerInput {
  summary: string
  title?: string
  agent?: string
  vocabulary: TaggerVocabulary
}

export interface TaggerConfig {
  wireShape: 'openai' | 'native'
  target: LlmEndpoint
  /** Per-attempt timeout. Default 60 s. */
  timeoutMs?: number
}

/** Model text that will be stored and rendered: no control characters, single-spaced. */
function cleanText(raw: string, max: number): string {
  const text = raw
    .replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  // By code point: never cut a surrogate pair.
  return Array.from(text).slice(0, max).join('')
}

export const TAG_SYSTEM_PROMPT = `You label engineering conversation summaries with key:value tags.

Rules:
- Output ONLY a JSON array. No prose, no markdown fences.
- Each element: {"key": "...", "value": "...", "confidence": 0..1, "reason": "one short clause"}.
- Keys: prefer "project" (a codebase, product or repo) and "topic" (what the work was about). Add another key only when neither fits.
- Values: 1-4 words, lowercase, specific. "topic:memory-compaction" not "topic:software".
- Reuse an existing vocabulary tag whenever it fits. Propose a new value only when nothing existing applies.
- At most ${String(TAG_MAX_PROPOSALS)} tags. Fewer is better. Return [] when the summary is noise (heartbeats, empty sessions).
- Never invent projects or topics that the summary does not mention.`

/** The summary offered to a tagger: bounded by code point (never a split surrogate pair). */
function boundSummary(summary: string): string {
  return summary.length <= TAG_SUMMARY_MAX_CHARS
    ? summary
    : Array.from(summary).slice(0, TAG_SUMMARY_MAX_CHARS).join('')
}

export function formatTagPrompt(input: TaggerInput): string {
  const lines: string[] = []
  // Title and agent are captured text: one line each so they cannot restructure the prompt.
  if (input.title) lines.push(`Conversation title: ${cleanText(input.title, 200)}`)
  if (input.agent) lines.push(`Agent: ${cleanText(input.agent, 80)}`)
  const vocab = input.vocabulary.accepted.slice(0, 80)
  lines.push(
    vocab.length > 0
      ? `Existing vocabulary (reuse when it fits):\n${vocab.map((v) => `- ${v}`).join('\n')}`
      : 'Existing vocabulary: (none yet)',
  )
  lines.push(`Summary:\n${boundSummary(input.summary)}`)
  lines.push('Tags (JSON array only):')
  return lines.join('\n\n')
}

/**
 * Normalize a raw model/classifier answer into clean proposals. Tolerates a
 * fenced block or an object wrapper (`{"tags": [...]}`), rejects anything that
 * is not an array of objects after that.
 */
export function parseTagProposals(raw: string): { proposals: TagProposal[]; rejected: string[] } {
  const rejected: string[] = []
  let text = raw.trim()
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/m.exec(text)
  if (fence) text = fence[1].trim()
  // Tolerate chatter around the array: take the outermost [...] or {...}.
  const start = Math.min(...['[', '{'].map((c) => text.indexOf(c)).filter((i) => i >= 0))
  if (!Number.isFinite(start)) return { proposals: [], rejected: ['no JSON found'] }
  text = text.slice(start)

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    // Trailing chatter after the JSON: cut at the last closing bracket.
    const end = Math.max(text.lastIndexOf(']'), text.lastIndexOf('}'))
    if (end < 0) return { proposals: [], rejected: ['invalid JSON'] }
    try {
      parsed = JSON.parse(text.slice(0, end + 1))
    } catch {
      return { proposals: [], rejected: ['invalid JSON'] }
    }
  }
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const wrapped = (parsed as { tags?: unknown }).tags
    if (Array.isArray(wrapped)) parsed = wrapped
  }
  if (!Array.isArray(parsed)) return { proposals: [], rejected: ['not an array'] }

  const seen = new Set<string>()
  const proposals: TagProposal[] = []
  for (const item of parsed) {
    if (!item || typeof item !== 'object') {
      rejected.push('element is not an object')
      continue
    }
    const o = item as Record<string, unknown>
    let key: string | undefined
    let valueRaw: string | undefined
    if (typeof o.key === 'string' && typeof o.value === 'string') {
      key = normalizeTagKey(o.key)
      valueRaw = o.value
    } else if (typeof o.tag === 'string' && o.tag.includes(':')) {
      const i = o.tag.indexOf(':')
      key = normalizeTagKey(o.tag.slice(0, i))
      valueRaw = o.tag.slice(i + 1)
    }
    if (!key || valueRaw === undefined) {
      rejected.push(`missing key/value: ${JSON.stringify(item).slice(0, 80)}`)
      continue
    }
    if (!KEY_RE.test(key)) {
      rejected.push(`bad key "${key}"`)
      continue
    }
    // By code point, so a surrogate pair is never cut.
    const value = Array.from(normalizeTagValue(valueRaw))
      .slice(0, VALUE_MAX)
      .join('')
      .replace(/-+$/, '')
    if (!value) {
      rejected.push(`empty value for key "${key}"`)
      continue
    }
    const literal = `${key}:${value}`
    if (seen.has(literal)) continue
    seen.add(literal)
    const confidence =
      typeof o.confidence === 'number' && Number.isFinite(o.confidence)
        ? Math.min(1, Math.max(0, o.confidence))
        : undefined
    const reason = typeof o.reason === 'string' ? cleanText(o.reason, 200) : undefined
    const display = cleanText(valueRaw, VALUE_MAX)
    proposals.push({
      key,
      value,
      ...(display && display !== value ? { display } : {}),
      ...(confidence === undefined ? {} : { confidence }),
      ...(reason ? { reason } : {}),
    })
    if (proposals.length >= TAG_MAX_PROPOSALS) break
  }
  return { proposals, rejected }
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
    text: boundSummary(input.summary),
    title: input.title ? cleanText(input.title, 200) : null,
    agent: input.agent ? cleanText(input.agent, 80) : null,
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
