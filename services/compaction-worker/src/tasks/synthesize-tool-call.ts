/**
 * synthesize-tool-call task — fill empty content on assistant tool-call messages.
 *
 * Filled in step 9b.2.
 */

import type { Task } from 'graphile-worker'

export interface SynthesizeToolCallPayload {
  messageId: string
}

export const synthesizeToolCallTask: Task = async (payload, helpers) => {
  const { messageId } = payload as SynthesizeToolCallPayload
  helpers.logger.info(`[synthesize-tool-call] stub for msg ${messageId.slice(0, 8)} — implemented in 9b.2`)
}
