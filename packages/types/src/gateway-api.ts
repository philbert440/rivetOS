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

export interface SessionMessage {
  id: string
  sessionId: string
  role: 'user' | 'assistant'
  text: string
  /** epoch ms */
  ts: number
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
  agent?: string
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

/** Frames on WS /api/sessions/ws (server → client only). */
export type SessionWsFrame =
  ({ kind: 'message' } & SessionMessage) | { kind: 'stream'; session: string; event: StreamEvent }

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
  /** Remote mesh entries carry no provider/model until mesh registration
   * advertises richer metadata (followups #272). */
  | { id: string; node: string; local: false }

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
