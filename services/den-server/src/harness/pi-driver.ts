/**
 * `pi` — HarnessDriver for the Pi coding agent (earendil-works/pi).
 *
 * Same shape as the `grok-build` / `claude-code` pinning drivers: pi 0.85.1
 * accepts `--session-id <uuid>` on a NEW session (creates the id if missing),
 * so the control plane can name the session it is creating. Resume is
 * `--session <id>`. Native ids are UUID-class (pi mints v7; any version is
 * accepted). Canonical form is `pi:<uuid>`.
 *
 *   | Contract method | Existing machinery it wraps                         |
 *   |-----------------|-----------------------------------------------------|
 *   | listSessions    | `listHarnessSessions(['pi'])` — ~/.pi/agent/sessions|
 *   | getSession      | `describePiSession`                                 |
 *   | startSession    | term manager `spawn(..., session)` → `--session-id` |
 *   | resumeSession   | term manager spawn-or-get → `pi --session <id>`     |
 *   | sendUserTurn    | term manager `inject(pty, text, submit)`            |
 *   | interrupt       | term manager `inject(pty, '', false, interrupt)`    |
 *   | subscribe       | den AgentEvent ingest tap (when a hook stamps ids)  |
 *   | transcript      | `readPiTranscript` — cwd-bucketed session jsonl     |
 *
 * **This driver does not rotate.** Nothing on the den wire carries a
 * previous→new pair for pi.
 *
 * See docs/ARCHITECTURE.md.
 */

import { formatSessionId, type SessionId } from '@rivetos/types'
import {
  PtyHarnessDriver,
  type HarnessPtyHost,
  type HarnessStoreHost,
  type PtyHarnessDriverDeps,
} from './pty-harness-driver.js'

export const PI_HARNESS_ID = 'pi' as const
/** Roster key the den term manager spawns Pi under. */
export const PI_ROSTER_COMMAND = 'pi'

export type PiPtyHost = HarnessPtyHost

export interface PiStoreHost extends HarnessStoreHost {
  /** Does the session jsonl exist? Sync. */
  exists(nativeId: string): boolean
}

export type PiDriverDeps = PtyHarnessDriverDeps<PiStoreHost>

export class PiDriver extends PtyHarnessDriver<PiStoreHost> {
  constructor(deps: PiDriverDeps) {
    super(
      {
        harnessId: PI_HARNESS_ID,
        rosterCommand: PI_ROSTER_COMMAND,
        productName: 'Pi',
      },
      deps,
    )
  }

  /** `pi:<uuid>` for a native id. @throws `invalid_session_id` */
  static sessionId(nativeId: string): SessionId {
    return formatSessionId(PI_HARNESS_ID, nativeId)
  }
}
