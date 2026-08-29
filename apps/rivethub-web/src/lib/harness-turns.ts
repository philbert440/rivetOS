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

import type { HarnessTranscriptTool, HarnessTranscriptTurn, SessionMessage } from '@rivetos/types'

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
): SessionMessage[] {
  return turns.map((t, i) => {
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
