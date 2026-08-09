/**
 * `grok-build` — HarnessDriver for Grok Build (Phase 3's first new driver).
 *
 * Same shape as the `claude-code` reference driver, and for the same reason:
 * it does not rebuild anything, it formalizes the machinery the node already
 * runs behind the one contract.
 *
 *   | Contract method    | Existing machinery it wraps                          |
 *   |--------------------|------------------------------------------------------|
 *   | listSessions       | `listHarnessSessions(['grok'])` — ~/.grok/sessions   |
 *   | getSession         | `describeGrokSession` (single-store lookup)          |
 *   | startSession       | term manager `spawn(..., session)` → `--session-id`  |
 *   | resumeSession      | term manager spawn-or-get → `--resume`               |
 *   | sendUserTurn       | term manager `inject(pty, text, submit)`             |
 *   | interrupt          | term manager `inject(pty, '', false, interrupt)` (Esc)|
 *   | subscribe          | den AgentEvent ingest tap (Grok's den hooks)         |
 *   | transcript         | `readGrokTranscript` — chat_history.jsonl            |
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
 *     resume decisions go through `store.exists` (`harnessSessionExists`),
 *     which is the same ground truth the term manager itself uses (#318).
 *   - *Reasoning is real.* Claude's den hook cannot read thinking text and
 *     sends a spinner status line; grok's `updates.jsonl` carries ACP
 *     `agent_thought_chunk`s, so the shared translator ships the actual thought
 *     tail on `thinking.delta`. Both land on `reasoning-delta`, but the grok
 *     stream is the higher-fidelity one.
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

import { randomUUID } from 'node:crypto'
import {
  HarnessError,
  formatSessionId,
  parseSessionId,
  type HarnessCapabilities,
  type HarnessDriver,
  type HarnessEvent,
  type HarnessSessionSummary,
  type HarnessTranscriptTurn,
  type SessionId,
  type StartSessionOpts,
  type UserTurn,
} from '@rivetos/types'
import type { HarnessSession } from '../term/harness-sessions.js'
import { isBareNativeUuid } from './alias.js'
import type { DenAgentEventLike } from './claude-driver.js'

export const GROK_HARNESS_ID = 'grok-build' as const
/** Roster key the den term manager spawns Grok Build under. */
export const GROK_ROSTER_COMMAND = 'grok'

/** The slice of the den term manager this driver needs. */
export interface GrokPtyHost {
  spawn(
    rosterKey: string | undefined,
    cols: number,
    rows: number,
    remote: string,
    session?: string,
    resume?: string,
  ): { id: string; denSession: string }
  ptyForSession(denSession: string): string | undefined
  inject(id: string, text: string, submit: boolean, interrupt?: boolean): boolean
}

/** The slice of the on-disk grok store this driver needs. */
export interface GrokStoreHost {
  list(limit: number): Promise<HarnessSession[]>
  describe(nativeId: string): Promise<HarnessSession | undefined>
  /**
   * Does the session DIR exist? Ground truth for collision + `--resume`, and
   * deliberately separate from `describe`: grok creates the dir before its
   * summary.json, so a describable session is a subset of an existing one.
   * Sync, like `harnessSessionExists` behind it — a handful of `existsSync`.
   */
  exists(nativeId: string): boolean
  transcript(nativeId: string): Promise<{ turns: HarnessTranscriptTurn[] }>
}

export interface GrokDriverDeps {
  store: GrokStoreHost
  /**
   * Lazily-resolved PTY host. Omit when den terminals are disabled on this
   * node — `interrupt` / `resume` then report `false` and the start/turn paths
   * reject with `capability_unsupported` instead of pretending.
   */
  pty?: () => Promise<GrokPtyHost | null>
  /** Tap on den AgentEvent ingest. Omit → `liveStream: false`. */
  events?: (sink: (ev: DenAgentEventLike) => void) => () => void
  /**
   * cwd the roster spawns Grok in — reported on summaries. A getter, not a
   * value: the term manager re-reads `den-term.json` on every spawn.
   */
  cwd?: () => string | undefined
  /** How many sessions `listSessions` pulls from the store. */
  listLimit?: number
  /**
   * Quiet window after a turn is injected before the driver stops calling it
   * in flight. Grok's den hooks emit `turn.end` on `Stop` — or, when the final
   * chunk lands after the hook exits, from the detached flush pass a beat
   * later. A node whose hooks are not installed would otherwise wedge every
   * later turn on `turn_in_flight`.
   */
  turnQuietMs?: number
  now?: () => number
  log?: (msg: string) => void
}

const DEFAULT_LIST_LIMIT = 100
const DEFAULT_TURN_QUIET_MS = 5 * 60_000
/** Fresh PTYs get a sane default geometry; a real attach resizes immediately. */
const SPAWN_COLS = 120
const SPAWN_ROWS = 40

interface LiveState {
  status: 'active' | 'idle' | 'ended'
  /** Last status we emitted `session-updated` for — de-dupes the stream. */
  reported?: 'active' | 'idle' | 'ended' | 'error'
  turnInFlight: boolean
  quietTimer?: NodeJS.Timeout
  /** Open tool calls, oldest-first — den carries no tool call ids. */
  openTools: { toolCallId: string; name: string }[]
  toolSeq: number
}

function unsupported(message: string, sessionId?: string): HarnessError {
  return new HarnessError('capability_unsupported', message, {
    harnessId: GROK_HARNESS_ID,
    ...(sessionId ? { sessionId } : {}),
  })
}

export class GrokBuildDriver implements HarnessDriver {
  readonly harnessId = GROK_HARNESS_ID
  readonly capabilities: HarnessCapabilities

  private readonly deps: GrokDriverDeps
  private readonly now: () => number
  private readonly log: (msg: string) => void
  private readonly listLimit: number
  private readonly turnQuietMs: number

  /** native id → live view (status, in-flight turn, open tool calls). */
  private readonly live = new Map<string, LiveState>()
  private readonly sessionSinks = new Map<string, Set<(e: HarnessEvent) => void>>()
  private readonly registrySinks = new Set<(e: HarnessEvent) => void>()
  /** native ids we have already announced as `session-created`. */
  private readonly announced = new Set<string>()
  private detachEvents?: () => void

  constructor(deps: GrokDriverDeps) {
    this.deps = deps
    this.now = deps.now ?? Date.now
    this.log = deps.log ?? ((): void => undefined)
    this.listLimit = deps.listLimit ?? DEFAULT_LIST_LIMIT
    this.turnQuietMs = deps.turnQuietMs ?? DEFAULT_TURN_QUIET_MS
    this.capabilities = {
      interrupt: !!deps.pty,
      resume: !!deps.pty,
      // Grok Build owns permission prompts inside its TUI, and the den roster
      // runs it in bypassPermissions so it never blocks on one. Either way
      // nothing on the den wire carries an approval request.
      approvals: false,
      liveStream: !!deps.events,
      listSessions: true,
    }
    if (deps.events) this.detachEvents = deps.events((ev) => this.onDenEvent(ev))
  }

  // -- identity ------------------------------------------------------------

  /** `grok-build:<uuid>` for a native id. @throws `invalid_session_id` */
  static sessionId(nativeId: string): SessionId {
    return formatSessionId(GROK_HARNESS_ID, nativeId)
  }

  /** Canonical id → native id, rejecting ids that belong to another harness. */
  private native(sessionId: SessionId): string {
    const { harnessId, nativeSessionId } = parseSessionId(sessionId)
    if (harnessId !== GROK_HARNESS_ID) {
      throw new HarnessError('invalid_session_id', `${sessionId} is not a grok-build session`, {
        harnessId: GROK_HARNESS_ID,
        sessionId,
      })
    }
    return nativeSessionId
  }

  // -- reads ---------------------------------------------------------------

  async listSessions(): Promise<HarnessSessionSummary[]> {
    const rows = await this.deps.store.list(this.listLimit)
    return rows.filter((r) => r.command === GROK_ROSTER_COMMAND).map((r) => this.summarize(r))
  }

  async getSession(sessionId: SessionId): Promise<HarnessSessionSummary | null> {
    const native = this.native(sessionId)
    const row = await this.deps.store.describe(native)
    if (row) return this.summarize(row)
    // A just-spawned session has a live PTY before its summary.json exists.
    if (this.live.has(native)) {
      return {
        sessionId,
        harnessId: GROK_HARNESS_ID,
        cwd: this.cwd(),
        createdAt: new Date(this.now()).toISOString(),
        updatedAt: new Date(this.now()).toISOString(),
        status: this.statusFor(native),
      }
    }
    return null
  }

  /**
   * Hard-resync source (generalizes den's
   * `GET /term/harness-sessions/:id/transcript`). Not part of the
   * `HarnessDriver` interface — the gateway feature-detects it.
   */
  async transcript(sessionId: SessionId): Promise<{ turns: HarnessTranscriptTurn[] }> {
    return this.deps.store.transcript(this.native(sessionId))
  }

  // -- lifecycle -----------------------------------------------------------

  async startSession(opts: StartSessionOpts = {}): Promise<HarnessSessionSummary> {
    // cwd/model are roster-owned on this driver: the term manager spawns the
    // operator's `grok` argv in the roster cwd and takes no per-request
    // override. Rejecting beats silently ignoring the caller's intent.
    if (opts.cwd !== undefined) throw unsupported('grok-build: cwd is roster-owned (den-term.json)')
    if (opts.model !== undefined) {
      throw unsupported('grok-build: model is roster-owned (den-term.json)')
    }
    const pty = await this.requirePty('startSession')

    const native = opts.nativeSessionId ?? randomUUID()
    if (!isBareNativeUuid(native)) {
      // `grok --session-id` only accepts a uuid, and the den join key is the
      // same string, so a non-uuid pin cannot be honored end to end.
      throw new HarnessError(
        'invalid_session_id',
        `grok-build native session ids must be uuids: ${native}`,
        { harnessId: GROK_HARNESS_ID, sessionId: native },
      )
    }
    const sessionId = GrokBuildDriver.sessionId(native)
    // Never attach: an id already in the harness store is a collision, even if
    // the caller meant to resume (that is `resumeSession`). Dir existence, not
    // summary.json — grok writes the dir first, and `--session-id` refuses an
    // id whose dir is already there.
    if (this.deps.store.exists(native)) {
      throw new HarnessError(
        'session_id_collision',
        `grok-build session ${native} already exists in the harness store`,
        { harnessId: GROK_HARNESS_ID, sessionId },
      )
    }

    pty.spawn(GROK_ROSTER_COMMAND, SPAWN_COLS, SPAWN_ROWS, 'harness-driver', native)
    this.ensureLive(native).status = 'idle'
    const summary: HarnessSessionSummary = {
      sessionId,
      harnessId: GROK_HARNESS_ID,
      cwd: this.cwd(),
      createdAt: new Date(this.now()).toISOString(),
      updatedAt: new Date(this.now()).toISOString(),
      status: 'idle',
    }
    this.announce(native, summary)
    return summary
  }

  async resumeSession(sessionId: SessionId): Promise<HarnessSessionSummary> {
    const native = this.native(sessionId)
    const pty = await this.requirePty('resumeSession')
    const row = await this.deps.store.describe(native)
    // A session whose dir exists but whose summary has not landed yet is still
    // resumable — that is exactly the window right after a fresh spawn.
    if (!row && !this.deps.store.exists(native) && !this.live.has(native)) {
      throw new HarnessError(
        'invalid_session_id',
        `no grok-build session ${native} in the harness store`,
        { harnessId: GROK_HARNESS_ID, sessionId },
      )
    }
    // spawn-or-get: a live PTY for this session is returned as-is; otherwise
    // the term manager re-spawns with `--resume <native>` (store existence is
    // its ground truth, so passing `resume` is belt-and-braces).
    pty.spawn(GROK_ROSTER_COMMAND, SPAWN_COLS, SPAWN_ROWS, 'harness-driver', native, native)
    this.ensureLive(native)
    return row
      ? this.summarize(row, this.statusFor(native))
      : {
          sessionId,
          harnessId: GROK_HARNESS_ID,
          cwd: this.cwd(),
          createdAt: new Date(this.now()).toISOString(),
          updatedAt: new Date(this.now()).toISOString(),
          status: this.statusFor(native),
        }
  }

  async sendUserTurn(sessionId: SessionId, turn: UserTurn): Promise<void> {
    const native = this.native(sessionId)
    if (turn.attachments?.length) {
      // Same answer as claude-code, for the same reason: this driver's only
      // channel into the harness is a PTY paste, which carries text. Pasting
      // the staged path as prose would be a different thing wearing the
      // contract's name. A driver that speaks a real protocol (ACP) consumes
      // the staged URI directly.
      throw unsupported('grok-build: attachments are not supported in v1', sessionId)
    }
    const pty = await this.requirePty('sendUserTurn')
    const state = this.live.get(native)
    if (state?.turnInFlight) {
      throw new HarnessError('turn_in_flight', `grok-build ${native} is mid-turn`, {
        harnessId: GROK_HARNESS_ID,
        sessionId,
      })
    }
    let ptyId = this.ensurePty(pty, native)
    if (!pty.inject(ptyId, turn.text, true)) {
      // The term manager keeps its session→pty mapping until the EXITED record
      // is reaped (exitLingerMs), so a harness that just died still resolves to
      // a pty that refuses writes. That is a retry, not a capability gap.
      ptyId = this.spawnFor(pty, native, true)
      if (!pty.inject(ptyId, turn.text, true)) {
        // A live-but-unwritable harness means its pre-ready inject buffer is
        // full — genuinely transient, so say so instead of 501.
        throw new HarnessError(
          'turn_in_flight',
          `grok-build ${native} is not accepting input yet`,
          {
            harnessId: GROK_HARNESS_ID,
            sessionId,
          },
        )
      }
    }
    this.beginTurn(native)
  }

  async interrupt(sessionId: SessionId): Promise<void> {
    const native = this.native(sessionId)
    const pty = await this.requirePty('interrupt')
    const ptyId = pty.ptyForSession(native)
    // Idempotent: with no live harness there is no turn to cancel.
    if (!ptyId) return
    // Deliberately unchecked, unlike sendUserTurn: interrupt is best-effort
    // "ensure no turn is running". A false here means the pty is dead or
    // unwritable — in which case nothing is running.
    pty.inject(ptyId, '', false, true)
    // Release the lock here rather than waiting for a den `turn.end`, which may
    // or may not follow a cancel — the same stance the reference driver takes.
    // Clearing early is the safe direction: a later real `turn.end` is a no-op,
    // whereas waiting for one that never comes would 409 every later turn.
    if (this.live.get(native)?.turnInFlight) {
      this.endTurn(native, 'interrupted')
    }
  }

  resolveApproval(): Promise<void> {
    return Promise.reject(
      unsupported(
        'grok-build: approvals are handled inside the Grok Build TUI and are not ' +
          'observable on the den wire',
      ),
    )
  }

  // -- streams -------------------------------------------------------------

  /**
   * The sink is pinned to the native id it was registered under, and that is
   * correct for a driver: **rotation is control-plane work.** The registry's
   * `subscribeSession` wraps this call and re-keys the sink onto the canonical
   * id when it records an alias (`registry.ts` → `rekey`). This harness never
   * rotates on the den path anyway — see the non-rotation note at the top.
   */
  subscribe(sessionId: SessionId, sink: (e: HarnessEvent) => void): () => void {
    if (!this.capabilities.liveStream) {
      throw unsupported('grok-build: no den event tap on this node', sessionId)
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
    }
    this.live.clear()
    this.sessionSinks.clear()
    this.registrySinks.clear()
    this.detachEvents?.()
    this.detachEvents = undefined
  }

  // -- internals -----------------------------------------------------------

  /** Roster cwd at call time — see `GrokDriverDeps.cwd`. */
  private cwd(): string | undefined {
    return this.deps.cwd?.()
  }

  private summarize(
    row: HarnessSession,
    statusOverride?: HarnessSessionSummary['status'],
  ): HarnessSessionSummary {
    const sessionId = GrokBuildDriver.sessionId(row.id)
    const updatedAt = new Date(row.updatedAt || this.now()).toISOString()
    const summary: HarnessSessionSummary = {
      sessionId,
      harnessId: GROK_HARNESS_ID,
      // summary.json carries created_at; the reader falls back to updated_at
      // for a store written by an older grok, so list and get cannot disagree.
      createdAt: new Date(row.createdAt ?? row.updatedAt).toISOString(),
      updatedAt,
      status: statusOverride ?? this.statusFor(row.id),
    }
    if (row.title && row.title !== row.id) summary.title = row.title
    const cwd = this.cwd()
    if (cwd) summary.cwd = cwd
    return summary
  }

  /** Is this den room a Grok session this driver should track? */
  private isGrokRoom(native: string, ev: DenAgentEventLike): boolean {
    if (this.live.has(native)) return true
    // grok-den-hook.sh runs the shared translator as `--harness grok-build`,
    // which stamps every event it posts.
    if (ev.harness === GROK_HARNESS_ID) return true
    return (
      ev.harness === 'rivetos' &&
      typeof ev.name === 'string' &&
      ev.name.endsWith(`:${GROK_ROSTER_COMMAND}`)
    )
  }

  /**
   * Status is reported from what we can actually observe: a live PTY mid-turn
   * is `active`, a live PTY between turns is `idle`, and a session that exists
   * only on disk is `ended` — the process is gone, though `resumeSession`
   * revives it.
   *
   * KNOWN GAP (same as claude-code): liveness comes from this driver's own map,
   * fed by `startSession`/`resumeSession` and by den events. A grok process
   * started outside den entirely (no `RIVET_DEN_SESSION`, no den hooks) reads
   * as `ended` until it speaks.
   */
  private statusFor(native: string): HarnessSessionSummary['status'] {
    const state = this.live.get(native)
    if (!state) return 'ended'
    if (state.status === 'ended') return 'ended'
    return state.turnInFlight ? 'active' : 'idle'
  }

  private ensureLive(native: string): LiveState {
    let state = this.live.get(native)
    if (!state) {
      state = { status: 'idle', turnInFlight: false, openTools: [], toolSeq: 0 }
      this.live.set(native, state)
    }
    return state
  }

  private async requirePty(method: string): Promise<GrokPtyHost> {
    if (!this.deps.pty) {
      throw unsupported(`grok-build: ${method} needs den terminals, which are disabled`)
    }
    const pty = await this.deps.pty()
    if (!pty) {
      throw unsupported(`grok-build: ${method} needs a PTY backend, which is unavailable`)
    }
    return pty
  }

  /**
   * Live PTY for a session, re-spawning (`--resume`) after an LRU eviction.
   * Sync, unlike the Claude driver's: the store question here is "does the
   * session dir exist", which `harnessSessionExists` answers without I/O worth
   * awaiting.
   */
  private ensurePty(pty: GrokPtyHost, native: string): string {
    const existing = pty.ptyForSession(native)
    if (existing) return existing
    return this.spawnFor(pty, native, this.deps.store.exists(native))
  }

  /**
   * Spawn (or spawn-or-get) the harness for a session. `resume` is passed when
   * the session dir already exists; the term manager checks store existence
   * itself, so this is belt-and-braces. A spawn-or-get against a still-lingering
   * EXITED record produces a fresh pty, which is what the dead-pty retry in
   * `sendUserTurn` wants.
   */
  private spawnFor(pty: GrokPtyHost, native: string, resume: boolean): string {
    const spawned = pty.spawn(
      GROK_ROSTER_COMMAND,
      SPAWN_COLS,
      SPAWN_ROWS,
      'harness-driver',
      native,
      resume ? native : undefined,
    )
    this.ensureLive(native)
    return spawned.id
  }

  private emit(native: string, event: HarnessEvent): void {
    for (const sink of [...(this.sessionSinks.get(native) ?? [])]) {
      try {
        sink(event)
      } catch {
        /* one bad subscriber must never break the others */
      }
    }
  }

  private emitRegistry(event: HarnessEvent): void {
    for (const sink of [...this.registrySinks]) {
      try {
        sink(event)
      } catch {
        /* as above */
      }
    }
  }

  private announce(native: string, summary: HarnessSessionSummary): void {
    if (this.announced.has(native)) return
    this.announced.add(native)
    this.emitRegistry({ type: 'session-created', sessionId: summary.sessionId, summary })
  }

  private setStatus(native: string, status: 'active' | 'idle' | 'ended' | 'error'): void {
    const state = this.ensureLive(native)
    if (status !== 'error') state.status = status
    if (state.reported === status) return
    state.reported = status
    const event: HarnessEvent = {
      type: 'session-updated',
      sessionId: GrokBuildDriver.sessionId(native),
      status,
    }
    this.emit(native, event)
    this.emitRegistry(event)
  }

  private beginTurn(native: string): void {
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
  private endTurn(native: string, stopReason: string, always = false): void {
    const state = this.live.get(native)
    if (!state) return
    if (state.quietTimer) {
      clearTimeout(state.quietTimer)
      state.quietTimer = undefined
    }
    if (!state.turnInFlight && !always) return
    state.turnInFlight = false
    this.emit(native, {
      type: 'turn-complete',
      sessionId: GrokBuildDriver.sessionId(native),
      stopReason,
    })
    this.setStatus(native, 'idle')
  }

  /**
   * Failsafe for nodes whose grok den hooks are not installed: without a
   * `turn.end` the in-flight flag would never clear and every later
   * `sendUserTurn` would 409. Re-armed on any den event for the session, so a
   * genuinely long turn is never cut short.
   */
  private armQuietWindow(native: string): void {
    const state = this.ensureLive(native)
    if (state.quietTimer) clearTimeout(state.quietTimer)
    if (this.turnQuietMs <= 0) return
    state.quietTimer = setTimeout(() => {
      state.quietTimer = undefined
      if (!state.turnInFlight) return
      this.log(
        `[den-server] harness: no den events for grok-build:${native} in ` +
          `${String(this.turnQuietMs)}ms — releasing the in-flight turn lock`,
      )
      this.endTurn(native, 'quiet-timeout')
    }, this.turnQuietMs)
    state.quietTimer.unref()
  }

  /**
   * Map one den AgentEvent onto the harness contract. Only sessions we know to
   * be Grok's are considered: den rooms also carry claude/hermes/shell PTYs.
   * Claude pins uuid session keys too, so a uuid alone proves nothing — and an
   * id-less grok (`unknown-<ppid>`, the translator's last-resort key) is not a
   * harness session at all, which the uuid test also filters out.
   *
   * Den event types the grok hooks produce that are NOT mapped here —
   * `message.user`, `speech.stt`, `thinking.end`, `activity`, `task.plan`,
   * `task.check`, `term.line` — are den-UI concerns with no place on the
   * contract's event union.
   */
  private onDenEvent(ev: DenAgentEventLike): void {
    const native = ev.session
    if (!isBareNativeUuid(native)) return
    if (!this.isGrokRoom(native, ev)) return
    const state = this.ensureLive(native)
    if (state.turnInFlight) this.armQuietWindow(native)
    const sessionId = GrokBuildDriver.sessionId(native)

    switch (ev.type) {
      case 'session.start': {
        if (!this.announced.has(native)) {
          void this.getSession(sessionId).then(
            (summary) => {
              if (summary) this.announce(native, summary)
            },
            () => undefined,
          )
        }
        this.setStatus(native, 'idle')
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
        // Real thinking, unlike Claude's spinner line: the translator tails
        // grok's ACP `agent_thought_chunk`s out of updates.jsonl. The contract
        // carries text only — whether a chunk replaces or appends to what is
        // showing is the client's call.
        const text = typeof ev.text === 'string' ? ev.text : ''
        if (text) this.emit(native, { type: 'reasoning-delta', sessionId, text })
        return
      }
      case 'tool.start': {
        const name = typeof ev.tool === 'string' ? ev.tool : 'unknown'
        // Names pass through as grok emits them (`run_terminal_cmd`,
        // `search_replace`) — renaming them to Claude's would be a lie about
        // which tool ran. den carries no tool call id, so mint a stable
        // per-session one and pair `tool.end` against it LIFO.
        const toolCallId = `${native}:t${String(++state.toolSeq)}`
        state.openTools.push({ toolCallId, name })
        this.emit(native, {
          type: 'tool-use',
          sessionId,
          toolCallId,
          name,
          input: ev.args ?? {},
        })
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
        // result body nor a failure flag — the translator collapses PostToolUse
        // and PostToolUseFailure into the same event. Claiming success would be
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
        // From `Stop`, or from the detached flush pass when grok's final
        // message chunk only lands after the hook exits.
        state.openTools = []
        this.endTurn(native, 'end-turn', true)
        return
      }
      default:
        return
    }
  }
}
