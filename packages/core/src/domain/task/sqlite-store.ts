/**
 * SqliteTaskStore — ros_tasks on a single file, no Postgres and no job table.
 *
 * Schema matches 0002_ros_tasks.sql + the eval columns from 0004_task_eval.sql.
 * UUID and JSONB columns are TEXT; timestamps are ISO-8601 TEXT. There is no
 * notify trigger — waiters use the poll-only completion waiter. Queueing is
 * the optional enqueue callback, same as InMemoryTaskStore.
 *
 * Postgres behaviour is untouched. If a node has both pgUrl and this file,
 * boot keeps PgTaskStore.
 */

import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import type {
  AcceptanceCriterion,
  ContextRef,
  EvalOutcome,
  TaskBudget,
  TaskExecutorKind,
  TaskPermissionDecision,
  TaskResult,
  TaskStatus,
  TaskUsage,
} from '@rivetos/types'
import {
  AWAITING_INPUT_TTL_MS_DEFAULT,
  SWEEP_STALE_MS_DEFAULT,
  TaskTerminalNotify,
  callerSpec,
  isTerminalTaskStatus,
  taskJobKey,
  type NewTaskInput,
  type OutcomeFilter,
  type OutcomeRow,
  type TaskListFilter,
  type TaskRow,
  type TaskStore,
  type TaskStoreTuning,
  type TaskTerminalListener,
  type TerminalOutcome,
} from './store.js'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS ros_tasks (
    id                  TEXT PRIMARY KEY,
    goal                TEXT NOT NULL,
    context_refs        TEXT NOT NULL DEFAULT '[]',
    acceptance_criteria TEXT NOT NULL DEFAULT '[]',
    spec                TEXT NOT NULL DEFAULT '{}',
    executor            TEXT NOT NULL CHECK (executor IN ('chat-loop','harness-session','mesh')),
    executor_target     TEXT,
    agent_id            TEXT NOT NULL,
    requested_by        TEXT,
    origin              TEXT NOT NULL CHECK (origin IN ('heartbeat','chat','tool','mesh','api','eval')),
    parent_task_id      TEXT REFERENCES ros_tasks(id) ON DELETE SET NULL,
    chain_depth         INTEGER NOT NULL DEFAULT 0,
    node_affinity       TEXT,
    claimed_by          TEXT,
    budget              TEXT NOT NULL DEFAULT '{}',
    usage               TEXT,
    status              TEXT NOT NULL DEFAULT 'queued'
                        CHECK (status IN ('queued','running','awaiting-input',
                                          'completed','failed','killed','timeout')),
    attempt             INTEGER NOT NULL DEFAULT 0,
    max_attempts        INTEGER NOT NULL DEFAULT 1,
    pending_message     TEXT,
    error               TEXT,
    result              TEXT,
    conversation_id     TEXT,
    session_key         TEXT,
    harness_session_ids TEXT NOT NULL DEFAULT '[]',
    eval                TEXT,
    eval_attempt        INTEGER NOT NULL DEFAULT 0,
    created_at          TEXT NOT NULL,
    started_at          TEXT,
    last_heartbeat_at   TEXT,
    completed_at        TEXT,
    duration_ms         INTEGER
);
CREATE INDEX IF NOT EXISTS idx_ros_tasks_active ON ros_tasks (status, created_at)
    WHERE status IN ('queued','running','awaiting-input');
CREATE INDEX IF NOT EXISTS idx_ros_tasks_agent  ON ros_tasks (agent_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ros_tasks_parent ON ros_tasks (parent_task_id) WHERE parent_task_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ros_tasks_origin ON ros_tasks (origin, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ros_tasks_node   ON ros_tasks (node_affinity, status) WHERE node_affinity IS NOT NULL;

CREATE VIEW IF NOT EXISTS ros_task_outcomes_v AS
SELECT
    t.id,
    t.agent_id,
    t.executor,
    t.executor_target,
    t.origin,
    substr(t.completed_at, 1, 10) AS day,
    t.status,
    json_extract(t.result, '$.verdict') AS executor_verdict,
    json_extract(t.eval, '$.verdict') AS eval_verdict,
    CASE
      WHEN json_extract(t.result, '$.verdict') = 'completed'
       AND json_extract(t.eval, '$.verdict') = 'refuted'
      THEN 1 ELSE 0
    END AS diverged,
    json_extract(t.usage, '$.costUsd') AS cost_usd,
    t.eval_attempt,
    t.duration_ms
FROM ros_tasks t
WHERE t.status IN ('completed','failed','killed','timeout')
  AND t.origin <> 'eval'
  AND json_type(t.spec, '$.auditOnly') IS NOT 'true'
  AND json_array_length(t.acceptance_criteria) > 0;
`

interface SqliteTaskRow {
  id: string
  goal: string
  context_refs: string
  acceptance_criteria: string
  spec: string
  executor: TaskExecutorKind
  executor_target: string | null
  agent_id: string
  requested_by: string | null
  origin: string
  parent_task_id: string | null
  chain_depth: number
  node_affinity: string | null
  claimed_by: string | null
  budget: string
  usage: string | null
  status: TaskStatus
  attempt: number
  max_attempts: number
  pending_message: string | null
  error: string | null
  result: string | null
  conversation_id: string | null
  session_key: string | null
  harness_session_ids: string
  eval: string | null
  eval_attempt: number
  created_at: string
  started_at: string | null
  last_heartbeat_at: string | null
  completed_at: string | null
  duration_ms: number | null
}

function iso(ms: number): string {
  return new Date(ms).toISOString()
}

function epoch(value: string | null): number | undefined {
  if (!value) return undefined
  const n = Date.parse(value)
  if (!Number.isFinite(n)) throw new Error(`ros_tasks timestamp is not ISO-8601: ${value}`)
  return n
}

function jsonText(value: unknown): string {
  return JSON.stringify(value ?? null)
}

function parseJson<T>(raw: string | null, fallback: T): T {
  if (raw == null || raw === '') return fallback
  return JSON.parse(raw) as T
}

/** Elapsed ms. julianday accepts the Z-suffixed ISO text node:sqlite stores. */
const DURATION_SQL = `CASE WHEN started_at IS NULL THEN 0
  ELSE CAST((julianday(?) - julianday(started_at)) * 86400000 AS INTEGER) END`

function sqliteToPublic(row: SqliteTaskRow): TaskRow {
  const usage = row.usage ? parseJson<TaskUsage | null>(row.usage, null) : null
  const result = row.result ? parseJson<TaskResult | null>(row.result, null) : null
  const evalOutcome = row.eval ? parseJson<EvalOutcome | null>(row.eval, null) : null
  return {
    id: row.id,
    goal: row.goal,
    contextRefs: parseJson<ContextRef[]>(row.context_refs, []),
    acceptanceCriteria: parseJson<AcceptanceCriterion[]>(row.acceptance_criteria, []),
    spec: parseJson<Record<string, unknown>>(row.spec, {}),
    executor: row.executor,
    executorTarget: row.executor_target ?? undefined,
    agentId: row.agent_id,
    requestedBy: row.requested_by ?? undefined,
    origin: row.origin,
    parentTaskId: row.parent_task_id ?? undefined,
    chainDepth: row.chain_depth,
    nodeAffinity: row.node_affinity ?? undefined,
    claimedBy: row.claimed_by ?? undefined,
    budget: parseJson<TaskBudget>(row.budget, {}),
    usage: usage ?? undefined,
    status: row.status,
    attempt: row.attempt,
    maxAttempts: row.max_attempts,
    pendingMessage: row.pending_message ?? undefined,
    error: row.error ?? undefined,
    result: result ?? undefined,
    conversationId: row.conversation_id ?? undefined,
    sessionKey: row.session_key ?? undefined,
    harnessSessionIds: parseJson<string[]>(row.harness_session_ids, []),
    eval: evalOutcome ?? undefined,
    evalAttempt: row.eval_attempt,
    createdAt: epoch(row.created_at) ?? 0,
    startedAt: epoch(row.started_at),
    lastHeartbeatAt: epoch(row.last_heartbeat_at),
    completedAt: epoch(row.completed_at),
    durationMs: row.duration_ms ?? undefined,
  }
}

// DatabaseSync is synchronous. The methods stay async so they match TaskStore.
/* eslint-disable @typescript-eslint/require-await */
export class SqliteTaskStore implements TaskStore {
  private readonly db: DatabaseSync
  private readonly terminal = new TaskTerminalNotify()
  private readonly sweepStaleMs: number
  private readonly awaitingInputTtlMs: number
  private closed = false

  constructor(
    filePath: string,
    private readonly enqueue?: (taskId: string) => void,
    tuning?: TaskStoreTuning,
  ) {
    mkdirSync(dirname(filePath), { recursive: true })
    this.db = new DatabaseSync(filePath)
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec('PRAGMA busy_timeout = 5000')
    this.db.exec('PRAGMA foreign_keys = ON')
    this.db.exec(SCHEMA)
    this.sweepStaleMs = tuning?.sweepStaleMs ?? SWEEP_STALE_MS_DEFAULT
    this.awaitingInputTtlMs = tuning?.awaitingInputTtlMs ?? AWAITING_INPUT_TTL_MS_DEFAULT
  }

  onTerminal(listener: TaskTerminalListener): () => void {
    return this.terminal.subscribe(listener)
  }

  /** Release the file. Idempotent. */
  close(): void {
    if (this.closed) return
    this.closed = true
    this.db.close()
  }

  async isReady(): Promise<boolean> {
    const row = this.db
      .prepare(`SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'ros_tasks'`)
      .get() as { ok: number } | undefined
    return row?.ok === 1
  }

  async create(input: NewTaskInput): Promise<TaskRow> {
    const id = randomUUID()
    const now = iso(Date.now())
    const row = this.tx(() => {
      return this.db
        .prepare(
          `INSERT INTO ros_tasks
             (id, goal, context_refs, acceptance_criteria, spec, executor,
              executor_target, agent_id, requested_by, origin, parent_task_id,
              chain_depth, node_affinity, budget, max_attempts, conversation_id,
              session_key, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           RETURNING *`,
        )
        .get(
          id,
          input.goal,
          jsonText(input.contextRefs ?? []),
          jsonText(input.acceptanceCriteria ?? []),
          jsonText(callerSpec(input.spec)),
          input.executor,
          input.executorTarget ?? null,
          input.agentId,
          input.requestedBy ?? null,
          input.origin,
          input.parentTaskId ?? null,
          input.chainDepth ?? 0,
          input.nodeAffinity ?? null,
          jsonText(input.budget ?? {}),
          input.maxAttempts ?? 1,
          input.conversationId ?? null,
          taskJobKey(id),
          now,
        ) as unknown as SqliteTaskRow
    })
    this.enqueue?.(id)
    return sqliteToPublic(row)
  }

  async recordTerminal(input: NewTaskInput, outcome: TerminalOutcome): Promise<TaskRow> {
    const id = randomUUID()
    const started = outcome.startedAt ?? Date.now()
    const now = iso(Date.now())
    const duration =
      outcome.durationMs ?? (outcome.startedAt != null ? Date.now() - outcome.startedAt : 0)
    const row = this.tx(() => {
      return this.db
        .prepare(
          `INSERT INTO ros_tasks
             (id, goal, context_refs, acceptance_criteria, spec, executor,
              executor_target, agent_id, requested_by, origin, parent_task_id,
              chain_depth, budget, usage, max_attempts, attempt, status, error,
              result, session_key, created_at, started_at, completed_at, duration_ms)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)
           RETURNING *`,
        )
        .get(
          id,
          input.goal,
          jsonText(input.contextRefs ?? []),
          jsonText(input.acceptanceCriteria ?? []),
          jsonText(callerSpec(input.spec)),
          input.executor,
          input.executorTarget ?? null,
          input.agentId,
          input.requestedBy ?? null,
          input.origin,
          input.parentTaskId ?? null,
          input.chainDepth ?? 0,
          jsonText(input.budget ?? {}),
          jsonText(outcome.result.usage),
          input.maxAttempts ?? 1,
          outcome.status,
          outcome.result.error ?? null,
          jsonText(outcome.result),
          taskJobKey(id),
          iso(started),
          iso(started),
          now,
          duration,
        ) as unknown as SqliteTaskRow
    })
    return sqliteToPublic(row)
  }

  async get(id: string): Promise<TaskRow | undefined> {
    const row = this.db.prepare(`SELECT * FROM ros_tasks WHERE id = ?`).get(id) as
      SqliteTaskRow | undefined
    return row ? sqliteToPublic(row) : undefined
  }

  async list(filter?: TaskListFilter): Promise<TaskRow[]> {
    const clauses: string[] = []
    const params: SQLInputValue[] = []
    if (filter?.status) {
      clauses.push('status = ?')
      params.push(filter.status)
    }
    if (filter?.agentId) {
      clauses.push('agent_id = ?')
      params.push(filter.agentId)
    }
    params.push(filter?.limit ?? 500)
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''
    const rows = this.db
      .prepare(`SELECT * FROM ros_tasks ${where} ORDER BY created_at DESC LIMIT ?`)
      .all(...params) as unknown as SqliteTaskRow[]
    return rows.map(sqliteToPublic)
  }

  async listClaimable(nodeId: string, limit: number): Promise<TaskRow[]> {
    const rows = this.db
      .prepare(
        `SELECT * FROM ros_tasks
          WHERE (node_affinity IS NULL OR node_affinity = ?)
            AND (
              status = 'queued'
              OR (status = 'awaiting-input' AND pending_message IS NOT NULL)
            )
          ORDER BY created_at ASC
          LIMIT ?`,
      )
      .all(nodeId, limit) as unknown as SqliteTaskRow[]
    return rows.map(sqliteToPublic)
  }

  async claim(id: string, node: string): Promise<TaskRow | undefined> {
    const now = iso(Date.now())
    const row = this.tx(() => {
      return this.db
        .prepare(
          `UPDATE ros_tasks
             SET status = 'running',
                 started_at = ?,
                 last_heartbeat_at = ?,
                 claimed_by = ?,
                 attempt = attempt + 1
           WHERE id = ?
             AND status IN ('queued','awaiting-input')
             AND (node_affinity IS NULL OR node_affinity = ?)
           RETURNING *`,
        )
        .get(now, now, node, id, node) as SqliteTaskRow | undefined
    })
    return row ? sqliteToPublic(row) : undefined
  }

  async finish(id: string, status: TaskStatus, result: TaskResult): Promise<void> {
    const now = iso(Date.now())
    const info = this.db
      .prepare(
        `UPDATE ros_tasks
           SET status = ?,
               result = ?,
               usage = ?,
               error = ?,
               pending_message = NULL,
               completed_at = ?,
               duration_ms = ${DURATION_SQL}
         WHERE id = ?`,
      )
      .run(status, jsonText(result), jsonText(result.usage), result.error ?? null, now, now, id)
    if (Number(info.changes) > 0 && isTerminalTaskStatus(status)) this.terminal.emit(id, status)
  }

  async recordEval(id: string, outcome: EvalOutcome): Promise<void> {
    this.db
      .prepare(`UPDATE ros_tasks SET eval = ?, eval_attempt = ? WHERE id = ?`)
      .run(jsonText(outcome), outcome.attempts, id)
  }

  async stashEvalRetry(id: string, attempt: number, steer: string): Promise<void> {
    this.db
      .prepare(
        `UPDATE ros_tasks SET eval_attempt = ?, pending_message = ?
         WHERE id = ? AND status = 'running'`,
      )
      .run(attempt, steer, id)
  }

  async listOutcomes(filter?: OutcomeFilter): Promise<OutcomeRow[]> {
    const clauses: string[] = []
    const params: SQLInputValue[] = []
    if (filter?.agentId) {
      clauses.push('agent_id = ?')
      params.push(filter.agentId)
    }
    if (filter?.origin) {
      clauses.push('origin = ?')
      params.push(filter.origin)
    }
    if (filter?.since !== undefined) {
      clauses.push(
        `id IN (SELECT id FROM ros_tasks WHERE completed_at IS NOT NULL AND completed_at >= ?)`,
      )
      params.push(iso(filter.since))
    }
    if (filter?.until !== undefined) {
      clauses.push(
        `id IN (SELECT id FROM ros_tasks WHERE completed_at IS NOT NULL AND completed_at <= ?)`,
      )
      params.push(iso(filter.until))
    }
    params.push(filter?.limit ?? 10_000)
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''
    const rows = this.db
      .prepare(`SELECT * FROM ros_task_outcomes_v ${where} ORDER BY day DESC LIMIT ?`)
      .all(...params) as unknown as Array<{
      id: string
      agent_id: string
      executor: string
      executor_target: string | null
      origin: string
      day: string | null
      status: TaskStatus
      executor_verdict: string | null
      eval_verdict: string | null
      diverged: number
      cost_usd: number | null
      eval_attempt: number
      duration_ms: number | null
    }>
    return rows.map((r) => ({
      id: r.id,
      agentId: r.agent_id,
      executor: r.executor,
      executorTarget: r.executor_target ?? undefined,
      origin: r.origin,
      day: r.day ?? '',
      status: r.status,
      executorVerdict: r.executor_verdict ?? undefined,
      evalVerdict: r.eval_verdict ?? undefined,
      diverged: r.diverged === 1,
      costUsd: r.cost_usd ?? undefined,
      evalAttempt: r.eval_attempt,
      durationMs: r.duration_ms ?? undefined,
    }))
  }

  async markAwaitingInput(id: string, interim?: TaskResult): Promise<boolean> {
    const now = iso(Date.now())
    const info = this.db
      .prepare(
        `UPDATE ros_tasks
           SET status = 'awaiting-input',
               result = COALESCE(?, result),
               duration_ms = ${DURATION_SQL}
         WHERE id = ? AND status = 'running' AND pending_message IS NULL`,
      )
      .run(interim ? jsonText(interim) : null, now, id)
    return Number(info.changes) > 0
  }

  async requestKill(id: string): Promise<TaskStatus | undefined> {
    const now = iso(Date.now())
    const prior = this.tx(() => {
      const row = this.db
        .prepare(
          `SELECT status FROM ros_tasks
           WHERE id = ? AND status IN ('queued','awaiting-input','running')`,
        )
        .get(id) as { status: TaskStatus } | undefined
      if (!row) return undefined
      this.db
        .prepare(
          `UPDATE ros_tasks
             SET status = 'killed',
                 completed_at = ?,
                 error = COALESCE(error, 'Killed by parent'),
                 duration_ms = ${DURATION_SQL}
           WHERE id = ?`,
        )
        .run(now, now, id)
      return row.status
    })
    if (prior !== undefined) this.terminal.emit(id, 'killed')
    return prior
  }

  async takePendingMessage(id: string): Promise<string | undefined> {
    return this.tx(() => {
      const row = this.db
        .prepare(
          `SELECT pending_message FROM ros_tasks WHERE id = ? AND pending_message IS NOT NULL`,
        )
        .get(id) as { pending_message: string } | undefined
      if (!row) return undefined
      this.db.prepare(`UPDATE ros_tasks SET pending_message = NULL WHERE id = ?`).run(id)
      return row.pending_message
    })
  }

  async send(id: string, message: string): Promise<void> {
    const info = this.db
      .prepare(`UPDATE ros_tasks SET pending_message = ? WHERE id = ?`)
      .run(message, id)
    if (Number(info.changes) > 0) this.enqueue?.(id)
  }

  async updateUsage(id: string, usage: TaskUsage): Promise<void> {
    const now = iso(Date.now())
    this.db
      .prepare(`UPDATE ros_tasks SET usage = ?, last_heartbeat_at = ? WHERE id = ?`)
      .run(jsonText(usage), now, id)
  }

  async appendHarnessSessionId(id: string, sessionId: string): Promise<void> {
    this.db
      .prepare(
        `UPDATE ros_tasks
           SET harness_session_ids = json_insert(harness_session_ids, '$[#]', ?)
         WHERE id = ?
           AND NOT EXISTS (
             SELECT 1 FROM json_each(harness_session_ids) WHERE value = ?
           )`,
      )
      .run(sessionId, id, sessionId)
  }

  async appendPermissionDecision(id: string, decision: TaskPermissionDecision): Promise<void> {
    this.db
      .prepare(
        `UPDATE ros_tasks
           SET spec = json_set(
             spec,
             '$.permissionDecisions',
             json_insert(
               COALESCE(json_extract(spec, '$.permissionDecisions'), json('[]')),
               '$[#]',
               json(?)
             )
           )
         WHERE id = ?`,
      )
      .run(JSON.stringify(decision), id)
  }

  async heartbeat(id: string): Promise<void> {
    this.db
      .prepare(`UPDATE ros_tasks SET last_heartbeat_at = ? WHERE id = ?`)
      .run(iso(Date.now()), id)
  }

  async sweep(node: string): Promise<number> {
    const nowMs = Date.now()
    const now = iso(nowMs)
    // Age >= window, so sweepStaleMs 0 reaps a heartbeat stamped this millisecond.
    const staleBefore = iso(nowMs - this.sweepStaleMs)
    const touched = this.tx(() => {
      const requeued = this.db
        .prepare(
          `UPDATE ros_tasks
             SET status = 'queued'
           WHERE status = 'running' AND claimed_by = ? AND attempt < max_attempts
             AND (last_heartbeat_at IS NULL OR last_heartbeat_at <= ?)
           RETURNING id`,
        )
        .all(node, staleBefore) as unknown as Array<{ id: string }>
      const failed = this.db
        .prepare(
          `UPDATE ros_tasks
             SET status = 'failed',
                 error = 'worker_restarted',
                 completed_at = ?,
                 duration_ms = ${DURATION_SQL}
           WHERE status = 'running' AND claimed_by = ?
             AND (last_heartbeat_at IS NULL OR last_heartbeat_at <= ?)
           RETURNING id`,
        )
        .all(now, now, node, staleBefore) as unknown as Array<{ id: string }>
      const reaped = this.db
        .prepare(
          `UPDATE ros_tasks
             SET status = 'timeout',
                 error = 'awaiting-input expired',
                 completed_at = ?,
                 duration_ms = ${DURATION_SQL}
           WHERE status = 'awaiting-input' AND claimed_by = ?
             AND (julianday(?) - julianday(COALESCE(last_heartbeat_at, created_at))) * 86400000
                 >= COALESCE(CAST(json_extract(budget, '$.maxWallClockMs') AS INTEGER), ?)
           RETURNING id`,
        )
        .all(now, now, node, now, this.awaitingInputTtlMs) as unknown as Array<{ id: string }>
      return {
        ids: requeued.map((row) => row.id),
        failedIds: failed.map((row) => row.id),
        timeoutIds: reaped.map((row) => row.id),
      }
    })
    for (const id of touched.ids) this.enqueue?.(id)
    // After the transaction commits. A listener that writes the same row
    // (permission audit) must not run inside it.
    for (const id of touched.failedIds) this.terminal.emit(id, 'failed')
    for (const id of touched.timeoutIds) this.terminal.emit(id, 'timeout')
    return touched.ids.length + touched.failedIds.length + touched.timeoutIds.length
  }

  async reenqueue(id: string): Promise<void> {
    const row = this.db
      .prepare(`SELECT id FROM ros_tasks WHERE id = ? AND status = 'queued'`)
      .get(id) as { id: string } | undefined
    if (row) this.enqueue?.(id)
  }

  private tx<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = fn()
      this.db.exec('COMMIT')
      return result
    } catch (err) {
      try {
        this.db.exec('ROLLBACK')
      } catch {
        // The original error is the one to surface.
      }
      throw err
    }
  }
}
