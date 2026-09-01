/**
 * `AdoptingPtyHarnessDriver` — the shared body of the PTY harness drivers that
 * cannot be told what to call a new session: `hermes`, `kimi-code` and
 * `deepseek-harness`.
 *
 * Extraction history, because both were rule-of-three calls: `PtyHarnessDriver`
 * was pulled out at driver THREE so its shape had three data points. The
 * ADOPTING shape was then deliberately left duplicated between hermes and kimi
 * (the EXTRACTION POINT notes on both room maps said so) — an adopting-driver
 * base drawn from two would be guessing at which parts are general.
 * `deepseek-harness` is that third adopting driver, and this file is the
 * extraction those notes deferred to.
 *
 * What "adopting" means. None of these CLIs has a `--session-id`-style flag:
 * hermes's `--resume`/`--continue`, kimi's `-S/--session`/`--continue` and
 * dsh's `--resume` all reference EXISTING sessions only. So:
 *
 *   1. **The den room key is not the native id.** A harness spawned from the
 *      drawer runs under a room key den chose while the CLI mints its own id
 *      (`20260802_225647_6ad0b9`, `session_<uuid>`, `session-<uuid>`). The
 *      room ↔ native pair is learned from the den stream: the den hook stamps
 *      the harness's own id on every event as `harnessSession` (the optional
 *      `AgentEventMeta` field added to the den protocol for hermes), the one
 *      place on the wire the two ids appear together. A session the driver
 *      resumes itself is spawned into a room NAMED after the native id, so
 *      for those the two coincide again.
 *   2. **`startSession` is refused** with `capability_unsupported`. Minting a
 *      Rivet-only id and hoping the harness adopts it is what § Rotation
 *      rule 7 forbids. Sessions enter the control plane by adoption: spawn
 *      from the den roster (or `POST .../resume` an existing one) and the
 *      driver picks the session up when its hooks announce an id.
 *   3. **A room that changes its session id is a ROTATION** — `bindRoom`
 *      answers with `session-updated` + `previousSessionId`, and the control
 *      plane does the rest (alias, moved tails, retired predecessor).
 *
 * What stays with each driver — the genuinely divergent hooks:
 *
 *   - **`announcedNative`** — how the harness's own id is validated off the
 *     wire. Deliberately NOT unified: hermes rejects only the translator's
 *     `unknown-<ppid>` fallback, kimi requires the `session_` prefix, dsh
 *     requires its `session-<uuid>` shape verbatim. Each check is that
 *     harness's product knowledge.
 *   - **`canonicalRoomNative`** — kimi and dsh accept a canonical
 *     `<harness-id>:<native>` room key as an id announcement (a harness
 *     running OUTSIDE den entirely, with no `RIVET_DEN_SESSION` to pin a
 *     room, posts under its own canonical id). Hermes has no such path and
 *     keeps the default (`undefined`). Not a difference to smooth over.
 *   - **`noPinReason`** — the verbatim `startSession` refusal, naming each
 *     CLI's actual flags; the base only wraps it in `capability_unsupported`.
 *
 * What a room changing session MEANS is likewise per-harness product
 * knowledge: hermes switches session inside one process (`/new`, `/branch`,
 * a mid-chat `/resume`, a rewind, a forking compaction) and fires a hook for
 * it; kimi and dsh never do — for them a changed room means the PTY was
 * re-spawned into a fresh harness (a reaped PTY restarted from the drawer).
 * The room is the conversation either way, so the MECHANICS are identical and
 * live in `bindRoom` here; the meaning is written down in each driver's own
 * file header.
 *
 * See docs/ARCHITECTURE.md.
 */

import { type HarnessSessionSummary, type SessionId } from '@rivetos/types'
import {
  PtyHarnessDriver,
  type DenAgentEventLike,
  type HarnessStoreHost,
  type PtyHarnessDriverDeps,
  type PtyHarnessIdentity,
} from './pty-harness-driver.js'

/**
 * Identity for an adopting driver: the pinning drivers' identity plus the
 * verbatim reason `startSession` is refused (product knowledge — it names the
 * harness's actual CLI flags, or the lack of them).
 */
export interface AdoptingHarnessIdentity extends PtyHarnessIdentity {
  /** The `capability_unsupported` message `startSession` rejects with. */
  noPinReason: string
}

export abstract class AdoptingPtyHarnessDriver<
  S extends HarnessStoreHost = HarnessStoreHost,
> extends PtyHarnessDriver<S> {
  /** The verbatim `startSession` refusal. See `AdoptingHarnessIdentity`. */
  protected readonly noPinReason: string

  /** den room key → the harness session currently running in it. */
  protected readonly roomNative = new Map<string, string>()
  /** The inverse — which room a native id is live in. See `room()`. */
  protected readonly nativeRoom = new Map<string, string>()

  constructor(identity: AdoptingHarnessIdentity, deps: PtyHarnessDriverDeps<S>) {
    super(identity, deps)
    this.noPinReason = identity.noPinReason
  }

  /**
   * Refused, deliberately — see the file header. A caller that wants a fresh
   * session starts one from the den roster; this driver adopts it when the
   * harness's hooks announce the id the CLI picked.
   */
  startSession(): Promise<HarnessSessionSummary> {
    return Promise.reject(this.unsupported(this.noPinReason))
  }

  /**
   * Resuming binds the den room key TO the native id (`--resume <id>` in a
   * room named `<id>`), which is the one case where the two ids coincide.
   * The bind happens AFTER the base has checked the store, not before:
   * binding marks the session live, which would otherwise talk the base out
   * of rejecting an id the harness has never heard of.
   */
  async resumeSession(sessionId: SessionId): Promise<HarnessSessionSummary> {
    const summary = await super.resumeSession(sessionId)
    const native = this.native(sessionId)
    if (!this.nativeRoom.has(native)) this.bindRoom(native, native)
    return summary
  }

  // -- subclass hooks (of PtyHarnessDriver) ------------------------------------

  /** The den room a session is live in — its own id until the map says otherwise. */
  protected override room(native: string): string {
    return this.nativeRoom.get(native) ?? native
  }

  /**
   * These harnesses' native ids are not bare uuids, so the base's uuid gate
   * would drop every event. Identity comes from the hook's `harnessSession`
   * field instead; a room we have never bound is not ours.
   *
   * A node still running an older hook (no `harnessSession`) degrades rather
   * than guesses: sessions this driver resumed itself keep streaming because
   * their room key IS the native id, and a drawer-spawned harness stays
   * invisible until the hook is updated — which beats inventing an id for it.
   */
  protected override nativeFor(ev: DenAgentEventLike): string | undefined {
    const room = ev.session
    if (!room) return undefined
    const announced = this.announcedNative(ev) ?? this.canonicalRoomNative(room)
    if (announced !== undefined) {
      if (!this.isHarnessRoom(room, ev)) return undefined
      this.bindRoom(room, announced)
      return announced
    }
    return this.roomNative.get(room)
  }

  /**
   * `nativeFor` has already established the room is ours (a bound room, or a
   * harness-stamped event), so the base's second check would only re-derive it.
   */
  protected override ownsEvent(): boolean {
    return true
  }

  // -- adopting hooks (of this class) ------------------------------------------

  /**
   * The harness's OWN session id off a den event, or `undefined` when the hook
   * did not report one (or reported something that is not a store id). Each
   * driver shape-checks the wire value against its harness's own id format —
   * see the per-driver implementations, which are deliberately not unified.
   */
  protected abstract announcedNative(ev: DenAgentEventLike): string | undefined

  /**
   * The native id out of a CANONICAL room key (`<harness-id>:<native>`), for
   * a harness running outside den with no `RIVET_DEN_SESSION` to pin a room.
   * Default is no such path (hermes); kimi and dsh override.
   */
  protected canonicalRoomNative(_room: string): string | undefined {
    return undefined
  }

  // -- internals ---------------------------------------------------------------

  /** Is this den room this harness's? den rooms also carry the other harnesses and shells. */
  private isHarnessRoom(room: string, ev: DenAgentEventLike): boolean {
    if (this.roomNative.has(room)) return true
    // The harness's den hook stamps `harness: <harness-id>` on everything it
    // posts; the term manager's synthetic session.start for a roster spawn
    // stamps `rivetos` + `<host>:<roster-key>`.
    if (ev.harness === this.harnessId) return true
    return (
      ev.harness === 'rivetos' &&
      typeof ev.name === 'string' &&
      ev.name.endsWith(`:${this.rosterCommand}`)
    )
  }

  /**
   * Point a den room at the harness session running in it. First sighting is
   * an adoption (announce it and start tracking); a room that changes its
   * session id is a ROTATION.
   *
   * The driver cannot tell WHY the id changed on the den wire and does not
   * need to: an in-process session switch (hermes's `/new`, `/branch`,
   * mid-chat `/resume`, rewind, forking compaction) and a den room re-spawned
   * into a fresh harness (the only way kimi/dsh rooms change session) both
   * replace the native id of the session this room is running, which is
   * exactly what the contract's `previousSessionId` means. The room is the
   * conversation every attached client is watching either way.
   */
  protected bindRoom(room: string, native: string): void {
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
