import type { HarnessTranscriptTool, HarnessTranscriptTurn } from '@rivetos/types'
import {
  extractTurnText,
  objectsFromLines,
  summarizeTurnArgs,
  THINKING_TAIL_CHARS,
  type HarnessTurn,
} from './parse-helpers.js'
import type { HarnessAdapter } from './types.js'

/**
 * Fold kimi `wire.jsonl` records into LOGICAL turns.
 *
 * kimi's transcript is an event log of the agent loop, not a message list, and
 * the CLI reconstructs the message view from it at read time. The record
 * semantics are kimi's own (`packages/agent-core` context restore, mirrored in
 * its daemon REST reducer) and the rivet-memory backfill tool in this repo
 * already relies on the same ones:
 *
 *   - `context.append_message`  — a real message. `origin.kind` says whose:
 *     `user` is a human turn, everything else (`injection` permission banners
 *     and todo reminders, `skill_activation`, `background_task`,
 *     `compaction_summary`) is kimi talking to itself.
 *   - `context.append_loop_event` `step.begin` — a new assistant step; later
 *     `content.part` (`text` / `think`) and `tool.call` events on that step
 *     grow the same assistant message, and `step.end` closes it with `usage`.
 *   - `context.append_loop_event` `tool.result` — pairs to a `tool.call` by
 *     `toolCallId` and carries a real `isError` flag, so unlike the den live
 *     stream a kimi transcript CAN report a failed tool honestly.
 *
 * Only a real user message ends the assistant turn, so everything between two
 * human turns coalesces into one — the same folding rule the Claude reader
 * uses, so the two harnesses' transcripts render identically.
 */
export function kimiTurnsFromLines(lines: Record<string, unknown>[]): HarnessTurn[] {
  const turns: HarnessTurn[] = []
  let toolsById = new Map<string, HarnessTranscriptTool>()
  let cur: HarnessTurn | null = null
  let thinking = ''
  let prompt = 0
  let completion = 0
  let cached = 0
  let model = ''

  const finishAssistant = (): void => {
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
      if (model) cur.model = model
      if (cur.text || cur.thinking || cur.tools) turns.push(cur)
    }
    cur = null
    thinking = ''
    prompt = 0
    completion = 0
    cached = 0
    toolsById = new Map()
  }

  for (const obj of lines) {
    // The model actually serving the session — stamped on every llm.request,
    // and the only place the transcript names it.
    if (obj.type === 'llm.request' && typeof obj.model === 'string') model = obj.model

    if (obj.type === 'context.append_message') {
      const msg = obj.message as { role?: unknown; content?: unknown; origin?: unknown } | undefined
      const origin = (msg?.origin ?? {}) as { kind?: unknown }
      if (msg?.role !== 'user' || origin.kind !== 'user') continue
      const text = extractTurnText(msg.content, 'user')
      if (!text) continue
      finishAssistant()
      turns.push({ role: 'user', text })
      continue
    }

    if (obj.type !== 'context.append_loop_event') continue
    const event = obj.event as Record<string, unknown> | undefined
    if (!event || typeof event !== 'object') continue

    switch (event.type) {
      case 'content.part': {
        const part = event.part as { type?: unknown; text?: unknown; think?: unknown } | undefined
        if (!part) break
        cur ??= { role: 'assistant', text: '', tools: [] }
        if (part.type === 'text' && typeof part.text === 'string' && part.text.trim()) {
          cur.text = cur.text ? cur.text + '\n\n' + part.text.trim() : part.text.trim()
        } else if (part.type === 'think' && typeof part.think === 'string') {
          thinking += part.think
        }
        break
      }
      case 'tool.call': {
        if (typeof event.name !== 'string') break
        cur ??= { role: 'assistant', text: '', tools: [] }
        const entry: HarnessTranscriptTool = { name: event.name, status: 'running' }
        const args = summarizeTurnArgs(event.args)
        if (args) entry.args = args
        if (typeof event.toolCallId === 'string') {
          entry.id = event.toolCallId
          toolsById.set(event.toolCallId, entry)
        }
        cur.tools?.push(entry)
        break
      }
      case 'tool.result': {
        const entry =
          typeof event.toolCallId === 'string' ? toolsById.get(event.toolCallId) : undefined
        if (!entry) break
        const result = event.result as { isError?: unknown } | undefined
        entry.status = result?.isError === true ? 'error' : 'done'
        break
      }
      case 'step.end': {
        // kimi's usage split: `inputOther` is the uncached prompt, and the two
        // cache counters are prompt tokens too — summed the same way the Claude
        // reader sums input + cache_read + cache_creation, so a token count
        // means the same thing on both transcripts.
        const usage = event.usage as Record<string, unknown> | undefined
        if (!usage) break
        const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
        const read = num(usage.inputCacheRead)
        prompt += num(usage.inputOther) + read + num(usage.inputCacheCreation)
        completion += num(usage.output)
        cached += read
        break
      }
      default:
        break
    }
  }
  finishAssistant()
  return turns
}

export const kimiAdapter: HarnessAdapter = {
  id: 'kimi-code',
  store: {
    parseLines(lines: string[]): HarnessTranscriptTurn[] {
      return kimiTurnsFromLines(objectsFromLines(lines))
    },
  },
  promptToolNames: [],
  capabilities: () => ({ liveTurn: true, prompts: false, approvals: true }),
}
