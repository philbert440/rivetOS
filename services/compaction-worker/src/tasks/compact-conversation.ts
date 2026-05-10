/**
 * compact-conversation task — full bottom-up summarization for one conversation.
 *
 * Job key (passed via add_job's job_key) is the conversation ID, which gives us
 * "only one pending/processing per conversation" deduplication via graphile-worker.
 *
 * Filled in step 9b.2.
 */

import type { Task } from 'graphile-worker'

export interface CompactConversationPayload {
  conversationId: string
  triggerType?: 'threshold' | 'session_idle' | 'explicit'
}

export const compactConversationTask: Task = async (payload, helpers) => {
  const { conversationId } = payload as CompactConversationPayload
  helpers.logger.info(`[compact-conversation] stub for ${conversationId.slice(0, 8)} — implemented in 9b.2`)
}
