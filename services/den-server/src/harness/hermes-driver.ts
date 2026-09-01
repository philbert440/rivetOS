/**
 * `hermes` — HarnessDriver for Hermes, and the FIRST ROTATING driver on the
 * control plane (Phase 3). The rotation gate (§ Rotation gate) exists for this
 * one; everything it promised is exercised here through the shared conformance
 * suite.
 *
 * Like its two siblings it formalizes machinery the node already runs, through
 * the shared `PtyHarnessDriver` base:
 *
 *   | Contract method | Existing machinery it wraps                          |
 *   |-----------------|------------------------------------------------------|
 *   | listSessions    | `listHarnessSessions(['hermes'])` — ~/.hermes/state.db |
 *   | getSession      | `describeHermesSession` (single sqlite row)          |
 *   | startSession    | **refused** — see "no pinning" below                 |
 *   | resumeSession   | term manager spawn-or-get → `hermes --resume <id>`   |
 *   | sendUserTurn    | term manager `inject(pty, text, submit)`             |
 *   | interrupt       | term manager `inject(pty, '', false, interrupt)` (Esc) |
 *   | subscribe       | den AgentEvent ingest tap (Hermes's den hooks)       |
 *   | transcript      | `readHermesTranscript` — the sqlite messages table   |
 *
 * Three things make hermes genuinely different from claude/grok, and all three
 * come from one fact: **hermes cannot be told what to call a new session.**
 * Its CLI has `--resume <id>` and `--continue [name]`, both of which reference
 * an EXISTING session, and no flag that mints a new one under a caller's id
 * (`--pass-session-id` only injects the id into the system prompt). So:
 *
 *   1. **The den room key is not the native id.** For claude and grok the term
 *      manager pins `--session-id <den session key>` and the two are the same
 *      string. A hermes spawned from the drawer or from hub chat runs under a
 *      room key it chose, while hermes mints `20260802_225647_6ad0b9` for
 *      itself. This driver therefore keeps a room ↔ native map, learned from
 *      the den stream: the rivet-den hook stamps hermes's own `session_id` on
 *      every event as `harnessSession`, which is the only place on the wire the
 *      two ids appear together. A session this driver resumes itself is spawned
 *      with the den room key SET to the native id, so the two coincide again.
 *   2. **`startSession` is refused** with `capability_unsupported`. The
 *      alternative — mint a uuid, hand it back, and hope — would be a Rivet-only
 *      third id that the harness never adopts, which § Rotation rule 7 forbids
 *      outright. Hermes sessions come into the control plane by adoption: spawn
 *      from the den roster (or `POST .../resume` an existing one) and the driver
 *      picks it up the moment its hooks announce an id.
 *   3. **It rotates.** `/new`, `/branch`, a mid-chat `/resume`, a rewind, and a
 *      compaction that forks a child session all replace hermes's session id
 *      inside one running process — hermes's own `on_session_switch` hook fires
 *      for each. On the den wire that shows up as the room's `harnessSession`
 *      changing, and the driver answers with `session-updated` +
 *      `previousSessionId`. That is the driver's entire part in rotation: the
 *      control plane records the alias, moves live tails, retires the old id and
 *      keeps `listSessions` canonical-only (`registry.ts` → `rekey`).
 *
 * **Identity.** `hermes:<native>` — exactly what the capture plugin already
 * writes (`integrations/hermes/rivet-memory`, `f"hermes:{session_id}"`) and what
 * the sqlite store keys on, so den, capture and the control plane join on one
 * string. Those natives are `YYYYMMDD_HHMMSS_<6 hex>`: k-sortable, but
 * second-resolution plus 24 bits rather than the uuid-class entropy § Session
 * identity asks for. Namespacing them (the rule's remedy) is deliberately NOT
 * done — it would fork the key away from capture and from hermes's own store,
 * done — it would fork the key away from capture and from hermes's own store,
 * which is a worse failure than the residual collision risk of two sessions
 * starting in the same second, on the same node, under the same agent tag, and
 * drawing the same 24 bits. Ruled in review (PR #477): accept and record.
 *
 * **Honest capabilities.** `approvals` is `false` like the others: the den
 * roster runs `hermes --yolo --accept-hooks` precisely so it never blocks on a
 * prompt, and while a hermes shell hook can *block* a tool call, that is a
 * policy verdict computed on the node — not a request for a human decision, and
 * there is no channel on the den wire to answer one. `interrupt` / `resume` /
 * `liveStream` are true only when the machinery behind them is wired here.
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

export const HERMES_HARNESS_ID = 'hermes' as const
/** Roster key the den term manager spawns Hermes under. */
export const HERMES_ROSTER_COMMAND = 'hermes'

/** The slice of the den term manager this driver needs. */
export type HermesPtyHost = HarnessPtyHost

/**
 * The slice of the hermes sqlite store this driver needs. `exists` is a
 * `SELECT 1 FROM sessions`, which is cheaper and broader than `describe` (a
 * session row exists before it has any messages to title it with).
 */
export interface HermesStoreHost extends HarnessStoreHost {
  exists(nativeId: string): boolean
}

export type HermesDriverDeps = PtyHarnessDriverDeps<HermesStoreHost>

export class HermesDriver extends AdoptingPtyHarnessDriver<HermesStoreHost> {
  constructor(deps: HermesDriverDeps) {
    super(
      {
        harnessId: HERMES_HARNESS_ID,
        rosterCommand: HERMES_ROSTER_COMMAND,
        productName: 'Hermes',
        // The verbatim refusal — see "no pinning" in the file header.
        noPinReason:
          'hermes: starting a session through the control plane is not supported — hermes has ' +
          'no flag to pin a new session id (--resume/--continue reference existing sessions ' +
          'only), so the control plane cannot name the session it would be creating. Spawn ' +
          'hermes from the den roster; the driver adopts it when its hooks announce an id.',
      },
      deps,
    )
  }

  /** `hermes:<native>` for a native id. @throws `invalid_session_id` */
  static sessionId(nativeId: string): SessionId {
    return formatSessionId(HERMES_HARNESS_ID, nativeId)
  }

  // -- divergent hooks ---------------------------------------------------------

  /**
   * hermes's OWN session id off a den event, or undefined when the hook did
   * not report one. The hook field carrying it, alongside the den room key in
   * `session`, was added to the den protocol for this driver
   * (`AgentEventMeta.harnessSession`) because hermes is the first harness
   * whose native id the den room key cannot be. Shape-checked rather than
   * trusted: the field is a wire value.
   */
  protected override announcedNative(ev: DenAgentEventLike): string | undefined {
    const raw = ev.harnessSession
    if (typeof raw !== 'string') return undefined
    const trimmed = raw.trim()
    // `unknown-<ppid>` is the translator's last-resort key for a hermes it could
    // not identify — a room, never a session id.
    if (!trimmed || trimmed.startsWith('unknown-')) return undefined
    return trimmed
  }

  // `canonicalRoomNative` is deliberately NOT overridden: hermes has no
  // outside-den path that posts under a canonical `hermes:<native>` room key,
  // so the adopting base's default (undefined) is hermes's answer.
}
