/**
 * Default on-disk store host for a harness driver. Thin adapter:
 * `term/harness-sessions.ts` stays the one place that knows each store's
 * layout (`~/.claude/projects/…`, `~/.grok/sessions/…`, `~/.hermes/state.db`,
 * and tests swap this whole object for a fake rather than shimming the
 * filesystem or node:sqlite.
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
  describeGrokSession,
  describeHermesSession,
  describeCodexSession,
  describeKimiSession,
  describeOpencodeSession,
  describePiSession,
  harnessSessionExists,
  listHarnessSessions,
  newestOpencodeSessionAfter,
  readClaudeTranscript,
  readCodexTranscript,
  readGrokTranscript,
  readHermesTranscript,
  readKimiTranscript,
  readOpencodeTranscript,
  readPiTranscript,
  type HarnessSession,
  type HarnessTranscript,
} from '../term/harness-sessions.js'
import { CLAUDE_ROSTER_COMMAND, type ClaudeStoreHost } from './claude-driver.js'
import { GROK_ROSTER_COMMAND, type GrokStoreHost } from './grok-driver.js'
import { HERMES_ROSTER_COMMAND, type HermesStoreHost } from './hermes-driver.js'
import { CODEX_ROSTER_COMMAND, type CodexStoreHost } from './codex-driver.js'
import { KIMI_ROSTER_COMMAND, type KimiStoreHost } from './kimi-driver.js'
import { OPENCODE_ROSTER_COMMAND, type OpencodeStoreHost } from './opencode-driver.js'
import { PI_ROSTER_COMMAND, type PiStoreHost } from './pi-driver.js'
import type { HarnessStoreHost } from './pty-harness-driver.js'

export type HarnessStoreName = 'claude' | 'grok' | 'hermes' | 'kimi' | 'codex' | 'opencode' | 'pi'

type StoreByName = {
  claude: ClaudeStoreHost
  grok: GrokStoreHost
  hermes: HermesStoreHost
  kimi: KimiStoreHost
  codex: CodexStoreHost
  opencode: OpencodeStoreHost
  pi: PiStoreHost
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
  codex: {
    roster: CODEX_ROSTER_COMMAND,
    describe: describeCodexSession,
    transcript: readCodexTranscript,
  },
  opencode: {
    roster: OPENCODE_ROSTER_COMMAND,
    describe: describeOpencodeSession,
    transcript: readOpencodeTranscript,
  },
  pi: {
    roster: PI_ROSTER_COMMAND,
    describe: describePiSession,
    transcript: readPiTranscript,
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
    // Session DIR (grok/kimi) or sqlite row (hermes), not the later
    // summary/state file — a describable session is a strict subset of an
    // existing one.
    host.exists = (nativeId) => harnessSessionExists(roster, nativeId)
  }
  if (name === 'opencode') {
    ;(host as OpencodeStoreHost).newestAfter = newestOpencodeSessionAfter
  }
  return host as StoreByName[N]
}
