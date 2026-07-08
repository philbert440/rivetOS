/**
 * Pure stream → LiveTurn fold. Unit-tested without React/Zustand.
 */

import type { StreamEvent } from '@rivetos/types'
import { humanToolTitle, normalizeToolName, type ToolArgs } from './tool-titles.js'

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

function emptyTurn(): LiveTurn {
  return { text: '', reasoning: false, reasoningText: '', tools: [] }
}

function newToolId(): string {
  try {
    return crypto.randomUUID()
  } catch {
    return `tool-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
  }
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
  let raw = (event.content || '').trim()
  // strip leading emoji / status glyphs
  raw = normalizeToolName(raw)
  // strip "name: payload" tail used by tools-aisdk tool_result
  const colon = raw.indexOf(':')
  if (colon > 0) {
    const head = raw.slice(0, colon).trim()
    // only treat as name:payload if head looks like a bare tool id (no spaces)
    if (head && !/\s/.test(head)) return head
  }
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
        reasoningText: base.reasoningText + (event.content || ''),
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
