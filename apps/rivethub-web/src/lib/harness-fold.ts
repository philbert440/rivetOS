/**
 * HarnessEvent → LiveTurn fold — the control-plane twin of `fold-stream.ts`.
 *
 * The legacy chat path folds den bridge `StreamEvent`s that arrive on the
 * all-sessions WS; a driver-owned session instead tails
 * `WS /api/harness-sessions/ws` and gets the typed `HarnessEvent` vocabulary.
 * Both produce the same `LiveTurn`, so the transcript renders identically
 * whichever surface owns the session.
 *
 * Tool pairing is exact here: the contract carries a `toolCallId` on both
 * `tool-use` and `tool-result`, so the result marks its own entry instead of
 * the "last running tool with this name" heuristic the den bridge needs.
 *
 * Approvals are deliberately NOT folded — they outlive a turn and are held in
 * the chat store (see `stores/chat.ts` `approvals`).
 */

import type { HarnessEvent } from '@rivetos/types'
import { humanToolTitle, type ToolArgs } from './tool-titles.js'
import { emptyTurn, nextReasoningText, type LiveToolEntry, type LiveTurn } from './fold-stream.js'

function toolArgs(input: unknown): ToolArgs {
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    return input as Record<string, unknown>
  }
  return undefined
}

/**
 * Fold one harness event into the live turn. Returns `undefined` on
 * `turn-complete` (the caller clears the live slot and hard-resyncs the
 * transcript, which is where the committed turn — with usage and tools —
 * comes from).
 */
export function foldHarnessEvent(
  turn: LiveTurn | undefined,
  event: HarnessEvent,
): LiveTurn | undefined {
  const base: LiveTurn = turn ?? emptyTurn()
  switch (event.type) {
    case 'assistant-delta':
      return { ...base, text: base.text + event.text, reasoning: false, activity: undefined }
    case 'reasoning-delta':
      // Same fields the den-bridge fold fills, by the same rule (spinner lines
      // replace, real thinking appends) — the transcript renders live thinking
      // identically whichever surface owns the session.
      return {
        ...base,
        reasoning: true,
        reasoningText: nextReasoningText(base.reasoningText, event.text),
      }
    case 'tool-use': {
      const args = toolArgs(event.input)
      const entry: LiveToolEntry = {
        id: event.toolCallId,
        name: event.name,
        title: humanToolTitle(event.name, args),
        status: 'running',
        ...(args ? { args } : {}),
      }
      return { ...base, activity: entry.title, tools: [...base.tools, entry] }
    }
    case 'tool-result': {
      const status = event.isError ? 'error' : 'done'
      const i = base.tools.findIndex((t) => t.id === event.toolCallId)
      const tools = [...base.tools]
      if (i >= 0) {
        tools[i] = { ...tools[i], status }
      } else {
        // Attached mid-turn: the `tool-use` half predates our subscription
        // (at-most-once live tail — there is no replay).
        tools.push({
          id: event.toolCallId,
          name: event.name,
          title: humanToolTitle(event.name),
          status,
        })
      }
      return { ...base, activity: undefined, tools }
    }
    case 'error':
      return { ...base, activity: `⚠ ${event.message || event.code}` }
    case 'turn-complete':
      return undefined
    case 'session-updated':
      // A session that ended or errored out has no live turn left to show.
      return event.status === 'ended' || event.status === 'error' ? undefined : base
    default:
      // session-created / approval-request / approval-resolved: not turn state.
      return turn
  }
}

/** The two events the approvals surface owns (never folded into a turn). */
export type HarnessApprovalEvent = Extract<
  HarnessEvent,
  { type: 'approval-request' | 'approval-resolved' }
>

export function isApprovalEvent(event: HarnessEvent): event is HarnessApprovalEvent {
  return event.type === 'approval-request' || event.type === 'approval-resolved'
}
