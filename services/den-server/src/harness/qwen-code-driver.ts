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

/** Match `PtyHarnessDriver` SPAWN_COLS / SPAWN_ROWS (not exported). */
const SPAWN_COLS = 120
const SPAWN_ROWS = 40

/**
 * Term manager `spawn` accepts cwd as the 11th argument (after effort).
 * `HarnessPtyHost` does not declare it; qwen resume needs it because
 * sessions are cwd-scoped (`qwen --resume` in the wrong dir exits 0 with
 * "No saved session found"). Extra optional params are assignable from the
 * 6-arg host method, so bind it as `const spawn: SpawnWithCwd = pty.spawn.bind(pty)`
 * rather than asserting — the assertion is a no-op to the type checker.
 */
type SpawnWithCwd = (
  rosterKey: string | undefined,
  cols: number,
  rows: number,
  remote: string,
  session?: string,
  resume?: string,
  envOverride?: Record<string, string>,
  routedUser?: string,
  model?: string,
  effort?: string,
  cwd?: string,
) => ReturnType<HarnessPtyHost['spawn']>

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
   * Prefer the transcript's recorded project cwd on summaries. New (live-only)
   * sessions still report the roster cwd via `liveSummary`.
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
   * Resume (and LRU re-spawn) in the session's original cwd. New sessions go
   * through `startSession` → base `spawn` and stay where the roster puts them
   * (homedir for room:true).
   */
  protected async spawnFor(pty: HarnessPtyHost, native: string, resume: boolean): Promise<string> {
    let cwd: string | undefined
    if (resume) {
      const row = await this.deps.store.describe(native)
      if (row?.cwd) cwd = row.cwd
    }
    // The host type declares 4–6 params; the 11th (cwd) is the manager's optional
    // override. Bind (not cast) so the widened signature is a real value, not an
    // unbound method reference.
    const spawn: SpawnWithCwd = pty.spawn.bind(pty)
    const spawned = await Promise.resolve(
      spawn(
        this.rosterCommand,
        SPAWN_COLS,
        SPAWN_ROWS,
        'harness-driver',
        this.room(native),
        resume ? native : undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        cwd,
      ),
    )
    this.ensureLive(native)
    return spawned.id
  }
}
