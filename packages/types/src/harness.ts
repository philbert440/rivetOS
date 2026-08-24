/**
 * Harness control plane contract (Phase 2).
 *
 * RivetOS is a per-node control plane for coding harnesses: the harness owns
 * the coding loop (tools, model turns, approvals, interrupt) and Rivet owns
 * sessions, identity, capture/memory, den, mesh, tasks and the gateway. Every
 * harness — Claude Code, Grok Build, Kimi, Hermes, DeepSeek Harness — is
 * reachable through the one `HarnessDriver` interface below, keyed by one
 * `SessionId` format.
 *
 * Types only; the session-id runtime helpers live in `harness-session-id.ts`
 * (same split as `task.ts` / `task-result.ts`).
 *
 * Source of truth: docs/plans/harness-control-plane.md.
 */

/** Left half of SessionId. Fixed product tokens. */
export const HARNESS_IDS = [
  'claude-code',
  'grok-build',
  'kimi-code',
  'hermes',
  'deepseek-harness',
] as const
export type HarnessId = (typeof HARNESS_IDS)[number]

/**
 * Canonical identity: `<harness-id>:<native-session-id>`.
 *
 * The native half is an opaque host string and MAY contain `:` — split on the
 * FIRST colon only (see `parseSessionId`). Native ids must be
 * collision-resistant (UUID-class entropy): the capture store is mesh-shared,
 * so key entropy is the cross-node collision defense.
 */
export type SessionId = `${HarnessId}:${string}`

/**
 * Which optional driver methods are actually implemented. A method whose flag
 * is `false` MUST reject with `capability_unsupported` (gateway → HTTP 501);
 * UIs gate on the flags and treat the rejection as non-fatal.
 */
export type HarnessCapabilities = {
  interrupt: boolean
  resume: boolean
  approvals: boolean
  liveStream: boolean
  listSessions: boolean
}

/** `allow-session` scope = all future invocations of the same tool `name`
 *  within that session. Nothing broader. */
export type ApprovalDecision = 'allow' | 'deny' | 'allow-session'

export type HarnessEvent =
  | { type: 'assistant-delta'; sessionId: SessionId; text: string; turnId?: string }
  | {
      /**
       * Thinking text for the turn in flight — the twin of `assistant-delta`
       * for reasoning. Text only, deliberately: what a harness can observe of
       * its own thinking varies wildly (Claude Code's den hooks see spinner
       * status lines, an SDK driver sees real thinking blocks), and the
       * contract carries the one thing they all have. Presentation — whether a
       * chunk replaces or appends to what is showing — is the client's call.
       *
       * Live-tail only, like every other delta: the committed thinking comes
       * from the transcript on hard-resync.
       */
      type: 'reasoning-delta'
      sessionId: SessionId
      text: string
      turnId?: string
    }
  | {
      type: 'tool-use'
      sessionId: SessionId
      toolCallId: string
      name: string
      input: unknown
      turnId?: string
    }
  | {
      type: 'tool-result'
      sessionId: SessionId
      toolCallId: string
      name: string
      output: unknown
      isError?: boolean
      turnId?: string
    }
  | {
      type: 'approval-request'
      sessionId: SessionId
      requestId: string
      toolCallId?: string
      name: string
      input: unknown
      reason?: string
    }
  | {
      /** Broadcast to ALL subscribers so multi-client UIs clear stale prompts. */
      type: 'approval-resolved'
      sessionId: SessionId
      requestId: string
      decision: ApprovalDecision
    }
  | {
      /** Emitted on the driver-level registry stream for any new/discovered session. */
      type: 'session-created'
      sessionId: SessionId
      summary: SessionSummary
    }
  | {
      type: 'turn-complete'
      sessionId: SessionId
      turnId?: string
      /** 'end-turn' | 'interrupted' | 'error' | harness-specific string */
      stopReason?: string
    }
  | {
      type: 'error'
      sessionId: SessionId
      code: string
      message: string
      retryable?: boolean
    }
  | {
      type: 'session-updated'
      sessionId: SessionId
      /** Set when the native id rotates (compact/fork/crash recovery). The
       *  control plane stores `previousSessionId → sessionId` as an alias;
       *  both ids MUST share the same harness id. */
      previousSessionId?: SessionId
      status: 'active' | 'idle' | 'ended' | 'error'
    }

/** `idle` = session alive, no turn in flight; drivers emit `session-updated`
 *  on active↔idle transitions.
 *
 *  Re-exported from the package barrel as `HarnessSessionSummary` — the name
 *  `SessionSummary` is already taken there by the den chat-session summary in
 *  `gateway-api.ts`. */
export type SessionSummary = {
  sessionId: SessionId
  harnessId: HarnessId
  title?: string
  cwd?: string
  createdAt: string // ISO
  updatedAt: string
  status: 'active' | 'idle' | 'ended' | 'error'
}

export type StartSessionOpts = {
  cwd?: string
  model?: string
  /**
   * Pin a pre-minted native id for a BRAND-NEW session (e.g. task executors
   * that mint the id before spawning). Never attaches to an existing session:
   * if the native id already exists in the harness store, fail with
   * `session_id_collision`. Attaching to an existing session is
   * `resumeSession` only.
   */
  nativeSessionId?: string
  metadata?: Record<string, string>
}

export type UserTurn = {
  text: string
  /** `pathOrUri` must be node-resolvable — remote clients stage files through
   *  the gateway upload endpoint, never client filesystem paths. */
  attachments?: Array<{ mime: string; pathOrUri: string; name?: string }>
}

/**
 * Per-node driver. Gateway/hub never talk to harness binaries directly.
 *
 * Drivers only ever see canonical ids: alias resolution is control-plane-owned
 * and happens before dispatch, for every method including `subscribe`.
 */
export interface HarnessDriver {
  readonly harnessId: HarnessId
  readonly capabilities: HarnessCapabilities

  startSession(opts?: StartSessionOpts): Promise<SessionSummary>
  resumeSession(sessionId: SessionId): Promise<SessionSummary>
  interrupt(sessionId: SessionId): Promise<void>
  /** Rejects with `turn_in_flight` while a turn is running — v1 drivers MUST
   *  NOT silently queue. */
  sendUserTurn(sessionId: SessionId, turn: UserTurn): Promise<void>
  /** Rejects with `unknown_approval` for an unknown/expired `requestId`. */
  resolveApproval(
    sessionId: SessionId,
    requestId: string,
    decision: ApprovalDecision,
  ): Promise<void>
  /**
   * Live stream; returns unsubscribe. Gateway may fan-out.
   *
   * At-most-once live tail from attach time — no replay buffer, no sequence
   * numbers in v1. After a drop, clients re-`subscribe` and hard-resync missed
   * history from the transcript source of truth.
   *
   * Pin the sink to the id you were handed: **rotation is control-plane work.**
   * The gateway subscribes through the registry, which re-keys live sinks onto
   * the canonical id when it records the alias, so a client's subscription
   * survives a rotation without any driver consulting the alias store.
   */
  subscribe(sessionId: SessionId, sink: (e: HarnessEvent) => void): () => void
  /**
   * Driver-level registry stream (`session-created` / `session-updated` across
   * ALL of this driver's sessions) — backs `GET /harnesses/:id/events`.
   */
  subscribeEvents(sink: (e: HarnessEvent) => void): () => void
  /** Canonical ids only — superseded ids never appear. */
  listSessions(): Promise<SessionSummary[]>
  getSession(sessionId: SessionId): Promise<SessionSummary | null>
}
