/**
 * Cowork transcripts are Claude Code JSONL when the sandbox left them on the
 * host. Full-VM mode has no readable transcript; the adapter still parses the
 * lines the capture kit and the driver can see.
 */

import type { HarnessTranscriptTurn } from '@rivetos/types'
import { claudeTurnsFromLines } from './claude.js'
import type { HarnessAdapter } from './types.js'

export function coworkTurnsFromObjects(
  objects: Record<string, unknown>[],
): HarnessTranscriptTurn[] {
  return claudeTurnsFromLines(objects)
}

export const coworkAdapter: HarnessAdapter = {
  id: 'cowork',
  promptToolNames: [],
  capabilities: () => ({ liveTurn: false, prompts: false, approvals: false }),
  store: {
    parseObjects: coworkTurnsFromObjects,
  },
}
