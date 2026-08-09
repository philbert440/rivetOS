/**
 * Default `ClaudeStoreHost` — the on-disk Claude Code store this node already
 * reads for the RivetHub drawer and the chat hard-resync, expressed as the
 * driver's read port.
 *
 * Deliberately thin: `term/harness-sessions.ts` stays the one place that knows
 * `~/.claude/projects/<slug>/<uuid>.jsonl`, and tests swap this whole object
 * for a fake rather than shimming the filesystem.
 */

import {
  describeClaudeSession,
  listHarnessSessions,
  readClaudeTranscript,
} from '../term/harness-sessions.js'
import { CLAUDE_ROSTER_COMMAND, type ClaudeStoreHost } from './claude-driver.js'

export function createClaudeStoreHost(): ClaudeStoreHost {
  return {
    list: (limit) => listHarnessSessions([CLAUDE_ROSTER_COMMAND], limit),
    describe: (nativeId) => describeClaudeSession(nativeId),
    // Store-scoped, not the drawer's first-hit-wins probe (claude → grok →
    // hermes): a claude id whose .jsonl is gone must read as empty rather than
    // be served another harness's transcript. Closed at driver three, where the
    // grok slice recorded it.
    transcript: async (nativeId) => {
      const transcript = await readClaudeTranscript(nativeId)
      return { turns: transcript.turns }
    },
  }
}
