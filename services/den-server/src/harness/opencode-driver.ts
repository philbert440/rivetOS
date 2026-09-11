/**
 * `opencode` — HarnessDriver for the OpenCode CLI (anomalyco/opencode).
 *
 * Same adopting shape as kimi-code / hermes / dsh: OpenCode mints its own
 * session id and (as of the wiring date) has no verified flag to pin a new
 * one from the control plane, so `startSession` is refused and the plane
 * adopts whatever the CLI created.
 *
 *   | Contract method | Existing machinery it wraps                                 |
 *   |-----------------|-------------------------------------------------------------|
 *   | listSessions    | `listHarnessSessions(['opencode'])` — ~/.local/share/opencode |
 *   | getSession      | `describeOpencodeSession`                                   |
 *   | startSession    | **refused** — see "no pinning" below                        |
 *   | resumeSession   | term manager spawn-or-get → `opencode` with --resume        |
 *   | sendUserTurn    | term manager `inject(pty, text, submit)`                    |
 *   | interrupt       | term manager `inject(pty, '', false, interrupt)` (Esc)      |
 *   | subscribe       | den AgentEvent ingest tap (when a hook stamps an id)        |
 *   | transcript      | `readOpencodeTranscript`                                    |
 *
 * **Identity.** // REVIEWER-CONFIRM: native ids assumed `ses_<alnum>` (OpenCode
 * Identifier.ascending("session")). Canonical form is `opencode:ses_…`.
 *
 * **No pinning.** // REVIEWER-CONFIRM: `opencode run` is documented to fail
 * with "Session not found" when no session exists; interactive resume is
 * assumed to reference an EXISTING session only (same shape as kimi
 * `-S/--session`). If a later CLI grows `--session-id`, this driver can start
 * pinning instead of adopting.
 *
 * See docs/ARCHITECTURE.md.
 */

import { formatSessionId, type SessionId } from '@rivetos/types'
import { AdoptingPtyHarnessDriver } from './adopting-harness-driver.js'
import {
  type DenAgentEventLike,
  type HarnessPtyHost,
  type HarnessStoreHost,
  type PtyHarnessDriverDeps,
} from './pty-harness-driver.js'

export const OPENCODE_HARNESS_ID = 'opencode' as const
/** Roster key the den term manager spawns OpenCode under. */
export const OPENCODE_ROSTER_COMMAND = 'opencode'

export type OpencodePtyHost = HarnessPtyHost

/**
 * The slice of the on-disk opencode store this driver needs. `exists` is
 * required like grok's and kimi's: the store writes a session file, so a
 * describable session is a strict subset of an existing one.
 */
export interface OpencodeStoreHost extends HarnessStoreHost {
  /** Does the session file exist under the data dir? Sync. */
  exists(nativeId: string): boolean
}

export type OpencodeDriverDeps = PtyHarnessDriverDeps<OpencodeStoreHost>

/** // REVIEWER-CONFIRM: OpenCode session ids are `ses_` + 8+ alphanumerics. */
const OPENCODE_NATIVE_RE = /^ses_[A-Za-z0-9]{8,}$/

export class OpencodeDriver extends AdoptingPtyHarnessDriver<OpencodeStoreHost> {
  constructor(deps: OpencodeDriverDeps) {
    super(
      {
        harnessId: OPENCODE_HARNESS_ID,
        rosterCommand: OPENCODE_ROSTER_COMMAND,
        productName: 'OpenCode',
        noPinReason:
          'opencode: starting a session through the control plane is not supported — opencode has ' +
          'no verified flag to pin a new session id (`run` fails with "Session not found" when ' +
          'none exists), so the control plane cannot name the session it would be creating. ' +
          'Spawn opencode from the den roster; the driver adopts it when its hooks announce an id.',
      },
      deps,
    )
  }

  /** `opencode:<native>` for a native id. @throws `invalid_session_id` */
  static sessionId(nativeId: string): SessionId {
    return formatSessionId(OPENCODE_HARNESS_ID, nativeId)
  }

  /**
   * OpenCode's OWN session id off a den event, or undefined when the hook did
   * not report one. Only the `ses_…` shape is accepted — the translator's
   * `unknown-<hex>` fallback is a room key, never a store id.
   */
  protected override announcedNative(ev: DenAgentEventLike): string | undefined {
    const raw = ev.harnessSession
    if (typeof raw !== 'string') return undefined
    const trimmed = raw.trim()
    if (!trimmed || !OPENCODE_NATIVE_RE.test(trimmed)) return undefined
    return trimmed
  }

  /**
   * An OpenCode running outside den would post under its canonical id as the
   * room key (`opencode:ses_…`). Recover the native id from that shape — and
   * only that shape.
   */
  protected override canonicalRoomNative(room: string): string | undefined {
    const prefix = `${OPENCODE_HARNESS_ID}:`
    if (!room.startsWith(prefix)) return undefined
    const native = room.slice(prefix.length)
    return OPENCODE_NATIVE_RE.test(native) ? native : undefined
  }
}
