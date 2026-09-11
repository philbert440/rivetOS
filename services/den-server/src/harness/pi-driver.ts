/**
 * `pi` — HarnessDriver for the Pi coding agent (earendil-works/pi).
 *
 * Adopting PTY driver, same shape as kimi-code / hermes / deepseek: pi mints
 * its own session id and (as of this wiring) has no confirmed flag to pin a
 * NEW id, so `startSession` is refused and the control plane adopts whatever
 * the CLI created.
 *
 *   | Contract method | Existing machinery it wraps                         |
 *   |-----------------|-----------------------------------------------------|
 *   | listSessions    | `listHarnessSessions(['pi'])` — ~/.pi/sessions      |
 *   | getSession      | `describePiSession`                                 |
 *   | startSession    | **refused** — see "no pinning" below                |
 *   | resumeSession   | term manager spawn-or-get → `pi --session <id>`     |
 *   | sendUserTurn    | term manager `inject(pty, text, submit)`            |
 *   | interrupt       | term manager `inject(pty, '', false, interrupt)`    |
 *   | subscribe       | den AgentEvent ingest tap (when a hook stamps ids)  |
 *   | transcript      | `readPiTranscript` — ~/.pi/sessions/<id>/transcript.jsonl |
 *
 * **Identity.** Native ids are treated as UUID-class (no prefix). Canonical
 * form is `pi:<uuid>`. // REVIEWER-CONFIRM: native id shape (UUID vs
 * session_<uuid> vs other) was not verified against an installed `pi` binary.
 *
 * **No pinning.** Print/JSON and RPC modes exist upstream, but the interactive
 * TUI's resume/pin flags were not confirmed at wiring time. Mirror kimi:
 * `--session` resumes an EXISTING session; there is no `--session-id`.
 * // REVIEWER-CONFIRM: resume flag (`--session` vs `--resume` vs other).
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

export const PI_HARNESS_ID = 'pi' as const
/** Roster key the den term manager spawns Pi under. */
export const PI_ROSTER_COMMAND = 'pi'

export type PiPtyHost = HarnessPtyHost

export interface PiStoreHost extends HarnessStoreHost {
  /** Does the session DIR (or flat jsonl) exist? Sync. */
  exists(nativeId: string): boolean
}

export type PiDriverDeps = PtyHarnessDriverDeps<PiStoreHost>

// REVIEWER-CONFIRM: native id shape. UUID-class is the collision-resistant
// default the rest of the control plane already requires; drop/relax if pi
// mints something else.
const PI_NATIVE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export class PiDriver extends AdoptingPtyHarnessDriver<PiStoreHost> {
  constructor(deps: PiDriverDeps) {
    super(
      {
        harnessId: PI_HARNESS_ID,
        rosterCommand: PI_ROSTER_COMMAND,
        productName: 'Pi',
        noPinReason:
          'pi: starting a session through the control plane is not supported — pi has ' +
          'no confirmed flag to pin a new session id (`--session` references existing ' +
          'sessions only), so the control plane cannot name the session it would be creating. ' +
          'Spawn pi from the den roster; the driver adopts it when its hooks announce an id.',
      },
      deps,
    )
  }

  /** `pi:<native>` for a native id. @throws `invalid_session_id` */
  static sessionId(nativeId: string): SessionId {
    return formatSessionId(PI_HARNESS_ID, nativeId)
  }

  protected override announcedNative(ev: DenAgentEventLike): string | undefined {
    const raw = ev.harnessSession
    if (typeof raw !== 'string') return undefined
    const trimmed = raw.trim()
    if (!trimmed || !PI_NATIVE_RE.test(trimmed)) return undefined
    return trimmed
  }

  /**
   * A pi running outside den would post under its canonical id as the room
   * key (`pi:<uuid>`). Recover the native id from that shape only.
   */
  protected override canonicalRoomNative(room: string): string | undefined {
    const prefix = `${PI_HARNESS_ID}:`
    if (!room.startsWith(prefix)) return undefined
    const native = room.slice(prefix.length)
    return PI_NATIVE_RE.test(native) ? native : undefined
  }
}
