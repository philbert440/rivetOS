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
} from '@rivetos/types'

export const TASK_JOB_NAME = 'run-task'

/** graphile-worker job key for a task — one live job per task row. */
export function taskJobKey(taskId: string): string {
  return `task:${taskId}`
}

export interface NewTaskInput {
  goal: string
  executor: TaskExecutorKind
  executorTarget?: string
  agentId: string
  origin: 'heartbeat' | 'chat' | 'tool' | 'mesh' | 'api'
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

export interface TaskStore {
  /** Insert a queued task and enqueue its run-task job atomically. */
  create(input: NewTaskInput): Promise<TaskRow>

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

  /**
   * Flip a running task to awaiting-input (turn ended with no queued
   * message); the job completes and send() re-enqueues.
   */
  markAwaitingInput(id: string): Promise<void>

  /**
   * Steer/resume: stash the pending message and (re-)enqueue the run-task
   * job under the same jobKey with jobKeyMode 'replace'.
   */
  send(id: string, message: string): Promise<void>

  /** Merge usage after a turn and stamp last_heartbeat_at. */
  updateUsage(id: string, usage: TaskUsage): Promise<void>

  /** Liveness stamp while a turn is in flight. */
  heartbeat(id: string): Promise<void>

  /**
   * Startup crash sweep (Appendix C): 'running' rows claimed by this node
   * are requeued when attempt < max_attempts, else failed with
   * error='worker_restarted'. Returns the number of rows touched.
   */
  sweep(node: string): Promise<number>
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

  constructor(private enqueue?: (taskId: string) => void) {}

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
    row.status = 'running'
    row.startedAt = Date.now()
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

  markAwaitingInput(id: string): Promise<void> {
    const row = this.rows.get(id)
    if (!row || row.status !== 'running') return Promise.resolve()
    row.status = 'awaiting-input'
    row.pendingMessage = undefined
    return Promise.resolve()
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

  heartbeat(id: string): Promise<void> {
    const row = this.rows.get(id)
    if (row) row.lastHeartbeatAt = Date.now()
    return Promise.resolve()
  }

  sweep(node: string): Promise<number> {
    let n = 0
    for (const row of this.rows.values()) {
      if (row.status !== 'running' || row.claimedBy !== node) continue
      if (row.attempt < row.maxAttempts) {
        row.status = 'queued'
        this.enqueue?.(row.id)
      } else {
        row.status = 'failed'
        row.error = 'worker_restarted'
        row.completedAt = Date.now()
        row.durationMs = row.startedAt ? row.completedAt - row.startedAt : 0
      }
      n++
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
    createdAt: row.created_at.getTime(),
    startedAt: row.started_at?.getTime(),
    lastHeartbeatAt: row.last_heartbeat_at?.getTime(),
    completedAt: row.completed_at?.getTime(),
    durationMs: row.duration_ms ?? undefined,
  }
}

export interface PgTaskStoreOptions {
  /** graphile-worker schema — override only in tests. */
  graphileSchema?: string
}

export class PgTaskStore implements TaskStore {
  private graphileSchema: string

  constructor(
    private pool: pg.Pool,
    opts?: PgTaskStoreOptions,
  ) {
    this.graphileSchema = opts?.graphileSchema ?? 'graphile_worker'
    if (!/^[a-zA-Z0-9_]+$/.test(this.graphileSchema)) {
      throw new Error(`Invalid graphile schema name: ${this.graphileSchema}`)
    }
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
      await this.addJob(client, id)
      await client.query('COMMIT')
      return pgToPublic(rows[0])
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
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
             claimed_by = $2,
             attempt = attempt + 1
       WHERE id = $1
         AND status IN ('queued','awaiting-input')
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

  async markAwaitingInput(id: string): Promise<void> {
    await this.pool.query(
      `UPDATE ros_tasks
         SET status = 'awaiting-input',
             pending_message = NULL
       WHERE id = $1 AND status = 'running'`,
      [id],
    )
  }

  async send(id: string, message: string): Promise<void> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(`UPDATE ros_tasks SET pending_message = $2 WHERE id = $1`, [id, message])
      await this.addJob(client, id, { replace: true })
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

  async heartbeat(id: string): Promise<void> {
    await this.pool.query(`UPDATE ros_tasks SET last_heartbeat_at = now() WHERE id = $1`, [id])
  }

  async sweep(node: string): Promise<number> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const requeued = await client.query<{ id: string }>(
        `UPDATE ros_tasks
           SET status = 'queued'
         WHERE status = 'running' AND claimed_by = $1 AND attempt < max_attempts
         RETURNING id`,
        [node],
      )
      for (const { id } of requeued.rows) {
        await this.addJob(client, id, { replace: true })
      }
      const failed = await client.query(
        `UPDATE ros_tasks
           SET status = 'failed',
               error = 'worker_restarted',
               completed_at = now(),
               duration_ms = CASE WHEN started_at IS NULL THEN 0
                                  ELSE (EXTRACT(EPOCH FROM (now() - started_at)) * 1000)::int END
         WHERE status = 'running' AND claimed_by = $1`,
        [node],
      )
      await client.query('COMMIT')
      return (requeued.rowCount ?? 0) + (failed.rowCount ?? 0)
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
    opts?: { replace?: boolean },
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
        TASK_JOB_NAME,
        JSON.stringify({ taskId }),
        taskJobKey(taskId),
        opts?.replace ? 'replace' : 'preserve_run_at',
      ],
    )
  }
}
