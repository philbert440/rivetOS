/**
 * Pure stream → LiveTurn fold. Unit-tested without React/Zustand.
 */

import type { StreamEvent } from '@rivetos/types'
import { humanToolTitle, normalizeToolName, type ToolArgs } from './tool-titles.js'
import { uuidv4 } from './uuid.js'

export interface LiveToolEntry {
  id: string
  name: string
  title: string
  status: 'running' | 'done' | 'error'
  args?: unknown
}

export interface LiveTurn {
  /** accumulated assistant text deltas for the in-flight turn */
  text: string
  /** last status line (interrupt/error/status) */
  activity?: string
  /** true while the latest stream slice is reasoning (not final text) */
  reasoning: boolean
  /** accumulated thinking/reasoning text for the turn */
  reasoningText: string
  /** multi-entry tool stack for this turn */
  tools: LiveToolEntry[]
}

export function emptyTurn(): LiveTurn {
  return { text: '', reasoning: false, reasoningText: '', tools: [] }
}

/**
 * Sliding-window cap for live `reasoningText` (den `THOUGHT_MAX` parity).
 *
 * Den board uses 220 chars — a single short thought bubble on a tile. The hub
 * transcript's ReasoningBlock is an expandable multi-line pane (mono 11px,
 * `whitespace-pre-wrap`, no max-height) that re-renders into the Zustand live
 * store on every delta. Cap high enough for readable recent thinking
 * (~2–4 screens at typical hub width ≈ 80 cols × 50 lines) yet hard-bounded so
 * a long extended-thinking turn (claude-cli `reasoning-delta` token streams)
 * cannot grow the live store without limit. 4 KiB is two orders of magnitude
 * under what a full extended-thinking stream can emit, and keeps re-render /
 * DOM cost bounded while always showing the *tail* of the stream.
 */
export const REASONING_TEXT_MAX = 4096

/**
 * Next `reasoningText` for a thinking chunk. Claude's den hook can't read real
 * thinking text, so it sends spinner status lines ("✳ Wrangling… (28s · ↓ 4.8k
 * tokens)") — each REPLACES the previous one (den reducer parity) instead of
 * accumulating into a wall of stale spinner snapshots. Real streamed thinking
 * appends, then slides through a capped window (same rule as
 * `packages/den-protocol` `THOUGHT_MAX`: `slice(-MAX)` then drop the leading
 * partial word when at cap).
 *
 * Shared with `harness-fold.ts`: the control-plane `reasoning-delta` and the
 * den bridge's `reasoning` frame carry the same text from the same hook, so
 * they must render the same way. Only the append path hits the cap — replace
 * semantics are preserved exactly.
 */
export function nextReasoningText(previous: string, chunk: string): string {
  // Spinner status lines replace wholesale — short by construction; never capped.
  if (/^[✳✢✻✽·] /.test(chunk)) return chunk
  let next = (previous + chunk).slice(-REASONING_TEXT_MAX)
  // When the window is full, trim to a word boundary so the stream never opens
  // mid-word (den reducer parity: `packages/den-protocol/src/reducer.ts`).
  if (next.length === REASONING_TEXT_MAX) next = next.replace(/^\S*\s+/, '')
  return next
}

function newToolId(): string {
  return uuidv4()
}

function argsFromEvent(event: StreamEvent): ToolArgs {
  const m = event.metadata
  if (!m || typeof m !== 'object') return undefined
  const args = (m as { args?: unknown }).args
  if (args && typeof args === 'object' && !Array.isArray(args)) {
    return args as Record<string, unknown>
  }
  if (typeof args === 'string' && args.trim()) {
    try {
      const parsed: unknown = JSON.parse(args)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>
      }
    } catch {
      return undefined
    }
  }
  return undefined
}

/**
 * Resolve tool name from stream event.
 * Wire shapes:
 * - metadata.tool (bridge / preferred)
 * - content "🔧 shell" / "shell"
 * - content "✅ shell: result" / "❌ shell: err" (tools-aisdk)
 */
export function toolNameFromEvent(event: StreamEvent): string {
  const m = event.metadata
  if (m && typeof m === 'object') {
    const tool = (m as { tool?: unknown }).tool
    if (typeof tool === 'string' && tool.trim()) return normalizeToolName(tool)
  }
  const original = (event.content || '').trim()
  // tools-aisdk: "✅ shell: hi" / "❌ shell: boom" — only then strip name:payload
  const statusPrefixed = /^[✅❌]/.test(original)
  const raw = normalizeToolName(original)
  if (statusPrefixed) {
    const colon = raw.indexOf(':')
    if (colon > 0) {
      const head = raw.slice(0, colon).trim()
      if (head && !/\s/.test(head)) return head
    }
  }
  // otherwise keep full name (MCP: mcp:rivetos:memory_search, den plain names)
  return raw || 'tool'
}

/** True only for tools-aisdk-style error results (leading ❌), not substring "error". */
export function isToolResultError(content: string): boolean {
  const t = content.trim()
  return t.startsWith('❌')
}

/**
 * Fold one stream event into the live turn. Returns undefined on `done`
 * (caller clears the live slot).
 */
export function foldStream(turn: LiveTurn | undefined, event: StreamEvent): LiveTurn | undefined {
  const base: LiveTurn = turn ?? emptyTurn()
  switch (event.type) {
    case 'text':
      return {
        ...base,
        text: base.text + event.content,
        reasoning: false,
        activity: undefined,
      }
    case 'reasoning':
      return {
        ...base,
        reasoning: true,
        reasoningText: nextReasoningText(base.reasoningText, event.content || ''),
      }
    case 'tool_start': {
      const name = toolNameFromEvent(event)
      const args = argsFromEvent(event)
      const entry: LiveToolEntry = {
        id: newToolId(),
        name,
        title: humanToolTitle(name, args),
        status: 'running',
        args,
      }
      return {
        ...base,
        activity: entry.title,
        tools: [...base.tools, entry],
      }
    }
    case 'tool_result': {
      const name = toolNameFromEvent(event)
      const tools = [...base.tools]
      // Mark the last matching running tool done; else last running; else append done.
      let idx = -1
      for (let i = tools.length - 1; i >= 0; i--) {
        if (tools[i].status === 'running' && normalizeToolName(tools[i].name) === name) {
          idx = i
          break
        }
      }
      if (idx < 0) {
        for (let i = tools.length - 1; i >= 0; i--) {
          if (tools[i].status === 'running') {
            idx = i
            break
          }
        }
      }
      const err = isToolResultError(event.content || '')
      if (idx >= 0) {
        tools[idx] = {
          ...tools[idx],
          status: err ? 'error' : 'done',
        }
      } else {
        tools.push({
          id: newToolId(),
          name,
          title: humanToolTitle(name),
          status: err ? 'error' : 'done',
        })
      }
      return { ...base, activity: undefined, tools }
    }
    case 'status':
      return { ...base, activity: event.content }
    case 'interrupt':
      // Steer, not termination — keep text/tools (#299).
      return { ...base, activity: 'steered — adjusting…' }
    case 'error':
      return { ...base, activity: `⚠ ${event.content || 'error'}` }
    case 'done':
      return undefined
    default:
      return base
  }
}
