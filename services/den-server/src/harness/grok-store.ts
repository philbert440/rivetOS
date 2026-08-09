/**
 * Default `GrokStoreHost` — the on-disk Grok Build store this node already
 * reads for the RivetHub drawer and the chat hard-resync, expressed as the
 * driver's read port.
 *
 * Deliberately thin, like `claude-store.ts`: `term/harness-sessions.ts` stays
 * the one place that knows `~/.grok/sessions/<enc-cwd>/<uuid>/`, and tests swap
 * this whole object for a fake rather than shimming the filesystem.
 */

import {
  describeGrokSession,
  harnessSessionExists,
  listHarnessSessions,
  readGrokTranscript,
} from '../term/harness-sessions.js'
import { GROK_ROSTER_COMMAND, type GrokStoreHost } from './grok-driver.js'

export function createGrokStoreHost(): GrokStoreHost {
  return {
    list: (limit) => listHarnessSessions([GROK_ROSTER_COMMAND], limit),
    describe: (nativeId) => describeGrokSession(nativeId),
    // Session DIR, not summary.json — the same ground truth the term manager
    // uses to pick `--resume` over `--session-id`.
    exists: (nativeId) => harnessSessionExists(GROK_ROSTER_COMMAND, nativeId),
    transcript: async (nativeId) => {
      const transcript = await readGrokTranscript(nativeId)
      return { turns: transcript.turns }
    },
  }
}
