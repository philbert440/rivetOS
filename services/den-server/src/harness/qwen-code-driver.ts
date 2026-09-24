/**
 * `qwen-code` — HarnessDriver for the Qwen Code coding agent (QwenLM/qwen-code).
 *
 * Same shape as the `claude-code` / `pi` pinning drivers: qwen-code 0.23.4
 * accepts `--session-id <uuid>` on a NEW session (pins the transcript
 * filename), so the control plane can name the session it is creating.
 * Resume is `--resume <uuid>`. Re-running `--session-id` with an existing
 * id is not resume. Native ids are UUID-class (any version is accepted).
 * Canonical form is `qwen-code:<uuid>`.
 *
 *   | Contract method | Existing machinery it wraps                          |
 *   |-----------------|------------------------------------------------------|
 *   | listSessions    | `listHarnessSessions(['qwen'])` — ~/.qwen/projects   |
 *   | getSession      | `describeQwenCodeSession`                            |
 *   | startSession    | term manager `spawn(..., session)` → `--session-id`  |
 *   | resumeSession   | term manager spawn-or-get → `qwen --resume <id>`     |
 *   | sendUserTurn    | term manager `inject(pty, text, submit)`             |
 *   | interrupt       | term manager `inject(pty, '', false, interrupt)`     |
 *   | subscribe       | den AgentEvent ingest tap (when a hook stamps ids)   |
 *   | transcript      | `readQwenCodeTranscript` — cwd-bucketed session jsonl|
 *
 * **This driver does not rotate.** Nothing on the den wire carries a
 * previous→new pair for qwen-code.
 *
 * See docs/ARCHITECTURE.md.
 */

import { formatSessionId, type HarnessSessionSummary, type SessionId } from '@rivetos/types'
import type { HarnessSession } from '../term/harness-sessions.js'
import {
  PtyHarnessDriver,
  type HarnessPtyHost,
  type HarnessStoreHost,
  type PtyHarnessDriverDeps,
} from './pty-harness-driver.js'

export const QWEN_CODE_HARNESS_ID = 'qwen-code' as const
/** Roster key the den term manager spawns Qwen Code under. */
export const QWEN_CODE_ROSTER_COMMAND = 'qwen'

export type QwenCodePtyHost = HarnessPtyHost

export interface QwenCodeStoreHost extends HarnessStoreHost {
  /** Does the session jsonl exist? Sync. */
  exists(nativeId: string): boolean
}

export type QwenCodeDriverDeps = PtyHarnessDriverDeps<QwenCodeStoreHost>

export class QwenCodeDriver extends PtyHarnessDriver<QwenCodeStoreHost> {
  constructor(deps: QwenCodeDriverDeps) {
    super(
      {
        harnessId: QWEN_CODE_HARNESS_ID,
        rosterCommand: QWEN_CODE_ROSTER_COMMAND,
        productName: 'Qwen Code',
      },
      deps,
    )
  }

  /** `qwen-code:<uuid>` for a native id. @throws `invalid_session_id` */
  static sessionId(nativeId: string): SessionId {
    return formatSessionId(QWEN_CODE_HARNESS_ID, nativeId)
  }

  /**
   * Prefer the transcript's recorded project cwd on summaries. A live session
   * with no row yet uses `sessionCwd`, then the roster cwd (`liveSummary`).
   */
  protected summarize(
    row: HarnessSession,
    statusOverride?: HarnessSessionSummary['status'],
  ): HarnessSessionSummary {
    const summary = super.summarize(row, statusOverride)
    if (row.cwd) summary.cwd = row.cwd
    return summary
  }

  /**
   * Resume (and LRU re-spawn) in the session's original cwd. The transcript
   * directory wins: `qwen --resume` in the wrong dir exits 0 with "No saved
   * session found". New sessions go through `startSession` → base `spawnFor`
   * and stay where the caller (or the roster) put them.
   */
  protected async spawnFor(
    pty: HarnessPtyHost,
    native: string,
    resume: boolean,
    opts?: { cwd?: string },
  ): Promise<string> {
    if (!resume) return super.spawnFor(pty, native, resume, opts)
    const row = await this.deps.store.describe(native)
    return super.spawnFor(pty, native, resume, { cwd: row?.cwd })
  }
}
