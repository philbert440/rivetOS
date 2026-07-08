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

let toolSeq = 0

function nextToolId(): string {
  toolSeq += 1
  return `tool-${toolSeq}`
}

/** Reset seq — tests only. */
export function _resetToolSeqForTests(): void {
  toolSeq = 0
}

function emptyTurn(): LiveTurn {
  return { text: '', reasoning: false, reasoningText: '', tools: [] }
}

function argsFromEvent(event: StreamEvent): ToolArgs {
  const m = event.metadata
  if (!m || typeof m !== 'object') return undefined
  const args = (m as { args?: unknown }).args
  if (args && typeof args === 'object') return args as Record<string, unknown>
  return undefined
}

function toolNameFromEvent(event: StreamEvent): string {
  const m = event.metadata
  if (m && typeof m === 'object') {
    const tool = (m as { tool?: unknown }).tool
    if (typeof tool === 'string' && tool.trim()) return normalizeToolName(tool)
  }
  return normalizeToolName(event.content || 'tool')
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
        id: nextToolId(),
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
      const isError = /^❌|error/i.test(event.content || '')
      if (idx >= 0) {
        tools[idx] = {
          ...tools[idx],
          status: isError ? 'error' : 'done',
        }
      } else {
        tools.push({
          id: nextToolId(),
          name,
          title: humanToolTitle(name),
          status: isError ? 'error' : 'done',
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
