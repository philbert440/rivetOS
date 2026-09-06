import type { HarnessId, HarnessTranscriptTurn } from '@rivetos/types'

/** Resolved on-disk store the transcript watcher / readers parse. */
export interface HarnessStoreRef {
  command: 'claude' | 'grok' | 'hermes' | 'kimi' | 'dsh'
  /** The file to watch for changes (jsonl / chat_history / sqlite db). */
  path: string
}

export interface HarnessAdapter {
  id: HarnessId
  /** Store-side: unchanged behaviour, moved here from term/harness-sessions.ts. */
  store: {
    /** Parse a resolved store (tail window already applied by the caller) into turns. */
    parseLines?(lines: string[]): HarnessTranscriptTurn[] // claude, kimi, grok (JSONL stores)
    /** hermes (sqlite), dsh (empty). sessionId is the den join key; hermes rows are keyed by it. */
    readTurns?(
      ref: HarnessStoreRef,
      maxBytes: number,
      sessionId?: string,
    ): Promise<HarnessTranscriptTurn[]>
  }
  /** Prompt-class tool names this harness can raise from its store (claude: AskUserQuestion; others: none yet). */
  promptToolNames: readonly string[]
  /** Honest per-harness matrix. liveTurn = the store exposes in-flight turns with tools/thinking. */
  capabilities(): { liveTurn: boolean; prompts: boolean; approvals: boolean }
  /** Part 2 adds: deriveStatus, detectPrompts, answerKeys, permissionDialog. Leave the interface open for them. */
}
