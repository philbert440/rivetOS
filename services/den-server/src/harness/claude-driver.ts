/**
 * `claude-code` — the reference HarnessDriver (Phase 2).
 *
 * This does NOT rebuild anything: it formalizes the machinery the node already
 * runs, behind the one contract every other harness will match.
 *
 *   | Contract method    | Existing machinery it wraps                        |
 *   |--------------------|----------------------------------------------------|
 *   | listSessions       | `listHarnessSessions(['claude'])` — ~/.claude/projects |
 *   | getSession         | `describeClaudeSession` (single-store lookup)      |
 *   | startSession       | term manager `spawn(..., session)` → `--session-id` |
 *   | resumeSession      | term manager spawn-or-get → `--resume`             |
 *   | sendUserTurn       | term manager `inject(pty, text, submit)`           |
 *   | interrupt          | term manager `inject(pty, '', false, interrupt)` (Esc) |
 *   | subscribe          | den AgentEvent ingest tap (Claude's den hooks)     |
 *   | transcript         | `readHarnessTranscript` (the hard-resync source)   |
 *
 * **Identity.** Den already makes the harness's native session id equal the
 * den session key (the term manager pins `--session-id <uuid>`), so the
 * canonical id is simply `claude-code:<uuid>`. Legacy shapes — the bare uuid
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

export const CLAUDE_HARNESS_ID = 'claude-code' as const
/** Roster key the den term manager spawns Claude under. */
export const CLAUDE_ROSTER_COMMAND = 'claude'

/** The den AgentEvent shape the tap delivers (structurally den-protocol's). */
export interface DenAgentEventLike {
  session: string
  type: string
  [k: string]: unknown
}

/** The slice of the den term manager this driver needs. */
export interface ClaudePtyHost {
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

/** The slice of the on-disk Claude store this driver needs. */
export interface ClaudeStoreHost {
  list(limit: number): Promise<HarnessSession[]>
  describe(nativeId: string): Promise<HarnessSession | undefined>
  transcript(nativeId: string): Promise<{ turns: HarnessTranscriptTurn[] }>
}

export interface ClaudeDriverDeps {
  store: ClaudeStoreHost
  /**
   * Lazily-resolved PTY host. Omit when den terminals are disabled on this
   * node — `interrupt` / `resume` then report `false` and the start/turn paths
   * reject with `capability_unsupported` instead of pretending.
   */
  pty?: () => Promise<ClaudePtyHost | null>
  /** Tap on den AgentEvent ingest. Omit → `liveStream: false`. */
  events?: (sink: (ev: DenAgentEventLike) => void) => () => void
  /**
   * cwd the roster spawns Claude in — reported on summaries. A getter, not a
   * value: the term manager re-reads `den-term.json` on every spawn, so a
   * snapshot taken at construction would go stale the moment an operator
   * edits the roster.
   */
  cwd?: () => string | undefined
  /** How many sessions `listSessions` pulls from the store. */
  listLimit?: number
  /**
   * Quiet window after a turn is injected before the driver stops calling it
   * in flight. Claude's den hooks emit `turn.end`; a node whose hooks are not
   * installed would otherwise wedge every later turn on `turn_in_flight`.
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
    harnessId: CLAUDE_HARNESS_ID,
    ...(sessionId ? { sessionId } : {}),
  })
}

export class ClaudeCodeDriver implements HarnessDriver {
  readonly harnessId = CLAUDE_HARNESS_ID
  readonly capabilities: HarnessCapabilities

  private readonly deps: ClaudeDriverDeps
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

  constructor(deps: ClaudeDriverDeps) {
    this.deps = deps
    this.now = deps.now ?? Date.now
    this.log = deps.log ?? ((): void => undefined)
    this.listLimit = deps.listLimit ?? DEFAULT_LIST_LIMIT
    this.turnQuietMs = deps.turnQuietMs ?? DEFAULT_TURN_QUIET_MS
    this.capabilities = {
      interrupt: !!deps.pty,
      resume: !!deps.pty,
      // Claude Code owns permission prompts inside its TUI — nothing on the
      // den wire carries an approval request, let alone a decision channel.
      approvals: false,
      liveStream: !!deps.events,
      listSessions: true,
    }
    if (deps.events) this.detachEvents = deps.events((ev) => this.onDenEvent(ev))
  }

  // -- identity ------------------------------------------------------------

  /** `claude-code:<uuid>` for a native id. @throws `invalid_session_id` */
  static sessionId(nativeId: string): SessionId {
    return formatSessionId(CLAUDE_HARNESS_ID, nativeId)
  }

  /** Canonical id → native id, rejecting ids that belong to another harness. */
  private native(sessionId: SessionId): string {
    const { harnessId, nativeSessionId } = parseSessionId(sessionId)
    if (harnessId !== CLAUDE_HARNESS_ID) {
      throw new HarnessError('invalid_session_id', `${sessionId} is not a claude-code session`, {
        harnessId: CLAUDE_HARNESS_ID,
        sessionId,
      })
    }
    return nativeSessionId
  }

  // -- reads ---------------------------------------------------------------

  async listSessions(): Promise<HarnessSessionSummary[]> {
    const rows = await this.deps.store.list(this.listLimit)
    return rows.filter((r) => r.command === CLAUDE_ROSTER_COMMAND).map((r) => this.summarize(r))
  }

  async getSession(sessionId: SessionId): Promise<HarnessSessionSummary | null> {
    const native = this.native(sessionId)
    const row = await this.deps.store.describe(native)
    if (row) return this.summarize(row)
    // A just-spawned session has a live PTY before its .jsonl exists.
    if (this.live.has(native)) {
      return {
        sessionId,
        harnessId: CLAUDE_HARNESS_ID,
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
    // operator's `claude` argv in the roster cwd and takes no per-request
    // override. Rejecting beats silently ignoring the caller's intent.
    if (opts.cwd !== undefined)
      throw unsupported('claude-code: cwd is roster-owned (den-term.json)')
    if (opts.model !== undefined) {
      throw unsupported('claude-code: model is roster-owned (den-term.json)')
    }
    const pty = await this.requirePty('startSession')

    const native = opts.nativeSessionId ?? randomUUID()
    if (!isBareNativeUuid(native)) {
      // `claude --session-id` only accepts a uuid, and the den join key is the
      // same string, so a non-uuid pin cannot be honored end to end.
      throw new HarnessError(
        'invalid_session_id',
        `claude-code native session ids must be uuids: ${native}`,
        { harnessId: CLAUDE_HARNESS_ID, sessionId: native },
      )
    }
    const sessionId = ClaudeCodeDriver.sessionId(native)
    // Never attach: an id already in the harness store is a collision, even if
    // the caller meant to resume (that is `resumeSession`).
    if (await this.deps.store.describe(native)) {
      throw new HarnessError(
        'session_id_collision',
        `claude-code session ${native} already exists in the harness store`,
        { harnessId: CLAUDE_HARNESS_ID, sessionId },
      )
    }

    pty.spawn(CLAUDE_ROSTER_COMMAND, SPAWN_COLS, SPAWN_ROWS, 'harness-driver', native)
    this.ensureLive(native).status = 'idle'
    const summary: HarnessSessionSummary = {
      sessionId,
      harnessId: CLAUDE_HARNESS_ID,
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
    if (!row && !this.live.has(native)) {
      throw new HarnessError(
        'invalid_session_id',
        `no claude-code session ${native} in the harness store`,
        { harnessId: CLAUDE_HARNESS_ID, sessionId },
      )
    }
    // spawn-or-get: a live PTY for this session is returned as-is; otherwise
    // the term manager re-spawns with `--resume <native>` (store existence is
    // its ground truth, so passing `resume` is belt-and-braces).
    pty.spawn(CLAUDE_ROSTER_COMMAND, SPAWN_COLS, SPAWN_ROWS, 'harness-driver', native, native)
    this.ensureLive(native)
    return row
      ? this.summarize(row, this.statusFor(native))
      : {
          sessionId,
          harnessId: CLAUDE_HARNESS_ID,
          cwd: this.cwd(),
          createdAt: new Date(this.now()).toISOString(),
          updatedAt: new Date(this.now()).toISOString(),
          status: this.statusFor(native),
        }
  }

  async sendUserTurn(sessionId: SessionId, turn: UserTurn): Promise<void> {
    const native = this.native(sessionId)
    if (turn.attachments?.length) {
      // `POST /api/uploads` now hands clients a node-local path, so
      // `pathOrUri` is resolvable — but this driver still cannot use one. Its
      // only channel into Claude is a PTY paste, which carries text; there is
      // no wire for "here is a file" into the TUI. Attaching by pasting the
      // path as prose would be a different thing wearing the contract's name,
      // so the honest answer stays `capability_unsupported`. A driver that
      // speaks a real protocol (SDK / ACP) consumes the staged URI directly.
      throw unsupported('claude-code: attachments are not supported in v1', sessionId)
    }
    const pty = await this.requirePty('sendUserTurn')
    const state = this.live.get(native)
    if (state?.turnInFlight) {
      throw new HarnessError('turn_in_flight', `claude-code ${native} is mid-turn`, {
        harnessId: CLAUDE_HARNESS_ID,
        sessionId,
      })
    }
    let ptyId = await this.ensurePty(pty, native)
    if (!pty.inject(ptyId, turn.text, true)) {
      // The term manager keeps its session→pty mapping until the EXITED record
      // is reaped (exitLingerMs, 60s by default), so a harness that just died
      // still resolves to a pty that refuses writes. Answering
      // `capability_unsupported` there would tell the client "this node cannot
      // do turns" — false, and a 501 is not retryable. Re-spawn through the
      // same `--resume` path a fully-reaped session takes and try once more.
      ptyId = this.spawnFor(pty, native, true)
      if (!pty.inject(ptyId, turn.text, true)) {
        // A live-but-unwritable harness means its pre-ready inject buffer is
        // full — genuinely transient, so say so instead of 501.
        throw new HarnessError(
          'turn_in_flight',
          `claude-code ${native} is not accepting input yet`,
          { harnessId: CLAUDE_HARNESS_ID, sessionId },
        )
      }
    }
    this.beginTurn(native)
  }

  async interrupt(sessionId: SessionId): Promise<void> {
    const native = this.native(sessionId)
    const pty = await this.requirePty('interrupt')
    const ptyId = pty.ptyForSession(native)
    // Idempotent: with no live harness there is no turn to cancel. Spawning
    // one just to Esc it would be worse than a no-op.
    if (!ptyId) return
    // Deliberately unchecked, unlike sendUserTurn: interrupt is best-effort
    // "ensure no turn is running". A false here means the pty is dead or
    // unwritable — in which case nothing is running and there is nothing to
    // cancel, so re-spawning a harness just to Esc it would be absurd.
    pty.inject(ptyId, '', false, true)
    if (this.live.get(native)?.turnInFlight) {
      this.endTurn(native, 'interrupted')
    }
  }

  resolveApproval(): Promise<void> {
    return Promise.reject(
      unsupported(
        'claude-code: approvals are handled inside the Claude Code TUI and are not ' +
          'observable on the den wire',
      ),
    )
  }

  // -- streams -------------------------------------------------------------

  /**
   * The sink is pinned to the native id it was registered under, and that is
   * correct for a driver: **rotation is control-plane work.** The registry's
   * `subscribeSession` wraps this call and re-keys the sink onto the canonical
   * id when it records an alias, so the client's subscription survives a
   * rotation without the driver ever consulting the alias store
   * (`registry.ts` → `rekey`; § Contract semantics, "Subscriptions survive
   * rotation"). Claude Code never rotates its native id anyway; a driver that
   * does — hermes first — needs nothing here beyond emitting `session-updated`
   * with `previousSessionId`, and proves it by running the shared conformance
   * suite in `harness/test/driver-conformance.ts`.
   */
  subscribe(sessionId: SessionId, sink: (e: HarnessEvent) => void): () => void {
    if (!this.capabilities.liveStream) {
      throw unsupported('claude-code: no den event tap on this node', sessionId)
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

  /** Roster cwd at call time — see `ClaudeDriverDeps.cwd`. */
  private cwd(): string | undefined {
    return this.deps.cwd?.()
  }

  private summarize(
    row: HarnessSession,
    statusOverride?: HarnessSessionSummary['status'],
  ): HarnessSessionSummary {
    const sessionId = ClaudeCodeDriver.sessionId(row.id)
    const updatedAt = new Date(row.updatedAt || this.now()).toISOString()
    const summary: HarnessSessionSummary = {
      sessionId,
      harnessId: CLAUDE_HARNESS_ID,
      createdAt: new Date(row.createdAt ?? row.updatedAt).toISOString(),
      updatedAt,
      status: statusOverride ?? this.statusFor(row.id),
    }
    if (row.title && row.title !== row.id) summary.title = row.title
    const cwd = this.cwd()
    if (cwd) summary.cwd = cwd
    return summary
  }

  /** Is this den room a Claude session this driver should track? */
  private isClaudeRoom(native: string, ev: DenAgentEventLike): boolean {
    if (this.live.has(native)) return true
    if (ev.harness === 'claude-code') return true
    return (
      ev.harness === 'rivetos' &&
      typeof ev.name === 'string' &&
      ev.name.endsWith(`:${CLAUDE_ROSTER_COMMAND}`)
    )
  }

  /**
   * Status is reported from what we can actually observe: a live PTY mid-turn
   * is `active`, a live PTY between turns is `idle`, and a session that exists
   * only on disk is `ended` — the process is gone, though `resumeSession`
   * revives it.
   *
   * KNOWN GAP: liveness comes from this driver's own map, which is fed by
   * `startSession`/`resumeSession` and by den events. A Claude process started
   * outside den entirely (a plain shell, no `RIVET_DEN_SESSION`) emits nothing
   * we can see and reads as `ended` until it does. Sessions spawned through
   * den — the driver or the `/term` drawer — are adopted at spawn time.
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

  private async requirePty(method: string): Promise<ClaudePtyHost> {
    if (!this.deps.pty) {
      throw unsupported(`claude-code: ${method} needs den terminals, which are disabled`)
    }
    const pty = await this.deps.pty()
    if (!pty) {
      throw unsupported(`claude-code: ${method} needs a PTY backend, which is unavailable`)
    }
    return pty
  }

  /** Live PTY for a session, re-spawning (`--resume`) after an LRU eviction. */
  private async ensurePty(pty: ClaudePtyHost, native: string): Promise<string> {
    const existing = pty.ptyForSession(native)
    if (existing) return existing
    const known = !!(await this.deps.store.describe(native))
    return this.spawnFor(pty, native, known)
  }

  /**
   * Spawn (or spawn-or-get) the harness for a session. `resume` is passed when
   * the session already exists in the store; the term manager checks store
   * existence itself, so this is belt-and-braces. A spawn-or-get against a
   * still-lingering EXITED record produces a fresh pty, which is exactly what
   * the dead-pty retry in `sendUserTurn` wants.
   */
  private spawnFor(pty: ClaudePtyHost, native: string, resume: boolean): string {
    const spawned = pty.spawn(
      CLAUDE_ROSTER_COMMAND,
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
      sessionId: ClaudeCodeDriver.sessionId(native),
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
      sessionId: ClaudeCodeDriver.sessionId(native),
      stopReason,
    })
    this.setStatus(native, 'idle')
  }

  /**
   * Failsafe for nodes whose Claude den hooks are not installed: without a
   * `turn.end` event the in-flight flag would never clear and every later
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
        `[den-server] harness: no den events for claude-code:${native} in ` +
          `${String(this.turnQuietMs)}ms — releasing the in-flight turn lock`,
      )
      this.endTurn(native, 'quiet-timeout')
    }, this.turnQuietMs)
    state.quietTimer.unref()
  }

  /**
   * Map one den AgentEvent onto the harness contract. Only sessions we know to
   * be Claude's are considered: den rooms also carry grok/hermes/shell PTYs,
   * and a `den-<pty>` roomless key is not a harness session at all.
   */
  private onDenEvent(ev: DenAgentEventLike): void {
    const native = ev.session
    if (!isBareNativeUuid(native)) return
    // den rooms also carry grok/hermes/shell PTYs, and grok pins uuid session
    // keys too — so a uuid alone proves nothing. Three ways a room is ours:
    //   1. Claude's den hook stamps `harness: 'claude-code'` on every event.
    //   2. This driver spawned it (already tracked).
    //   3. The term manager's synthetic session.start for a `/term` spawn —
    //      stamped `rivetos`, but its `name` is `<host>:<roster-key>`, so a
    //      claude PTY opened straight from the drawer is adopted immediately
    //      rather than waiting for its first hook event.
    if (!this.isClaudeRoom(native, ev)) return
    const state = this.ensureLive(native)
    if (state.turnInFlight) this.armQuietWindow(native)
    const sessionId = ClaudeCodeDriver.sessionId(native)

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
        // Claude's den hook cannot read real thinking text, so what arrives is
        // usually a spinner status line ("✳ Wrangling… (28s · ↓ 4.8k tokens)")
        // rather than a token stream. Both are the harness thinking out loud,
        // and the contract carries text only — whether a chunk replaces or
        // appends to what is showing is the client's call, exactly as it is on
        // the den bridge path.
        const text = typeof ev.text === 'string' ? ev.text : ''
        if (text) this.emit(native, { type: 'reasoning-delta', sessionId, text })
        return
      }
      case 'tool.start': {
        const name = typeof ev.tool === 'string' ? ev.tool : 'unknown'
        // den carries no tool call id, so mint a stable per-session one and
        // pair `tool.end` against it LIFO (nested tools are rare, and a
        // mismatched pair is better than dropping the result entirely).
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
