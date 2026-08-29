/**
 * Harness transcript turns → SessionMessages. Ids are index-stable
 * (`harness:<sid>:<i>`) so a pushed delta that replaces the tail keeps the
 * unchanged prefix's identity (no list re-key churn while streaming).
 *
 * Object identity is stable too: a turn object the previous frame already
 * carried (deltas splice new turns onto the old prefix, so prefix turns are
 * reference-equal) reuses its previous SessionMessage instead of allocating a
 * fresh one. That identity is what lets memo(Bubble) bail out for every
 * message a streaming tick did not touch.
 */

import type { HarnessTranscriptTurn, SessionMessage } from '@rivetos/types'

export function messagesFromHarnessTurns(
  sessionId: string,
  turns: HarnessTranscriptTurn[],
  prev?: { turns: HarnessTranscriptTurn[]; messages: SessionMessage[] },
): SessionMessage[] {
  return turns.map((t, i) => {
    const prevMsg = prev?.messages[i]
    if (prevMsg && prev.turns[i] === t && prevMsg.id === `harness:${sessionId}:${String(i)}`) {
      return prevMsg
    }
    return {
      id: `harness:${sessionId}:${String(i)}`,
      sessionId,
      role: t.role,
      text: t.text,
      ts: i + 1,
      ...(t.thinking ? { thinking: t.thinking } : {}),
      ...(t.tools && t.tools.length > 0 ? { tools: t.tools } : {}),
      ...(t.usage ? { usage: t.usage } : {}),
      ...(t.model ? { model: t.model } : {}),
    }
  })
}
