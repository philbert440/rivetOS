/**
 * /api/tasks — gateway route family (G1, Appendix F).
 *
 * The task engine's HTTP surface: create (optionally waiting for the
 * terminal row via the shared TaskCompletionWaiter — the LISTEN ros_task_done
 * consumer), read, list, steer, kill. Phase 2's scoreboard and RivetHub's
 * task UI consume this; mesh callers keep their in-process path.
 *
 * Sub-routes (all JSON; mounted behind the gateway bearer gate):
 *   POST /api/tasks                  create; ?wait=1[&timeoutMs=] blocks for
 *                                    the terminal row (deadline-kill like the
 *                                    mesh transport — no zombie runs)
 *   GET  /api/tasks                  list; ?status=&agentId=&limit=
 *   GET  /api/tasks/:id              one row
 *   GET  /api/tasks/:id/wait         block for terminal; ?timeoutMs=
 *   POST /api/tasks/:id/steer        {message} → send/resume
 *   POST /api/tasks/:id/kill         requestKill (idempotent)
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type {
  GatewayRoute,
  TaskKillResponse,
  TaskResponse,
  TasksListResponse,
  TaskStatus,
  TaskSteerAccepted,
  TaskWaitTimeoutResponse,
  TaskWire,
} from '@rivetos/types'
import type { NewTaskInput, TaskListFilter, TaskRow, TaskStore } from './store.js'
import {
  CRITERIA_POLICY_OFF,
  CriteriaRequiredError,
  CriteriaShapeError,
  normalizeCriteria,
  type CriteriaPolicy,
} from './criteria.js'
import type { TaskCompletionWaiter } from './completion-waiter.js'
import { logger } from '../../logger.js'

const log = logger('TaskApi')

const DEFAULT_WAIT_MS = 120_000
const MAX_WAIT_MS = 1_800_000
const MAX_BODY_BYTES = 256 * 1024

const STATUSES: readonly TaskStatus[] = [
  'queued',
  'running',
  'awaiting-input',
  'completed',
  'failed',
  'killed',
  'timeout',
]

export interface TaskApiOptions {
  store: TaskStore
  waiter: TaskCompletionWaiter
  /**
   * Acceptance-criteria policy (phase 2b). Default OFF: creates behave as
   * phase 1 shipped. When eval is enabled with require_criteria, POST
   * /api/tasks rejects empty criteria with 400.
   */
  criteriaPolicy?: CriteriaPolicy
  /**
   * Agent-aware dispatch (G4): resolve a nodeAffinity for creates that don't
   * pin one — local agents pin to this node, mesh agents to their host.
   * Returning undefined leaves the row unpinned (global queue); returning
   * an Error message rejects the create with 400 (agent nowhere).
   */
  resolveAffinity?: (agentId: string) => Promise<string | { error: string } | undefined>
}

function json(res: ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

class BodyTooLarge extends Error {}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown> | undefined> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > MAX_BODY_BYTES) {
      // Stop reading — the caller answers 413 and then drops the connection
      // so a slow client can't hold the socket streaming an oversized body.
      req.pause()
      throw new BodyTooLarge('body too large')
    }
    chunks.push(chunk as Buffer)
  }
  if (size === 0) return {}
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  return parsed as Record<string, unknown>
}

function clampWaitMs(raw: string | null): number {
  const n = raw ? Number.parseInt(raw, 10) : NaN
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_WAIT_MS
  return Math.min(n, MAX_WAIT_MS)
}

/**
 * Public row shape — TaskRow verbatim; it is already JSON-safe. The TaskWire
 * return type is the compile-time lock against @rivetos/types gateway-api.ts:
 * drift between the store row and the published contract fails the build here.
 */
function toWire(row: TaskRow): TaskWire {
  return row
}

function parseCreate(body: Record<string, unknown>): NewTaskInput | string {
  if (typeof body.goal !== 'string' || body.goal.trim() === '') return 'goal (string) is required'
  if (typeof body.agentId !== 'string' || body.agentId.trim() === '')
    return 'agentId (string) is required'
  const executor = body.executor ?? 'chat-loop'
  if (executor !== 'chat-loop' && executor !== 'harness-session' && executor !== 'mesh')
    return `unknown executor ${JSON.stringify(executor)}`
  return {
    goal: body.goal,
    agentId: body.agentId,
    executor,
    executorTarget: typeof body.executorTarget === 'string' ? body.executorTarget : undefined,
    origin: 'api',
    requestedBy: typeof body.requestedBy === 'string' ? body.requestedBy : 'gateway',
    nodeAffinity: typeof body.nodeAffinity === 'string' ? body.nodeAffinity : undefined,
    spec:
      typeof body.spec === 'object' && body.spec !== null && !Array.isArray(body.spec)
        ? (body.spec as Record<string, unknown>)
        : undefined,
    budget:
      typeof body.budget === 'object' && body.budget !== null && !Array.isArray(body.budget)
        ? body.budget
        : undefined,
    contextRefs: Array.isArray(body.contextRefs)
      ? (body.contextRefs as NewTaskInput['contextRefs'])
      : undefined,
    acceptanceCriteria: Array.isArray(body.acceptanceCriteria)
      ? (body.acceptanceCriteria as NewTaskInput['acceptanceCriteria'])
      : undefined,
    maxAttempts: 1,
  }
}

/** Apply criteria policy to a parsed create; returns an error string for 400. */
function applyCriteriaPolicy(input: NewTaskInput, policy: CriteriaPolicy): NewTaskInput | string {
  try {
    return {
      ...input,
      acceptanceCriteria: normalizeCriteria(
        { goal: input.goal, origin: input.origin, acceptanceCriteria: input.acceptanceCriteria },
        policy,
      ),
    }
  } catch (err) {
    if (err instanceof CriteriaRequiredError || err instanceof CriteriaShapeError)
      return err.message
    throw err
  }
}

export function createTaskApiRoute(opts: TaskApiOptions): GatewayRoute {
  const { store, waiter } = opts

  return {
    prefix: '/api/tasks',
    handler: async (req, res) => {
      try {
        const url = new URL(req.url ?? '/', 'http://localhost')
        const rest = url.pathname.slice('/api/tasks'.length).replace(/^\//, '')
        const [id, action] = rest === '' ? [undefined, undefined] : rest.split('/')

        // POST /api/tasks — create (+ optional wait)
        if (req.method === 'POST' && !id) {
          const body = await readJsonBody(req).catch((err: unknown) => {
            const tooLarge = err instanceof BodyTooLarge
            json(res, tooLarge ? 413 : 400, {
              error: (err as Error).message || 'invalid JSON body',
            })
            if (tooLarge) res.once('finish', () => req.destroy())
            return null
          })
          if (body === null) return
          if (body === undefined) return json(res, 400, { error: 'body must be a JSON object' })
          const parsed = parseCreate(body)
          if (typeof parsed === 'string') return json(res, 400, { error: parsed })
          const input = applyCriteriaPolicy(parsed, opts.criteriaPolicy ?? CRITERIA_POLICY_OFF)
          if (typeof input === 'string') return json(res, 400, { error: input })
          if (!input.nodeAffinity && opts.resolveAffinity) {
            const resolved = await opts.resolveAffinity(input.agentId)
            if (typeof resolved === 'object' && resolved !== null)
              return json(res, 400, { error: resolved.error })
            input.nodeAffinity = resolved
          }

          const row = await store.create(input)
          if (url.searchParams.get('wait') !== '1' && url.searchParams.get('wait') !== 'true') {
            return json(res, 201, { task: toWire(row) } satisfies TaskResponse)
          }
          const waitMs = clampWaitMs(url.searchParams.get('timeoutMs'))
          const terminal = await waiter.wait(row.id, { deadlineMs: waitMs })
          if (!terminal) {
            // Deadline: kill before answering — no zombie runs (mesh/heartbeat
            // precedent). requestKill only flips pre-terminal rows, so if the
            // task finished in the window after the wait timed out, the
            // re-read sees the real terminal row — answer 200 with it rather
            // than a lying 504 (review finding).
            await store.requestKill(row.id)
            const after = await store.get(row.id)
            if (after && after.status !== 'killed') {
              return json(res, 200, { task: toWire(after) } satisfies TaskResponse)
            }
            return json(res, 504, {
              error: 'wait deadline exceeded — task killed',
              task: after ? toWire(after) : undefined,
            } satisfies TaskWaitTimeoutResponse)
          }
          return json(res, 200, { task: toWire(terminal) } satisfies TaskResponse)
        }

        // GET /api/tasks — list
        if (req.method === 'GET' && !id) {
          const filter: TaskListFilter = {}
          const status = url.searchParams.get('status')
          if (status) {
            if (!STATUSES.includes(status as TaskStatus))
              return json(res, 400, { error: `unknown status "${status}"` })
            filter.status = status as TaskStatus
          }
          const agentId = url.searchParams.get('agentId')
          if (agentId) filter.agentId = agentId
          const limit = url.searchParams.get('limit')
          if (limit) {
            const n = Number.parseInt(limit, 10)
            if (!Number.isFinite(n) || n <= 0) return json(res, 400, { error: 'invalid limit' })
            filter.limit = n
          }
          const rows = await store.list(filter)
          return json(res, 200, { tasks: rows.map(toWire) } satisfies TasksListResponse)
        }

        if (!id) return json(res, 405, { error: 'method not allowed' })

        const row = await store.get(id)
        if (!row) return json(res, 404, { error: `no task ${id}` })

        // GET /api/tasks/:id
        if (req.method === 'GET' && !action)
          return json(res, 200, { task: toWire(row) } satisfies TaskResponse)

        // GET /api/tasks/:id/wait — deliberately does NOT kill on deadline:
        // GET is a side-effect-free observation; only the creating POST owns
        // the task's lifetime. A watcher timing out must not kill someone
        // else's run.
        if (req.method === 'GET' && action === 'wait') {
          const waitMs = clampWaitMs(url.searchParams.get('timeoutMs'))
          const terminal = await waiter.wait(id, { deadlineMs: waitMs })
          if (!terminal) return json(res, 504, { error: 'wait deadline exceeded' })
          return json(res, 200, { task: toWire(terminal) } satisfies TaskResponse)
        }

        // POST /api/tasks/:id/steer
        if (req.method === 'POST' && action === 'steer') {
          const body = await readJsonBody(req).catch(() => undefined)
          const message = body?.message
          if (typeof message !== 'string' || message.trim() === '')
            return json(res, 400, { error: 'message (string) is required' })
          if (['completed', 'failed', 'killed', 'timeout'].includes(row.status))
            return json(res, 409, { error: `task is terminal (${row.status})` })
          await store.send(id, message)
          return json(res, 202, { ok: true } satisfies TaskSteerAccepted)
        }

        // POST /api/tasks/:id/kill
        if (req.method === 'POST' && action === 'kill') {
          const prior = await store.requestKill(id)
          return json(res, 200, { ok: true, prior: prior ?? null } satisfies TaskKillResponse)
        }

        return json(res, 405, { error: 'method not allowed' })
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        log.warn(`task api error: ${msg}`)
        if (!res.headersSent) json(res, 500, { error: msg })
      }
    },
  }
}
