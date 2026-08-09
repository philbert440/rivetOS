/**
 * `claude-code` — the reference HarnessDriver (Phase 2).
 *
 * This does NOT rebuild anything: it formalizes the machinery the node already
 * runs, behind the one contract every other harness matches. Since driver
 * three (`hermes`) landed, the machinery itself lives in the shared
 * `PtyHarnessDriver` base — the live map, the in-flight turn lock, LIFO tool
 * pairing, den event mapping, sink fanout — and what remains here is what makes
 * this harness itself:
 *
 *   | Contract method | Existing machinery it wraps                          |
 *   |-----------------|------------------------------------------------------|
 *   | listSessions    | `listHarnessSessions(['claude'])` — ~/.claude/projects |
 *   | getSession      | `describeClaudeSession` (single-store lookup)        |
 *   | startSession    | term manager `spawn(..., session)` → `--session-id`  |
 *   | resumeSession   | term manager spawn-or-get → `--resume`               |
 *   | sendUserTurn    | term manager `inject(pty, text, submit)`             |
 *   | interrupt       | term manager `inject(pty, '', false, interrupt)` (Esc) |
 *   | subscribe       | den AgentEvent ingest tap (Claude's den hooks)       |
 *   | transcript      | `readClaudeTranscript` (the hard-resync source)      |
 *
 * **Identity.** Den already makes the harness's native session id equal the
 * den session key (the term manager pins `--session-id <uuid>`), so the
 * canonical id is simply `claude-code:<uuid>`, and the base's default
 * room↔native identity mapping is exactly right. Legacy shapes — the bare uuid
 * the drawer/hub use and capture's `claude-code:<project-slug>/<uuid>` path
 * fallback — are aliased to it by the control plane, never dual-written.
 *
 * **Honest capabilities.** `approvals` is `false`: Claude Code surfaces
 * permission prompts inside its TUI, and nothing on the den wire carries an
 * approval request or a decision channel. Rather than fake it, the driver
 * rejects `resolveApproval` with `capability_unsupported` (HTTP 501) and the
 * UI hides the affordance. `interrupt` / `resume` / `liveStream` are true only
 * when the machinery backing them is actually wired on this node (terminals
 * enabled, den ingest tap present).
 *
 * **This driver does not rotate.** Claude never replaces its native session id,
 * so it emits no `session-updated` with `previousSessionId` and the rotation
 * conformance suite has nothing to run against it.
 *
 * See docs/plans/harness-control-plane.md.
 */

import { formatSessionId, type SessionId } from '@rivetos/types'
import {
  PtyHarnessDriver,
  type DenAgentEventLike,
  type HarnessPtyHost,
  type HarnessStoreHost,
  type PtyHarnessDriverDeps,
} from './pty-harness-driver.js'

export const CLAUDE_HARNESS_ID = 'claude-code' as const
/** Roster key the den term manager spawns Claude under. */
export const CLAUDE_ROSTER_COMMAND = 'claude'

/**
 * Re-exported from the shared base, where it moved at driver three. Importing
 * it from here still works — server.ts and the sibling drivers do.
 */
export type { DenAgentEventLike }

/** The slice of the den term manager this driver needs. */
export type ClaudePtyHost = HarnessPtyHost

/**
 * The slice of the on-disk Claude store this driver needs. No `exists` port:
 * Claude's store is one `<uuid>.jsonl`, so "describable" and "exists" are the
 * same question and the base derives one from the other.
 */
export type ClaudeStoreHost = Omit<HarnessStoreHost, 'exists'>

export type ClaudeDriverDeps = PtyHarnessDriverDeps<ClaudeStoreHost>

export class ClaudeCodeDriver extends PtyHarnessDriver<ClaudeStoreHost> {
  constructor(deps: ClaudeDriverDeps) {
    super(
      {
        harnessId: CLAUDE_HARNESS_ID,
        rosterCommand: CLAUDE_ROSTER_COMMAND,
        productName: 'Claude Code',
      },
      deps,
    )
  }

  /** `claude-code:<uuid>` for a native id. @throws `invalid_session_id` */
  static sessionId(nativeId: string): SessionId {
    return formatSessionId(CLAUDE_HARNESS_ID, nativeId)
  }
}
