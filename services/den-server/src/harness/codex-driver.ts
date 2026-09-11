/**
 * `codex` — HarnessDriver for the Codex CLI.
 *
 * Adopting driver, same shape as kimi-code: Codex mints its own rollout UUID
 * and `codex resume <SESSION_ID>` / `--last` reference EXISTING sessions
 * only. There is no `--session-id`, so `startSession` is refused and the
 * control plane adopts whatever the CLI created.
 *
 *   | Contract method | Existing machinery it wraps                            |
 *   |-----------------|--------------------------------------------------------|
 *   | listSessions    | `listHarnessSessions(['codex'])` — ~/.codex/sessions   |
 *   | getSession      | `describeCodexSession` (YYYY/MM/DD rollout jsonl)      |
 *   | startSession    | **refused** — see "no pinning" below                   |
 *   | resumeSession   | term manager spawn-or-get → `codex resume <uuid>`      |
 *   | sendUserTurn    | term manager `inject(pty, text, submit)`               |
 *   | interrupt       | term manager `inject(pty, '', false, interrupt)` (Esc) |
 *   | subscribe       | den AgentEvent ingest tap (Codex has no den hooks)     |
 *   | transcript      | `readCodexTranscript` — rollout jsonl                  |
 *
 * **Identity.** Native ids are a BARE UUID (the rollout id) — no `session_`
 * prefix. Canonical form is `codex:<uuid>`. `announcedNative` /
 * `canonicalRoomNative` accept only that UUID shape.
 *
 * **No pinning.** `codex resume <SESSION_ID>` and `codex resume --last`
 * reference an EXISTING session; an unknown id fails. So:
 *
 *   1. The den room key is not the native id for a drawer spawn.
 *   2. `startSession` is refused with `capability_unsupported`.
 *
 * **It does NOT rotate its own session id.** A Codex process is one rollout
 * for its whole life. A den ROOM can still change which Codex it runs (a
 * reaped PTY restarted from the drawer) — that is the rotation.
 *
 * **What the live stream does not carry.** Codex has no Claude/kimi-style den
 * hooks. This driver emits no invented `assistant-delta` / `reasoning-delta`:
 * turn text comes from `transcript()` (the rollout jsonl). `liveStream` is
 * still honestly true when the tap is wired — session lifecycle that DOES
 * appear on the wire is real.
 *
 * **Honest capabilities.** `approvals` is false on this PTY driver. Codex
 * permission prompts are not keyed from the TUI path (codex-cli 0.153.4
 * bindings were not verified from the binary); the protocol driver
 * (`codexAppServerUrl`) is the only surface that can resolve them.
 * `interrupt` / `resume` / `liveStream` are true only when the machinery
 * behind them is wired here.
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

export const CODEX_HARNESS_ID = 'codex' as const
/** Roster key the den term manager spawns Codex under. */
export const CODEX_ROSTER_COMMAND = 'codex'

/** Bare rollout UUID — no `session_` prefix. */
export const CODEX_NATIVE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type CodexPtyHost = HarnessPtyHost

export interface CodexStoreHost extends HarnessStoreHost {
  /** Does the rollout jsonl exist under any YYYY/MM/DD bucket? Sync. */
  exists(nativeId: string): boolean
}

export type CodexDriverDeps = PtyHarnessDriverDeps<CodexStoreHost>

export class CodexDriver extends AdoptingPtyHarnessDriver<CodexStoreHost> {
  constructor(deps: CodexDriverDeps) {
    super(
      {
        harnessId: CODEX_HARNESS_ID,
        rosterCommand: CODEX_ROSTER_COMMAND,
        productName: 'Codex',
        noPinReason:
          'codex: starting a session through the control plane is not supported — Codex has ' +
          'no flag to pin a new session id (`codex resume` / `--last` reference existing ' +
          'sessions only), so the control plane cannot name the session it would be creating. ' +
          'Spawn Codex from the den roster; the driver adopts it when its hooks announce an id.',
      },
      deps,
    )
  }

  /** `codex:<native>` for a native id. @throws `invalid_session_id` */
  static sessionId(nativeId: string): SessionId {
    return formatSessionId(CODEX_HARNESS_ID, nativeId)
  }

  protected override announcedNative(ev: DenAgentEventLike): string | undefined {
    const raw = ev.harnessSession
    if (typeof raw !== 'string') return undefined
    const trimmed = raw.trim()
    if (!trimmed || !CODEX_NATIVE_RE.test(trimmed)) return undefined
    return trimmed
  }

  protected override canonicalRoomNative(room: string): string | undefined {
    const prefix = `${CODEX_HARNESS_ID}:`
    if (!room.startsWith(prefix)) return undefined
    const native = room.slice(prefix.length)
    return CODEX_NATIVE_RE.test(native) ? native : undefined
  }
}
