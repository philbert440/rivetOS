/**
 * Default on-disk store host for a harness driver. Thin adapter:
 * `term/harness-sessions.ts` stays the one place that knows each store's
 * layout (`~/.claude/projects/…`, `~/.grok/sessions/…`, `~/.hermes/state.db`,
 * `~/.kimi-code/sessions/…`, `~/.dsh/sessions/…`), and tests swap this whole
 * object for a fake rather than shimming the filesystem or node:sqlite.
 *
 * Five files used to say the same thing with a different name in each slot.
 * The one real difference is Claude: its store is one `<uuid>.jsonl`, so
 * "describable" and "exists" are the same question and the base derives
 * `exists` from `describe`. The other four write a session DIR or sqlite row
 * before a describable summary, so `exists` is a separate, broader probe
 * (`harnessSessionExists`) — ground truth for `--resume` / collision.
 */

import {
  describeClaudeSession,
  describeDshSession,
  describeGrokSession,
  describeHermesSession,
  describeKimiSession,
  harnessSessionExists,
  listHarnessSessions,
  readClaudeTranscript,
  readDshTranscript,
  readGrokTranscript,
  readHermesTranscript,
  readKimiTranscript,
  type HarnessSession,
  type HarnessTranscript,
} from '../term/harness-sessions.js'
import { CLAUDE_ROSTER_COMMAND, type ClaudeStoreHost } from './claude-driver.js'
import { DEEPSEEK_ROSTER_COMMAND, type DeepseekStoreHost } from './deepseek-driver.js'
import { GROK_ROSTER_COMMAND, type GrokStoreHost } from './grok-driver.js'
import { HERMES_ROSTER_COMMAND, type HermesStoreHost } from './hermes-driver.js'
import { KIMI_ROSTER_COMMAND, type KimiStoreHost } from './kimi-driver.js'
import type { HarnessStoreHost } from './pty-harness-driver.js'

export type HarnessStoreName = 'claude' | 'grok' | 'hermes' | 'kimi' | 'deepseek'

type StoreByName = {
  claude: ClaudeStoreHost
  grok: GrokStoreHost
  hermes: HermesStoreHost
  kimi: KimiStoreHost
  deepseek: DeepseekStoreHost
}

type Adapter = {
  roster: string
  describe: (nativeId: string) => Promise<HarnessSession | undefined>
  transcript: (nativeId: string) => Promise<HarnessTranscript>
}

const ADAPTERS: Record<HarnessStoreName, Adapter> = {
  claude: {
    roster: CLAUDE_ROSTER_COMMAND,
    describe: describeClaudeSession,
    transcript: readClaudeTranscript,
  },
  grok: {
    roster: GROK_ROSTER_COMMAND,
    describe: describeGrokSession,
    transcript: readGrokTranscript,
  },
  hermes: {
    roster: HERMES_ROSTER_COMMAND,
    describe: describeHermesSession,
    transcript: readHermesTranscript,
  },
  kimi: {
    roster: KIMI_ROSTER_COMMAND,
    describe: describeKimiSession,
    transcript: readKimiTranscript,
  },
  deepseek: {
    roster: DEEPSEEK_ROSTER_COMMAND,
    describe: describeDshSession,
    transcript: readDshTranscript,
  },
}

export function createHarnessStore<N extends HarnessStoreName>(name: N): StoreByName[N] {
  const { roster, describe, transcript } = ADAPTERS[name]
  const host: HarnessStoreHost = {
    list: (limit) => listHarnessSessions([roster], limit),
    describe: (nativeId) => describe(nativeId),
    // Store-scoped, not the drawer's first-hit-wins probe: an id whose own
    // store file is gone must read as empty rather than be served another
    // harness's transcript.
    transcript: async (nativeId) => {
      const t = await transcript(nativeId)
      return { turns: t.turns }
    },
  }
  if (name !== 'claude') {
    // Session DIR (grok/kimi/dsh) or sqlite row (hermes), not the later
    // summary/state file — a describable session is a strict subset of an
    // existing one.
    host.exists = (nativeId) => harnessSessionExists(roster, nativeId)
  }
  return host as StoreByName[N]
}
