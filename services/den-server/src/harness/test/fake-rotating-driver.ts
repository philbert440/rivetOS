/**
 * A minimal `HarnessDriver` that rotates its native session id on demand —
 * the reference target for the rotation conformance suite next door.
 *
 * Claude Code never rotates, so without this nothing in the tree could prove
 * the control plane's rotation machinery works. It is also the shape a real
 * rotating driver (hermes first) should copy: rotation is nothing more than
 * `session-updated` carrying `previousSessionId`, emitted on the driver's own
 * streams. The driver keeps no alias state and never re-keys its own sinks —
 * that is the registry's job.
 *
 * `rotationDelivery` exists because the contract does NOT pin down whether a
 * driver emits the rotation to its per-session sinks before the registry
 * stream, after it, under the new id, or not at all. All four are conformant,
 * and the control plane must deliver exactly once in every case, so the suite
 * runs against all four.
 *
 * Lives under `test/` (not `*.test.ts`) so it is importable as a helper rather
 * than collected as a suite of its own — same convention as
 * `packages/core/src/domain/task/test/executor-conformance.ts`.
 */

import { randomUUID } from 'node:crypto'
import {
  HarnessError,
  formatSessionId,
  type HarnessCapabilities,
  type HarnessDriver,
  type HarnessEvent,
  type HarnessId,
  type HarnessSessionSummary,
  type HarnessTranscriptTurn,
  type SessionId,
  type StartSessionOpts,
  type UserTurn,
} from '@rivetos/types'

/** Where the driver puts the rotation event. Every variant is conformant. */
export type RotationDelivery =
  /** Per-session sinks under the OLD id first, then the registry stream. */
  | 'session-sinks-first'
  /** Registry stream first, then per-session sinks under the OLD id. */
  | 'registry-first'
  /** Registry stream only — the driver never tells its session sinks. */
  | 'registry-only'
  /** Registry stream, then per-session sinks under the NEW id. */
  | 'new-id-sinks'

export interface FakeRotatingDriverOpts {
  harnessId?: HarnessId
  rotationDelivery?: RotationDelivery
  /**
   * Model a harness store still keyed on the pre-rotation id: `listSessions`
   * keeps reporting the superseded id after a rotation. The control plane must
   * rewrite it to canonical rather than leak it.
   */
  keepSupersededInList?: boolean
  liveStream?: boolean
  listSessions?: boolean
  /**
   * Misbehave: re-key the driver's OWN per-session sinks on rotation, the way
   * a driver that reimplemented the control plane's job would. The sink then
   * ends up attached twice and every later event doubles — the failure the
   * conformance suite's exact-sequence assertions exist to catch.
   */
  selfRekeyOnRotate?: boolean
  /** Refuse `subscribe` for any id in this set (models a mid-rotation failure). */
  refuseSubscribeFor?: Set<SessionId>
}

const CAPS: HarnessCapabilities = {
  interrupt: true,
  resume: true,
  approvals: false,
  liveStream: true,
  listSessions: true,
}

export class FakeRotatingDriver implements HarnessDriver {
  readonly harnessId: HarnessId
  readonly capabilities: HarnessCapabilities

  /** Every id `subscribe` was called with, in order — proves the re-key. */
  readonly subscribeCalls: SessionId[] = []
  /** Ids `subscribe` refuses. Mutable so a test can arm it mid-flight. */
  readonly refuseSubscribeFor: Set<SessionId>
  readonly turns: { sessionId: SessionId; text: string }[] = []
  readonly interrupts: SessionId[] = []

  /**
   * Called at the end of every `subscribe`, so a test can make the harness
   * rotate AGAIN from inside the control plane's re-key — the re-entrancy the
   * registry has to survive.
   */
  hookSubscribe?: (sessionId: SessionId) => void

  private readonly delivery: RotationDelivery
  private readonly keepSupersededInList: boolean
  private readonly selfRekeyOnRotate: boolean
  private readonly sessions = new Map<SessionId, HarnessSessionSummary>()
  private readonly transcripts = new Map<SessionId, HarnessTranscriptTurn[]>()
  private readonly sessionSinks = new Map<SessionId, Set<(e: HarnessEvent) => void>>()
  private readonly registrySinks = new Set<(e: HarnessEvent) => void>()
  /** Rows `listSessions` still reports under a rotated-away id. */
  private readonly stale = new Set<SessionId>()

  constructor(opts: FakeRotatingDriverOpts = {}) {
    this.harnessId = opts.harnessId ?? 'hermes'
    this.delivery = opts.rotationDelivery ?? 'registry-first'
    this.keepSupersededInList = opts.keepSupersededInList ?? false
    this.selfRekeyOnRotate = opts.selfRekeyOnRotate ?? false
    this.refuseSubscribeFor = opts.refuseSubscribeFor ?? new Set()
    this.capabilities = {
      ...CAPS,
      liveStream: opts.liveStream ?? true,
      listSessions: opts.listSessions ?? true,
    }
  }

  // -- test surface ----------------------------------------------------------

  /** Create a session outside the contract, for a test that needs one live. */
  seed(nativeSessionId = randomUUID()): SessionId {
    const sessionId = formatSessionId(this.harnessId, nativeSessionId)
    this.sessions.set(sessionId, this.summary(sessionId))
    this.transcripts.set(sessionId, [])
    return sessionId
  }

  /**
   * Rotate `from` onto a freshly minted native id, exactly as a compact / fork
   * / crash-recovery would: same harness, new native id, one `session-updated`
   * carrying `previousSessionId`. `nativeSessionId` pins the id it lands on,
   * for a test that has to know it before the rotation happens.
   */
  rotate(from: SessionId, nativeSessionId = randomUUID()): SessionId {
    const next = formatSessionId(this.harnessId, nativeSessionId)
    const carried = this.sessions.get(from) ?? this.summary(from)
    this.sessions.delete(from)
    this.sessions.set(next, { ...carried, sessionId: next, updatedAt: new Date().toISOString() })
    this.transcripts.set(next, this.transcripts.get(from) ?? [])
    this.transcripts.delete(from)
    if (this.keepSupersededInList) this.stale.add(from)
    if (this.selfRekeyOnRotate) {
      // The misbehavior: the driver drags its own sinks along, so the control
      // plane's (correct) re-key attaches them a second time.
      const carriedSinks = this.sessionSinks.get(from)
      if (carriedSinks) {
        this.sessionSinks.delete(from)
        this.sessionSinks.set(
          next,
          new Set([
            ...(this.sessionSinks.get(next) ?? []),
            // Wrapped, not the bare function: a driver that keys registrations
            // by anything other than sink identity (a record per subscribe, the
            // usual shape) cannot recognize the control plane's re-attach as
            // the subscriber it just moved, so the tail ends up doubled.
            ...[...carriedSinks].map((sink) => (e: HarnessEvent) => {
              sink(e)
            }),
          ]),
        )
      }
    }

    const event: HarnessEvent = {
      type: 'session-updated',
      sessionId: next,
      previousSessionId: from,
      status: 'active',
    }
    switch (this.delivery) {
      case 'session-sinks-first':
        this.emitSession(from, event)
        this.emitRegistry(event)
        break
      case 'registry-first':
        this.emitRegistry(event)
        this.emitSession(from, event)
        break
      case 'registry-only':
        this.emitRegistry(event)
        break
      case 'new-id-sinks':
        this.emitRegistry(event)
        this.emitSession(next, event)
        break
    }
    return next
  }

  /** One ordinary event for a session — the "later events carry the new id" leg. */
  activity(sessionId: SessionId, text = 'tick'): void {
    this.emitSession(sessionId, { type: 'assistant-delta', sessionId, text })
  }

  /** Put an arbitrary event on the driver's registry stream (malformed rotations). */
  emitRaw(event: HarnessEvent): void {
    this.emitRegistry(event)
  }

  // -- HarnessDriver ---------------------------------------------------------

  startSession(opts: StartSessionOpts = {}): Promise<HarnessSessionSummary> {
    const native = opts.nativeSessionId ?? randomUUID()
    const sessionId = formatSessionId(this.harnessId, native)
    if (this.sessions.has(sessionId)) {
      return Promise.reject(
        new HarnessError('session_id_collision', `${sessionId} already exists`, {
          harnessId: this.harnessId,
          sessionId,
        }),
      )
    }
    const summary = this.summary(sessionId)
    this.sessions.set(sessionId, summary)
    this.transcripts.set(sessionId, [])
    this.emitRegistry({ type: 'session-created', sessionId, summary })
    return Promise.resolve(summary)
  }

  resumeSession(sessionId: SessionId): Promise<HarnessSessionSummary> {
    return Promise.resolve(this.require(sessionId))
  }

  interrupt(sessionId: SessionId): Promise<void> {
    this.require(sessionId)
    this.interrupts.push(sessionId)
    return Promise.resolve()
  }

  sendUserTurn(sessionId: SessionId, turn: UserTurn): Promise<void> {
    this.require(sessionId)
    this.turns.push({ sessionId, text: turn.text })
    this.transcripts.get(sessionId)?.push({ role: 'user', text: turn.text })
    return Promise.resolve()
  }

  resolveApproval(): Promise<void> {
    return Promise.reject(
      new HarnessError('capability_unsupported', 'fake driver has no approvals', {
        harnessId: this.harnessId,
      }),
    )
  }

  subscribe(sessionId: SessionId, sink: (e: HarnessEvent) => void): () => void {
    if (!this.capabilities.liveStream) {
      throw new HarnessError('capability_unsupported', 'fake driver has no live stream', {
        harnessId: this.harnessId,
        sessionId,
      })
    }
    this.subscribeCalls.push(sessionId)
    if (this.refuseSubscribeFor.has(sessionId)) {
      throw new HarnessError('capability_unsupported', `fake driver refuses ${sessionId}`, {
        harnessId: this.harnessId,
        sessionId,
      })
    }
    let set = this.sessionSinks.get(sessionId)
    if (!set) {
      set = new Set()
      this.sessionSinks.set(sessionId, set)
    }
    set.add(sink)
    this.hookSubscribe?.(sessionId)
    return () => {
      const current = this.sessionSinks.get(sessionId)
      if (!current) return
      current.delete(sink)
      if (current.size === 0) this.sessionSinks.delete(sessionId)
    }
  }

  subscribeEvents(sink: (e: HarnessEvent) => void): () => void {
    this.registrySinks.add(sink)
    return () => this.registrySinks.delete(sink)
  }

  listSessions(): Promise<HarnessSessionSummary[]> {
    const rows = [...this.stale].map((id) => this.summary(id, 'ended'))
    return Promise.resolve([...rows, ...this.sessions.values()])
  }

  getSession(sessionId: SessionId): Promise<HarnessSessionSummary | null> {
    return Promise.resolve(this.sessions.get(sessionId) ?? null)
  }

  transcript(sessionId: SessionId): Promise<{ turns: HarnessTranscriptTurn[] }> {
    this.require(sessionId)
    return Promise.resolve({ turns: this.transcripts.get(sessionId) ?? [] })
  }

  // -- internals -------------------------------------------------------------

  private require(sessionId: SessionId): HarnessSessionSummary {
    const row = this.sessions.get(sessionId)
    if (!row) {
      throw new HarnessError('invalid_session_id', `unknown session ${sessionId}`, {
        harnessId: this.harnessId,
        sessionId,
      })
    }
    return row
  }

  private summary(
    sessionId: SessionId,
    status: HarnessSessionSummary['status'] = 'idle',
  ): HarnessSessionSummary {
    const at = new Date().toISOString()
    return { sessionId, harnessId: this.harnessId, createdAt: at, updatedAt: at, status }
  }

  private emitSession(sessionId: SessionId, event: HarnessEvent): void {
    for (const sink of [...(this.sessionSinks.get(sessionId) ?? [])]) sink(event)
  }

  private emitRegistry(event: HarnessEvent): void {
    for (const sink of [...this.registrySinks]) sink(event)
  }
}
