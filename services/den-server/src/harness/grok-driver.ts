/**
 * `grok-build` — HarnessDriver for Grok Build (Phase 3's first new driver).
 *
 * Same shape as the `claude-code` reference driver, and for the same reason:
 * it does not rebuild anything, it formalizes the machinery the node already
 * runs behind the one contract. Since driver three (`hermes`) landed, that
 * machinery is the shared `PtyHarnessDriver` base and this file is what makes
 * Grok Build itself:
 *
 *   | Contract method | Existing machinery it wraps                          |
 *   |-----------------|------------------------------------------------------|
 *   | listSessions    | `listHarnessSessions(['grok'])` — ~/.grok/sessions   |
 *   | getSession      | `describeGrokSession` (single-store lookup)          |
 *   | startSession    | term manager `spawn(..., session)` → `--session-id`  |
 *   | resumeSession   | term manager spawn-or-get → `--resume`               |
 *   | sendUserTurn    | term manager `inject(pty, text, submit)`             |
 *   | interrupt       | term manager `inject(pty, '', false, interrupt)` (Esc)|
 *   | subscribe       | den AgentEvent ingest tap (Grok's den hooks)         |
 *   | transcript      | `readGrokTranscript` — chat_history.jsonl            |
 *
 * **Identity.** Grok mints UUIDv7 native ids, and `grok --session-id` accepts
 * only a uuid — so the term manager can pin the harness's native id to the den
 * session key exactly as it does for Claude, and the canonical id is simply
 * `grok-build:<uuid>`. Nothing needs namespacing, and unlike Claude there is no
 * legacy key shape to alias: grok's capture plugin already derives
 * `grok-build:<uuid>` (`integrations/grok/rivet-memory/capture`), which IS the
 * canonical form. The bare-uuid shape the den drawer and hub chat use is
 * resolved by the registry's probe for every driver alike.
 *
 * **Two places this driver is NOT a copy of the Claude one:**
 *
 *   - *Store existence is a directory, not a file.* Claude's store is one
 *     `<uuid>.jsonl`; grok's is a session DIR that it creates BEFORE writing
 *     `summary.json`. A `describe` miss therefore does not mean the id is free
 *     — `grok --session-id` refuses an id whose dir exists. Collision and
 *     resume decisions go through the base's `storeExists`, backed here by the
 *     store's `exists` port (`harnessSessionExists`), which is the same ground
 *     truth the term manager itself uses (#318).
 *   - *Reasoning is real.* Claude's den hook cannot read thinking text and
 *     sends a spinner status line; grok's `updates.jsonl` carries ACP
 *     `agent_thought_chunk`s, so the shared translator ships the actual thought
 *     tail on `thinking.delta`. Both land on `reasoning-delta`, but the grok
 *     stream is the higher-fidelity one. Tool names likewise pass through as
 *     grok emits them (`run_terminal_cmd`, `search_replace`).
 *
 * **Honest capabilities.** `approvals` is `false`: Grok Build owns permission
 * prompts inside its TUI (and the den roster runs it with
 * `--permission-mode bypassPermissions` precisely so it does not block), and
 * nothing on the den wire carries an approval request or a decision channel —
 * `resolveApproval` rejects with `capability_unsupported` (HTTP 501).
 * `interrupt` / `resume` / `liveStream` are true only when the machinery
 * backing them is wired on this node (terminals enabled, den ingest tap
 * present).
 *
 * **This driver does not rotate.** Grok can mint a new native id
 * (`--fork-session`), but no den event carries a previous→new pair, and the
 * `PreCompact` hook the rivet-den integration wires emits `thinking.end` +
 * `activity` only. So `grok-build` never emits `session-updated` with
 * `previousSessionId`, and the rotation conformance suite
 * (`harness/test/driver-conformance.ts`) has nothing to run against it — the
 * same position `claude-code` is in. `grok-driver.test.ts` pins the
 * non-rotation explicitly instead.
 *
 * See docs/plans/harness-control-plane.md.
 */

import { formatSessionId, type SessionId } from '@rivetos/types'
import {
  PtyHarnessDriver,
  type HarnessPtyHost,
  type HarnessStoreHost,
  type PtyHarnessDriverDeps,
} from './pty-harness-driver.js'

export const GROK_HARNESS_ID = 'grok-build' as const
/** Roster key the den term manager spawns Grok Build under. */
export const GROK_ROSTER_COMMAND = 'grok'

/** The slice of the den term manager this driver needs. */
export type GrokPtyHost = HarnessPtyHost

/**
 * The slice of the on-disk grok store this driver needs. `exists` is required
 * here, unlike Claude's: grok writes the session dir before `summary.json`, so
 * a describable session is a strict subset of an existing one.
 */
export interface GrokStoreHost extends HarnessStoreHost {
  /**
   * Does the session DIR exist? Ground truth for collision + `--resume`, and
   * deliberately separate from `describe`. Sync, like `harnessSessionExists`
   * behind it — a handful of `existsSync`.
   */
  exists(nativeId: string): boolean
}

export type GrokDriverDeps = PtyHarnessDriverDeps<GrokStoreHost>

export class GrokBuildDriver extends PtyHarnessDriver<GrokStoreHost> {
  constructor(deps: GrokDriverDeps) {
    super(
      {
        harnessId: GROK_HARNESS_ID,
        rosterCommand: GROK_ROSTER_COMMAND,
        productName: 'Grok Build',
      },
      deps,
    )
  }

  /** `grok-build:<uuid>` for a native id. @throws `invalid_session_id` */
  static sessionId(nativeId: string): SessionId {
    return formatSessionId(GROK_HARNESS_ID, nativeId)
  }
}
