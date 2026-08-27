/**
 * Session ids whose agent system prompt already rode the first harness turn.
 * Cleared on turn error so a failed 202-accept can retry the prompt.
 */

const sent = new Set<string>()

export function markSystemPromptSent(sessionId: string): void {
  sent.add(sessionId)
}

export function clearSystemPromptSent(sessionId: string): void {
  sent.delete(sessionId)
}

export function wasSystemPromptSent(sessionId: string): boolean {
  return sent.has(sessionId)
}

export function rekeySystemPromptSent(from: string, to: string): void {
  if (sent.has(from)) {
    sent.delete(from)
    sent.add(to)
  }
}
