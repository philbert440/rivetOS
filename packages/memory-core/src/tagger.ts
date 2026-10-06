/**
 * Session tagger: the prompt, the input bounds and the answer parser.
 * Backend-neutral, so every memory backend proposes tags the same way; each
 * backend brings its own LLM call and its own store.
 */

import { normalizeTagKey, normalizeTagValue, PROJECT_RULE_NAME, type TagProposal } from '@rivetos/types'

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
  /** Accepted `key:value` literals already on the summary or its conversation. */
  currentTags?: readonly string[]
}

/**
 * A person added this tag, or a person accepted it. The tagger must not
 * propose removing it unless the operator opts in. The cwd rule's own
 * `decided_by` is not a person.
 */
export function tagRemovalIsProtected(tag: { source: string; decidedBy?: string | null }): boolean {
  if (tag.source === 'user') return true
  const by = (tag.decidedBy ?? '').trim()
  return by !== '' && by !== PROJECT_RULE_NAME
}

/** Model text that will be stored and rendered: no control characters, single-spaced. */
export function cleanTagText(raw: string, max: number): string {
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
- To flag a tag already on the conversation as wrong, return {"key","value","action":"remove","confidence","reason"}. Only a tag listed under "already on this conversation". A removal is a suggestion: it is not applied until a person accepts it.
- At most ${String(TAG_MAX_PROPOSALS)} tags, removals included. Fewer is better. Return [] when the summary is noise (heartbeats, empty sessions).
- Never invent projects or topics that the summary does not mention.`

/** The summary offered to a tagger: bounded by code point (never a split surrogate pair). */
export function boundTagSummary(summary: string): string {
  return summary.length <= TAG_SUMMARY_MAX_CHARS
    ? summary
    : Array.from(summary).slice(0, TAG_SUMMARY_MAX_CHARS).join('')
}

export function formatTagPrompt(input: TaggerInput): string {
  const lines: string[] = []
  // Title and agent are captured text: one line each so they cannot restructure the prompt.
  if (input.title) lines.push(`Conversation title: ${cleanTagText(input.title, 200)}`)
  if (input.agent) lines.push(`Agent: ${cleanTagText(input.agent, 80)}`)
  const vocab = input.vocabulary.accepted.slice(0, 80)
  lines.push(
    vocab.length > 0
      ? `Existing vocabulary (reuse when it fits):\n${vocab.map((v) => `- ${v}`).join('\n')}`
      : 'Existing vocabulary: (none yet)',
  )
  const current = (input.currentTags ?? []).slice(0, 40).map((v) => cleanTagText(v, 200))
  lines.push(
    current.length > 0
      ? `Tags already on this conversation (suggest action "remove" only for one of these, and only when the summary shows it is wrong):\n${current.map((v) => `- ${v}`).join('\n')}`
      : 'Tags already on this conversation: (none)',
  )
  lines.push(`Summary:\n${boundTagSummary(input.summary)}`)
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
    let action: 'remove' | undefined
    if (o.action !== undefined && o.action !== 'add') {
      if (o.action !== 'remove') {
        rejected.push(`bad action for "${literal}"`)
        continue
      }
      action = 'remove'
    }
    const seenKey = `${action ?? 'add'}:${literal}`
    if (seen.has(seenKey)) continue
    seen.add(seenKey)
    const confidence =
      typeof o.confidence === 'number' && Number.isFinite(o.confidence)
        ? Math.min(1, Math.max(0, o.confidence))
        : undefined
    const reason = typeof o.reason === 'string' ? cleanTagText(o.reason, 200) : undefined
    const display = cleanTagText(valueRaw, VALUE_MAX)
    proposals.push({
      key,
      value,
      ...(display && display !== value ? { display } : {}),
      ...(confidence === undefined ? {} : { confidence }),
      ...(reason ? { reason } : {}),
      ...(action ? { action } : {}),
    })
    if (proposals.length >= TAG_MAX_PROPOSALS) break
  }
  return { proposals, rejected }
}
