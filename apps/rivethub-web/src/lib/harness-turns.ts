/**
 * Harness transcript turns → SessionMessages. Ids are index-stable
 * (`harness:<sid>:<i>`) so a pushed delta that replaces the tail keeps the
 * unchanged prefix's identity (no list re-key churn while streaming).
 *
 * Object identity is stable too: when a turn's observable fields still match
 * what was copied onto the previous frame's SessionMessage at that index, the
 * previous message object is returned instead of a fresh allocation — that
 * identity is what lets memo(Bubble) bail out per message. The comparison is
 * against the COPIES on the previous message (never `prev turn === turn`), so
 * a producer that mutates a turn in place can't be served a stale bubble; for
 * the same reason tool entries are shallow-cloned onto the message, keeping an
 * in-place `status` flip detectable on the next frame.
 */

import type {
  HarnessStatusFrame,
  HarnessTranscriptTool,
  HarnessTranscriptTurn,
  SessionMessage,
} from '@rivetos/types'
import { humanToolTitle } from './tool-titles.js'
import { statusActivity } from './harness-fold.js'
import type { LiveToolEntry, LiveTurn } from './fold-stream.js'

/**
 * Roster / harness tokens whose on-disk store carries in-flight turns
 * (tools + thinking). Matches adapter `capabilities().liveTurn` — the
 * transcript event does not carry that flag, so we key on `command`.
 * Codex is on the same branch as claude/kimi (tools + reasoning in the
 * transcript).
 */
export function isLiveTurnCommand(command: string): boolean {
  const c = command.toLowerCase()
  return (
    c === 'claude' ||
    c === 'claude-code' ||
    c === 'kimi' ||
    c === 'kimi-code' ||
    c === 'opencode' ||
    c === 'pi' ||
    c === 'grok' ||
    c === 'grok-build' ||
    c === 'hermes' ||
    c === 'codex'
  )
}

/**
 * Build the live overlay from a trailing incomplete assistant turn while
 * the agent is working/blocked. `undefined` when the turn is solid
 * (status idle, or `complete`).
 */
export function liveFromTranscript(
  turns: HarnessTranscriptTurn[],
  status: HarnessStatusFrame | undefined,
): LiveTurn | undefined {
  if (status?.status !== 'working' && status?.status !== 'blocked') return undefined
  const last = turns.at(-1)
  if (!last || last.role !== 'assistant' || last.complete === true) return undefined
  const tools: LiveToolEntry[] = (last.tools ?? []).map((t, i) => {
    const args = t.args
    return {
      id: t.id ?? `tool:${String(i)}`,
      name: t.name,
      title: humanToolTitle(t.name, args),
      status: t.status,
      ...(args ? { args } : {}),
    }
  })
  return {
    text: last.text,
    reasoning: last.lastBlock === 'thinking' && !last.text,
    reasoningText: last.thinking ?? '',
    tools,
    activity: statusActivity(status),
  }
}

function sameUsage(a: SessionMessage['usage'], b: HarnessTranscriptTurn['usage']): boolean {
  if (!a || !b) return !a && !b
  return (
    a.promptTokens === b.promptTokens &&
    a.completionTokens === b.completionTokens &&
    a.cachedTokens === b.cachedTokens
  )
}

function sameTools(a: SessionMessage['tools'], b: HarnessTranscriptTool[] | undefined): boolean {
  if (!a || !b) return !a && !b
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    const x = a[i]
    const y = b[i]
    if (x.name !== y.name || x.status !== y.status || x.args !== y.args) return false
  }
  return true
}

export function messagesFromHarnessTurns(
  sessionId: string,
  turns: HarnessTranscriptTurn[],
  /** The previous frame's messages for this session — trailing optimistic
   *  bubbles (or ring-seeded rows) are fine, the id check skips them. */
  prev?: SessionMessage[],
  /** Drop the trailing assistant while it is the live overlay (incomplete). */
  skipTrailingLive?: boolean,
): SessionMessage[] {
  const list = skipTrailingLive && turns.length > 0 ? turns.slice(0, -1) : turns
  return list.map((t, i) => {
    const id = `harness:${sessionId}:${String(i)}`
    const tools = t.tools && t.tools.length > 0 ? t.tools : undefined
    const prevMsg = prev?.[i]
    if (
      prevMsg &&
      prevMsg.id === id &&
      prevMsg.role === t.role &&
      prevMsg.text === t.text &&
      prevMsg.thinking === (t.thinking ? t.thinking : undefined) &&
      prevMsg.model === (t.model ? t.model : undefined) &&
      sameUsage(prevMsg.usage, t.usage) &&
      sameTools(prevMsg.tools, tools)
    ) {
      return prevMsg
    }
    return {
      id,
      sessionId,
      role: t.role,
      text: t.text,
      ts: i + 1,
      ...(t.thinking ? { thinking: t.thinking } : {}),
      ...(tools ? { tools: tools.map((x) => ({ ...x })) } : {}),
      ...(t.usage ? { usage: { ...t.usage } } : {}),
      ...(t.model ? { model: t.model } : {}),
    }
  })
}

/**
 * The one-line status under the transcript when there is NO live bubble but
 * the agent is not idle: the thinking window before the first block, or a
 * blocked / prompt state. Undefined when idle or when a live bubble already
 * carries the activity.
 */
export function agentStatusLine(
  live: LiveTurn | undefined,
  status: HarnessStatusFrame | undefined,
): { text: string; tool?: string } | undefined {
  if (live || !status) return undefined
  if (status.status === 'blocked' || status.phase === 'prompt') {
    return { text: 'waiting for you', tool: status.tool?.name }
  }
  if (status.status === 'working') {
    return { text: statusActivity(status) ?? 'working…', tool: status.tool?.name }
  }
  return undefined
}
