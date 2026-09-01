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
      /**
       * Adoption edge (immutable session ids, plan W1): set when the session
       * enters the control plane as the continuation of an earlier id — e.g. a
       * fork declaring its lineage at birth. Append-only lineage, recorded on
       * the session record as a field; never an alias, so `supersedes` does not
       * occupy the alias namespace and resolves to nothing. Both ids MUST share
       * the same harness id.
       */
      supersedes?: SessionId
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
      /**
       * New-style rotation edge (immutable session ids, plan W1): the harness
       * replaced the native id UNDER this session (resume/fork/crash recovery)
       * and the canonical id does NOT change — `sessionId` stays THE id.
       * `supersedes` names the previous native id (as a full SessionId); both
       * ids MUST share the same harness id, and a self-edge is legal (the
       * first rotation off a client-minted id supersedes the canonical id
       * itself, whose native half was the original native id).
       *
       * The control plane records the edge on the session record as a field —
       * append-only lineage — and does NOT alias, re-key subscriptions, or
       * retire anything. `previousSessionId` remains for legacy drivers;
       * stage 3 deletes it once no driver emits it.
       */
      supersedes?: SessionId
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
  /**
   * Lineage field (immutable session ids, plan W1): the most recent
   * `supersedes` edge recorded for this session — the native id (as a full
   * SessionId) that the session's current native incarnation replaced. A
   * field on the record, not an alias-chain rebuild; the append-only lineage
   * is the sequence of these edges over time. On `listSessions` the control
   * plane stamps the latest edge IT recorded onto every row, so the record
   * and the list agree even when a driver failed to update its own row.
   */
  supersedes?: SessionId
}

export type StartSessionOpts = {
  cwd?: string
  model?: string
  /**
   * Client-minted canonical SessionId (immutable session ids, plan W1
   * stage 1). When the client supplies one, the control plane ACCEPTS it
   * verbatim — no adoption event, no alias entry — and passes it through
   * alongside `nativeSessionId` (its native half), so a driver that only
   * knows the pin honors it unchanged. Present only when the client minted
   * the id; when both are present they must agree.
   */
  sessionId?: SessionId
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

/** Cap for a session/turn system-prompt override. Same bound as `/api/agents`. */
export const SYSTEM_PROMPT_MAX_CHARS = 16_384

/**
 * PTY harnesses have no system-prompt channel, so the first injected turn
 * prefixes the override. Shared by den-server drivers and the hub raw-inject
 * path so the two cannot drift.
 */
export const SYSTEM_PROMPT_INJECT_HEADING = '[System instructions]'

export function prefixSystemPrompt(prompt: string, text: string): string {
  const trimmed = prompt.trim().slice(0, SYSTEM_PROMPT_MAX_CHARS)
  if (!trimmed) return text
  return `${SYSTEM_PROMPT_INJECT_HEADING}\n${trimmed}\n\n${text}`
}

export type UserTurn = {
  text: string
  /** `pathOrUri` must be node-resolvable — remote clients stage files through
   *  the gateway upload endpoint, never client filesystem paths. */
  attachments?: Array<{ mime: string; pathOrUri: string; name?: string }>
  /**
   * Optional system-prompt override for this session. Applied once on the
   * first turn that carries it (chat-loop appends to the workspace prompt;
   * PTY drivers prefix the injected text). Empty/omitted = no override.
   * Callers must cap at `SYSTEM_PROMPT_MAX_CHARS`.
   */
  systemPrompt?: string
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
