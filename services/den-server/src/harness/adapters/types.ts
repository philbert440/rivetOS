import type {
  ApprovalDecision,
  HarnessAskQuestion,
  HarnessId,
  HarnessTranscriptTurn,
} from '@rivetos/types'

/** Resolved on-disk store the transcript watcher / readers parse. */
export interface HarnessStoreRef {
  command: 'claude' | 'grok' | 'hermes' | 'kimi' | 'dsh' | 'codex' | 'pi'
  /** The file to watch for changes (jsonl / chat_history / sqlite db). */
  path: string
}

export interface HarnessAdapter {
  id: HarnessId
  /** Store-side: unchanged behaviour, moved here from term/harness-sessions.ts. */
  store: {
    /** Parse a resolved store (tail window already applied by the caller) into turns. */
    parseLines?(lines: string[]): HarnessTranscriptTurn[] // claude, kimi, grok (JSONL stores)
    /** Same fold over ALREADY-PARSED JSONL objects — the watcher hot path has
     *  them from the tail-window reader; never stringify to re-parse. */
    parseObjects?(objects: Record<string, unknown>[]): HarnessTranscriptTurn[]
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
  /**
   * Optional keystroke translation for answering a store-sourced prompt (lane A2).
   * Absent → the driver falls back to composing a text answer and PTY-injecting it.
   */
  answerKeys?(
    prompt: { promptId: string; toolName: string; questions: HarnessAskQuestion[] },
    answers: Array<{ question: number; labels: string[]; other?: string }>,
  ): Uint8Array[]
  /** Permission-prompt keystrokes. Absent → resolveApproval stays 501. */
  approvalKeys?(decision: ApprovalDecision): Uint8Array[]
}
