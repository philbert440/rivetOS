/**
 * Default on-disk store host for a harness driver. Thin adapter:
 * `term/harness-sessions.ts` stays the one place that knows each store's
 * layout (`~/.claude/projects/…`, `~/.grok/sessions/…`, `~/.hermes/state.db`).
 * Tests swap this whole object for a fake rather than shimming the filesystem
 * or node:sqlite.
 *
 * `exists` is always `harnessSessionExists` — "the CLI can resume this id" —
 * not "describe returned a row". Claude's resumable file is the top-level
 * `<uuid>.jsonl`; a subagent `agent-<id>.jsonl` is describable and readable,
 * but `exists` is false so resume does not pass the agent id to `--resume`.
 * Grok and the other dir/sqlite stores write a session dir or row before a
 * describable summary, so `exists` is the broader probe there too.
 */

import type { DelegatedSessionLink } from '@rivetos/types'
import {
  describeClaudeSession,
  describeGrokSession,
  describeHermesSession,
  describeCodexSession,
  describeKimiSession,
  describeOpencodeSession,
  describePiSession,
  describeQwenCodeSession,
  describeCursorSession,
  harnessSessionExists,
  listHarnessSessions,
  newestOpencodeSessionAfter,
  newestCursorSessionAfter,
  opencodeSessionsAfter,
  cursorSessionsAfter,
  readClaudeTranscript,
  readCodexTranscript,
  readGrokTranscript,
  readHermesTranscript,
  readKimiTranscript,
  readOpencodeTranscript,
  readPiTranscript,
  readQwenCodeTranscript,
  readCursorTranscript,
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
import { QWEN_CODE_ROSTER_COMMAND, type QwenCodeStoreHost } from './qwen-code-driver.js'
import { CURSOR_ROSTER_COMMAND, type CursorStoreHost } from './cursor-driver.js'
import type { HarnessStoreHost } from './pty-harness-driver.js'

export type HarnessStoreName =
  'claude' | 'grok' | 'hermes' | 'kimi' | 'codex' | 'opencode' | 'pi' | 'qwen-code' | 'cursor'

type StoreByName = {
  claude: ClaudeStoreHost
  grok: GrokStoreHost
  hermes: HermesStoreHost
  kimi: KimiStoreHost
  codex: CodexStoreHost
  opencode: OpencodeStoreHost
  pi: PiStoreHost
  'qwen-code': QwenCodeStoreHost
  cursor: CursorStoreHost
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
  'qwen-code': {
    roster: QWEN_CODE_ROSTER_COMMAND,
    describe: describeQwenCodeSession,
    transcript: readQwenCodeTranscript,
  },
  cursor: {
    roster: CURSOR_ROSTER_COMMAND,
    describe: describeCursorSession,
    transcript: readCursorTranscript,
  },
}

export function createHarnessStore<N extends HarnessStoreName>(
  name: N,
  opts?: { delegatedSessions?: () => Promise<DelegatedSessionLink[]> },
): StoreByName[N] {
  const { roster, describe, transcript } = ADAPTERS[name]
  const host: HarnessStoreHost = {
    list: async (limit) =>
      listHarnessSessions([roster], limit, (await opts?.delegatedSessions?.()) ?? []),
    describe: (nativeId) => describe(nativeId),
    // Store-scoped, not the drawer's first-hit-wins probe: an id whose own
    // store file is gone must read as empty rather than be served another
    // harness's transcript.
    transcript: async (nativeId) => {
      const t = await transcript(nativeId)
      return { turns: t.turns }
    },
  }
  // `exists` is "the CLI can resume this id". For grok that is the session
  // DIR, which predates summary.json, so a describable session is a subset.
  // For claude it is the top-level `<uuid>.jsonl` only: a subagent transcript
  // is describable and readable, but `claude --resume` does not take its
  // agent id.
  host.exists = (nativeId) => harnessSessionExists(roster, nativeId)
  if (name === 'opencode') {
    ;(host as OpencodeStoreHost).newestAfter = newestOpencodeSessionAfter
    ;(host as OpencodeStoreHost).candidatesAfter = opencodeSessionsAfter
  }
  if (name === 'cursor') {
    ;(host as CursorStoreHost).newestAfter = newestCursorSessionAfter
    ;(host as CursorStoreHost).candidatesAfter = cursorSessionsAfter
  }
  return host as StoreByName[N]
}
