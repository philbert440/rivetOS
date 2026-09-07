import {
  HarnessError,
  type HarnessTranscriptTool,
  type HarnessTranscriptTurn,
} from '@rivetos/types'
import {
  objectsFromLines,
  summarizeTurnArgs,
  THINKING_TAIL_CHARS,
  type HarnessTurn,
} from './parse-helpers.js'
import type { HarnessAdapter } from './types.js'

/**
 * Fold Codex rollout jsonl records into LOGICAL turns.
 *
 * Codex writes one JSON object per line under
 * `~/.codex/sessions/YYYY/MM/DD/rollout-<ISO>-<uuid>.jsonl`. Shapes (live
 * rollout on rivet-gpt, 2026-09-07):
 *
 *   - `session_meta` — session id in `payload.id` (also in the filename)
 *   - `response_item` / `payload.type: message` — `role` user|assistant|developer
 *     with `content[].type` `input_text` | `output_text`
 *   - `response_item` / `payload.type: reasoning` — thinking
 *   - `response_item` / `payload.type: custom_tool_call` + `custom_tool_call_output`
 *     — tool pair by call id
 *   - `token_usage_record` — turn usage
 *   - `event_msg` `task_complete` — turn boundary
 *
 * Folding matches kimi: only `role:'user'` input_text is a human turn;
 * developer / injection wrappers are dropped; reasoning + tools + the final
 * assistant `output_text` between two human turns coalesce into ONE assistant
 * turn.
 */
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function isCodexWrapper(text: string): boolean {
  return (
    text.startsWith('<environment_context>') ||
    text.startsWith('<skills_instructions>') ||
    text.startsWith('<multi_agent_')
  )
}

function contentText(content: unknown, want: 'input_text' | 'output_text'): string | null {
  let text = ''
  if (typeof content === 'string') {
    text = content
  } else if (Array.isArray(content)) {
    text = content
      .map((b) => {
        if (!isRecord(b) || typeof b.text !== 'string') return ''
        if (b.type !== want && b.type !== 'text') return ''
        return b.text
      })
      .filter(Boolean)
      .join('\n')
  }
  text = text.trim()
  if (!text || isCodexWrapper(text)) return null
  return text
}

function reasoningText(payload: Record<string, unknown>): string {
  if (typeof payload.text === 'string' && payload.text) return payload.text
  const parts: string[] = []
  const collect = (raw: unknown): void => {
    if (!Array.isArray(raw)) return
    for (const item of raw) {
      if (!isRecord(item) || typeof item.text !== 'string' || !item.text) continue
      parts.push(item.text)
    }
  }
  collect(payload.summary)
  collect(payload.content)
  return parts.join('')
}

function parseToolInput(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw
  try {
    return JSON.parse(raw) as unknown
  } catch {
    return raw
  }
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

export function codexTurnsFromLines(lines: Record<string, unknown>[]): HarnessTurn[] {
  const turns: HarnessTurn[] = []
  let toolsById = new Map<string, HarnessTranscriptTool>()
  let cur: HarnessTurn | null = null
  let thinking = ''
  let prompt = 0
  let completion = 0
  let cached = 0
  let hadText = false
  let hadFinalText = false

  const finishAssistant = (complete: boolean): void => {
    if (cur) {
      if (thinking) {
        cur.thinking =
          thinking.length > THINKING_TAIL_CHARS
            ? '…' + thinking.slice(-THINKING_TAIL_CHARS)
            : thinking
      }
      if (cur.tools && cur.tools.length === 0) delete cur.tools
      if (prompt > 0 || completion > 0) {
        cur.usage = { promptTokens: prompt, completionTokens: completion, cachedTokens: cached }
      }
      const running = cur.tools?.some((t) => t.status === 'running') === true
      cur.stopReason = running ? 'tool_use' : complete && hadText ? 'end_turn' : cur.stopReason
      if (complete && hadText && !running) cur.complete = true
      if (cur.text || cur.thinking || cur.tools) turns.push(cur)
    }
    cur = null
    hadText = false
    hadFinalText = false
    thinking = ''
    prompt = 0
    completion = 0
    cached = 0
    toolsById = new Map()
  }

  const ensureAssistant = (): HarnessTurn => {
    cur ??= { role: 'assistant', text: '', tools: [] }
    return cur
  }

  for (const obj of lines) {
    const type = obj.type
    const payload = isRecord(obj.payload) ? obj.payload : undefined

    if (type === 'token_usage_record' && payload) {
      prompt = num(payload.input_tokens)
      cached = num(payload.cached_input_tokens)
      completion = num(payload.output_tokens) + num(payload.reasoning_output_tokens)
      continue
    }

    if (type === 'event_msg' && payload?.type === 'task_complete') {
      finishAssistant(true)
      continue
    }

    if (type !== 'response_item' || !payload) continue

    switch (payload.type) {
      case 'message': {
        const role = payload.role
        if (role === 'developer') break
        if (role === 'user') {
          const text = contentText(payload.content, 'input_text')
          if (!text) break
          finishAssistant(true)
          turns.push({ role: 'user', text })
          break
        }
        if (role !== 'assistant') break
        const text = contentText(payload.content, 'output_text')
        if (!text) break
        const asst = ensureAssistant()
        asst.text = asst.text ? asst.text + '\n\n' + text : text
        asst.lastBlock = 'text'
        hadText = true
        hadFinalText = payload.phase !== 'commentary'
        break
      }
      case 'reasoning': {
        const chunk = reasoningText(payload)
        if (!chunk) break
        const asst = ensureAssistant()
        thinking += chunk
        asst.lastBlock = 'thinking'
        break
      }
      case 'function_call':
      case 'custom_tool_call': {
        const name =
          typeof payload.name === 'string'
            ? payload.name
            : typeof payload.tool === 'string'
              ? payload.tool
              : undefined
        if (!name) break
        const asst = ensureAssistant()
        const entry: HarnessTranscriptTool = { name, status: 'running' }
        const input = parseToolInput(payload.input ?? payload.arguments)
        const args = summarizeTurnArgs(typeof input === 'string' ? { input } : input)
        if (args) entry.args = args
        const id =
          typeof payload.call_id === 'string'
            ? payload.call_id
            : typeof payload.id === 'string'
              ? payload.id
              : undefined
        if (id) {
          entry.id = id
          toolsById.set(id, entry)
        }
        asst.tools?.push(entry)
        asst.lastBlock = 'tool_use'
        break
      }
      case 'function_call_output':
      case 'custom_tool_call_output': {
        const callId =
          typeof payload.call_id === 'string'
            ? payload.call_id
            : typeof payload.id === 'string'
              ? payload.id
              : undefined
        const entry = callId ? toolsById.get(callId) : undefined
        if (!entry) break
        const err = payload.error
        entry.status = err != null && err !== false && err !== '' ? 'error' : 'done'
        // The result lands on the same open turn the matching call opened.
        ensureAssistant().lastBlock = 'tool_result'
        break
      }
      default:
        break
    }
  }
  // A file tail is only a snapshot: commentary does not end an active turn.
  finishAssistant(hadFinalText)
  return turns
}

export const codexAdapter: HarnessAdapter = {
  id: 'codex',
  store: {
    parseLines(lines: string[]): HarnessTranscriptTurn[] {
      return codexTurnsFromLines(objectsFromLines(lines))
    },
    parseObjects(objects: Record<string, unknown>[]): HarnessTranscriptTurn[] {
      return codexTurnsFromLines(objects)
    },
  },
  promptToolNames: [],
  capabilities: () => ({ liveTurn: true, prompts: false, approvals: true }),
  // Only use shortcuts parsed from the current, version-pinned dialog.
  approvalKeys() {
    throw new HarnessError(
      'bad_request',
      'This Codex approval choice is not available from the captured screen; answer it in the terminal.',
    )
  },
}
