/**
 * `PtyHarnessDriver` — the shared half of every HarnessDriver that drives a
 * TUI harness through the den term manager and watches it through den's
 * AgentEvent stream.
 *
 * This is the rule-of-three extraction the `grok-build` slice deferred
 * ("extracting a common base is the right move at driver three … when there is
 * a third data point to shape it"). `hermes` is that third driver, and the three of
 * them wrap exactly the same machinery:
 *
 *   | Contract method | Machinery                                            |
 *   |-----------------|------------------------------------------------------|
 *   | listSessions    | the harness's on-disk store, filtered to its roster key |
 *   | getSession      | a single-store lookup, or the live map for a fresh spawn |
 *   | startSession    | term manager `spawn(..., session)`                   |
 *   | resumeSession   | term manager spawn-or-get → `--resume`               |
 *   | sendUserTurn    | term manager `inject(pty, text, submit)`             |
 *   | interrupt       | term manager `inject(pty, '', false, interrupt)` (Esc) |
 *   | subscribe       | den AgentEvent ingest tap (the harness's den hooks)  |
 *   | transcript      | a store-scoped transcript reader                     |
 *
 * so the state machine over that machinery — the live map, the in-flight turn
 * lock and its quiet-window failsafe, LIFO tool pairing, status de-duping,
 * `session-created` announcement, sink fanout — is written once here. What a
 * subclass supplies is its identity (`harnessId` + roster key), its store
 * ports, and the handful of places its harness genuinely differs:
 *
 *   - **`nativeFor`** — which native session id a den event belongs to.
 *     Claude and grok pin the harness's native id to the den room key, so the
 *     room key IS the native id; the harnesses that cannot pin (no
 *     `--session-id` flag) share the room → native mapping in
 *     `AdoptingPtyHarnessDriver` (`adopting-harness-driver.ts`).
 *   - **`room`** — the inverse: which den room a native id is running in.
 *   - **`storeExists`** — grok's ground truth is a session DIR that predates
 *     its `summary.json`; claude's is simply "the store can describe it".
 *   - **`assertPinnable`** — claude and grok require a uuid because their
 *     `--session-id` does; a harness with no pinning flag refuses outright.
 *   - **`rotate`** — emitting `session-updated` with `previousSessionId`. Only
 *     the adopting drivers have an observable rotation; the helper lives here
 *     because the bookkeeping (carry the live state, retire the old key
 *     locally) is contract-level rather than harness-level. Note what it
 *     deliberately does NOT do: re-key subscriber sinks. That is control-plane
 *     work (`registry.ts` → `rekey`), and a driver that did it too would leave
 *     every tail attached twice.
 *
 * Everything else is identical across the three, including the honest-capability
 * stance: flags report what is ACTUALLY wired on this node (terminals enabled,
 * den tap present), `approvals` is false because a TUI's permission prompt
 * never reaches the den wire, and roster-owned `cwd`/`model` plus attachments
 * are rejected with `capability_unsupported` rather than silently ignored.
 *
 * **Capabilities are runtime-truthed, not just declared** (`capabilities.ts`) —
 * a config-level answer ("are den terminals enabled") must never stand in for
 * the runtime one ("can this node actually open a PTY").
 * The declaration is still the starting point, because nothing
 * has been asked yet at construction time; from there the flags follow what the
 * machinery says:
 *
 *   - `verifyCapabilities()` resolves the PTY host once and latches the
 *     verdict. The routes call it before advertising, so the sheet a client
 *     reads is true when it is read.
 *   - `requirePty` records what it observes on every real call, so the truth is
 *     also learned lazily, for free, by the first method that needs a PTY.
 *   - A flip after advertisement is announced on `subscribeCapabilities`, which
 *     the registry fans onto the registry stream.
 *
 * The latch is one-way in practice rather than by rule: `loadRealPtySpawn`
 * memoizes one import attempt and returns null forever after, so an unavailable
 * PTY host stays unavailable for the life of the process. The code still lets a
 * later observation move the verdict either way — it reports what it last saw,
 * which is the honest rule, and it means a fake in a test cannot lie by
 * omission.
 *
 * `liveStream` and `listSessions` are NOT probed, deliberately. The den tap is
 * a closure over an in-process Set — `!!deps.events` is not a proxy for
 * anything, it IS the answer — and `listSessions` is a store scan that reports
 * an empty list rather than failing. `approvals` is false unconditionally.
 *
 * See docs/ARCHITECTURE.md.
 */

import { randomUUID } from 'node:crypto'
import {
  HarnessError,
  formatSessionId,
  parseSessionId,
  type HarnessCapabilities,
  type HarnessDriver,
  type HarnessEvent,
  type HarnessStatusFrame,
  type HarnessId,
  type HarnessSessionSummary,
  type HarnessTranscriptTurn,
  type SessionId,
  prefixSystemPrompt,
  type StartSessionOpts,
  type UserTurn,
} from '@rivetos/types'
import type { HarnessSession } from '../term/harness-sessions.js'
import { isBareNativeUuid } from './alias.js'
import {
  capabilityDiff,
  type HarnessCapabilityEvent,
  type HarnessCapabilitySource,
} from './capabilities.js'
import {
  applySheetOverride,
  sheetForHarness,
  type ModelSheet,
  type SheetOverride,
  type SheetReaders,
} from './model-sheets.js'

/** The den AgentEvent shape the tap delivers (structurally den-protocol's). */
export interface DenAgentEventLike {
  session: string
  type: string
  [k: string]: unknown
}

/** The slice of the den term manager these drivers need. */
export interface HarnessPtyHost {
  spawn(
    rosterKey: string | undefined,
    cols: number,
    rows: number,
    remote: string,
    session?: string,
    resume?: string,
  ): { id: string; denSession: string } | Promise<{ id: string; denSession: string }>
  ptyForSession(denSession: string): string | undefined
  inject(id: string, text: string, submit: boolean, interrupt?: boolean): boolean
}

/** The slice of a harness's on-disk store these drivers need. */
export interface HarnessStoreHost {
  list(limit: number): Promise<HarnessSession[]>
  describe(nativeId: string): Promise<HarnessSession | undefined>
  transcript(nativeId: string): Promise<{ turns: HarnessTranscriptTurn[] }>
  /**
   * Does the harness store already hold this id? Ground truth for the
   * collision check and for choosing `--resume`. Optional: when store
   * existence is exactly describability (Claude's single `<uuid>.jsonl`), the
   * base derives it from `describe` instead.
   */
  exists?(nativeId: string): boolean | Promise<boolean>
}

export interface PtyHarnessDriverDeps<S extends HarnessStoreHost = HarnessStoreHost> {
  store: S
  /**
   * Lazily-resolved PTY host. Omit when den terminals are disabled on this
   * node — `interrupt` / `resume` then report `false` and the start/turn paths
   * reject with `capability_unsupported` instead of pretending.
   */
  pty?: () => Promise<HarnessPtyHost | null>
  /** Tap on den AgentEvent ingest. Omit → `liveStream: false`. */
  events?: (sink: (ev: DenAgentEventLike) => void) => () => void
  /**
   * herdr status frames (`applyHerdrStatus`) reach this driver — a live
   * source that does not depend on the den hook tap. Lets `subscribe` work
   * on a hook-dead node whose terminals run under `term.mux: herdr`.
   */
  /** True, or a getter that reads the manager's *resolved* mux (N5). */
  herdrStatus?: boolean | (() => boolean)
  /**
   * cwd the roster spawns this harness in — reported on summaries. A getter,
   * not a value: the term manager re-reads `den-term.json` on every spawn, so
   * a snapshot taken at construction would go stale the moment an operator
   * edits the roster.
   */
  cwd?: () => string | undefined
  /** How many sessions `listSessions` pulls from the store. */
  listLimit?: number
  /**
   * Quiet window after a turn is injected before the driver stops calling it
   * in flight. The den hooks emit `turn.end`; a node whose hooks are not
   * installed would otherwise wedge every later turn on `turn_in_flight`.
   */
  turnQuietMs?: number
  now?: () => number
  log?: (msg: string) => void
  /**
   * Config override for this driver's model/effort sheet
   * (`tasks.harnesses.<id>.models` / `.efforts`). Replaces the sheet lists
   * when present.
   */
  sheetOverride?: SheetOverride
  /** Injectable file readers for grok/kimi sheets (tests). */
  sheetReaders?: SheetReaders
  /** Full sheet factory — tests that want a fake sheet skip the built-in. */
  sheet?: () => ModelSheet
}

/** Per-driver identity, supplied by the subclass's constructor. */
export interface PtyHarnessIdentity {
  harnessId: HarnessId
  /** Roster key the den term manager spawns this harness under. */
  rosterCommand: string
  /** Product name, for the `approvals: false` rejection message. */
  productName: string
}

const DEFAULT_LIST_LIMIT = 100
const DEFAULT_TURN_QUIET_MS = 5 * 60_000
/** Re-read grok/kimi sheets at most this often (`verifyCapabilities` is hot). */
const SHEET_TTL_MS = 60_000
/** Fresh PTYs get a sane default geometry; a real attach resizes immediately. */
const SPAWN_COLS = 120
const SPAWN_ROWS = 40

export interface LiveState {
  status: 'active' | 'idle' | 'ended'
  /** Last status we emitted `session-updated` for — de-dupes the stream. */
  reported?: 'active' | 'idle' | 'ended' | 'error'
  reportedBlocked?: boolean
  turnInFlight: boolean
  quietTimer?: NodeJS.Timeout
  /** Open tool calls, oldest-first — den carries no tool call ids. */
  openTools: { toolCallId: string; name: string }[]
  toolSeq: number
  /** First turn already prefixed the agent system prompt into the PTY. */
  systemPromptApplied?: boolean
  /** herdr screen-manifest status, when a `status` frame has arrived. */
  herdrStatus?: 'working' | 'blocked' | 'idle'
  herdrSince?: number
  /** Debounce a herdr `idle` before ending the turn (N4). */
  herdrIdleTimer?: NodeJS.Timeout
  /** Visible blocker: herdr `blocked` (permission prompt / stuck). */
  blocked?: boolean
}

/**
 * PTY inject payload for a user turn. TUI harnesses have no system-prompt
 * channel, so the first turn that carries `systemPrompt` is prefixed. Later
 * turns (and resumes of a session that already got it) pass `text` through.
 */
export function harnessTurnText(turn: UserTurn, applySystemPrompt: boolean): string {
  if (!applySystemPrompt) return turn.text
  const prompt = typeof turn.systemPrompt === 'string' ? turn.systemPrompt.trim() : ''
  if (!prompt) return turn.text
  return prefixSystemPrompt(prompt, turn.text)
}

/** What a PTY probe last learned. See § capability truthing in the header. */
type PtyVerdict = 'unprobed' | 'available' | 'unavailable'

export abstract class PtyHarnessDriver<S extends HarnessStoreHost = HarnessStoreHost>
  implements HarnessDriver, HarnessCapabilitySource
{
  readonly harnessId: HarnessId

  /** Roster key the den term manager spawns this harness under. */
  protected readonly rosterCommand: string
  protected readonly productName: string
  protected readonly deps: PtyHarnessDriverDeps<S>
  protected readonly now: () => number
  protected readonly log: (msg: string) => void
  protected readonly listLimit: number
  protected readonly turnQuietMs: number

  /** native id → live view (status, in-flight turn, open tool calls). */
  protected readonly live = new Map<string, LiveState>()
  /** herdr status frames are pushed to this driver (see deps.herdrStatus). */
  private readonly sessionSinks = new Map<string, Set<(e: HarnessEvent) => void>>()
  private readonly registrySinks = new Set<(e: HarnessEvent) => void>()
  /** native ids we have already announced as `session-created`. */
  private readonly announced = new Set<string>()
  private detachEvents?: () => void
  /** Flags as DECLARED at construction — the pre-probe starting point. */
  private readonly declared: HarnessCapabilities
  private readonly sheetFn: () => ModelSheet
  private cachedSheet: ModelSheet | undefined
  private sheetCachedAt = Number.NEGATIVE_INFINITY
  /** What the PTY host last told us. See § capability truthing in the header. */
  private ptyVerdict: PtyVerdict = 'unprobed'
  /** Memoized proactive probe — one `deps.pty()` for the life of the driver. */
  private probe?: Promise<HarnessCapabilities>
  private readonly capabilitySinks = new Set<(e: HarnessCapabilityEvent) => void>()

  constructor(identity: PtyHarnessIdentity, deps: PtyHarnessDriverDeps<S>) {
    this.harnessId = identity.harnessId
    this.rosterCommand = identity.rosterCommand
    this.productName = identity.productName
    this.deps = deps
    this.now = deps.now ?? Date.now
    this.log = deps.log ?? ((): void => undefined)
    this.listLimit = deps.listLimit ?? DEFAULT_LIST_LIMIT
    this.turnQuietMs = deps.turnQuietMs ?? DEFAULT_TURN_QUIET_MS
    this.sheetFn =
      deps.sheet ??
      ((): ModelSheet =>
        applySheetOverride(
          sheetForHarness(identity.harnessId, deps.sheetReaders),
          deps.sheetOverride,
          this.log,
        ))
    this.declared = {
      // Config, not yet ground truth: `deps.pty` present means den terminals
      // are ENABLED. Whether a PTY can actually be opened is what
      // `verifyCapabilities`/`requirePty` find out — until one of them has
      // asked, the declaration is the most this driver honestly knows.
      interrupt: !!deps.pty,
      resume: !!deps.pty,
      // Every harness on this path owns its permission prompts inside its own
      // TUI, and nothing on the den wire carries an approval request, let
      // alone a decision channel. Never faked true.
      approvals: false,
      liveStream: !!deps.events,
      listSessions: true,
    }
    this.refreshSheet()
    if (deps.events) this.detachEvents = deps.events((ev) => this.onDenEvent(ev))
  }

  /**
   * Re-read the model/effort sheet at most once per TTL. A changed sheet
   * is merged onto `declared` and announced the same way a PTY flip is.
   */
  private refreshSheet(): void {
    const t = this.now()
    if (this.cachedSheet !== undefined && t - this.sheetCachedAt < SHEET_TTL_MS) return
    const nextSheet = this.sheetFn()
    const previous = this.cachedSheet !== undefined ? this.capabilities : undefined
    this.cachedSheet = nextSheet
    this.sheetCachedAt = t
    this.mergeSheet(nextSheet)
    if (!previous) return
    const next = this.capabilities
    const changed = capabilityDiff(previous, next)
    if (Object.keys(changed).length === 0) return
    this.emitCapabilities(next, changed, `${this.harnessId}: model/effort sheet changed`)
  }

  /** Stamp model/effort fields from the sheet onto the declared flags. */
  private mergeSheet(sheet: ModelSheet): void {
    if (sheet.models) this.declared.models = sheet.models
    else delete this.declared.models
    if (sheet.efforts) this.declared.efforts = sheet.efforts
    else delete this.declared.efforts
    if (sheet.modelFlag) this.declared.modelFlag = sheet.modelFlag
    else delete this.declared.modelFlag
    if (sheet.effortFlag) this.declared.effortFlag = sheet.effortFlag
    else delete this.declared.effortFlag
  }

  // -- capabilities (runtime-truthed) -----------------------------------------

  /**
   * The sheet as of now. A fresh object each read: callers must never be able
   * to mutate a driver's advertised flags, and a cached reference must never
   * silently change under a client that thought it held a snapshot.
   */
  get capabilities(): HarnessCapabilities {
    const pty = this.declared.interrupt && this.ptyVerdict !== 'unavailable'
    return { ...this.declared, interrupt: pty, resume: pty }
  }

  /**
   * Ask the machinery and latch the answer (`HarnessCapabilitySource`). One
   * probe per driver: `deps.pty()` is itself memoized in production
   * (`ensureManager` → `loadRealPtySpawn`), so re-probing would re-read a
   * decided answer, and a probe that has already run costs one microtask.
   *
   * Never throws. A PTY host that rejects is exactly as unavailable as one that
   * resolves null, and the caller asked a question about capabilities, not for
   * a chance to fail.
   */
  verifyCapabilities(): Promise<HarnessCapabilities> {
    this.refreshSheet()
    // Nothing to verify when terminals are disabled: the flags are already
    // false and there is no machinery to ask.
    if (!this.deps.pty) return Promise.resolve(this.capabilities)
    this.probe ??= (async (): Promise<HarnessCapabilities> => {
      const host = await (this.deps.pty?.() ?? Promise.resolve(null)).catch(() => null)
      this.notePty(!!host, 'probe')
      return this.capabilities
    })()
    return this.probe
  }

  subscribeCapabilities(sink: (e: HarnessCapabilityEvent) => void): () => void {
    this.capabilitySinks.add(sink)
    return () => this.capabilitySinks.delete(sink)
  }

  /**
   * Record what a PTY resolution just observed, announcing the flip if it moved
   * an advertised flag. Called by the proactive probe AND by `requirePty`, so
   * the first real method call corrects the sheet even on a node nobody ever
   * asked `GET /api/harnesses`.
   */
  private notePty(available: boolean, source: 'probe' | 'call'): void {
    const verdict: PtyVerdict = available ? 'available' : 'unavailable'
    if (this.ptyVerdict === verdict) return
    const previous = this.capabilities
    this.ptyVerdict = verdict
    const next = this.capabilities
    const changed = capabilityDiff(previous, next)
    if (Object.keys(changed).length === 0) return
    const reason = available
      ? `${this.harnessId}: PTY backend is available (${source})`
      : `${this.harnessId}: PTY backend is unavailable — interrupt/resume answer 501 (${source})`
    this.emitCapabilities(next, changed, reason)
  }

  private emitCapabilities(
    capabilities: HarnessCapabilities,
    changed: Partial<HarnessCapabilities>,
    reason: string,
  ): void {
    this.log(`[den-server] harness: ${reason}`)
    const event: HarnessCapabilityEvent = {
      type: 'harness-capabilities',
      harnessId: this.harnessId,
      capabilities,
      changed,
      reason,
    }
    for (const sink of [...this.capabilitySinks]) {
      try {
        sink(event)
      } catch {
        /* one bad subscriber must never break the others */
      }
    }
  }

  // -- identity --------------------------------------------------------------

  /** `<harness-id>:<native>`. @throws `invalid_session_id` */
  protected sid(nativeId: string): SessionId {
    return formatSessionId(this.harnessId, nativeId)
  }

  /** Canonical id → native id, rejecting ids that belong to another harness. */
  protected native(sessionId: SessionId): string {
    const { harnessId, nativeSessionId } = parseSessionId(sessionId)
    if (harnessId !== this.harnessId) {
      throw new HarnessError(
        'invalid_session_id',
        `${sessionId} is not a ${this.harnessId} session`,
        { harnessId: this.harnessId, sessionId },
      )
    }
    return nativeSessionId
  }

  protected unsupported(message: string, sessionId?: string): HarnessError {
    return new HarnessError('capability_unsupported', message, {
      harnessId: this.harnessId,
      ...(sessionId ? { sessionId } : {}),
    })
  }

  // -- reads -----------------------------------------------------------------

  async listSessions(): Promise<HarnessSessionSummary[]> {
    const rows = await this.deps.store.list(this.listLimit)
    return rows.filter((r) => r.command === this.rosterCommand).map((r) => this.summarize(r))
  }

  async getSession(sessionId: SessionId): Promise<HarnessSessionSummary | null> {
    const native = this.native(sessionId)
    const row = await this.deps.store.describe(native)
    if (row) return this.summarize(row)
    // A just-spawned session has a live PTY before its store entry exists.
    if (this.live.has(native)) return this.liveSummary(native)
    return null
  }

  /**
   * Hard-resync source (generalizes den's
   * `GET /term/harness-sessions/:id/transcript`). Not part of the
   * `HarnessDriver` interface — the gateway feature-detects it.
   *
   * Store-SCOPED by construction: a driver already knows which harness owns
   * the id and must never serve another store's transcript for it.
   */
  async transcript(sessionId: SessionId): Promise<{ turns: HarnessTranscriptTurn[] }> {
    return this.deps.store.transcript(this.native(sessionId))
  }

  // -- lifecycle -------------------------------------------------------------

  async startSession(opts: StartSessionOpts = {}): Promise<HarnessSessionSummary> {
    // cwd/model are roster-owned on this path: the term manager spawns the
    // operator's argv in the roster cwd and takes no per-request override.
    // Rejecting beats silently ignoring the caller's intent.
    if (opts.cwd !== undefined) {
      throw this.unsupported(`${this.harnessId}: cwd is roster-owned (den-term.json)`)
    }
    if (opts.model !== undefined) {
      throw this.unsupported(`${this.harnessId}: model is roster-owned (den-term.json)`)
    }
    const pty = await this.requirePty('startSession')

    const native = opts.nativeSessionId ?? randomUUID()
    this.assertPinnable(native)
    const sessionId = this.sid(native)
    // Never attach: an id already in the harness store is a collision, even if
    // the caller meant to resume (that is `resumeSession`).
    if (await this.storeExists(native)) {
      throw new HarnessError(
        'session_id_collision',
        `${this.harnessId} session ${native} already exists in the harness store`,
        { harnessId: this.harnessId, sessionId },
      )
    }

    await Promise.resolve(
      pty.spawn(this.rosterCommand, SPAWN_COLS, SPAWN_ROWS, 'harness-driver', native),
    )
    this.ensureLive(native).status = 'idle'
    const summary = this.liveSummary(native, 'idle')
    this.announce(native, summary)
    return summary
  }

  async resumeSession(sessionId: SessionId): Promise<HarnessSessionSummary> {
    const native = this.native(sessionId)
    const pty = await this.requirePty('resumeSession')
    const row = await this.deps.store.describe(native)
    // A session the store knows of but cannot describe yet is still resumable
    // — that is exactly the window right after a fresh spawn (grok's session
    // dir before its summary.json; a hermes row before its first message).
    //
    // Deliberate on Claude, where `exists` is DERIVED from `describe` and this
    // reads the store twice: the two are genuinely different questions, the
    // second read only happens on the miss path (`row` undefined, `&&`
    // short-circuits), and it re-asks a moment later, which is the direction
    // that turns a just-lost race into a resume rather than a 400. Not an
    // oversight — please do not "optimize" it into reusing `row`.
    if (!row && !(await this.storeExists(native)) && !this.live.has(native)) {
      throw new HarnessError(
        'invalid_session_id',
        `no ${this.harnessId} session ${native} in the harness store`,
        { harnessId: this.harnessId, sessionId },
      )
    }
    // spawn-or-get: a live PTY for this session is returned as-is; otherwise
    // the term manager re-spawns with `--resume <native>` (store existence is
    // its ground truth, so passing `resume` is belt-and-braces).
    await this.spawnFor(pty, native, true)
    return row ? this.summarize(row, this.statusFor(native)) : this.liveSummary(native)
  }

  async sendUserTurn(sessionId: SessionId, turn: UserTurn): Promise<void> {
    const native = this.native(sessionId)
    if (turn.attachments?.length) {
      // `POST /api/uploads` hands clients a node-local path, so `pathOrUri` is
      // resolvable — but this driver still cannot use one. Its only channel
      // into the harness is a PTY paste, which carries text; there is no wire
      // for "here is a file" into a TUI, and pasting the path as prose would
      // be a different thing wearing the contract's name. A driver that speaks
      // a real protocol (SDK / ACP) consumes the staged URI directly.
      throw this.unsupported(`${this.harnessId}: attachments are not supported in v1`, sessionId)
    }
    const pty = await this.requirePty('sendUserTurn')
    // CLAIM the in-flight lock synchronously, in the same tick as the check,
    // and hold it across every await below. Two concurrent turns must not both
    // pass the check and both paste into the TUI — the loser gets the retryable
    // 409 (§ Contract semantics: "drivers MUST NOT silently queue in v1").
    // Checking here and setting it after the inject would leave a window at
    // every `await` in between: resolving the PTY host, probing the store.
    // `pty-harness-driver.test.ts` pins this for all three drivers.
    const state = this.ensureLive(native)
    if (state.turnInFlight) {
      throw new HarnessError('turn_in_flight', `${this.harnessId} ${native} is mid-turn`, {
        harnessId: this.harnessId,
        sessionId,
      })
    }
    state.turnInFlight = true
    try {
      const applySystemPrompt = !state.systemPromptApplied
      const injected = harnessTurnText(turn, applySystemPrompt)
      let ptyId = await this.ensurePty(pty, native)
      if (!pty.inject(ptyId, injected, true)) {
        // The term manager keeps its session→pty mapping until the EXITED
        // record is reaped (exitLingerMs), so a harness that just died still
        // resolves to a pty that refuses writes. Answering
        // `capability_unsupported` there would tell the client "this node
        // cannot do turns" — false, and a 501 is not retryable. Re-spawn
        // through the same `--resume` path a fully-reaped session takes and try
        // once more.
        ptyId = await this.spawnFor(pty, native, true)
        if (!pty.inject(ptyId, injected, true)) {
          // A live-but-unwritable harness means its pre-ready inject buffer is
          // full — genuinely transient, so say so instead of 501.
          throw new HarnessError(
            'turn_in_flight',
            `${this.harnessId} ${native} is not accepting input yet`,
            { harnessId: this.harnessId, sessionId },
          )
        }
      }
      if (applySystemPrompt && injected !== turn.text) state.systemPromptApplied = true
    } catch (err) {
      // Nothing was accepted, so the claim has to go back — otherwise one
      // failed turn wedges the session on 409 until the quiet window expires.
      state.turnInFlight = false
      throw err
    }
    // Announce it: `beginTurn` re-sets the flag (already ours), arms the
    // quiet-window failsafe and moves the session to `active`.
    this.beginTurn(native)
  }

  async interrupt(sessionId: SessionId): Promise<void> {
    const native = this.native(sessionId)
    const pty = await this.requirePty('interrupt')
    const ptyId = pty.ptyForSession(this.room(native))
    // Idempotent: with no live harness there is no turn to cancel. Spawning
    // one just to Esc it would be worse than a no-op.
    if (!ptyId) return
    // Deliberately unchecked, unlike sendUserTurn: interrupt is best-effort
    // "ensure no turn is running". A false here means the pty is dead or
    // unwritable — in which case nothing is running.
    pty.inject(ptyId, '', false, true)
    // Release the lock here rather than waiting for a den `turn.end`, which may
    // or may not follow a cancel. Clearing early is the safe direction: a later
    // real `turn.end` is a no-op, whereas waiting for one that never comes
    // would 409 every later turn.
    if (this.live.get(native)?.turnInFlight) this.endTurn(native, 'interrupted')
  }

  resolveApproval(): Promise<void> {
    return Promise.reject(
      this.unsupported(
        `${this.harnessId}: approvals are handled inside the ${this.productName} TUI and are ` +
          'not observable on the den wire',
      ),
    )
  }

  // -- streams ---------------------------------------------------------------

  /**
   * The sink is pinned to the native id it was registered under, and that is
   * correct for a driver: **rotation is control-plane work.** The registry's
   * `subscribeSession` wraps this call and re-keys the sink onto the canonical
   * id when it records an alias, so the client's subscription survives a
   * rotation without the driver ever consulting the alias store
   * (`registry.ts` → `rekey`; § Contract semantics, "Subscriptions survive
   * rotation"). A rotating driver needs nothing here beyond emitting
   * `session-updated` with `previousSessionId` — see `rotate`.
   */
  subscribe(sessionId: SessionId, sink: (e: HarnessEvent) => void): () => void {
    if (!this.capabilities.liveStream && !this.herdrStatusOn()) {
      throw this.unsupported(`${this.harnessId}: no den event tap on this node`, sessionId)
    }
    const native = this.native(sessionId)
    let set = this.sessionSinks.get(native)
    if (!set) {
      set = new Set()
      this.sessionSinks.set(native, set)
    }
    set.add(sink)
    return () => {
      const current = this.sessionSinks.get(native)
      if (!current) return
      current.delete(sink)
      if (current.size === 0) this.sessionSinks.delete(native)
    }
  }

  subscribeEvents(sink: (e: HarnessEvent) => void): () => void {
    this.registrySinks.add(sink)
    return () => this.registrySinks.delete(sink)
  }

  /** Detach the den tap and drop every subscriber (server shutdown). */
  close(): void {
    for (const state of this.live.values()) {
      if (state.quietTimer) clearTimeout(state.quietTimer)
      if (state.herdrIdleTimer) clearTimeout(state.herdrIdleTimer)
    }
    this.live.clear()
    this.sessionSinks.clear()
    this.registrySinks.clear()
    this.capabilitySinks.clear()
    this.detachEvents?.()
    this.detachEvents = undefined
  }

  // -- subclass hooks --------------------------------------------------------

  /**
   * Which native session id a den event belongs to, or `undefined` to ignore
   * it. The default is the pinning harnesses' answer: the den room key IS the
   * native id, and a non-uuid room (the translator's `unknown-<ppid>`
   * fallback, a shell pty) is not a harness session at all.
   */
  protected nativeFor(ev: DenAgentEventLike): string | undefined {
    return isBareNativeUuid(ev.session) ? ev.session : undefined
  }

  /**
   * Which den room a native id runs in. Identity for the pinning harnesses;
   * `AdoptingPtyHarnessDriver` maps it through its room ↔ native map.
   */
  protected room(native: string): string {
    return native
  }

  /**
   * Is this den event one of ours? den rooms also carry the other harnesses
   * and plain shells, and a uuid alone proves nothing when two harnesses both
   * pin uuid keys.
   */
  protected ownsEvent(native: string, ev: DenAgentEventLike): boolean {
    if (this.live.has(native)) return true
    // The shared den-hook translator stamps the harness id on everything it
    // posts; the term manager's synthetic `session.start` for a roster spawn
    // stamps `rivetos` + `<host>:<roster-key>` instead.
    if (ev.harness === this.harnessId) return true
    return (
      ev.harness === 'rivetos' &&
      typeof ev.name === 'string' &&
      ev.name.endsWith(`:${this.rosterCommand}`)
    )
  }

  /**
   * Guard a caller-pinned `startSession` id. Both pinning harnesses require a
   * uuid because their `--session-id` flag does, and the den join key is the
   * same string, so a non-uuid pin cannot be honored end to end.
   *
   * @throws HarnessError `invalid_session_id` | `capability_unsupported`
   */
  protected assertPinnable(native: string): void {
    if (isBareNativeUuid(native)) return
    throw new HarnessError(
      'invalid_session_id',
      `${this.harnessId} native session ids must be uuids: ${native}`,
      { harnessId: this.harnessId, sessionId: native },
    )
  }

  /** Does the harness store already hold this id? See `HarnessStoreHost`. */
  protected async storeExists(native: string): Promise<boolean> {
    const store = this.deps.store
    if (typeof store.exists === 'function') return store.exists(native)
    return !!(await store.describe(native))
  }

  // -- internals -------------------------------------------------------------

  /** Roster cwd at call time — see `PtyHarnessDriverDeps.cwd`. */
  protected cwd(): string | undefined {
    return this.deps.cwd?.()
  }

  /**
   * Summary for a session that exists only as a live PTY (no store row yet).
   *
   * `cwd` is omitted when the roster has none, where the pre-extraction drivers
   * set it to `undefined` on this path (their `summarize` already guarded it).
   * The wire is identical — `JSON.stringify` drops an undefined value either
   * way — and this makes the two summary paths agree with each other.
   */
  protected liveSummary(
    native: string,
    statusOverride?: HarnessSessionSummary['status'],
  ): HarnessSessionSummary {
    const stamp = new Date(this.now()).toISOString()
    const summary: HarnessSessionSummary = {
      sessionId: this.sid(native),
      harnessId: this.harnessId,
      createdAt: stamp,
      updatedAt: stamp,
      status: statusOverride ?? this.statusFor(native),
    }
    const cwd = this.cwd()
    if (cwd) summary.cwd = cwd
    if (this.live.get(native)?.blocked) summary.blocked = true
    return summary
  }

  protected summarize(
    row: HarnessSession,
    statusOverride?: HarnessSessionSummary['status'],
  ): HarnessSessionSummary {
    const summary: HarnessSessionSummary = {
      sessionId: this.sid(row.id),
      harnessId: this.harnessId,
      // A store that carries a creation stamp uses it; one that does not falls
      // back to updatedAt, so a list row and a `getSession` cannot disagree.
      createdAt: new Date(row.createdAt ?? row.updatedAt).toISOString(),
      updatedAt: new Date(row.updatedAt || this.now()).toISOString(),
      status: statusOverride ?? this.statusFor(row.id),
    }
    if (row.title && row.title !== row.id) summary.title = row.title
    const cwd = this.cwd()
    if (cwd) summary.cwd = cwd
    if (row.model) summary.model = row.model
    if (this.live.get(row.id)?.blocked) summary.blocked = true
    return summary
  }

  /**
   * Status is reported from what we can actually observe: a live PTY mid-turn
   * is `active`, a live PTY between turns is `idle`, and a session that exists
   * only on disk is `ended` — the process is gone, though `resumeSession`
   * revives it.
   *
   * KNOWN GAP: liveness comes from this driver's own map, fed by
   * `startSession`/`resumeSession` and by den events. A harness process started
   * outside den entirely (no `RIVET_DEN_SESSION`, no den hooks) reads as
   * `ended` until it speaks.
   */
  protected statusFor(native: string): HarnessSessionSummary['status'] {
    const state = this.live.get(native)
    if (!state) return 'ended'
    if (state.status === 'ended') return 'ended'
    // Prefer herdr's screen-manifest over the activity clock when present
    // and fresh (ignore when older than turnQuietMs — N3).
    const herdrFresh =
      state.herdrStatus !== undefined &&
      (this.turnQuietMs <= 0 ||
        (state.herdrSince !== undefined && this.now() - state.herdrSince <= this.turnQuietMs))
    if (herdrFresh) {
      if (state.herdrStatus === 'working' || state.herdrStatus === 'blocked') return 'active'
      if (state.herdrStatus === 'idle') return 'idle'
    }
    return state.turnInFlight ? 'active' : 'idle'
  }

  protected herdrStatusOn(): boolean {
    const v = this.deps.herdrStatus
    return typeof v === 'function' ? v() : !!v
  }

  protected ensureLive(native: string): LiveState {
    let state = this.live.get(native)
    if (!state) {
      state = { status: 'idle', turnInFlight: false, openTools: [], toolSeq: 0 }
      this.live.set(native, state)
    }
    return state
  }

  /**
   * Resolve the PTY host, or reject with `capability_unsupported`.
   *
   * Doubles as the LAZY half of capability truthing: whatever this call
   * observes is recorded, so the sheet corrects itself on the first real method
   * that needs a PTY even if nobody ever read `GET /api/harnesses`. A node that
   * never calls a PTY method never pays for the probe, and never advertises a
   * flag anyone could have acted on.
   */
  protected async requirePty(method: string): Promise<HarnessPtyHost> {
    if (!this.deps.pty) {
      throw this.unsupported(`${this.harnessId}: ${method} needs den terminals, which are disabled`)
    }
    let pty: HarnessPtyHost | null
    try {
      pty = await this.deps.pty()
    } catch (err) {
      this.notePty(false, 'call')
      throw this.unsupported(
        `${this.harnessId}: ${method} needs a PTY backend, which failed to load ` +
          `(${err instanceof Error ? err.message : String(err)})`,
      )
    }
    this.notePty(!!pty, 'call')
    if (!pty) {
      throw this.unsupported(
        `${this.harnessId}: ${method} needs a PTY backend, which is unavailable`,
      )
    }
    return pty
  }

  /** Live PTY for a session, re-spawning (`--resume`) after an LRU eviction. */
  protected async ensurePty(pty: HarnessPtyHost, native: string): Promise<string> {
    const existing = pty.ptyForSession(this.room(native))
    if (existing) return existing
    return this.spawnFor(pty, native, await this.storeExists(native))
  }

  /**
   * Spawn (or spawn-or-get) the harness for a session. `resume` is passed when
   * the session already exists in the store; the term manager checks store
   * existence itself, so this is belt-and-braces. A spawn-or-get against a
   * still-lingering EXITED record produces a fresh pty, which is what the
   * dead-pty retry in `sendUserTurn` wants.
   */
  protected async spawnFor(pty: HarnessPtyHost, native: string, resume: boolean): Promise<string> {
    const spawned = await Promise.resolve(
      pty.spawn(
        this.rosterCommand,
        SPAWN_COLS,
        SPAWN_ROWS,
        'harness-driver',
        this.room(native),
        resume ? native : undefined,
      ),
    )
    this.ensureLive(native)
    return spawned.id
  }

  protected emit(native: string, event: HarnessEvent): void {
    for (const sink of [...(this.sessionSinks.get(native) ?? [])]) {
      try {
        sink(event)
      } catch {
        /* one bad subscriber must never break the others */
      }
    }
  }

  protected emitRegistry(event: HarnessEvent): void {
    for (const sink of [...this.registrySinks]) {
      try {
        sink(event)
      } catch {
        /* as above */
      }
    }
  }

  protected announce(native: string, summary: HarnessSessionSummary): void {
    if (this.announced.has(native)) return
    this.announced.add(native)
    this.emitRegistry({ type: 'session-created', sessionId: summary.sessionId, summary })
  }

  /**
   * Announce a session we have just learned about from the den stream. Reads
   * the store for a real summary and drops the announcement if the read fails
   * — a `session-created` is worth nothing without one.
   */
  protected announceIfNew(native: string): void {
    if (this.announced.has(native)) return
    void this.getSession(this.sid(native)).then(
      (summary) => {
        if (summary) this.announce(native, summary)
      },
      () => undefined,
    )
  }

  protected setStatus(native: string, status: 'active' | 'idle' | 'ended' | 'error'): void {
    const state = this.ensureLive(native)
    if (status !== 'error') state.status = status
    const blocked = status === 'active' && Boolean(state.blocked)
    if (state.reported === status && Boolean(state.reportedBlocked) === blocked) return
    state.reported = status
    state.reportedBlocked = blocked
    const event: HarnessEvent = { type: 'session-updated', sessionId: this.sid(native), status }
    if (blocked) event.blocked = true
    this.emit(native, event)
    this.emitRegistry(event)
  }

  /**
   * Apply a herdr `status` frame. `working`/`idle` replace the activity clock
   * for active↔idle; `blocked` stays `active` and surfaces `blocked: true`
   * so a permission prompt is not a silent no-op.
   *
   * `nativeOrRoom` is the harness native id, or the den room key (claude/grok
   * pin them equal; adopting drivers look up by room).
   */
  applyHerdrStatus(nativeOrRoom: string, frame: HarnessStatusFrame): void {
    let native = nativeOrRoom
    if (!this.live.has(native)) {
      for (const [k] of this.live) {
        if (this.room(k) === nativeOrRoom) {
          native = k
          break
        }
      }
    }
    const known = this.live.has(native)
    if (process.env.RIVETOS_HERDR_DEBUG === '1') {
      console.error(
        `[herdr] apply ${this.harnessId} room=${nativeOrRoom} native=${native} known=${String(known)} status=${frame.status}`,
      )
    }
    const statusEvent: HarnessEvent = {
      type: 'status',
      sessionId: this.sid(native),
      status: frame.status,
      since: frame.since,
    }
    if (!known) {
      // N2: do not mint a ghost LiveState for a room this driver has not
      // adopted. Still surface the frame on the registry so a POST /term PTY
      // that is not yet a harness session (hook-dead node) is visible.
      this.emitRegistry(statusEvent)
      return
    }
    const state = this.live.get(native)!
    if (state.herdrIdleTimer) {
      clearTimeout(state.herdrIdleTimer)
      state.herdrIdleTimer = undefined
    }
    state.herdrStatus = frame.status
    state.herdrSince = frame.since
    if (frame.status === 'working') {
      state.blocked = false
      state.turnInFlight = true
      this.armQuietWindow(native)
      this.setStatus(native, 'active')
    } else if (frame.status === 'blocked') {
      state.blocked = true
      state.turnInFlight = true
      this.setStatus(native, 'active')
    } else {
      state.blocked = false
      // N4: one flicker of idle must not end a live turn. Debounce unless
      // the quiet window is disabled (tests / operator 0).
      const idleWait = this.turnQuietMs <= 0 ? 0 : Math.min(750, this.turnQuietMs)
      const endIdle = (): void => {
        if (state.herdrStatus !== 'idle') return
        if (state.turnInFlight) this.endTurn(native, 'herdr-idle')
        else this.setStatus(native, 'idle')
      }
      if (idleWait <= 0) endIdle()
      else {
        state.herdrIdleTimer = setTimeout(() => {
          state.herdrIdleTimer = undefined
          endIdle()
        }, idleWait)
        state.herdrIdleTimer.unref?.()
      }
    }
    this.emit(native, statusEvent)
    this.emitRegistry(statusEvent)
  }

  /**
   * Announce that the harness replaced `previous`'s native id with `next`
   * (§ Native session id rotation). The driver's whole job is this one event:
   * the control plane records the alias, moves every live tail, retires the
   * old id and keeps `listSessions` canonical-only.
   *
   * The live state moves with the id — an in-flight turn that spans a
   * compaction still completes — and the old key is dropped from this driver's
   * map. Sinks are deliberately NOT moved: `registry.rekey` owns that, and a
   * driver that re-keyed its own would leave every tail attached twice and
   * double every later event.
   */
  protected rotate(previous: string, next: string): void {
    if (previous === next) return
    // The rotation IS the successor's announcement: a client that also got a
    // `session-created` for it would show the same session twice, once under
    // each id, which is the opposite of what an alias is for.
    this.announced.add(next)
    const carried = this.live.get(previous)
    const state = this.ensureLive(next)
    if (carried) {
      state.status = carried.status === 'ended' ? 'idle' : carried.status
      state.turnInFlight = carried.turnInFlight
      state.openTools = carried.openTools
      state.toolSeq = carried.toolSeq
      state.systemPromptApplied = carried.systemPromptApplied
      if (carried.quietTimer) {
        clearTimeout(carried.quietTimer)
        carried.quietTimer = undefined
      }
      if (state.turnInFlight) this.armQuietWindow(next)
      this.live.delete(previous)
    }
    const status = this.statusFor(next)
    // The rotation event is also the successor's first status report, so record
    // it as reported: an immediate follow-up `setStatus` with the same value
    // (the den event that CARRIED the rotation usually reports one) de-dupes
    // into silence instead of restating it.
    state.reported = status
    const event: HarnessEvent = {
      type: 'session-updated',
      sessionId: this.sid(next),
      previousSessionId: this.sid(previous),
      status,
    }
    // To the tails still attached under the OLD id first (the registry
    // de-dupes its own copy against this one), then to the registry stream,
    // which is what records the alias and moves those tails.
    this.emit(previous, event)
    this.emitRegistry(event)
  }

  protected beginTurn(native: string): void {
    const state = this.ensureLive(native)
    state.turnInFlight = true
    this.armQuietWindow(native)
    this.setStatus(native, 'active')
  }

  /**
   * Complete the current turn. `always` is set for a real `turn.end` from the
   * harness: a turn typed straight into the TUI (no `sendUserTurn`) still ends,
   * and subscribers must see it. Teardown paths (interrupt, session exit, the
   * quiet-window failsafe) only report a turn they know was running.
   */
  protected endTurn(native: string, stopReason: string, always = false): void {
    const state = this.live.get(native)
    if (!state) return
    if (state.quietTimer) {
      clearTimeout(state.quietTimer)
      state.quietTimer = undefined
    }
    if (!state.turnInFlight && !always) return
    state.turnInFlight = false
    state.herdrStatus = undefined
    state.herdrSince = undefined
    if (state.herdrIdleTimer) {
      clearTimeout(state.herdrIdleTimer)
      state.herdrIdleTimer = undefined
    }
    this.emit(native, { type: 'turn-complete', sessionId: this.sid(native), stopReason })
    this.setStatus(native, 'idle')
  }

  /**
   * Failsafe for nodes whose den hooks are not installed: without a `turn.end`
   * the in-flight flag would never clear and every later `sendUserTurn` would
   * 409. Re-armed on any den event for the session, so a genuinely long turn is
   * never cut short.
   */
  protected armQuietWindow(native: string): void {
    const state = this.ensureLive(native)
    if (state.quietTimer) clearTimeout(state.quietTimer)
    if (this.turnQuietMs <= 0) return
    state.quietTimer = setTimeout(() => {
      state.quietTimer = undefined
      if (!state.turnInFlight) return
      this.log(
        `[den-server] harness: no den events for ${this.harnessId}:${native} in ` +
          `${String(this.turnQuietMs)}ms — releasing the in-flight turn lock`,
      )
      this.endTurn(native, 'quiet-timeout')
    }, this.turnQuietMs)
    state.quietTimer.unref()
  }

  /**
   * Map one den AgentEvent onto the harness contract.
   *
   * Den event types the hooks produce that are NOT mapped here —
   * `message.user`, `speech.stt`, `thinking.end`, `activity`, `task.plan`,
   * `task.check`, `term.line` — are den-UI concerns with no place on the
   * contract's event union.
   */
  protected onDenEvent(ev: DenAgentEventLike): void {
    const native = this.nativeFor(ev)
    if (native === undefined) return
    if (!this.ownsEvent(native, ev)) return
    const state = this.ensureLive(native)
    if (state.turnInFlight) this.armQuietWindow(native)
    const sessionId = this.sid(native)

    switch (ev.type) {
      case 'session.start': {
        this.announceIfNew(native)
        // Report what is TRUE, not a hardcoded `idle`. On the rotation path
        // this very event is the one that carried a rotation (hermes's
        // `on_session_reset`), and a compaction can fork mid-turn: the in-flight
        // turn moved to this id a few lines ago, so forcing `idle` here would
        // tell every stream client the session went quiet while it is still
        // answering — on exactly the path rotation exists for. A session.start
        // does still REVIVE an ended session; that is the one thing it settles.
        if (state.status === 'ended') state.status = 'idle'
        this.setStatus(native, this.statusFor(native))
        return
      }
      case 'session.end': {
        this.endTurn(native, 'error')
        this.setStatus(native, 'ended')
        return
      }
      case 'message.agent': {
        const text = typeof ev.text === 'string' ? ev.text : ''
        if (text) this.emit(native, { type: 'assistant-delta', sessionId, text })
        return
      }
      case 'thinking.delta': {
        // The contract carries text only — whether a chunk replaces or appends
        // to what is showing is the client's call, because what a harness can
        // observe of its own thinking varies (a spinner status line for Claude,
        // real ACP thought chunks for grok).
        const text = typeof ev.text === 'string' ? ev.text : ''
        if (text) this.emit(native, { type: 'reasoning-delta', sessionId, text })
        return
      }
      case 'tool.start': {
        const name = typeof ev.tool === 'string' ? ev.tool : 'unknown'
        // Names pass through as the harness emits them — renaming them to
        // another harness's vocabulary would be a lie about which tool ran.
        // den carries no tool call id, so mint a stable per-session one and
        // pair `tool.end` against it LIFO.
        const toolCallId = `${native}:t${String(++state.toolSeq)}`
        state.openTools.push({ toolCallId, name })
        this.emit(native, { type: 'tool-use', sessionId, toolCallId, name, input: ev.args ?? {} })
        return
      }
      case 'tool.end': {
        const name = typeof ev.tool === 'string' ? ev.tool : undefined
        const index = name
          ? state.openTools.map((t) => t.name).lastIndexOf(name)
          : state.openTools.length - 1
        const open = index >= 0 ? state.openTools.splice(index, 1)[0] : undefined
        if (!open) return
        // `output: null` and no `isError`: den's `tool.end` carries neither a
        // result body nor a failure flag — the translators collapse the success
        // and failure hooks into the same event. Claiming success would be
        // worse than saying nothing.
        this.emit(native, {
          type: 'tool-result',
          sessionId,
          toolCallId: open.toolCallId,
          name: open.name,
          output: null,
        })
        return
      }
      case 'turn.end': {
        state.openTools = []
        this.endTurn(native, 'end-turn', true)
        return
      }
      default:
        return
    }
  }
}
