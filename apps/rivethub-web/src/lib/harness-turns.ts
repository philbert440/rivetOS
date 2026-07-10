/**
 * Harness transcript turns → SessionMessages. Ids are index-stable
 * (`harness:<sid>:<i>`) so a pushed delta that replaces the tail keeps the
 * unchanged prefix's identity (no list re-key churn while streaming).
 */

import type { HarnessTranscriptTurn, SessionMessage } from '@rivetos/types'

export function messagesFromHarnessTurns(
  sessionId: string,
  turns: HarnessTranscriptTurn[],
): SessionMessage[] {
  return turns.map((t, i) => ({
    id: `harness:${sessionId}:${String(i)}`,
    sessionId,
    role: t.role,
    text: t.text,
    ts: i + 1,
    ...(t.thinking ? { thinking: t.thinking } : {}),
    ...(t.tools && t.tools.length > 0 ? { tools: t.tools } : {}),
    ...(t.usage ? { usage: t.usage } : {}),
    ...(t.model ? { model: t.model } : {}),
  }))
}
