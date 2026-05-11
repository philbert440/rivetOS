/**
 * SubagentStore — persistence abstraction for sub-agent sessions.
 *
 * Two implementations:
 *   - PgSubagentStore       — durable (ros_subagent_sessions); survives restart
 *   - InMemorySubagentStore — process-local (tests + pgUrl-less dev)
 *
 * Status lifecycle:
 *   queued  → spawn() or send() inserted/reset the row, job enqueued
 *   running → worker claimed and started execution
 *   completed | failed | killed → terminal
 *
 * On worker startup, sweepRunning() flips any 'running' row to 'failed' with
 * error='worker_restarted' (option 1a from the migration plan — turn-level
 * resume is out of scope; session *state* survives, mid-turn execution does
 * not).
 */

import type pg from 'pg'
import type { SubagentSession, SubagentSpawnRequest, Message } from '@rivetos/types'

export interface NewSessionInput extends SubagentSpawnRequest {
  parentAgent: string
  provider: string
  modelOverride?: string
}

export interface TurnResult {
  status: 'completed' | 'failed' | 'killed'
  iterations: number
  toolsUsed: string[]
  usage?: { promptTokens: number; completionTokens: number }
  response: string
  error?: string
}

export interface ClaimedSession {
  id: string
  childAgent: string
  provider: string
  modelOverride?: string
  history: Message[]
  pendingMessage: string
}

export interface SubagentStore {
  /** Insert a queued session and return the public view. */
  insert(input: NewSessionInput, pendingMessage: string): Promise<SubagentSession>

  /** Read a session by id, or undefined if not found. */
  get(id: string): Promise<SubagentSession | undefined>

  /** List all sessions (newest first). */
  list(): Promise<SubagentSession[]>

  /**
   * Reset state for a follow-up turn and stash the pending message.
   * Throws if session is in a terminal state that doesn't allow send
   * (caller is responsible for the check; this just writes).
   */
  resetForSend(id: string, message: string): Promise<void>

  /**
   * Atomically claim the queued/follow-up row, returning the data the
   * worker needs to drive a turn. Marks the row 'running' and stamps
   * started_at. Returns undefined if the row has been killed/removed.
   */
  claim(id: string): Promise<ClaimedSession | undefined>

  /** Persist the outcome of a turn. */
  recordTurn(id: string, userMessage: string, result: TurnResult): Promise<void>

  /** Mark a running session killed (best-effort; worker honors at iteration boundary). */
  markKilled(id: string): Promise<void>

  /**
   * On worker startup: flip any 'running' rows to 'failed' with
   * error='worker_restarted'. Returns the count flipped.
   */
  sweepRunning(): Promise<number>
}

// ---------------------------------------------------------------------------
// In-memory store — for tests + pgUrl-less dev.
// ---------------------------------------------------------------------------

interface InMemoryRow {
  id: string
  parentAgent: string
  childAgent: string
  provider: string
  modelOverride?: string
  timeoutMs?: number
  status: 'queued' | 'running' | 'completed' | 'failed' | 'killed'
  history: Message[]
  pendingMessage: string
  iterations: number
  toolsUsed: string[]
  usage?: { promptTokens: number; completionTokens: number }
  lastResponse: string
  error?: string
  createdAt: number
  startedAt?: number
  completedAt?: number
  durationMs?: number
}

export class InMemorySubagentStore implements SubagentStore {
  private rows = new Map<string, InMemoryRow>()

  insert(input: NewSessionInput, pendingMessage: string): Promise<SubagentSession> {
    const id = randomId()
    const row: InMemoryRow = {
      id,
      parentAgent: input.parentAgent,
      childAgent: input.agent,
      provider: input.provider,
      modelOverride: input.modelOverride,
      timeoutMs: input.timeoutMs,
      status: 'queued',
      history: [],
      pendingMessage,
      iterations: 0,
      toolsUsed: [],
      lastResponse: '',
      createdAt: Date.now(),
    }
    this.rows.set(id, row)
    return Promise.resolve(toPublic(row))
  }

  get(id: string): Promise<SubagentSession | undefined> {
    const row = this.rows.get(id)
    return Promise.resolve(row ? toPublic(row) : undefined)
  }

  list(): Promise<SubagentSession[]> {
    return Promise.resolve(
      [...this.rows.values()].sort((a, b) => b.createdAt - a.createdAt).map(toPublic),
    )
  }

  resetForSend(id: string, message: string): Promise<void> {
    const row = this.rows.get(id)
    if (!row) return Promise.resolve()
    row.status = 'queued'
    row.pendingMessage = message
    row.iterations = 0
    row.toolsUsed = []
    row.lastResponse = ''
    row.usage = undefined
    row.error = undefined
    row.startedAt = undefined
    row.completedAt = undefined
    row.durationMs = undefined
    return Promise.resolve()
  }

  claim(id: string): Promise<ClaimedSession | undefined> {
    const row = this.rows.get(id)
    if (!row || row.status === 'killed') return Promise.resolve(undefined)
    row.status = 'running'
    row.startedAt = Date.now()
    return Promise.resolve({
      id: row.id,
      childAgent: row.childAgent,
      provider: row.provider,
      modelOverride: row.modelOverride,
      history: [...row.history],
      pendingMessage: row.pendingMessage,
    })
  }

  recordTurn(id: string, userMessage: string, result: TurnResult): Promise<void> {
    const row = this.rows.get(id)
    if (!row) return Promise.resolve()
    row.iterations = result.iterations
    row.toolsUsed = result.toolsUsed
    row.usage = result.usage
    row.lastResponse = result.response
    row.error = result.error
    row.history.push({ role: 'user', content: userMessage })
    if (result.status === 'completed') {
      row.history.push({ role: 'assistant', content: result.response })
    }
    row.status = row.status === 'killed' ? 'killed' : result.status
    row.completedAt = Date.now()
    row.durationMs = row.startedAt ? row.completedAt - row.startedAt : undefined
    row.pendingMessage = ''
    return Promise.resolve()
  }

  markKilled(id: string): Promise<void> {
    const row = this.rows.get(id)
    if (!row) return Promise.resolve()
    row.status = 'killed'
    row.error = row.error ?? 'Killed by parent'
    row.completedAt = Date.now()
    row.durationMs = row.startedAt ? row.completedAt - row.startedAt : 0
    return Promise.resolve()
  }

  sweepRunning(): Promise<number> {
    let n = 0
    for (const row of this.rows.values()) {
      if (row.status === 'running') {
        row.status = 'failed'
        row.error = 'worker_restarted'
        row.completedAt = Date.now()
        row.durationMs = row.startedAt ? row.completedAt - row.startedAt : 0
        n++
      }
    }
    return Promise.resolve(n)
  }
}

function toPublic(row: InMemoryRow): SubagentSession {
  return {
    id: row.id,
    parentAgent: row.parentAgent,
    childAgent: row.childAgent,
    provider: row.provider,
    status: publicStatus(row.status),
    history: [...row.history],
    createdAt: row.createdAt,
    iterations: row.iterations,
    toolsUsed: [...new Set(row.toolsUsed)],
    usage: row.usage,
    durationMs:
      row.status === 'running' || row.status === 'queued'
        ? row.startedAt
          ? Date.now() - row.startedAt
          : 0
        : row.durationMs,
    lastResponse: row.lastResponse,
    error: row.error,
  }
}

function publicStatus(s: InMemoryRow['status']): 'running' | 'completed' | 'failed' {
  if (s === 'queued' || s === 'running') return 'running'
  if (s === 'completed') return 'completed'
  return 'failed'
}

function randomId(): string {
  // Lightweight v4-ish — only used for the in-memory store; pg generates server-side.
  const bytes = new Uint8Array(16)
  for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256)
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

// ---------------------------------------------------------------------------
// Postgres store — durable; backed by ros_subagent_sessions.
// ---------------------------------------------------------------------------

interface PgRow {
  id: string
  parent_agent: string
  child_agent: string
  provider: string
  model_override: string | null
  timeout_ms: number | null
  status: 'queued' | 'running' | 'completed' | 'failed' | 'killed'
  history: Message[]
  pending_message: string | null
  iterations: number
  tools_used: string[]
  usage: { promptTokens: number; completionTokens: number } | null
  last_response: string
  error: string | null
  created_at: Date
  started_at: Date | null
  completed_at: Date | null
  duration_ms: number | null
}

function pgToPublic(row: PgRow): SubagentSession {
  const createdAt = row.created_at.getTime()
  return {
    id: row.id,
    parentAgent: row.parent_agent,
    childAgent: row.child_agent,
    provider: row.provider,
    status: publicStatus(row.status),
    history: row.history,
    createdAt,
    iterations: row.iterations,
    toolsUsed: [...new Set(row.tools_used)],
    usage: row.usage ?? undefined,
    durationMs:
      row.status === 'running' || row.status === 'queued'
        ? row.started_at
          ? Date.now() - row.started_at.getTime()
          : 0
        : (row.duration_ms ?? undefined),
    lastResponse: row.last_response,
    error: row.error ?? undefined,
  }
}

export class PgSubagentStore implements SubagentStore {
  constructor(private pool: pg.Pool) {}

  async insert(input: NewSessionInput, pendingMessage: string): Promise<SubagentSession> {
    const { rows } = await this.pool.query<PgRow>(
      `INSERT INTO ros_subagent_sessions
         (parent_agent, child_agent, provider, status, history, pending_message,
          iterations, tools_used, last_response, model_override, timeout_ms)
       VALUES ($1, $2, $3, 'queued', '[]'::jsonb, $4, 0, '[]'::jsonb, '', $5, $6)
       RETURNING *`,
      [
        input.parentAgent,
        input.agent,
        input.provider,
        pendingMessage,
        input.modelOverride ?? null,
        input.timeoutMs ?? null,
      ],
    )
    return pgToPublic(rows[0])
  }

  async get(id: string): Promise<SubagentSession | undefined> {
    const { rows } = await this.pool.query<PgRow>(
      `SELECT * FROM ros_subagent_sessions WHERE id = $1`,
      [id],
    )
    return rows[0] ? pgToPublic(rows[0]) : undefined
  }

  async list(): Promise<SubagentSession[]> {
    const { rows } = await this.pool.query<PgRow>(
      `SELECT * FROM ros_subagent_sessions ORDER BY created_at DESC LIMIT 500`,
    )
    return rows.map(pgToPublic)
  }

  async resetForSend(id: string, message: string): Promise<void> {
    await this.pool.query(
      `UPDATE ros_subagent_sessions
         SET status = 'queued',
             pending_message = $2,
             iterations = 0,
             tools_used = '[]'::jsonb,
             last_response = '',
             usage = NULL,
             error = NULL,
             started_at = NULL,
             completed_at = NULL,
             duration_ms = NULL
       WHERE id = $1`,
      [id, message],
    )
  }

  async claim(id: string): Promise<ClaimedSession | undefined> {
    const { rows } = await this.pool.query<PgRow>(
      `UPDATE ros_subagent_sessions
         SET status = 'running',
             started_at = now()
       WHERE id = $1
         AND status IN ('queued')
       RETURNING *`,
      [id],
    )
    if (!rows[0]) return undefined
    const row = rows[0]
    return {
      id: row.id,
      childAgent: row.child_agent,
      provider: row.provider,
      modelOverride: row.model_override ?? undefined,
      history: row.history,
      pendingMessage: row.pending_message ?? '',
    }
  }

  async recordTurn(id: string, userMessage: string, result: TurnResult): Promise<void> {
    // Build new history server-side via jsonb concatenation to avoid races
    // with concurrent reads. We append the user message + (on completion)
    // the assistant message.
    const additions: Message[] = [{ role: 'user', content: userMessage }]
    if (result.status === 'completed') {
      additions.push({ role: 'assistant', content: result.response })
    }

    await this.pool.query(
      `UPDATE ros_subagent_sessions
         SET status         = CASE WHEN status = 'killed' THEN 'killed' ELSE $2 END,
             iterations     = $3,
             tools_used     = $4::jsonb,
             usage          = $5::jsonb,
             last_response  = $6,
             error          = $7,
             history        = history || $8::jsonb,
             completed_at   = now(),
             duration_ms    = CASE WHEN started_at IS NULL THEN NULL
                                   ELSE (EXTRACT(EPOCH FROM (now() - started_at)) * 1000)::int END,
             pending_message = NULL
       WHERE id = $1`,
      [
        id,
        result.status,
        result.iterations,
        JSON.stringify(result.toolsUsed),
        result.usage ? JSON.stringify(result.usage) : null,
        result.response,
        result.error ?? null,
        JSON.stringify(additions),
      ],
    )
  }

  async markKilled(id: string): Promise<void> {
    await this.pool.query(
      `UPDATE ros_subagent_sessions
         SET status = 'killed',
             error  = COALESCE(error, 'Killed by parent'),
             completed_at = now(),
             duration_ms = CASE WHEN started_at IS NULL THEN 0
                                ELSE (EXTRACT(EPOCH FROM (now() - started_at)) * 1000)::int END
       WHERE id = $1 AND status IN ('queued','running')`,
      [id],
    )
  }

  async sweepRunning(): Promise<number> {
    const { rowCount } = await this.pool.query(
      `UPDATE ros_subagent_sessions
         SET status = 'failed',
             error  = 'worker_restarted',
             completed_at = now(),
             duration_ms = CASE WHEN started_at IS NULL THEN 0
                                ELSE (EXTRACT(EPOCH FROM (now() - started_at)) * 1000)::int END
       WHERE status = 'running'`,
    )
    return rowCount ?? 0
  }
}
