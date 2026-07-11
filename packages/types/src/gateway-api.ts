/**
 * Gateway HTTP + WS wire contracts.
 *
 * Single source of truth for every shape that crosses the gateway boundary
 * (den-server `/api/*` mounts). Handlers in core assert against these with
 * `satisfies`; `@rivetos/gateway-client` imports them verbatim. Nothing in
 * here may import runtime packages — wire DTOs only.
 *
 * Date encoding is intentionally uneven across families and mirrors what the
 * handlers actually emit: task/session/mesh rows carry epoch-ms numbers,
 * `/api/outcomes` re-emits its filter as ISO strings, and wiki timestamps are
 * opaque passthrough strings from git frontmatter.
 */

import type { StreamEvent } from './events.js'
import type {
  AcceptanceCriterion,
  ContextRef,
  EvalOutcome,
  HarnessExecutorCapabilities,
  TaskBudget,
  TaskExecutorKind,
  TaskResult,
  TaskStatus,
  TaskUsage,
} from './task.js'
import type { WikiIndexEntry } from './wiki.js'

/** Every non-2xx gateway response body. */
export interface GatewayErrorResponse {
  error: string
}

/**
 * Reserved for the client config / future auth phases. v1 supports 'none'
 * (tokenless LAN) and 'bearer' (gateway-token-file); 'device' is a
 * placeholder for per-device minting later.
 */
export type GatewayAuthMode = 'none' | 'bearer' | 'device'

export interface GatewayClientConfig {
  /** Origin of the node's gateway, e.g. `http://10.0.0.5:8080`. */
  baseUrl: string
  /** Bearer token; sent as `Authorization` on HTTP and `?token=` on WS. */
  token?: string
  /** Self-describing auth posture; defaults to 'bearer' when token is set,
   *  'none' otherwise. */
  authMode?: GatewayAuthMode
}

// ---------------------------------------------------------------------------
// /api/sessions
// ---------------------------------------------------------------------------

export interface SessionSummary {
  id: string
  /** epoch ms */
  lastActive: number
  /** message count currently held in the ring */
  messages: number
}

/** Token accounting for an assistant turn, when the harness reports it (Claude
 *  Code does, via its transcript). `completionTokens` is summed across the
 *  turn's requests (may span several tool rounds); `promptTokens` is the FINAL
 *  request's input — the context size at turn end — and includes cached input;
 *  `cachedTokens` is the cache-read portion of that. */
export interface MessageUsage {
  promptTokens: number
  completionTokens: number
  cachedTokens: number
}

export interface SessionMessage {
  id: string
  sessionId: string
  role: 'user' | 'assistant'
  text: string
  /** epoch ms */
  ts: number
  /** Token usage for the turn — assistant messages only, harness-dependent
   *  (absent when the harness doesn't report it). */
  usage?: MessageUsage
  /** Model that produced this message (e.g. 'claude-opus-4-8'), when known. */
  model?: string
  /** Wall-clock duration of the turn in ms, when known — powers tokens/sec. */
  durationMs?: number
  /** Thinking trace for the turn (harness-transcript sourced, tail-capped). */
  thinking?: string
  /** Tools the turn invoked, in call order (harness-transcript sourced). */
  tools?: HarnessTranscriptTool[]
}

export interface SessionsListResponse {
  sessions: SessionSummary[]
}

export interface SessionMessagesResponse {
  messages: SessionMessage[]
}

export interface SessionPostRequest {
  text: string
  userId?: string
  /** Agent/harness for this turn (Claude Code, grok Build, a local agent). */
  agent?: string
  /** Reasoning effort for this turn; falls back to the session's level.
   *  RivetHub persists it per-conversation (Claude-app style). */
  thinking?: 'off' | 'low' | 'medium' | 'high' | 'xhigh'
}

/** 202 from POST without `?wait` */
export interface SessionPostAccepted {
  accepted: true
  session: string
}

/** 200 from POST with `?wait` */
export interface SessionPostReply {
  message: SessionMessage
}

/**
 * Server-materialized transcript push (seamless modes v2). The gateway
 * watches the harness's on-disk store for sessions a client subscribed to
 * (see SessionWsClientMessage), reparses on change, and pushes versioned
 * turn deltas — the store file is the single source of truth, so chat can
 * never drift from the TUI. `from` is the splice index into the turn array;
 * a frame with from=0 is a full snapshot (always sent first after a watch).
 */
export interface TranscriptWsFrame {
  kind: 'transcript'
  session: string
  /** Monotonic per-session revision. A delta (from>0) applies iff it is the
   *  next rev the client expects; otherwise re-watch to get a snapshot. */
  rev: number
  from: number
  /** turns[from..] after the change */
  turns: HarnessTranscriptTurn[]
  /** total turn count after the change (guards splice misalignment) */
  total: number
  /** which harness store produced the turns ('' = none found yet) */
  command: string
}

/** Frames on WS /api/sessions/ws (server → client). */
export type SessionWsFrame =
  | ({ kind: 'message' } & SessionMessage)
  | { kind: 'stream'; session: string; event: StreamEvent }
  | TranscriptWsFrame
  /** a harness store changed somewhere — refetch the session drawer */
  | { kind: 'sessions-dirty' }

/** Client → server control messages on WS /api/sessions/ws. `sync` re-emits
 *  a full snapshot for an already-watched session (delta-gap recovery). */
export interface SessionWsClientMessage {
  type: 'watch' | 'unwatch' | 'sync'
  session: string
}

// ---------------------------------------------------------------------------
// /api/tasks
// ---------------------------------------------------------------------------

/**
 * Wire mirror of core's TaskRow (domain/task/store.ts toWire()). Core's row
 * type stays core-local; this is the contract clients rely on. The store's
 * TaskRow satisfies this shape — asserted in task-api.ts.
 */
export interface TaskWire {
  id: string
  goal: string
  contextRefs: ContextRef[]
  acceptanceCriteria: AcceptanceCriterion[]
  spec: Record<string, unknown>
  executor: TaskExecutorKind
  executorTarget?: string
  agentId: string
  requestedBy?: string
  origin: string
  parentTaskId?: string
  chainDepth: number
  nodeAffinity?: string
  claimedBy?: string
  budget: TaskBudget
  usage?: TaskUsage
  status: TaskStatus
  attempt: number
  maxAttempts: number
  pendingMessage?: string
  error?: string
  result?: TaskResult
  conversationId?: string
  sessionKey?: string
  harnessSessionIds: string[]
  eval?: EvalOutcome
  evalAttempt: number
  /** epoch ms */
  createdAt: number
  startedAt?: number
  lastHeartbeatAt?: number
  completedAt?: number
  durationMs?: number
}

export interface TaskCreateRequest {
  goal: string
  agentId: string
  executor?: TaskExecutorKind
  executorTarget?: string
  requestedBy?: string
  nodeAffinity?: string
  spec?: Record<string, unknown>
  budget?: TaskBudget
  contextRefs?: ContextRef[]
  acceptanceCriteria?: AcceptanceCriterion[]
}

export interface TaskResponse {
  task: TaskWire
}

export interface TasksListResponse {
  tasks: TaskWire[]
}

export interface TaskSteerRequest {
  message: string
}

export interface TaskSteerAccepted {
  ok: true
}

export interface TaskKillResponse {
  ok: true
  prior: TaskStatus | null
}

/**
 * 504 body from POST /api/tasks?wait=1 when the deadline kills the run — the
 * one error shape that carries a payload: the killed row when the store still
 * has it.
 */
export interface TaskWaitTimeoutResponse {
  error: string
  task?: TaskWire
}

// ---------------------------------------------------------------------------
// /api/catalog
// ---------------------------------------------------------------------------

export type CatalogAgent =
  /** model can be absent on agents whose provider resolves it lazily */
  | { id: string; provider: string; model?: string; node: string; local: true }
  /** Remote mesh entries: provider/model present when the owning node
   * advertised per-agent detail in its mesh registration (#272); absent on
   * older peers. */
  | { id: string; node: string; local: false; provider?: string; model?: string }

export interface CatalogCommand {
  name: string
  description: string
  argHint?: string
  source: string
}

export interface CatalogExecutorEntry {
  key: string
  capabilities: HarnessExecutorCapabilities
  commands: CatalogCommand[]
}

export interface CatalogSkillEntry {
  name: string
  description: string
}

export interface CatalogSheet {
  node: string
  agents: CatalogAgent[]
  executors: CatalogExecutorEntry[]
  tools: string[]
  skills: CatalogSkillEntry[]
}

export interface CatalogAgentsResponse {
  agents: CatalogAgent[]
}

// ---------------------------------------------------------------------------
// /api/outcomes
// ---------------------------------------------------------------------------

export interface OutcomeBucket {
  tasks: number
  completed: number
  failed: number
  verified: number
  refuted: number
  escalated: number
  diverged: number
  /** 0..1 */
  divergenceRate: number
  totalCostUsd?: number
  avgDurationMs?: number
}

export interface OutcomesResponse {
  filter: {
    /** ISO string (unlike the epoch-ms inputs) */
    since?: string
    until?: string
    agentId?: string
    origin?: string
  }
  totals: OutcomeBucket
  byAgent: Record<string, OutcomeBucket>
  byExecutor: Record<string, OutcomeBucket>
  byDay: Record<string, OutcomeBucket>
}

// ---------------------------------------------------------------------------
// /api/wiki — page/index shapes live in wiki.ts; only _gaps was untyped
// ---------------------------------------------------------------------------

export interface WikiGapsResponse {
  redLinks: { entity: string; referencedBy: string[] }[]
  stalest: WikiIndexEntry[]
}

// ---------------------------------------------------------------------------
// /api/mesh — den roster projection (distinct from mesh.ts MeshRegistry)
// ---------------------------------------------------------------------------

export interface MeshDenNode {
  id: string
  name: string
  denUrl: string
  online: boolean
  sessions: number | null
  /** only populated on the local node's entry */
  latest?: { activity: string; title: string } | null
}

export interface MeshOverview {
  /** epoch ms */
  updatedAt: number
  nodes: MeshDenNode[]
}

// ---------------------------------------------------------------------------
// /api/terminal — den's PTY surface (aliased to /term*; shapes are
// den-server-local literals mirrored here for clients, like /api/mesh)
// ---------------------------------------------------------------------------

export interface TermConfigResponse {
  enabled: boolean
  default: string
  maxPtys: number
  active: number
  commands: { id: string; label: string; room: boolean }[]
}

export interface TermSpawnRequest {
  /** roster key from TermConfigResponse.commands; default when omitted */
  command?: string
  /**
   * Conversation join key (seamless modes): when set, this PTY's denSession
   * IS this id and the harness runs with RIVETOS_SESSION_KEY=<session>, so
   * chat / den / terminal are three views of ONE session. Spawn is
   * spawn-or-get: an existing PTY for this session is returned, not a second.
   */
  session?: string
  /** Harness-native session id to resume (e.g. `claude --resume`) when the
   *  pool respawns a cold conversation. Reserved; wired with the pool. */
  resume?: string
  cols?: number
  rows?: number
}

export interface TermSpawnResponse {
  id: string
  denSession: string
  command: string
  pid: number
  /** epoch ms */
  createdAt: number
}

/**
 * Inject a chat turn into a conversation's live harness (seamless modes 5c):
 * the text is written to the session's PTY stdin — one server-side write path
 * owns stdin, so terminal attach can stay read-mostly. Requires a live PTY
 * for the session (spawn it first with TermSpawnRequest.session).
 */
export interface TermInjectRequest {
  /** conversation join key — the PTY spawned with this session */
  session: string
  text: string
  /** append the harness's submit key (CR) after the text; default true */
  submit?: boolean
  /** send Esc first to cancel the harness's in-flight turn, then paste after
   *  a settle — "inject now" on a queued message; default false */
  interrupt?: boolean
}

export interface TermInjectResponse {
  ok: true
  ptyId: string
}

export interface HarnessSession {
  id: string
  /** roster command it belongs to (e.g. 'claude') */
  command: string
  /** drawer label: first user message / summary, or the id */
  title: string
  /** epoch ms of last activity */
  updatedAt: number
}

export interface HarnessSessionsResponse {
  sessions: HarnessSession[]
}

/** One tool invocation recorded on an assistant transcript turn. */
export interface HarnessTranscriptTool {
  /** Harness tool name verbatim (e.g. 'Bash', 'mcp:rivetos:memory_search'). */
  name: string
  /** 'running' until the store records the matching tool result. */
  status: 'running' | 'done' | 'error'
  /** Summarized tool input (primitives only, strings capped) for titles. */
  args?: Record<string, unknown>
}

/** One turn from GET /api/terminal/harness-sessions/:id/transcript (TUI store). */
export interface HarnessTranscriptTurn {
  role: 'user' | 'assistant'
  text: string
  /** Accumulated thinking text for the turn (tail-capped server-side). */
  thinking?: string
  /** Tools the turn invoked, in call order (Claude Code stores only). */
  tools?: HarnessTranscriptTool[]
  /** Claude Code (and others that stamp usage on transcript lines). */
  usage?: MessageUsage
  /** Model id when present on the transcript line (e.g. claude-opus-4). */
  model?: string
}

/** Hard-resync payload: rebuild chat UI from the on-disk harness transcript. */
export interface HarnessTranscriptResponse {
  id: string
  /** Which harness produced the turns, or '' if none found. */
  command: string
  turns: HarnessTranscriptTurn[]
}

export interface PtyInfo {
  id: string
  denSession: string
  command: string
  state: 'running' | 'exited'
  pid: number
  /** currently attached WS clients */
  attached: number
  exitCode?: number | null
  /** epoch ms */
  createdAt: number
  lastOutputTs?: number
  cols: number
  rows: number
}

export interface TermListResponse {
  ptys: PtyInfo[]
}

/** First frame on WS /api/terminal/ws (JSON; everything after is binary
 *  scrollback/output, plus a final TermExitFrame). */
export interface TermHelloFrame {
  type: 'hello'
  v: 1
  id: string
  denSession: string
  command: string
  cols: number
  rows: number
  state: 'running' | 'exited'
  exitCode?: number | null
}

export interface TermExitFrame {
  type: 'exit'
  code: number | null
  signal?: string
}

/** Client → server JSON control frames (keystrokes ride as binary). */
export type TermControlFrame = { type: 'resize'; cols: number; rows: number } | { type: 'kill' }

// ---------------------------------------------------------------------------
// WS /api/notifications/ws (phase 4e) — ephemeral delivery; /api/outcomes is
// the durable escalation inbox.
// ---------------------------------------------------------------------------

export type NotificationFrame =
  | {
      kind: 'escalation'
      taskId: string
      agentId: string
      summary: string
      /** client-relative link to the task, e.g. `/tasks/<id>` */
      href: string
      /** epoch ms */
      ts: number
    }
  | { kind: 'task.done'; taskId: string; status: TaskStatus; ts: number }

// ---------------------------------------------------------------------------
// GET /api/events/sessions — the den's live session roster (reducer state).
// ---------------------------------------------------------------------------

/** One den session as reported by the den event reducer. */
export interface DenSessionInfo {
  id: string
  /** display name (falls back to the id server-side) */
  name: string
  /** harness that emitted the events (e.g. 'claude', 'grok') */
  harness?: string
  /** epoch ms of the most recent event */
  lastEventTs?: number
  /** id of a local PTY currently linked to this session, when one exists */
  pty?: string
}

export interface DenSessionsResponse {
  sessions: DenSessionInfo[]
}

// ---------------------------------------------------------------------------
// /api/files/* — shared filestore browser (path-fenced to the node's
// configured files root, `/rivet-shared` by default).
// ---------------------------------------------------------------------------

export interface FileEntry {
  name: string
  type: 'file' | 'dir'
  /** bytes; 0 for dirs */
  size: number
  /** epoch ms */
  mtime: number
}

export interface FilesListResponse {
  /** normalized path relative to the files root ('' = root) */
  path: string
  /** absolute root on the node, for display (e.g. '/rivet-shared') */
  root: string
  entries: FileEntry[]
}

export interface FilesUploadResponse {
  ok: true
  /** root-relative path of the written file */
  path: string
  bytes: number
}

// -- mesh device enrollment (Settings → Devices; den-server devices.ts) ------

export interface MeshDevice {
  id: string
  name: string
  publicKey: string
  address: string
  createdAt: number
  enrolledAt: number | null
  /** Unix ms of the peer's last WireGuard handshake; null = never/unknown. */
  lastHandshake: number | null
}

export interface MeshDevicePending {
  id: string
  name: string
  address: string
  expiresAt: number
}

export interface DeviceEnrollConfig {
  sharedHost: string
  sharedExport: string
  pgUrl: string
  embedUrl: string
  wgEndpoint: string
  wgPeerPublicKey: string
  wgAddress: string
  wgAllowedIps: string
  homeSubnet: string
}

/** The QR payload the desktop renders; the phone scans + redeems `token`. */
export interface DeviceEnrollQr {
  v: 1
  kind: 'rivet-mesh-enroll'
  gateway: string
  token: string
  config: DeviceEnrollConfig
}

export interface DevicesListResponse {
  devices: MeshDevice[]
  pending: MeshDevicePending[]
  relayConfigured: boolean
}

export interface DeviceOpenResponse {
  id: string
  name: string
  address: string
  expiresAt: number
  qr: DeviceEnrollQr
}
