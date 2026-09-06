import type { HarnessTranscriptTurn } from '@rivetos/types'
import type { HarnessAdapter } from './types.js'

/** dsh transcripts are `session.jsonl.zstd` — no in-process decompressor. */
export function readDshTurns(): HarnessTranscriptTurn[] {
  return []
}

export const deepseekAdapter: HarnessAdapter = {
  id: 'deepseek-harness',
  store: {
    readTurns(): Promise<HarnessTranscriptTurn[]> {
      return Promise.resolve(readDshTurns())
    },
  },
  promptToolNames: [],
  capabilities: () => ({ liveTurn: false, prompts: false, approvals: false }),
}
