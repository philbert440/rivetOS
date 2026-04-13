/**
 * Token estimator — rough chars ÷ 4 approximation.
 * Used as a fallback when provider-reported usage is unavailable
 * (e.g., first iteration before the provider has responded).
 * After the first provider response, the loop uses actual promptTokens
 * from the provider's usage data instead.
 */

import type { Message } from '@rivetos/types'

/**
 * Estimate token count for a message array.
 * Uses chars ÷ 4 as baseline, plus overhead per message and tool call.
 */
export function estimateTokens(messages: Message[]): number {
  let total = 0
  for (const msg of messages) {
    total += 4 // role + framing overhead
    if (typeof msg.content === 'string') {
      total += Math.ceil(msg.content.length / 4)
    } else if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (part.type === 'text') {
          total += Math.ceil(part.text.length / 4)
        } else {
          total += 1000 // rough image token estimate
        }
      }
    }
    // Tool calls: count argument JSON
    if (msg.toolCalls) {
      for (const tc of msg.toolCalls) {
        total += Math.ceil(JSON.stringify(tc.arguments).length / 4) + 10
      }
    }
  }
  return total
}

/**
 * Estimate token count for a system prompt string.
 */
export function estimateSystemPromptTokens(prompt: string): number {
  return Math.ceil(prompt.length / 4) + 4
}
