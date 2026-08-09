/**
 * `kimi-code` — HarnessDriver for Kimi Code CLI, the FOURTH driver and the one
 * that completes the control plane's four-harness set (Phase 3).
 *
 * Like its three siblings it rebuilds nothing: it formalizes machinery the node
 * already runs behind the one contract, through the shared `PtyHarnessDriver`
 * base.
 *
 *   | Contract method | Existing machinery it wraps                            |
 *   |-----------------|--------------------------------------------------------|
 *   | listSessions    | `listHarnessSessions(['kimi'])` — ~/.kimi-code/sessions |
 *   | getSession      | `describeKimiSession` (index lookup → state.json)      |
 *   | startSession    | **refused** — see "no pinning" below                   |
 *   | resumeSession   | term manager spawn-or-get → `kimi --session <id>`      |
 *   | sendUserTurn    | term manager `inject(pty, text, submit)`               |
 *   | interrupt       | term manager `inject(pty, '', false, interrupt)` (Esc) |
 *   | subscribe       | den AgentEvent ingest tap (kimi's rivet-den hooks)     |
 *   | transcript      | `readKimiTranscript` — agents/main/wire.jsonl          |
 *
 * **Identity.** kimi's native ids are `session_<uuid>` — uuid-class entropy
 * behind a fixed prefix, so § Session identity's collision rule is satisfied by
 * plain namespacing and the canonical id is `kimi-code:session_<uuid>`. That is
 * already what kimi's rivet-memory capture writes and what its rivet-den hook
 * uses as a room key when it runs outside den, so den, capture and the control
 * plane join on one string. Note the prefix means `isBareNativeUuid` never
 * matches a kimi id: the registry's bare-uuid probe cannot resolve one, and
 * clients must send the canonical form. That is the right trade — a probe that
 * asked four stores about every unprefixed id would be guessing.
 *
 * **No pinning, exactly like hermes.** `kimi --help` (0.34.0) offers
 * `-S, --session [id]` and `-c, --continue`, both of which reference an
 * EXISTING session; there is no `--session-id`, and `--session <unknown-id>`
 * fails with `Session "…" not found`. So:
 *
 *   1. **The den room key is not the native id.** A kimi spawned from the
 *      drawer runs under a room key den chose while kimi mints
 *      `session_<uuid>` for itself. This driver keeps a room ↔ native map,
 *      learned from the den stream: `kimi-den-hook.mjs` stamps kimi's own
 *      session id on every event as `harnessSession` — the same optional
 *      `AgentEventMeta` field the hermes driver reads, reused rather than
 *      reinvented. A session this driver resumes itself is spawned into a room
 *      NAMED after the native id, so for those the two coincide again.
 *   2. **`startSession` is refused** with `capability_unsupported`. Minting a
 *      Rivet-only id and hoping kimi adopts it is what § Rotation rule 7
 *      forbids, and the same reasoning that settled it for hermes settles it
 *      here. Kimi sessions enter the control plane by adoption: spawn from the
 *      den roster (or `POST .../resume` an existing one) and the driver picks
 *      the session up when its hooks announce an id.
 *
 * **It does NOT rotate its own session id — verified, not assumed.** kimi's
 * `/clear` is an RPC scoped to the running session (`clearContext({ sessionId
 * })`, which appends a `context.clear` record to the SAME `wire.jsonl`);
 * compaction likewise appends `context.apply_compaction` in place; and
 * `kimi --session <id>` replays the same session dir under the same id. A
 * native id is minted in exactly one place — `createSession` at process start.
 * `kimi-driver.test.ts` pins that non-rotation explicitly, the way
 * `grok-driver.test.ts` does.
 *
 * What CAN change is which session a den ROOM is running: a room whose PTY was
 * reaped and re-spawned fresh holds a different kimi than it did before, and
 * the room is the conversation as far as every attached client is concerned. So
 * the driver reports that as a rotation — the same event, the same registry
 * machinery — and the rotation conformance suite runs against it. Rotation here
 * means "this room moved on", never "kimi renamed itself", and the header of
 * `bindRoom` is where that distinction is written down.
 *
 * **What the live stream does not carry, stated rather than faked.** kimi's
 * `Stop` hook payload is `{ stop_hook_active }` — no reply text — and no kimi
 * hook is given thinking text at all. Its den translator therefore emits
 * neither `message.agent` nor `thinking.delta`, so this driver emits **no
 * `assistant-delta` and no `reasoning-delta`**: the base maps both the moment
 * such an event appears, and until the harness produces one there is nothing to
 * carry. Inventing a spinner line to fill the gap would be a lie about what the
 * node observed. `liveStream` is still honestly true when the tap is wired —
 * session lifecycle, tool calls and turn boundaries are all real — and the
 * assistant/thinking text is served by `transcript()`, which reads kimi's own
 * `content.part` `text` and `think` parts out of `wire.jsonl`. A
 * transcript-watch-fed delta stream is the documented follow-up, not a fake.
 *
 * **Honest capabilities.** `approvals` is `false`: kimi owns permission prompts
 * inside its TUI, its den integration deliberately leaves
 * `PermissionRequest`/`PermissionResult` unmapped (protocol v1 has no approval
 * surface), nothing carries a decision back, and the roster runs `kimi --yolo`
 * precisely so ordinary tool calls never block. `interrupt` / `resume` /
 * `liveStream` are true only when the machinery behind them is wired on this
 * node. Esc is kimi's documented interrupt key ("Close dialogs / interrupt
 * streaming" in its own keybinding help), so the base's Esc inject applies
 * unchanged, and its TUI parses bracketed paste (DEC 2004), which is what the
 * term manager wraps an injected turn in.
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

export const KIMI_HARNESS_ID = 'kimi-code' as const
/** Roster key the den term manager spawns Kimi Code under. */
export const KIMI_ROSTER_COMMAND = 'kimi'

/** The slice of the den term manager this driver needs. */
export type KimiPtyHost = HarnessPtyHost

/**
 * The slice of the on-disk kimi store this driver needs. `exists` is required
 * like grok's and hermes's: kimi creates the session DIR, then writes
 * `state.json`, then the transcript, so a describable session is a strict
 * subset of an existing one.
 */
export interface KimiStoreHost extends HarnessStoreHost {
  /** Does the session DIR exist under any workspace bucket? Sync — a handful
   *  of `existsSync`, like `harnessSessionExists`. */
  exists(nativeId: string): boolean
}

export type KimiDriverDeps = PtyHarnessDriverDeps<KimiStoreHost>

/**
 * kimi's OWN session id off a den event, or undefined when the hook did not
 * report one. Shape-checked rather than trusted: the field is a wire value.
 */
function announcedNative(ev: DenAgentEventLike): string | undefined {
  const raw = ev.harnessSession
  if (typeof raw !== 'string') return undefined
  const trimmed = raw.trim()
  // `unknown-<hex>` is the translator's cached fallback id for a kimi that sent
  // no session_id at all — a room key, never a store id, and resuming one would
  // ask the CLI for a session that does not exist.
  if (!trimmed || !trimmed.startsWith('session_')) return undefined
  return trimmed
}

export class KimiCodeDriver extends PtyHarnessDriver<KimiStoreHost> {
  /**
   * den room key → the kimi session currently running in it.
   *
   * EXTRACTION POINT: this room ↔ native pair, and the `nativeFor` / `room` /
   * `ownsEvent` / `bindRoom` shape around it, is copy TWO of
   * `hermes-driver.ts`. Deliberately not extracted yet, under this plan's own
   * rule — the `PtyHarnessDriver` base was pulled out at driver THREE so the
   * shape had three data points to be sure of, and an adopting-driver base
   * drawn from two would be guessing at which parts are general. A THIRD
   * adopting driver is the trigger: extract then, taking the room map and the
   * adopt-vs-rotate decision in `bindRoom` with it. The same note sits on
   * hermes's copy, so whichever file the next author opens says so.
   *
   * What is NOT shared, and would have to survive any extraction: kimi accepts
   * a canonical `kimi-code:<native>` ROOM KEY as an id announcement (hermes has
   * no such path), and what a changed room MEANS differs — hermes switches
   * session inside one process, kimi never does. See `bindRoom` below.
   */
  private readonly roomNative = new Map<string, string>()
  /** The inverse — which room a native id is live in. See `room()`. */
  private readonly nativeRoom = new Map<string, string>()

  constructor(deps: KimiDriverDeps) {
    super(
      {
        harnessId: KIMI_HARNESS_ID,
        rosterCommand: KIMI_ROSTER_COMMAND,
        productName: 'Kimi Code',
      },
      deps,
    )
  }

  /** `kimi-code:<native>` for a native id. @throws `invalid_session_id` */
  static sessionId(nativeId: string): SessionId {
    return formatSessionId(KIMI_HARNESS_ID, nativeId)
  }

  /**
   * Refused, deliberately — see "no pinning" in the file header. A caller that
   * wants a fresh kimi starts one from the den roster; this driver adopts it
   * when its hooks announce the id kimi picked.
   */
  startSession(): Promise<HarnessSessionSummary> {
    return Promise.reject(
      this.unsupported(
        'kimi-code: starting a session through the control plane is not supported — kimi has ' +
          'no flag to pin a new session id (-S/--session and --continue reference existing ' +
          'sessions only), so the control plane cannot name the session it would be creating. ' +
          'Spawn kimi from the den roster; the driver adopts it when its hooks announce an id.',
      ),
    )
  }

  /**
   * Resuming binds the den room key TO the native id (`kimi --session <id>` in
   * a room named `<id>`), which is the one case where kimi's two ids coincide.
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
   * kimi native ids are `session_<uuid>`, not bare uuids, so the base's uuid
   * gate would drop every event. Identity comes from the hook's
   * `harnessSession` field instead; a room we have never bound is not ours.
   *
   * A node still running an older kimi hook (no `harnessSession`) degrades
   * rather than guesses, exactly as hermes does: sessions this driver resumed
   * itself keep streaming because their room key IS the native id, and a
   * drawer-spawned kimi stays invisible until the hook is updated. The one
   * kimi-specific case is a kimi running OUTSIDE den entirely — no
   * `RIVET_DEN_SESSION` to pin a room, so its hook posts under the canonical
   * `kimi-code:session_<uuid>`, which carries the native id in plain sight.
   */
  protected override nativeFor(ev: DenAgentEventLike): string | undefined {
    const room = ev.session
    if (!room) return undefined
    const announced = announcedNative(ev) ?? canonicalRoomNative(room)
    if (announced !== undefined) {
      if (!this.isKimiRoom(room, ev)) return undefined
      this.bindRoom(room, announced)
      return announced
    }
    return this.roomNative.get(room)
  }

  /**
   * `nativeFor` has already established the room is ours (a bound room, or a
   * kimi-stamped event), so the base's second check would only re-derive it.
   */
  protected override ownsEvent(): boolean {
    return true
  }

  // -- internals -------------------------------------------------------------

  /** Is this den room kimi's? den rooms also carry the other three and shells. */
  private isKimiRoom(room: string, ev: DenAgentEventLike): boolean {
    if (this.roomNative.has(room)) return true
    // kimi-den-hook.mjs stamps `harness: 'kimi-code'` on everything it posts;
    // the term manager's synthetic session.start for a roster spawn stamps
    // `rivetos` + `<host>:kimi`.
    if (ev.harness === KIMI_HARNESS_ID) return true
    return (
      ev.harness === 'rivetos' &&
      typeof ev.name === 'string' &&
      ev.name.endsWith(`:${KIMI_ROSTER_COMMAND}`)
    )
  }

  /**
   * Point a den room at the kimi session running in it. First sighting is an
   * adoption (announce it and start tracking); a room that changes its session
   * id is a ROTATION.
   *
   * Worth being precise about what that second case IS for kimi, because it is
   * narrower than hermes's. Hermes switches session inside one process (`/new`,
   * `/branch`, a mid-chat `/resume`, a rewind, a forking compaction) and fires
   * a hook for it. Kimi does none of that: its `/clear` and its compaction are
   * context operations on the running session id, and a resume replays the same
   * id — a kimi process is one session for its whole life. So the only way a
   * kimi room changes session is that the ROOM was re-spawned into a different
   * kimi (a reaped PTY restarted from the drawer, an operator re-running the
   * roster entry). The room is the conversation every attached client is
   * watching, so that still means "the native id behind this session id has
   * been replaced", which is exactly what `previousSessionId` says — and it
   * still wants an alias, a moved tail and a retired predecessor, which is
   * exactly what the control plane does with it.
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

/**
 * A kimi running outside den posts under its own canonical id as the room key
 * (`kimi-code:session_<uuid>`), because there is no `RIVET_DEN_SESSION` to pin
 * one. Recover the native id from that shape — and only that shape, so a room
 * key that merely contains a colon is not mistaken for one.
 */
function canonicalRoomNative(room: string): string | undefined {
  const prefix = `${KIMI_HARNESS_ID}:`
  if (!room.startsWith(prefix)) return undefined
  const native = room.slice(prefix.length)
  return native.startsWith('session_') ? native : undefined
}
