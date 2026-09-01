/**
 * `deepseek-harness` — HarnessDriver for the DeepSeek Harness CLI (`dsh`).
 *
 * Fifth driver. Same adopting shape as hermes and kimi-code: dsh mints its
 * own `session-<uuid>` and has no `--session-id` pin, so `startSession` is
 * refused and the control plane adopts whatever the CLI created.
 *
 *   | Contract method | Existing machinery it wraps                              |
 *   |-----------------|----------------------------------------------------------|
 *   | listSessions    | `listHarnessSessions(['dsh'])` — ~/.dsh/sessions         |
 *   | getSession      | `describeDshSession` (dir lookup)                        |
 *   | startSession    | **refused** — no flag to pin a new session id            |
 *   | resumeSession   | term manager spawn-or-get → `dsh --profile tui --resume` |
 *   | sendUserTurn    | term manager `inject(pty, text, submit)`                 |
 *   | interrupt       | term manager `inject(pty, '', false, interrupt)` (Esc)   |
 *   | subscribe       | none — dsh has no hook-fed den stream                    |
 *   | transcript      | empty for now (session.jsonl.zstd is out-of-band)        |
 *
 * **No hook-fed capture.** Memory capture is the Cordis `session/event`
 * plugin (`integrations/deepseek/rivet-memory`, PR #538). This driver only
 * spawns and manages the interactive PTY. `liveStream` is therefore true
 * only when a den tap is actually wired, and even then the stream carries
 * no assistant/thinking/tool events until something starts stamping them.
 *
 * **Identity.** Native ids are `session-<uuid>` (hyphen, not kimi's
 * `session_`). Canonical form is `deepseek-harness:session-<uuid>`.
 *
 * **No pinning.** `dsh --help` documents `dsh --profile tui --resume
 * <session>` for an EXISTING session. There is no `--session-id`.
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

export const DEEPSEEK_HARNESS_ID = 'deepseek-harness' as const
/** Roster key the den term manager spawns DeepSeek Harness under. */
export const DEEPSEEK_ROSTER_COMMAND = 'dsh'

export type DeepseekPtyHost = HarnessPtyHost

export interface DeepseekStoreHost extends HarnessStoreHost {
  /** Does the session DIR exist under any cwd-slug bucket? Sync. */
  exists(nativeId: string): boolean
}

export type DeepseekDriverDeps = PtyHarnessDriverDeps<DeepseekStoreHost>

const DSH_NATIVE_RE = /^session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * The adopting shape (room ↔ native map, adopt-vs-rotate in `bindRoom`,
 * refused `startSession`) is the shared `AdoptingPtyHarnessDriver` — dsh is
 * the THIRD adopting driver, the trigger the EXTRACTION POINT notes on the
 * hermes and kimi copies waited for. What stays here is dsh's own: the
 * `session-<uuid>` id shape (hyphen, not kimi's underscore) behind both
 * hooks.
 */
export class DeepseekHarnessDriver extends AdoptingPtyHarnessDriver<DeepseekStoreHost> {
  constructor(deps: DeepseekDriverDeps) {
    super(
      {
        harnessId: DEEPSEEK_HARNESS_ID,
        rosterCommand: DEEPSEEK_ROSTER_COMMAND,
        productName: 'DeepSeek Harness',
        // The verbatim refusal — see "no pinning" in the file header.
        noPinReason:
          'deepseek-harness: starting a session through the control plane is not supported — dsh has ' +
          'no flag to pin a new session id (`--resume` references existing sessions only), so the ' +
          'control plane cannot name the session it would be creating. Spawn dsh from the den ' +
          'roster; the driver adopts the CLI-minted id.',
      },
      deps,
    )
  }

  /** `deepseek-harness:<native>` for a native id. @throws `invalid_session_id` */
  static sessionId(nativeId: string): SessionId {
    return formatSessionId(DEEPSEEK_HARNESS_ID, nativeId)
  }

  // -- divergent hooks ---------------------------------------------------------

  /**
   * dsh's OWN session id off a den event (if a future plugin stamps
   * `harnessSession`), or undefined. Only the exact `session-<uuid>` shape is
   * accepted — kimi's underscore variant and the translator's fallbacks are
   * not store ids.
   */
  protected override announcedNative(ev: DenAgentEventLike): string | undefined {
    const raw = ev.harnessSession
    if (typeof raw !== 'string') return undefined
    const trimmed = raw.trim()
    if (!trimmed || !DSH_NATIVE_RE.test(trimmed)) return undefined
    return trimmed
  }

  /**
   * A dsh running outside den would post under its canonical id as the room
   * key (`deepseek-harness:session-<uuid>`). Recover the native id from that
   * shape — and only that shape, so a junk colon room is not mistaken for one.
   */
  protected override canonicalRoomNative(room: string): string | undefined {
    const prefix = `${DEEPSEEK_HARNESS_ID}:`
    if (!room.startsWith(prefix)) return undefined
    const native = room.slice(prefix.length)
    return DSH_NATIVE_RE.test(native) ? native : undefined
  }
}
