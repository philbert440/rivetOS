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
 * See docs/plans/harness-control-plane.md.
 */

import { formatSessionId, type HarnessSessionSummary, type SessionId } from '@rivetos/types'
import {
  PtyHarnessDriver,
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

/**
 * The hook field carrying hermes's OWN session id, alongside the den room key
 * in `session`. Added to the den protocol for this driver
 * (`AgentEventMeta.harnessSession`) because hermes is the first harness whose
 * native id the den room key cannot be.
 */
function announcedNative(ev: DenAgentEventLike): string | undefined {
  const raw = ev.harnessSession
  if (typeof raw !== 'string') return undefined
  const trimmed = raw.trim()
  // `unknown-<ppid>` is the translator's last-resort key for a hermes it could
  // not identify — a room, never a session id.
  if (!trimmed || trimmed.startsWith('unknown-')) return undefined
  return trimmed
}

export class HermesDriver extends PtyHarnessDriver<HermesStoreHost> {
  /**
   * den room key → the hermes session currently running in it.
   *
   * EXTRACTION POINT: `kimi-code` is the second driver that cannot pin an id
   * and therefore keeps this same room ↔ native pair, plus the same
   * `nativeFor` / `room` / `ownsEvent` / `bindRoom` shape around it. Two is a
   * deliberate duplicate under this plan's own rule — the `PtyHarnessDriver`
   * base was extracted at driver THREE precisely so the shape had three data
   * points to be sure of. A THIRD adopting driver is the trigger: extract the
   * room map (and the adopt-vs-rotate decision in `bindRoom`) into a shared
   * intermediate then, not before. See `kimi-driver.ts` for the twin, and for
   * the two places kimi genuinely diverges.
   */
  private readonly roomNative = new Map<string, string>()
  /** The inverse — which room a native id is live in. See `room()`. */
  private readonly nativeRoom = new Map<string, string>()

  constructor(deps: HermesDriverDeps) {
    super(
      {
        harnessId: HERMES_HARNESS_ID,
        rosterCommand: HERMES_ROSTER_COMMAND,
        productName: 'Hermes',
      },
      deps,
    )
  }

  /** `hermes:<native>` for a native id. @throws `invalid_session_id` */
  static sessionId(nativeId: string): SessionId {
    return formatSessionId(HERMES_HARNESS_ID, nativeId)
  }

  /**
   * Refused, deliberately — see "no pinning" in the file header. A caller that
   * wants a fresh hermes starts one from the den roster; this driver adopts it
   * when its hooks announce the id hermes picked.
   */
  startSession(): Promise<HarnessSessionSummary> {
    return Promise.reject(
      this.unsupported(
        'hermes: starting a session through the control plane is not supported — hermes has ' +
          'no flag to pin a new session id (--resume/--continue reference existing sessions ' +
          'only), so the control plane cannot name the session it would be creating. Spawn ' +
          'hermes from the den roster; the driver adopts it when its hooks announce an id.',
      ),
    )
  }

  /**
   * Resuming binds the den room key TO the native id (`hermes --resume <id>` in
   * a room named `<id>`), which is the one case where hermes's two ids
   * coincide. The bind happens AFTER the base has checked the store, not
   * before: binding marks the session live, which would talk the base out of
   * rejecting an id the harness has never heard of.
   */
  async resumeSession(sessionId: SessionId): Promise<HarnessSessionSummary> {
    // Bind AFTER the base has checked the store: binding marks the session
    // live, which would otherwise talk the base out of rejecting an id the
    // harness has never heard of.
    const summary = await super.resumeSession(sessionId)
    const native = this.native(sessionId)
    if (!this.nativeRoom.has(native)) this.bindRoom(native, native)
    return summary
  }

  // -- subclass hooks --------------------------------------------------------

  /** The den room a session is live in — its own id until the map says otherwise. */
  protected override room(native: string): string {
    return this.nativeRoom.get(native) ?? native
  }

  /**
   * Hermes native ids are not uuids, so the base's uuid gate would drop every
   * event. The room's identity comes from the hook's `harnessSession` field
   * instead; a room we have never bound is not ours to report on.
   *
   * A node still running an older hook (no `harnessSession`) degrades rather
   * than guesses: sessions this driver resumed itself keep streaming, because
   * their room key IS the native id; a drawer-spawned hermes stays invisible
   * until the hook is updated, which beats inventing an id for it.
   */
  protected override nativeFor(ev: DenAgentEventLike): string | undefined {
    const room = ev.session
    if (!room) return undefined
    const announced = announcedNative(ev)
    if (announced !== undefined) {
      if (!this.isHermesRoom(room, ev)) return undefined
      this.bindRoom(room, announced)
      return announced
    }
    return this.roomNative.get(room)
  }

  /**
   * `nativeFor` has already established the room is ours (a bound room, or a
   * hermes-stamped event), so the base's second check would only re-derive it.
   */
  protected override ownsEvent(): boolean {
    return true
  }

  // -- internals -------------------------------------------------------------

  /** Is this den room hermes's? den rooms also carry claude, grok and shells. */
  private isHermesRoom(room: string, ev: DenAgentEventLike): boolean {
    if (this.roomNative.has(room)) return true
    // hermes-den-hook.mjs stamps `harness: 'hermes'` on everything it posts;
    // the term manager's synthetic session.start for a roster spawn stamps
    // `rivetos` + `<host>:hermes`.
    if (ev.harness === HERMES_HARNESS_ID) return true
    return (
      ev.harness === 'rivetos' &&
      typeof ev.name === 'string' &&
      ev.name.endsWith(`:${HERMES_ROSTER_COMMAND}`)
    )
  }

  /**
   * Point a den room at the hermes session running in it. First sighting is an
   * adoption (announce it and start tracking); a room that changes its session
   * id is a ROTATION — `/new`, `/branch`, mid-chat `/resume`, a rewind, a
   * compaction that forked a child session, or a den room re-spawned into a
   * fresh hermes (the room is the conversation either way). The driver cannot
   * tell those apart on the den wire and does not need to: every one of them
   * replaces the native id of the session this room is running, which is
   * exactly what the contract's `previousSessionId` means. Reasons are
   * preserved where they are
   * observable — capture stamps hermes's own `reason` on its rotation
   * breadcrumb (`integrations/hermes/rivet-memory`).
   */
  private bindRoom(room: string, native: string): void {
    const previous = this.roomNative.get(room)
    if (previous === native) return
    this.roomNative.set(room, native)
    this.nativeRoom.set(native, room)
    if (previous === undefined) {
      this.ensureLive(native)
      this.announceIfNew(native)
      return
    }
    this.nativeRoom.delete(previous)
    this.rotate(previous, native)
  }
}
