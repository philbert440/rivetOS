/**
 * Default `DeepseekStoreHost` — the on-disk DeepSeek Harness store.
 *
 * Thin, like the kimi/hermes stores: `term/harness-sessions.ts` is the one
 * place that knows `~/.dsh/sessions/<cwd-slug>/session-<uuid>/`.
 */

import {
  describeDshSession,
  harnessSessionExists,
  listHarnessSessions,
  readDshTranscript,
} from '../term/harness-sessions.js'
import { DEEPSEEK_ROSTER_COMMAND, type DeepseekStoreHost } from './deepseek-driver.js'

export function createDeepseekStoreHost(): DeepseekStoreHost {
  return {
    list: (limit) => listHarnessSessions([DEEPSEEK_ROSTER_COMMAND], limit),
    describe: (nativeId) => describeDshSession(nativeId),
    exists: (nativeId) => harnessSessionExists(DEEPSEEK_ROSTER_COMMAND, nativeId),
    transcript: async (nativeId) => {
      const transcript = await readDshTranscript(nativeId)
      return { turns: transcript.turns }
    },
  }
}
