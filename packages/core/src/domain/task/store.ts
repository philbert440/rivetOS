/**
 * TaskStore — persistence for the durable task engine (`ros_tasks`).
 *
 * Two implementations, mirroring subagent-store:
 *   - PgTaskStore       — durable; INSERT + graphile-worker add_job in ONE
 *                         transaction (jobKey `task:<id>`, maxAttempts 1)
 *   - InMemoryTaskStore — process-local (tests + pgUrl-less dev)
 *
 * Status lifecycle (see 0002_ros_tasks.sql):
 *   queued → running → completed | failed | killed | timeout
 *                    ↘ awaiting-input → (send) → running → …
 *
 * Claim is a CAS (Appendix C): only 'queued'/'awaiting-input' rows flip to
 * 'running'; concurrent claimers race and exactly one wins. On worker
 * startup, sweep() requeues (or fails) 'running' rows claimed by this node —
 * mid-flight execution does not resume, the row does.
 */

import type pg from 'pg'
import type {
  AcceptanceCriterion,
  ContextRef,
  TaskBudget,
  TaskExecutorKind,
  TaskResult,
  TaskStatus,
  TaskUsage,
  EvalOutcome,
} from '@rivetos/types'

export const TASK_JOB_NAME = 'run-task'

/**
 * graphile-worker task name for a row — per-node when affinity is set
 * ('run-task:<node>', Appendix E) so only the target node's runner ever
 * dequeues it; the global name serves unpinned rows.
 */
export function taskJobName(nodeAffinity?: string | null): string {
  return nodeAffinity ? `${TASK_JOB_NAME}:${nodeAffinity}` : TASK_JOB_NAME
}

/** graphile-worker job key for a task — one live job per task row. */
export function taskJobKey(taskId: string): string {
  return `task:${taskId}`
}

export interface NewTaskInput {
  goal: string
  executor: TaskExecutorKind
  executorTarget?: string
  agentId: string
  origin: 'heartbeat' | 'chat' | 'tool' | 'mesh' | 'api' | 'eval'
  requestedBy?: string
  contextRefs?: ContextRef[]
  acceptanceCriteria?: AcceptanceCriterion[]
  spec?: Record<string, unknown>
  budget?: TaskBudget
  parentTaskId?: string
  chainDepth?: number
  nodeAffinity?: string
  maxAttempts?: number
  conversationId?: string
}

export interface TaskRow {
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
  /** Evaluation outcome (phase 2d) — undefined until the eval loop settles. */
  eval?: EvalOutcome
  /** Verifier-driven retry counter (distinct from crash-recovery attempt). */
  evalAttempt: number
  createdAt: number
  startedAt?: number
  lastHeartbeatAt?: number
  completedAt?: number
  durationMs?: number
}

export interface TaskListFilter {
  status?: TaskStatus
  agentId?: string
  limit?: number
}

/** Terminal outcome for recordTerminal — audit rows that never run. */
export interface TerminalOutcome {
  status: Extract<TaskStatus, 'completed' | 'failed' | 'timeout' | 'killed'>
  result: TaskResult
  /** Epoch ms the recorded work actually started (defaults to now). */
  startedAt?: number
  durationMs?: number
}

export interface TaskStore {
  /** Insert a queued task and enqueue its run-task job atomically. */
  create(input: NewTaskInput): Promise<TaskRow>

  /**
   * Insert an already-terminal row with NO run-task job — the audit path for
   * work that executed elsewhere (sync delegation, cutover step (e)). The
   * trg_task_done notify trigger is AFTER UPDATE only, so a terminal INSERT
   * emits no ros_task_done notification — by design; nothing waits on it.
   */
  recordTerminal(input: NewTaskInput, outcome: TerminalOutcome): Promise<TaskRow>

  get(id: string): Promise<TaskRow | undefined>

  list(filter?: TaskListFilter): Promise<TaskRow[]>

  /**
   * CAS claim (Appendix C): flip queued/awaiting-input → running, stamp
   * started_at/claimed_by, bump attempt. Returns undefined when the row was
   * already claimed, terminal, or removed — the loser of a race gets nothing.
   */
  claim(id: string, node: string): Promise<TaskRow | undefined>

  /** Persist the terminal outcome: status + result + duration + completed_at. */
  finish(id: string, status: TaskStatus, result: TaskResult): Promise<void>

  /** Persist the evaluation outcome on a parent row (phase 2d) — does NOT
   *  touch status/result; the executor's verdict is never overwritten. */
  recordEval(id: string, outcome: EvalOutcome): Promise<void>

  /**
   * Durably stash retry state at the retry decision (phase 2e): bump
   * eval_attempt and stash the refutation scaffold as pending_message, so a
   * crash mid-retry re-claims into the resume path (goal never re-executes,
   * retry budget not reset) instead of replaying from scratch.
   */
  stashEvalRetry(id: string, attempt: number, steer: string): Promise<void>

  /**
   * Flip a running task to awaiting-input (turn ended with no queued
   * message); the job completes and send() re-enqueues.
   *
   * Guarded against the lost-message race: if a concurrent send() stashed a
   * pending_message between the last turn and this call, the flip is refused
   * (returns false) — the caller must takePendingMessage() and keep going
   * instead of parking.
   *
   * `interim` persists the turn's result snapshot alongside the park so
   * consumers (subagent_status) can read lastResponse/usage while the row is
   * awaiting-input — a parked row would otherwise carry no result at all.
   */
  markAwaitingInput(id: string, interim?: TaskResult): Promise<boolean>

  /**
   * Kill request: CAS flip any pre-terminal row (queued / awaiting-input /
   * running) to 'killed' and return its prior status; undefined when the row
   * is missing or already terminal. Killing 'running' does NOT abort the
   * in-flight turn — the runner re-reads the row at turn end and discards the
   * outcome (same "let it finish, drop the result" semantics as the legacy
   * subagent engine).
   */
  requestKill(id: string): Promise<TaskStatus | undefined>

  /**
   * Atomically read-and-clear pending_message (returns undefined when none).
   * Used when claiming an awaiting-input resume and when markAwaitingInput
   * loses the race against a concurrent send().
   */
  takePendingMessage(id: string): Promise<string | undefined>

  /**
   * Steer/resume: stash the pending message and (re-)enqueue the run-task
   * job under the same jobKey with jobKeyMode 'replace'.
   */
  send(id: string, message: string): Promise<void>

  /** Merge usage after a turn and stamp last_heartbeat_at. */
  updateUsage(id: string, usage: TaskUsage): Promise<void>

  /**
   * Append a harness spawn's session id to harness_session_ids (deduped).
   * Optional: only harness-session executors surface session ids.
   */
  appendHarnessSessionId?(id: string, sessionId: string): Promise<void>

  /** Liveness stamp while a turn is in flight. */
  heartbeat(id: string): Promise<void>

  /**
   * Startup crash sweep (Appendix C): 'running' rows claimed by this node
   * whose last_heartbeat_at is stale (older than the sweep window, default
   * 90s — an overlapping old process still heartbeats its rows and must not
   * be double-run) are requeued when attempt < max_attempts, else failed
   * with error='worker_restarted'. Also reaps parked 'awaiting-input' rows
   * older than their budget.maxWallClockMs (default 24h) → 'timeout'.
   * Returns the number of rows touched.
   */
  sweep(node: string): Promise<number>

  /** Present on PG-backed stores: false when the ros_tasks table is missing
   *  (migration not applied) — the runner must no-op, never crash boot. */
  isReady?(): Promise<boolean>

  /** Re-enqueue a queued row under its correct (per-node) job name — the
   *  stranding interim for mixed-version mesh windows (Appendix E). */
  reenqueue?(id: string): Promise<void>
}

/** Running rows with a heartbeat newer than this are NOT crash-swept. */
export const SWEEP_STALE_MS_DEFAULT = 90_000
/** Parked awaiting-input rows time out after budget.maxWallClockMs, else this. */
export const AWAITING_INPUT_TTL_MS_DEFAULT = 24 * 60 * 60 * 1000

export interface TaskStoreTuning {
  /** Heartbeat staleness window for the crash sweep (default 90s). */
  sweepStaleMs?: number
  /** Fallback TTL for parked awaiting-input rows (default 24h). */
  awaitingInputTtlMs?: number
}

function newTaskId(): string {
  return crypto.randomUUID()
}

// ---------------------------------------------------------------------------
// In-memory store — tests + pgUrl-less dev. No job queue: an optional
// enqueue callback stands in for graphile-worker.
// ---------------------------------------------------------------------------

export class InMemoryTaskStore implements TaskStore {
  private rows = new Map<string, TaskRow>()
  private sweepStaleMs: number
  private awaitingInputTtlMs: number

  constructor(
    private enqueue?: (taskId: string) => void,
    tuning?: TaskStoreTuning,
  ) {
    this.sweepStaleMs = tuning?.sweepStaleMs ?? SWEEP_STALE_MS_DEFAULT
    this.awaitingInputTtlMs = tuning?.awaitingInputTtlMs ?? AWAITING_INPUT_TTL_MS_DEFAULT
  }

  create(input: NewTaskInput): Promise<TaskRow> {
    const id = newTaskId()
    const row: TaskRow = {
      id,
      goal: input.goal,
      contextRefs: input.contextRefs ?? [],
      acceptanceCriteria: input.acceptanceCriteria ?? [],
      spec: input.spec ?? {},
      executor: input.executor,
      executorTarget: input.executorTarget,
      agentId: input.agentId,
      requestedBy: input.requestedBy,
      origin: input.origin,
      parentTaskId: input.parentTaskId,
      chainDepth: input.chainDepth ?? 0,
      nodeAffinity: input.nodeAffinity,
      budget: input.budget ?? {},
      status: 'queued',
      attempt: 0,
      evalAttempt: 0,
      maxAttempts: input.maxAttempts ?? 1,
      conversationId: input.conversationId,
      sessionKey: taskJobKey(id),
      harnessSessionIds: [],
      createdAt: Date.now(),
    }
    this.rows.set(id, row)
    this.enqueue?.(id)
    return Promise.resolve({ ...row })
  }

  recordTerminal(input: NewTaskInput, outcome: TerminalOutcome): Promise<TaskRow> {
    const id = newTaskId()
    const now = Date.now()
    const row: TaskRow = {
      id,
      goal: input.goal,
      contextRefs: input.contextRefs ?? [],
      acceptanceCriteria: input.acceptanceCriteria ?? [],
      spec: input.spec ?? {},
      executor: input.executor,
      executorTarget: input.executorTarget,
      agentId: input.agentId,
      requestedBy: input.requestedBy,
      origin: input.origin,
      parentTaskId: input.parentTaskId,
      chainDepth: input.chainDepth ?? 0,
      nodeAffinity: input.nodeAffinity,
      budget: input.budget ?? {},
      usage: outcome.result.usage,
      status: outcome.status,
      attempt: 1,
      evalAttempt: 0,
      maxAttempts: input.maxAttempts ?? 1,
      error: outcome.result.error,
      result: outcome.result,
      conversationId: input.conversationId,
      sessionKey: taskJobKey(id),
      harnessSessionIds: [],
      createdAt: outcome.startedAt ?? now,
      startedAt: outcome.startedAt ?? now,
      completedAt: now,
      durationMs: outcome.durationMs ?? (outcome.startedAt ? now - outcome.startedAt : 0),
    }
    this.rows.set(id, row)
    return Promise.resolve({ ...row })
  }

  get(id: string): Promise<TaskRow | undefined> {
    const row = this.rows.get(id)
    return Promise.resolve(row ? { ...row } : undefined)
  }

  list(filter?: TaskListFilter): Promise<TaskRow[]> {
    let rows = [...this.rows.values()]
    if (filter?.status) rows = rows.filter((r) => r.status === filter.status)
    if (filter?.agentId) rows = rows.filter((r) => r.agentId === filter.agentId)
    rows.sort((a, b) => b.createdAt - a.createdAt)
    return Promise.resolve(rows.slice(0, filter?.limit ?? 500).map((r) => ({ ...r })))
  }

  claim(id: string, node: string): Promise<TaskRow | undefined> {
    const row = this.rows.get(id)
    if (!row || (row.status !== 'queued' && row.status !== 'awaiting-input')) {
      return Promise.resolve(undefined)
    }
    // Affinity guard — mirror of the PG claim: pinned tasks only run on
    // their node.
    if (row.nodeAffinity && row.nodeAffinity !== node) {
      return Promise.resolve(undefined)
    }
    row.status = 'running'
    row.startedAt = Date.now()
    // Stamp liveness at claim so a fresh claim is never crash-swept before
    // the first periodic heartbeat fires.
    row.lastHeartbeatAt = Date.now()
    row.claimedBy = node
    row.attempt += 1
    return Promise.resolve({ ...row })
  }

  finish(id: string, status: TaskStatus, result: TaskResult): Promise<void> {
    const row = this.rows.get(id)
    if (!row) return Promise.resolve()
    row.status = status
    row.result = result
    row.usage = result.usage
    row.error = result.error
    row.pendingMessage = undefined
    row.completedAt = Date.now()
    row.durationMs = row.startedAt ? row.completedAt - row.startedAt : 0
    return Promise.resolve()
  }

  recordEval(id: string, outcome: EvalOutcome): Promise<void> {
    const row = this.rows.get(id)
    if (!row) return Promise.resolve()
    row.eval = outcome
    row.evalAttempt = outcome.attempts
    return Promise.resolve()
  }

  stashEvalRetry(id: string, attempt: number, steer: string): Promise<void> {
    const row = this.rows.get(id)
    if (!row) return Promise.resolve()
    row.evalAttempt = attempt
    row.pendingMessage = steer
    return Promise.resolve()
  }

  markAwaitingInput(id: string, interim?: TaskResult): Promise<boolean> {
    const row = this.rows.get(id)
    // pending_message guard: a concurrent send() wins — refuse the park so
    // the caller consumes the message instead of wiping it.
    if (!row || row.status !== 'running' || row.pendingMessage !== undefined) {
      return Promise.resolve(false)
    }
    row.status = 'awaiting-input'
    if (interim) row.result = interim
    // Freeze elapsed at park — a parked session reads as 'completed' to the
    // subagent surface, so its clock must not keep running.
    row.durationMs = row.startedAt ? Date.now() - row.startedAt : 0
    return Promise.resolve(true)
  }

  reenqueue(id: string): Promise<void> {
    const row = this.rows.get(id)
    if (row?.status === 'queued') this.enqueue?.(id)
    return Promise.resolve()
  }

  requestKill(id: string): Promise<TaskStatus | undefined> {
    const row = this.rows.get(id)
    if (!row || !['queued', 'awaiting-input', 'running'].includes(row.status)) {
      return Promise.resolve(undefined)
    }
    const prior = row.status
    row.status = 'killed'
    row.completedAt = Date.now()
    row.error = row.error ?? 'Killed by parent'
    row.durationMs = row.startedAt ? row.completedAt - row.startedAt : 0
    return Promise.resolve(prior)
  }

  takePendingMessage(id: string): Promise<string | undefined> {
    const row = this.rows.get(id)
    if (!row || row.pendingMessage === undefined) return Promise.resolve(undefined)
    const message = row.pendingMessage
    row.pendingMessage = undefined
    return Promise.resolve(message)
  }

  send(id: string, message: string): Promise<void> {
    const row = this.rows.get(id)
    if (!row) return Promise.resolve()
    row.pendingMessage = message
    this.enqueue?.(id)
    return Promise.resolve()
  }

  updateUsage(id: string, usage: TaskUsage): Promise<void> {
    const row = this.rows.get(id)
    if (!row) return Promise.resolve()
    row.usage = usage
    row.lastHeartbeatAt = Date.now()
    return Promise.resolve()
  }

  appendHarnessSessionId(id: string, sessionId: string): Promise<void> {
    const row = this.rows.get(id)
    if (row && !row.harnessSessionIds.includes(sessionId)) {
      row.harnessSessionIds.push(sessionId)
    }
    return Promise.resolve()
  }

  heartbeat(id: string): Promise<void> {
    const row = this.rows.get(id)
    if (row) row.lastHeartbeatAt = Date.now()
    return Promise.resolve()
  }

  sweep(node: string): Promise<number> {
    const now = Date.now()
    let n = 0
    for (const row of this.rows.values()) {
      if (row.claimedBy !== node) continue

      if (row.status === 'running') {
        // Heartbeat-fresh rows belong to an overlapping old process that is
        // still executing — leave them alone (no double-run on restart).
        const fresh =
          row.lastHeartbeatAt !== undefined && now - row.lastHeartbeatAt < this.sweepStaleMs
        if (fresh) continue
        if (row.attempt < row.maxAttempts) {
          row.status = 'queued'
          this.enqueue?.(row.id)
        } else {
          row.status = 'failed'
          row.error = 'worker_restarted'
          row.completedAt = now
          row.durationMs = row.startedAt ? now - row.startedAt : 0
        }
        n++
      } else if (row.status === 'awaiting-input') {
        // Parked-task reaper: expire rows nobody resumed within their budget.
        const ttl = row.budget.maxWallClockMs ?? this.awaitingInputTtlMs
        const parkedSince = row.lastHeartbeatAt ?? row.createdAt
        if (now - parkedSince < ttl) continue
        row.status = 'timeout'
        row.error = 'awaiting-input expired'
        row.completedAt = now
        row.durationMs = row.startedAt ? now - row.startedAt : 0
        n++
      }
    }
    return Promise.resolve(n)
  }
}

// ---------------------------------------------------------------------------
// Postgres store — durable; backed by ros_tasks + graphile_worker.add_job.
// ---------------------------------------------------------------------------

interface PgTaskRow {
  id: string
  goal: string
  context_refs: ContextRef[]
  acceptance_criteria: AcceptanceCriterion[]
  spec: Record<string, unknown>
  executor: TaskExecutorKind
  executor_target: string | null
  agent_id: string
  requested_by: string | null
  origin: string
  parent_task_id: string | null
  chain_depth: number
  node_affinity: string | null
  claimed_by: string | null
  budget: TaskBudget
  usage: TaskUsage | null
  status: TaskStatus
  attempt: number
  max_attempts: number
  pending_message: string | null
  error: string | null
  result: TaskResult | null
  conversation_id: string | null
  session_key: string | null
  harness_session_ids: string[]
  eval: EvalOutcome | null
  eval_attempt: number
  created_at: Date
  started_at: Date | null
  last_heartbeat_at: Date | null
  completed_at: Date | null
  duration_ms: number | null
}

function pgToPublic(row: PgTaskRow): TaskRow {
  return {
    id: row.id,
    goal: row.goal,
    contextRefs: row.context_refs,
    acceptanceCriteria: row.acceptance_criteria,
    spec: row.spec,
    executor: row.executor,
    executorTarget: row.executor_target ?? undefined,
    agentId: row.agent_id,
    requestedBy: row.requested_by ?? undefined,
    origin: row.origin,
    parentTaskId: row.parent_task_id ?? undefined,
    chainDepth: row.chain_depth,
    nodeAffinity: row.node_affinity ?? undefined,
    claimedBy: row.claimed_by ?? undefined,
    budget: row.budget,
    usage: row.usage ?? undefined,
    status: row.status,
    attempt: row.attempt,
    maxAttempts: row.max_attempts,
    pendingMessage: row.pending_message ?? undefined,
    error: row.error ?? undefined,
    result: row.result ?? undefined,
    conversationId: row.conversation_id ?? undefined,
    sessionKey: row.session_key ?? undefined,
    harnessSessionIds: row.harness_session_ids,
    eval: row.eval ?? undefined,
    evalAttempt: row.eval_attempt,
    createdAt: row.created_at.getTime(),
    startedAt: row.started_at?.getTime(),
    lastHeartbeatAt: row.last_heartbeat_at?.getTime(),
    completedAt: row.completed_at?.getTime(),
    durationMs: row.duration_ms ?? undefined,
  }
}

export interface PgTaskStoreOptions extends TaskStoreTuning {
  /** graphile-worker schema — override only in tests. */
  graphileSchema?: string
}

export class PgTaskStore implements TaskStore {
  private graphileSchema: string
  private sweepStaleMs: number
  private awaitingInputTtlMs: number

  constructor(
    private pool: pg.Pool,
    opts?: PgTaskStoreOptions,
  ) {
    this.graphileSchema = opts?.graphileSchema ?? 'graphile_worker'
    if (!/^[a-zA-Z0-9_]+$/.test(this.graphileSchema)) {
      throw new Error(`Invalid graphile schema name: ${this.graphileSchema}`)
    }
    this.sweepStaleMs = opts?.sweepStaleMs ?? SWEEP_STALE_MS_DEFAULT
    this.awaitingInputTtlMs = opts?.awaitingInputTtlMs ?? AWAITING_INPUT_TTL_MS_DEFAULT
  }

  /** False when the ros_tasks table is missing (0002 migration not applied).
   *  The runner checks this before sweeping so boot never crash-loops on a
   *  node whose memory DB hasn't been migrated yet. */
  async isReady(): Promise<boolean> {
    const { rows } = await this.pool.query<{ reg: string | null }>(
      `SELECT to_regclass('ros_tasks') AS reg`,
    )
    return rows[0]?.reg != null
  }

  /** INSERT + add_job under the same transaction — a task row without a job
   *  (or a job without a row) can never exist. */
  async create(input: NewTaskInput): Promise<TaskRow> {
    const id = newTaskId()
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const { rows } = await client.query<PgTaskRow>(
        `INSERT INTO ros_tasks
           (id, goal, context_refs, acceptance_criteria, spec, executor,
            executor_target, agent_id, requested_by, origin, parent_task_id,
            chain_depth, node_affinity, budget, max_attempts, conversation_id,
            session_key)
         VALUES ($1, $2, $3::jsonb, $4::jsonb, $5::jsonb, $6, $7, $8, $9, $10,
                 $11, $12, $13, $14::jsonb, $15, $16, $17)
         RETURNING *`,
        [
          id,
          input.goal,
          JSON.stringify(input.contextRefs ?? []),
          JSON.stringify(input.acceptanceCriteria ?? []),
          JSON.stringify(input.spec ?? {}),
          input.executor,
          input.executorTarget ?? null,
          input.agentId,
          input.requestedBy ?? null,
          input.origin,
          input.parentTaskId ?? null,
          input.chainDepth ?? 0,
          input.nodeAffinity ?? null,
          JSON.stringify(input.budget ?? {}),
          input.maxAttempts ?? 1,
          input.conversationId ?? null,
          taskJobKey(id),
        ],
      )
      await this.addJob(client, id, { nodeAffinity: input.nodeAffinity })
      await client.query('COMMIT')
      return pgToPublic(rows[0])
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  }

  async recordTerminal(input: NewTaskInput, outcome: TerminalOutcome): Promise<TaskRow> {
    const id = newTaskId()
    const { rows } = await this.pool.query<PgTaskRow>(
      `INSERT INTO ros_tasks
         (id, goal, context_refs, acceptance_criteria, spec, executor,
          executor_target, agent_id, requested_by, origin, parent_task_id,
          chain_depth, budget, usage, max_attempts, attempt, status, error,
          result, session_key, created_at, started_at, completed_at, duration_ms)
       VALUES ($1, $2, $3::jsonb, $4::jsonb, $5::jsonb, $6, $7, $8, $9, $10,
               $11, $12, $13::jsonb, $14::jsonb, $15, 1, $16, $17, $18::jsonb,
               $19, to_timestamp($20 / 1000.0), to_timestamp($20 / 1000.0), now(), $21)
       RETURNING *`,
      [
        id,
        input.goal,
        JSON.stringify(input.contextRefs ?? []),
        JSON.stringify(input.acceptanceCriteria ?? []),
        JSON.stringify(input.spec ?? {}),
        input.executor,
        input.executorTarget ?? null,
        input.agentId,
        input.requestedBy ?? null,
        input.origin,
        input.parentTaskId ?? null,
        input.chainDepth ?? 0,
        JSON.stringify(input.budget ?? {}),
        JSON.stringify(outcome.result.usage),
        input.maxAttempts ?? 1,
        outcome.status,
        outcome.result.error ?? null,
        JSON.stringify(outcome.result),
        taskJobKey(id),
        outcome.startedAt ?? Date.now(),
        outcome.durationMs ?? (outcome.startedAt != null ? Date.now() - outcome.startedAt : 0),
      ],
    )
    return pgToPublic(rows[0])
  }

  async get(id: string): Promise<TaskRow | undefined> {
    const { rows } = await this.pool.query<PgTaskRow>(`SELECT * FROM ros_tasks WHERE id = $1`, [id])
    return rows[0] ? pgToPublic(rows[0]) : undefined
  }

  async list(filter?: TaskListFilter): Promise<TaskRow[]> {
    const clauses: string[] = []
    const params: unknown[] = []
    if (filter?.status) {
      params.push(filter.status)
      clauses.push(`status = $${String(params.length)}`)
    }
    if (filter?.agentId) {
      params.push(filter.agentId)
      clauses.push(`agent_id = $${String(params.length)}`)
    }
    params.push(filter?.limit ?? 500)
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''
    const { rows } = await this.pool.query<PgTaskRow>(
      `SELECT * FROM ros_tasks ${where} ORDER BY created_at DESC LIMIT $${String(params.length)}`,
      params,
    )
    return rows.map(pgToPublic)
  }

  async claim(id: string, node: string): Promise<TaskRow | undefined> {
    const { rows } = await this.pool.query<PgTaskRow>(
      `UPDATE ros_tasks
         SET status = 'running',
             started_at = now(),
             -- Liveness stamp at claim: a fresh claim must never be
             -- crash-swept before the first periodic heartbeat fires.
             last_heartbeat_at = now(),
             claimed_by = $2,
             attempt = attempt + 1
       WHERE id = $1
         AND status IN ('queued','awaiting-input')
         -- Affinity guard: a task pinned to another node must not run here,
         -- even if its job lands in this node's queue (gateway dispatch).
         AND (node_affinity IS NULL OR node_affinity = $2)
       RETURNING *`,
      [id, node],
    )
    return rows[0] ? pgToPublic(rows[0]) : undefined
  }

  async finish(id: string, status: TaskStatus, result: TaskResult): Promise<void> {
    await this.pool.query(
      `UPDATE ros_tasks
         SET status = $2,
             result = $3::jsonb,
             usage = $4::jsonb,
             error = $5,
             pending_message = NULL,
             completed_at = now(),
             duration_ms = CASE WHEN started_at IS NULL THEN 0
                                ELSE (EXTRACT(EPOCH FROM (now() - started_at)) * 1000)::int END
       WHERE id = $1`,
      [id, status, JSON.stringify(result), JSON.stringify(result.usage), result.error ?? null],
    )
  }

  async recordEval(id: string, outcome: EvalOutcome): Promise<void> {
    await this.pool.query(
      `UPDATE ros_tasks SET eval = $2::jsonb, eval_attempt = $3 WHERE id = $1`,
      [id, JSON.stringify(outcome), outcome.attempts],
    )
  }

  async stashEvalRetry(id: string, attempt: number, steer: string): Promise<void> {
    await this.pool.query(
      `UPDATE ros_tasks SET eval_attempt = $2, pending_message = $3
       WHERE id = $1 AND status = 'running'`,
      [id, attempt, steer],
    )
  }

  async markAwaitingInput(id: string, interim?: TaskResult): Promise<boolean> {
    // pending_message guard: a concurrent send() stashed a message — refuse
    // the park (and DON'T wipe the message); the caller consumes it via
    // takePendingMessage() and keeps the turn loop going.
    const { rowCount } = await this.pool.query(
      `UPDATE ros_tasks
         SET status = 'awaiting-input',
             result = COALESCE($2, result),
             duration_ms = CASE WHEN started_at IS NULL THEN 0
                                ELSE (EXTRACT(EPOCH FROM (now() - started_at)) * 1000)::int END
       WHERE id = $1 AND status = 'running' AND pending_message IS NULL`,
      [id, interim ? JSON.stringify(interim) : null],
    )
    return (rowCount ?? 0) > 0
  }

  async requestKill(id: string): Promise<TaskStatus | undefined> {
    const { rows } = await this.pool.query<{ prior: TaskStatus }>(
      `UPDATE ros_tasks t
         SET status = 'killed',
             completed_at = now(),
             error = COALESCE(t.error, 'Killed by parent'),
             duration_ms = CASE WHEN t.started_at IS NULL THEN 0
                                ELSE (EXTRACT(EPOCH FROM (now() - t.started_at)) * 1000)::int END
        FROM (SELECT id, status AS prior FROM ros_tasks
               WHERE id = $1 AND status IN ('queued','awaiting-input','running')
               FOR UPDATE) p
       WHERE t.id = p.id
       RETURNING p.prior`,
      [id],
    )
    return rows[0]?.prior
  }

  async takePendingMessage(id: string): Promise<string | undefined> {
    const { rows } = await this.pool.query<{ pending_message: string | null }>(
      `WITH taken AS (
         SELECT id, pending_message FROM ros_tasks
          WHERE id = $1 AND pending_message IS NOT NULL
          FOR UPDATE
       )
       UPDATE ros_tasks SET pending_message = NULL
         FROM taken
        WHERE ros_tasks.id = taken.id
        RETURNING taken.pending_message`,
      [id],
    )
    return rows[0]?.pending_message ?? undefined
  }

  async send(id: string, message: string): Promise<void> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const { rows } = await client.query<{ node_affinity: string | null }>(
        `UPDATE ros_tasks SET pending_message = $2 WHERE id = $1 RETURNING node_affinity`,
        [id, message],
      )
      await this.addJob(client, id, { replace: true, nodeAffinity: rows[0]?.node_affinity })
      await client.query('COMMIT')
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  }

  async updateUsage(id: string, usage: TaskUsage): Promise<void> {
    await this.pool.query(
      `UPDATE ros_tasks SET usage = $2::jsonb, last_heartbeat_at = now() WHERE id = $1`,
      [id, JSON.stringify(usage)],
    )
  }

  async appendHarnessSessionId(id: string, sessionId: string): Promise<void> {
    await this.pool.query(
      `UPDATE ros_tasks
         SET harness_session_ids = harness_session_ids || to_jsonb($2::text)
       WHERE id = $1 AND NOT (harness_session_ids @> to_jsonb($2::text))`,
      [id, sessionId],
    )
  }

  async heartbeat(id: string): Promise<void> {
    await this.pool.query(`UPDATE ros_tasks SET last_heartbeat_at = now() WHERE id = $1`, [id])
  }

  async sweep(node: string): Promise<number> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      // Heartbeat window: rows with a fresh last_heartbeat_at belong to an
      // overlapping old process that is still executing (systemd restart) —
      // sweeping them would double-run the task.
      const stale = `(last_heartbeat_at IS NULL
                      OR last_heartbeat_at < now() - ($2::bigint * interval '1 millisecond'))`
      const requeued = await client.query<{ id: string }>(
        `UPDATE ros_tasks
           SET status = 'queued'
         WHERE status = 'running' AND claimed_by = $1 AND attempt < max_attempts
           AND ${stale}
         RETURNING id, node_affinity`,
        [node, this.sweepStaleMs],
      )
      for (const row of requeued.rows as Array<{ id: string; node_affinity: string | null }>) {
        await this.addJob(client, row.id, { replace: true, nodeAffinity: row.node_affinity })
      }
      const failed = await client.query(
        `UPDATE ros_tasks
           SET status = 'failed',
               error = 'worker_restarted',
               completed_at = now(),
               duration_ms = CASE WHEN started_at IS NULL THEN 0
                                  ELSE (EXTRACT(EPOCH FROM (now() - started_at)) * 1000)::int END
         WHERE status = 'running' AND claimed_by = $1
           AND ${stale}`,
        [node, this.sweepStaleMs],
      )
      // Parked-task reaper: awaiting-input rows nobody resumed within their
      // budget.maxWallClockMs (fallback: the store TTL, default 24h) expire.
      const reaped = await client.query(
        `UPDATE ros_tasks
           SET status = 'timeout',
               error = 'awaiting-input expired',
               completed_at = now(),
               duration_ms = CASE WHEN started_at IS NULL THEN 0
                                  ELSE (EXTRACT(EPOCH FROM (now() - started_at)) * 1000)::int END
         WHERE status = 'awaiting-input' AND claimed_by = $1
           AND COALESCE(last_heartbeat_at, created_at)
               < now() - (COALESCE((budget->>'maxWallClockMs')::bigint, $2::bigint)
                          * interval '1 millisecond')`,
        [node, this.awaitingInputTtlMs],
      )
      await client.query('COMMIT')
      return (requeued.rowCount ?? 0) + (failed.rowCount ?? 0) + (reaped.rowCount ?? 0)
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  }

  /** Enqueue the run-task job via SQL so it can share the row's transaction. */
  private async addJob(
    client: pg.PoolClient,
    taskId: string,
    opts?: { replace?: boolean; nodeAffinity?: string | null },
  ): Promise<void> {
    await client.query(
      `SELECT ${this.graphileSchema}.add_job(
         $1,
         payload => $2::json,
         job_key => $3,
         max_attempts => 1,
         job_key_mode => $4
       )`,
      [
        taskJobName(opts?.nodeAffinity),
        JSON.stringify({ taskId }),
        taskJobKey(taskId),
        opts?.replace ? 'replace' : 'preserve_run_at',
      ],
    )
  }

  /**
   * Re-enqueue a queued row under its correct (per-node) job name — the
   * stranding interim for mixed-version windows where an old node enqueued a
   * pinned row on the global name and a wrong-node worker consumed the job.
   */
  async reenqueue(id: string): Promise<void> {
    const client = await this.pool.connect()
    try {
      const { rows } = await client.query<{ node_affinity: string | null }>(
        `SELECT node_affinity FROM ros_tasks WHERE id = $1 AND status = 'queued'`,
        [id],
      )
      if (rows.length === 0) return
      await this.addJob(client, id, { replace: true, nodeAffinity: rows[0].node_affinity })
    } finally {
      client.release()
    }
  }
}
