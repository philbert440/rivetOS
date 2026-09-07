import {
  isPromptToolName,
  type HarnessTranscriptTool,
  type HarnessTranscriptTurn,
} from '@rivetos/types'
import {
  extractClaudeUsage,
  extractTurnText,
  objectsFromLines,
  summarizeTurnArgs,
  THINKING_TAIL_CHARS,
  type HarnessTurn,
} from './parse-helpers.js'
import { claudeApprovalKeys, claudeAskAnswerKeys } from '../prompt-keys.js'
import type { HarnessAdapter } from './types.js'

const PROMPT_INPUT_MAX = 8192
const PROMPT_RESULT_MAX = 2048

function capResultText(text: string): string {
  return text.length > PROMPT_RESULT_MAX ? text.slice(0, PROMPT_RESULT_MAX) : text
}

function promptResultText(block: { content?: unknown }, toolUseResult: unknown): string {
  if (typeof block.content === 'string') return capResultText(block.content)
  if (Array.isArray(block.content)) {
    for (const p of block.content) {
      if (!p || typeof p !== 'object') continue
      const text = (p as { text?: unknown }).text
      if (typeof text === 'string') return capResultText(text)
    }
  }
  if (toolUseResult === undefined) return ''
  try {
    return capResultText(
      typeof toolUseResult === 'string' ? toolUseResult : JSON.stringify(toolUseResult),
    )
  } catch {
    return ''
  }
}

function promptInput(raw: unknown): unknown {
  try {
    const s = JSON.stringify(raw)
    if (s.length > PROMPT_INPUT_MAX) return { truncated: true }
    return raw
  } catch {
    return { truncated: true }
  }
}

/**
 * Claude Code 2.1.263 writes the raw slash line (`/compact`, `/exit`, `/model x`)
 * as a plain user message BEFORE the `<command-name>` echo that
 * `extractTurnText` already drops. The TUI never sends a leading-slash input
 * to the model (unknown commands are rejected at the prompt), so for THIS
 * store a bare slash line is never conversation. Claude-only on purpose —
 * other harness stores have no such line and get no filter.
 */
export function isBareSlashCommand(text: string): boolean {
  return /^\/[A-Za-z][\w:-]*(?:[ \t][^\n]*)?$/.test(text)
}

/** `system`/`compact_boundary` → a complete assistant marker turn carrying the post-compaction context size. */
function compactMarker(meta: unknown): HarnessTurn {
  const m = (meta ?? {}) as { postTokens?: unknown; preTokens?: unknown }
  const post = typeof m.postTokens === 'number' && m.postTokens >= 0 ? m.postTokens : undefined
  const pre = typeof m.preTokens === 'number' && m.preTokens > 0 ? m.preTokens : undefined
  const turn: HarnessTurn = {
    role: 'assistant',
    text:
      pre !== undefined && post !== undefined
        ? `Conversation compacted (${tokensLabel(pre)} → ${tokensLabel(post)})`
        : 'Conversation compacted',
    stopReason: 'end_turn',
    lastBlock: 'text',
    complete: true,
    compact: true,
  }
  if (post !== undefined) turn.usage = { promptTokens: post, completionTokens: 0, cachedTokens: 0 }
  return turn
}

function tokensLabel(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M tokens`
  if (n >= 1000) return `${Math.round(n / 1000).toString()}k tokens`
  return `${String(n)} tokens`
}

/**
 * Fold Claude Code store lines into LOGICAL turns. One agent turn spans many
 * store lines — one 'assistant' line per committed content block, with
 * 'user'-role tool_result lines interleaved. Only a REAL user text message
 * ends the assistant turn; everything between two user messages coalesces
 * into ONE assistant turn carrying its text, thinking tail, and tool stack
 * (matching what the live bridge streams, so a resynced transcript and a
 * watched-live one look identical).
 */
export function claudeTurnsFromLines(lines: Record<string, unknown>[]): HarnessTurn[] {
  const turns: HarnessTurn[] = []
  // tool_use id → entry on the current turn; results arrive on later lines
  let toolsById = new Map<string, HarnessTranscriptTool>()
  let cur: HarnessTurn | null = null
  let outputTokens = 0
  let thinking = ''
  // Distinct from lastBlock: a tool_result after a text line must not un-complete.
  let lastLineHadTextBlock = false

  const assistantComplete = (): boolean =>
    cur !== null &&
    cur.stopReason === 'end_turn' &&
    lastLineHadTextBlock &&
    !(cur.tools ?? []).some((t) => t.status === 'running')

  const finishAssistant = (): void => {
    if (cur) {
      if (thinking) {
        cur.thinking =
          thinking.length > THINKING_TAIL_CHARS
            ? '…' + thinking.slice(-THINKING_TAIL_CHARS)
            : thinking
      }
      if (cur.tools && cur.tools.length === 0) delete cur.tools
      if (cur.usage) cur.usage.completionTokens = outputTokens
      if (assistantComplete()) cur.complete = true
      // a turn with no visible content at all (blocks not flushed yet) is noise
      if (cur.text || cur.thinking || cur.tools) turns.push(cur)
    }
    cur = null
    outputTokens = 0
    thinking = ''
    lastLineHadTextBlock = false
    toolsById = new Map()
  }

  for (const obj of lines) {
    if (obj.isSidechain === true || obj.isMeta === true || obj.isCompactSummary === true) continue
    if (obj.type === 'system' && obj.subtype === 'compact_boundary') {
      // Context compaction. Between turns (manual /compact, or auto at the
      // start of a turn): close the finished turn and drop a complete marker
      // whose usage is the POST-compaction context size — without it the
      // pre-compaction peak stays on the context meter until the next reply.
      // Mid-turn (auto compaction lands right after a tool_result): leave the
      // running turn alone — a marker would split the live turn and read as a
      // false turn-complete; the continuation's own usage lines reset the
      // meter within seconds anyway.
      if (cur && !assistantComplete()) continue
      finishAssistant()
      turns.push(compactMarker(obj.compactMetadata))
      continue
    }
    if (obj.type !== 'user' && obj.type !== 'assistant') continue
    const msg = obj.message as
      { content?: unknown; usage?: unknown; model?: unknown; stop_reason?: unknown } | undefined
    const content = msg?.content

    if (obj.type === 'user') {
      // Tool results ride user-role lines: they update the pending tool's
      // status but must never render as something the user typed.
      if (Array.isArray(content)) {
        for (const b of content) {
          if (!b || typeof b !== 'object') continue
          const block = b as {
            type?: unknown
            tool_use_id?: unknown
            is_error?: unknown
            content?: unknown
          }
          if (block.type !== 'tool_result') continue
          if (cur) cur.lastBlock = 'tool_result'
          const entry =
            typeof block.tool_use_id === 'string' ? toolsById.get(block.tool_use_id) : undefined
          if (entry) {
            entry.status = block.is_error === true ? 'error' : 'done'
            if (isPromptToolName(entry.name)) {
              const text = promptResultText(block, obj.toolUseResult)
              if (text) entry.resultText = text
            }
          }
        }
      }
      const text = extractTurnText(content, 'user')
      if (text && !isBareSlashCommand(text)) {
        finishAssistant()
        turns.push({ role: 'user', text })
      }
      continue
    }

    // assistant line — extend the current turn
    cur ??= { role: 'assistant', text: '', tools: [] }
    if (typeof msg?.stop_reason === 'string') cur.stopReason = msg.stop_reason
    const blocks = Array.isArray(content)
      ? content
      : typeof content === 'string'
        ? [{ type: 'text', text: content }]
        : []
    let lineHadTextBlock = false
    for (const b of blocks) {
      if (!b || typeof b !== 'object') continue
      const block = b as {
        type?: unknown
        text?: unknown
        thinking?: unknown
        id?: unknown
        name?: unknown
        input?: unknown
      }
      if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
        cur.text = cur.text ? cur.text + '\n\n' + block.text.trim() : block.text.trim()
        cur.lastBlock = 'text'
        lineHadTextBlock = true
      } else if (block.type === 'thinking') {
        // stores write the trace as `thinking`; tolerate `text` variants
        const t = typeof block.thinking === 'string' ? block.thinking : block.text
        if (typeof t === 'string') thinking += t
        cur.lastBlock = 'thinking'
      } else if (block.type === 'tool_use' && typeof block.name === 'string') {
        const entry: HarnessTranscriptTool = { name: block.name, status: 'running' }
        if (typeof block.id === 'string') {
          entry.id = block.id
          toolsById.set(block.id, entry)
        }
        // `args` (summarised) for every tool — clients title tool rows from it;
        // prompt-class tools ALSO carry the full structured `input`.
        const args = summarizeTurnArgs(block.input)
        if (args) entry.args = args
        if (isPromptToolName(block.name)) entry.input = promptInput(block.input)
        cur.tools?.push(entry)
        cur.lastBlock = 'tool_use'
      }
    }
    lastLineHadTextBlock = lineHadTextBlock
    // usage: output tokens SUM across the turn's lines; prompt/cached/model
    // take the last line that carries them (final context size, den-hook parity)
    const stats = extractClaudeUsage(msg)
    if (stats.usage) {
      outputTokens += stats.usage.completionTokens
      cur.usage = stats.usage
    }
    if (stats.model) cur.model = stats.model
  }
  finishAssistant()
  return turns
}

export const claudeAdapter: HarnessAdapter = {
  id: 'claude-code',
  store: {
    parseLines(lines: string[]): HarnessTranscriptTurn[] {
      return claudeTurnsFromLines(objectsFromLines(lines))
    },
    parseObjects(objects: Record<string, unknown>[]): HarnessTranscriptTurn[] {
      return claudeTurnsFromLines(objects)
    },
  },
  promptToolNames: ['AskUserQuestion'],
  capabilities: () => ({ liveTurn: true, prompts: true, approvals: true }),
  answerKeys(prompt, answers) {
    return claudeAskAnswerKeys(prompt.questions, answers)
  },
  approvalKeys(decision) {
    return claudeApprovalKeys(decision)
  },
}
