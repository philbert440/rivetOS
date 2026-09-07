import { splitHermesReasoning, type HarnessTranscriptTurn } from '@rivetos/types'

export type HarnessTurn = HarnessTranscriptTurn

/** Keep the recent end of a long thinking trace — the UI collapses it anyway
 *  and whole traces can run to tens of KB per turn. */
export const THINKING_TAIL_CHARS = 8_000

/** Summarize tool input for turn display: primitives only, strings capped —
 *  titles need hints (file_path, command), never payloads or secrets. Local
 *  twin of the live bridge's summarizeBridgeArgs (core is not a dependency
 *  of den-server, and the cap policy must match the wire's expectations). */
export function summarizeTurnArgs(raw: unknown): Record<string, unknown> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const out: Record<string, unknown> = {}
  let keys = 0
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (keys >= 12) break
    if (typeof v === 'string') {
      out[k] = v.length > 200 ? v.slice(0, 200) + '…' : v
    } else if (typeof v === 'number' || typeof v === 'boolean') {
      out[k] = v
    } else {
      continue
    }
    keys++
  }
  return keys > 0 ? out : undefined
}

/**
 * Claude Code message.usage → MessageUsage. promptTokens includes cache
 * (input + cache_read + cache_creation), matching den-hook readTurnUsage.
 */
export function extractClaudeUsage(
  msg: { usage?: unknown; model?: unknown } | undefined,
): Pick<HarnessTurn, 'usage' | 'model'> {
  const out: Pick<HarnessTurn, 'usage' | 'model'> = {}
  if (typeof msg?.model === 'string' && msg.model.trim()) out.model = msg.model.trim()
  const u = msg?.usage
  if (!u || typeof u !== 'object') return out
  const o = u as Record<string, unknown>
  const input = typeof o.input_tokens === 'number' ? o.input_tokens : 0
  const cacheRead = typeof o.cache_read_input_tokens === 'number' ? o.cache_read_input_tokens : 0
  const cacheCreate =
    typeof o.cache_creation_input_tokens === 'number' ? o.cache_creation_input_tokens : 0
  const output = typeof o.output_tokens === 'number' ? o.output_tokens : 0
  const prompt = input + cacheRead + cacheCreate
  if (prompt <= 0 && output <= 0) return out
  out.usage = {
    promptTokens: prompt > 0 ? prompt : input,
    completionTokens: output,
    cachedTokens: cacheRead,
  }
  return out
}

/**
 * Pull display text out of a message content value (string or content blocks).
 * Keeps `text` blocks; drops thinking / tool_use / tool_result. Returns null
 * for turns with no human-visible text.
 */
export function extractTurnText(content: unknown, role: 'user' | 'assistant'): string | null {
  let text = ''
  if (typeof content === 'string') {
    text = content
  } else if (Array.isArray(content)) {
    text = content
      .map((b) => {
        if (!b || typeof b !== 'object') return ''
        const block = b as { type?: unknown; text?: unknown }
        if (block.type !== 'text' || typeof block.text !== 'string') return ''
        return block.text
      })
      .filter(Boolean)
      .join('\n')
  }
  text = text.trim()
  if (!text) return null
  // Skip harness-injected wrappers that aren't real conversational content
  // (mirrors Android SessionTranscript.extractText). <task-notification> is
  // Claude Code's background-task completion notice — it reads like tool
  // output and must never render as something the user typed.
  if (
    role === 'user' &&
    (text.startsWith('<command-') ||
      text.startsWith('<local-command') ||
      text.startsWith('<system-reminder') ||
      text.startsWith('<task-notification') ||
      text.startsWith('<user_info') ||
      text.startsWith('<environment_context>') ||
      text.startsWith('<skills_instructions>') ||
      text.startsWith('<multi_agent_') ||
      text.startsWith('Caveat:'))
  ) {
    return null
  }
  // grok wraps the actual user message in <user_query>…</user_query>
  if (role === 'user' && text.startsWith('<user_query>')) {
    const end = text.indexOf('</user_query>')
    text = (
      end >= 0 ? text.slice('<user_query>'.length, end) : text.slice('<user_query>'.length)
    ).trim()
    if (!text) return null
  }
  if (role === 'assistant') {
    text = splitHermesReasoning(text).text
    if (!text) return null
  }
  return text
}

/** Parse JSONL text lines into objects; skip non-objects and mid-write junk. */
export function objectsFromLines(lines: string[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = []
  for (const line of lines) {
    const t = line.trim()
    if (!t.startsWith('{')) continue
    try {
      out.push(JSON.parse(t) as Record<string, unknown>)
    } catch {
      // mid-write partial line — skip
    }
  }
  return out
}
