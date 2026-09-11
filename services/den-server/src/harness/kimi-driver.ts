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
 * means "this room moved on", never "kimi renamed itself", and this class's
 * doc comment is where that distinction is written down.
 *
 * **Live deltas come from `wire.jsonl`, not the Stop hook.** kimi's `Stop`
 * hook payload is `{ stop_hook_active }` — no reply text — and no kimi hook
 * is given thinking text at all, so the den translator still emits neither
 * `message.agent` nor `thinking.delta`. The base would map those the moment
 * they appeared; until then this driver tails the same `agents/main/wire.jsonl`
 * the transcript reader already watches (`onTranscriptFrame` →
 * `kimiDeltasFromTurns`) and emits `assistant-delta` / `reasoning-delta` as
 * new `content.part` text/think lands. Inventing a spinner would still be a
 * lie. `liveStream` is true when the tap **or** the transcript watcher is
 * wired — session lifecycle, tools, turn boundaries, and now the in-flight
 * reply.
 *
 * **Honest capabilities.** `approvals` is true when a PTY is available and
 * herdr is the mux (approval-panel keys, mapping unverified). Under tmux it
 * stays false (501). `interrupt` / `resume` / `liveStream` are true only when
 * the machinery behind them is wired on this node. Esc is kimi's documented
 * interrupt key ("Close dialogs / interrupt streaming" in its own keybinding
 * help), so the base's Esc inject applies
 * unchanged, and its TUI parses bracketed paste (DEC 2004), which is what the
 * term manager wraps an injected turn in.
 *
 * See docs/ARCHITECTURE.md.
 */

import {
  formatSessionId,
  type HarnessTranscriptTurn,
  type SessionId,
  type TranscriptWsFrame,
} from '@rivetos/types'
import { AdoptingPtyHarnessDriver } from './adopting-harness-driver.js'
import { kimiDeltasFromTurns } from './adapters/kimi.js'
import {
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
 * The adopting shape (room ↔ native map, adopt-vs-rotate in `bindRoom`,
 * refused `startSession`) is the shared `AdoptingPtyHarnessDriver` — extracted
 * when the adopting-driver base was extracted (rule of three), exactly as the
 * EXTRACTION POINT notes that used to sit here and on hermes's copy prescribed.
 *
 * What that extraction deliberately did NOT take, because it is kimi's own:
 *
 *   - kimi accepts a canonical `kimi-code:<native>` ROOM KEY as an id
 *     announcement (`canonicalRoomNative` below — hermes has no such path).
 *   - What a changed room MEANS differs from hermes, and it is worth being
 *     precise about what that case IS for kimi, because it is narrower.
 *     Hermes switches session inside one process (`/new`, `/branch`, a
 *     mid-chat `/resume`, a rewind, a forking compaction) and fires a hook
 *     for it. Kimi does none of that: its `/clear` and its compaction are
 *     context operations on the running session id, and a resume replays the
 *     same id — a kimi process is one session for its whole life. So the only
 *     way a kimi room changes session is that the ROOM was re-spawned into a
 *     different kimi (a reaped PTY restarted from the drawer, an operator
 *     re-running the roster entry). The room is the conversation every
 *     attached client is watching, so that still means "the native id behind
 *     this session id has been replaced", which is exactly what
 *     `previousSessionId` says — and it still wants an alias, a moved tail
 *     and a retired predecessor, which is exactly what the control plane does
 *     with it.
 */
export class KimiCodeDriver extends AdoptingPtyHarnessDriver<KimiStoreHost> {
  /**
   * Per-native previous parse used only for live deltas. Not copied on
   * rotation — `state.turns` is, and comparing a successor snapshot against
   * a predecessor history would replay it as live text.
   */
  private readonly deltaBaseline = new Map<string, readonly HarnessTranscriptTurn[]>()

  constructor(deps: KimiDriverDeps) {
    super(
      {
        harnessId: KIMI_HARNESS_ID,
        rosterCommand: KIMI_ROSTER_COMMAND,
        productName: 'Kimi Code',
        // The verbatim refusal — see "no pinning" in the file header.
        noPinReason:
          'kimi-code: starting a session through the control plane is not supported — kimi has ' +
          'no flag to pin a new session id (-S/--session and --continue reference existing ' +
          'sessions only), so the control plane cannot name the session it would be creating. ' +
          'Spawn kimi from the den roster; the driver adopts it when its hooks announce an id.',
      },
      deps,
    )
  }

  /** `kimi-code:<native>` for a native id. @throws `invalid_session_id` */
  static sessionId(nativeId: string): SessionId {
    return formatSessionId(KIMI_HARNESS_ID, nativeId)
  }

  // -- divergent hooks ---------------------------------------------------------

  /**
   * kimi's OWN session id off a den event, or undefined when the hook did not
   * report one. Shape-checked rather than trusted: the field is a wire value.
   */
  protected override announcedNative(ev: DenAgentEventLike): string | undefined {
    const raw = ev.harnessSession
    if (typeof raw !== 'string') return undefined
    const trimmed = raw.trim()
    // `unknown-<hex>` is the translator's cached fallback id for a kimi that sent
    // no session_id at all — a room key, never a store id, and resuming one would
    // ask the CLI for a session that does not exist.
    if (!trimmed || !trimmed.startsWith('session_')) return undefined
    return trimmed
  }

  /**
   * A kimi running outside den posts under its own canonical id as the room
   * key (`kimi-code:session_<uuid>`), because there is no `RIVET_DEN_SESSION`
   * to pin one. Recover the native id from that shape — and only that shape,
   * so a room key that merely contains a colon is not mistaken for one.
   *
   * (This is one of the two places kimi genuinely diverges from hermes, which
   * has no outside-den canonical-room path and keeps the base's default.)
   */
  protected override canonicalRoomNative(room: string): string | undefined {
    const prefix = `${KIMI_HARNESS_ID}:`
    if (!room.startsWith(prefix)) return undefined
    const native = room.slice(prefix.length)
    return native.startsWith('session_') ? native : undefined
  }

  /**
   * The transcript watcher already tails `agents/main/wire.jsonl` at the
   * harness-store cadence. Diff against the previous parse and emit live
   * deltas *before* the base frame (which may emit turn-complete) — kimi's
   * Stop hook never will.
   */
  protected override onTranscriptFrame(native: string, f: TranscriptWsFrame): void {
    const next = this.nextTurnsFromFrame(native, f)
    if (next) {
      const prev = this.deltaBaseline.get(native)
      const sessionId = this.sid(native)
      for (const d of kimiDeltasFromTurns(prev, next)) {
        if (d.kind === 'reasoning') {
          this.emit(native, { type: 'reasoning-delta', sessionId, text: d.text })
        } else {
          this.emit(native, { type: 'assistant-delta', sessionId, text: d.text })
        }
      }
      this.deltaBaseline.set(native, next)
    }
    super.onTranscriptFrame(native, f)
  }

  /**
   * Reconstruct the full turn list the base will store, without waiting for
   * `super` (which also emits completion edges).
   */
  private nextTurnsFromFrame(
    native: string,
    f: TranscriptWsFrame,
  ): HarnessTranscriptTurn[] | undefined {
    if (f.from === 0) return f.turns.slice()
    const cur = this.live.get(native)?.turns
    if (cur === undefined) return undefined
    return [...cur.slice(0, f.from), ...f.turns]
  }

  protected override rotate(previous: string, next: string): void {
    this.deltaBaseline.delete(previous)
    this.deltaBaseline.delete(next)
    super.rotate(previous, next)
  }

  override close(): void {
    this.deltaBaseline.clear()
    super.close()
  }
}
