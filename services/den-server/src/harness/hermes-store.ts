/**
 * Default `HermesStoreHost` — the hermes sqlite store this node already reads
 * for the RivetHub drawer and the chat hard-resync, expressed as the driver's
 * read port.
 *
 * Deliberately thin, like `claude-store.ts` and `grok-store.ts`:
 * `term/harness-sessions.ts` stays the one place that knows
 * `~/.hermes/state.db`, and tests swap this whole object for a fake rather than
 * shimming node:sqlite.
 */

import {
  describeHermesSession,
  harnessSessionExists,
  listHarnessSessions,
  readHermesTranscript,
} from '../term/harness-sessions.js'
import { HERMES_ROSTER_COMMAND, type HermesStoreHost } from './hermes-driver.js'

export function createHermesStoreHost(): HermesStoreHost {
  return {
    list: (limit) => listHarnessSessions([HERMES_ROSTER_COMMAND], limit),
    describe: (nativeId) => describeHermesSession(nativeId),
    // `SELECT 1 FROM sessions` — a session row exists from the moment hermes
    // starts, before it has any messages, so this is broader than `describe`
    // and is the ground truth for `--resume`.
    exists: (nativeId) => harnessSessionExists(HERMES_ROSTER_COMMAND, nativeId),
    transcript: async (nativeId) => {
      const transcript = await readHermesTranscript(nativeId)
      return { turns: transcript.turns }
    },
  }
}
