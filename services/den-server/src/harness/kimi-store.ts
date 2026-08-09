/**
 * Default `KimiStoreHost` — the on-disk Kimi Code store, expressed as the
 * driver's read port.
 *
 * Deliberately thin, like `claude-store.ts`, `grok-store.ts` and
 * `hermes-store.ts`: `term/harness-sessions.ts` stays the one place that knows
 * `~/.kimi-code/sessions/wd_<label>_<hash>/session_<uuid>/`, and tests swap this
 * whole object for a fake rather than shimming the filesystem.
 */

import {
  describeKimiSession,
  harnessSessionExists,
  listHarnessSessions,
  readKimiTranscript,
} from '../term/harness-sessions.js'
import { KIMI_ROSTER_COMMAND, type KimiStoreHost } from './kimi-driver.js'

export function createKimiStoreHost(): KimiStoreHost {
  return {
    list: (limit) => listHarnessSessions([KIMI_ROSTER_COMMAND], limit),
    describe: (nativeId) => describeKimiSession(nativeId),
    // Session DIR, not state.json — kimi creates the dir first, so "no row" is
    // not "id is free", the same relationship grok's store has.
    exists: (nativeId) => harnessSessionExists(KIMI_ROSTER_COMMAND, nativeId),
    transcript: async (nativeId) => {
      const transcript = await readKimiTranscript(nativeId)
      return { turns: transcript.turns }
    },
  }
}
