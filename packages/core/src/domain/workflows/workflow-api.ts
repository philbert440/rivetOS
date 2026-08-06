/**
 * /api/workflows + /api/workflow-runs — gateway route families (slice C).
 *
 *   GET  /api/workflows              list defs from workflowsRoots
 *   POST /api/workflows/:id/runs     start a run (body = input fields)
 *   GET  /api/workflow-runs          recent runs (scan caseDirRoot)
 *   GET  /api/workflow-runs/:id      detail: case + journal + children + openGate
 *   POST /api/workflow-runs/:id/resume  body = { gateResponse }
 *   POST /api/workflow-runs/:id/kill
 *
 * Live updates: v1 polls (UI 3s). WS deltas deferred — see slice-c NOTES.
 */

import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type {
  GatewayRoute,
  NotificationFrame,
  WorkflowDefSummary,
  WorkflowKillResponse,
  WorkflowRunDetail,
  WorkflowRunSummary,
  WorkflowRunsListResponse,
  WorkflowStartRunResponse,
  WorkflowsListResponse,
} from '@rivetos/types'
import {
  ContractValidationError,
  RunNotFoundError,
  WorkflowEngine,
  WorkflowNotFoundError,
  findOpenGate,
  listChildRuns,
  listRuns,
  appendJournal,
  listWorkflowDefs,
  readCase,
  readJournal,
  updateRun,
  validateStartInput,
  writeCase,
  type StartRunResult,
} from '@rivetos/workflows'
import { logger } from '../../logger.js'

const log = logger('WorkflowApi')

const MAX_BODY_BYTES = 256 * 1024
const DEFAULT_WORKFLOWS_ROOT = '/rivet-shared/workflows/defs'
const DEFAULT_CASE_DIR_ROOT = '/rivet-shared/workflows/runs'

export interface WorkflowApiOptions {
  engine: WorkflowEngine
  /** Roots to scan for workflow.yaml dirs. */
  workflowsRoots?: string[]
  /** caseDir root for listRuns. */
  caseDirRoot?: string
  /**
   * Optional fan-out when a run pauses at a human gate.
   * Boot wires the 4e notifications channel here.
   */
  onGatePaused?: (frame: Extract<NotificationFrame, { kind: 'workflow.gate' }>) => void
  /** Resolve human id for startedBy (default 'gateway'). */
  resolveUserId?: (req: IncomingMessage) => string | undefined
}

export interface WorkflowRoutes {
  /** prefix /api/workflows */
  workflows: GatewayRoute
  /** prefix /api/workflow-runs */
  workflowRuns: GatewayRoute
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

function toRunSummary(run: {
  id: string
  workflowId: string
  status: WorkflowRunSummary['status']
  startedAt?: string
  finishedAt?: string
  current?: string
  version?: string
  parent?: { runId: string }
}): WorkflowRunSummary {
  return {
    id: run.id,
    workflowId: run.workflowId,
    status: run.status,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    current: run.current,
    version: run.version,
    parentRunId: run.parent?.runId,
  }
}

function fromStartResult(result: StartRunResult): WorkflowStartRunResponse {
  return {
    run: toRunSummary(result.run),
    suspended: result.suspended,
    suspension: result.suspension,
  }
}

function contractError(res: ServerResponse, err: ContractValidationError): void {
  json(res, 422, {
    error: err.message,
    issues: err.issues,
  })
}

function notifyGate(opts: WorkflowApiOptions, result: StartRunResult): void {
  if (!result.suspended || !opts.onGatePaused) return
  void (async () => {
    try {
      const entries = await readJournal(result.caseDir)
      const open = findOpenGate(entries)
      opts.onGatePaused?.({
        kind: 'workflow.gate',
        runId: result.run.id,
        workflowId: result.run.workflowId,
        label: open?.label ?? result.suspension?.label ?? 'gate',
        prompt: open?.prompt,
        href: `/workflows/runs/${result.run.id}`,
        ts: Date.now(),
      })
    } catch (err) {
      log.warn(`gate notify failed: ${err instanceof Error ? err.message : String(err)}`)
      opts.onGatePaused?.({
        kind: 'workflow.gate',
        runId: result.run.id,
        workflowId: result.run.workflowId,
        label: result.suspension?.label ?? 'gate',
        href: `/workflows/runs/${result.run.id}`,
        ts: Date.now(),
      })
    }
  })()
}

export function createWorkflowApiRoutes(opts: WorkflowApiOptions): WorkflowRoutes {
  const workflowsRoots = opts.workflowsRoots?.length
    ? opts.workflowsRoots
    : [DEFAULT_WORKFLOWS_ROOT]
  const caseDirRoot = opts.caseDirRoot ?? DEFAULT_CASE_DIR_ROOT

  const workflows: GatewayRoute = {
    prefix: '/api/workflows',
    handler: async (req, res) => {
      try {
        const url = new URL(req.url ?? '/', 'http://localhost')
        const rest = url.pathname.slice('/api/workflows'.length).replace(/^\//, '')
        const parts = rest === '' ? [] : rest.split('/')

        // GET /api/workflows
        if (req.method === 'GET' && parts.length === 0) {
          const loaded = await listWorkflowDefs(workflowsRoots, (m) => log.warn(m))
          const body: WorkflowsListResponse = {
            workflows: loaded.map((w): WorkflowDefSummary => ({
              id: w.manifest.id,
              name: w.manifest.name,
              version: w.manifest.version,
              description: w.manifest.description,
              input: w.manifest.input,
              output: w.manifest.output,
              outline: w.manifest.outline,
            })),
          }
          return json(res, 200, body)
        }

        // POST /api/workflows/:id/runs
        if (req.method === 'POST' && parts.length === 2 && parts[1] === 'runs') {
          const workflowId = decodeURIComponent(parts[0])
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

          const input =
            typeof body.input === 'object' && body.input !== null && !Array.isArray(body.input)
              ? (body.input as Record<string, unknown>)
              : // Allow top-level fields as input for convenience (excluding control keys)
                stripControlKeys(body)

          const userId =
            (typeof body.startedById === 'string' && body.startedById) ||
            opts.resolveUserId?.(req) ||
            'gateway'

          // Validate the contract before responding — 422 is identical for
          // sync and detached starts, and a detached 202 must mean "accepted".
          const loaded = await listWorkflowDefs(workflowsRoots, (m) => log.warn(m))
          const def = loaded.find((w) => w.manifest.id === workflowId)
          if (!def) return json(res, 404, { error: `workflow not found: ${workflowId}` })
          try {
            validateStartInput(def.manifest.input, input)
          } catch (err) {
            if (err instanceof ContractValidationError) return contractError(res, err)
            throw err
          }

          if (url.searchParams.get('wait') === 'true') {
            try {
              const result = await opts.engine.startRun(workflowId, input, {
                type: 'human',
                id: userId,
              })
              notifyGate(opts, result)
              return json(res, 201, fromStartResult(result))
            } catch (err) {
              if (err instanceof ContractValidationError) return contractError(res, err)
              if (err instanceof WorkflowNotFoundError) {
                return json(res, 404, { error: err.message })
              }
              throw err
            }
          }

          // Detached (default): a real run can take minutes-to-days — never
          // hold the HTTP request across execution. The UI polls run detail;
          // failures land in the run's own status/journal (engine execute
          // marks failed; pre-execute throws are materialized below so the
          // 202'd runId never becomes a permanent 404 / phantom-running run).
          const runId = randomUUID()
          const caseDir = join(caseDirRoot, runId)
          void opts.engine
            .startRun(workflowId, input, { type: 'human', id: userId }, { runId, caseDir })
            .then((result) => notifyGate(opts, result))
            .catch(async (err: unknown) => {
              const message = err instanceof Error ? err.message : String(err)
              log.warn(`detached start ${runId} (${workflowId}) failed: ${message}`)
              await materializeDetachedFailure({
                caseDir,
                runId,
                workflowId,
                version: def.manifest.version,
                startedBy: { type: 'human', id: userId },
                message,
              }).catch((e: unknown) => {
                log.warn(
                  `could not materialize failure for ${runId}: ${e instanceof Error ? e.message : String(e)}`,
                )
              })
            })
          const body202: WorkflowStartRunResponse = {
            run: {
              id: runId,
              workflowId,
              status: 'running',
              version: def.manifest.version,
            },
            suspended: false,
            detached: true,
          }
          return json(res, 202, body202)
        }

        // GET /api/workflows/:id — single def (handy for trigger form)
        if (req.method === 'GET' && parts.length === 1) {
          const workflowId = decodeURIComponent(parts[0])
          const loaded = await listWorkflowDefs(workflowsRoots, (m) => log.warn(m))
          const match = loaded.find((w) => w.manifest.id === workflowId)
          if (!match) return json(res, 404, { error: `workflow not found: ${workflowId}` })
          return json(res, 200, {
            workflow: {
              id: match.manifest.id,
              name: match.manifest.name,
              version: match.manifest.version,
              description: match.manifest.description,
              input: match.manifest.input,
              output: match.manifest.output,
              outline: match.manifest.outline,
            } satisfies WorkflowDefSummary,
          })
        }

        if (req.method !== 'GET' && req.method !== 'POST') {
          return json(res, 405, { error: 'method not allowed' })
        }
        return json(res, 404, { error: `no workflows route for /${rest}` })
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        log.warn(`workflows api error: ${msg}`)
        if (!res.headersSent) json(res, 500, { error: msg })
      }
    },
  }

  const workflowRuns: GatewayRoute = {
    prefix: '/api/workflow-runs',
    handler: async (req, res) => {
      try {
        const url = new URL(req.url ?? '/', 'http://localhost')
        const rest = url.pathname.slice('/api/workflow-runs'.length).replace(/^\//, '')
        const parts = rest === '' ? [] : rest.split('/')

        // GET /api/workflow-runs
        if (req.method === 'GET' && parts.length === 0) {
          const limitRaw = url.searchParams.get('limit')
          const limit = limitRaw
            ? Math.min(500, Math.max(1, Number.parseInt(limitRaw, 10) || 100))
            : 100
          const runs = await listRuns(caseDirRoot, { limit }, (m) => log.warn(m))
          const body: WorkflowRunsListResponse = {
            runs: runs.map((r) => ({
              id: r.id,
              workflowId: r.workflowId,
              status: r.status,
              startedAt: r.startedAt,
              finishedAt: r.finishedAt,
              current: r.current,
              version: r.version,
              nested: r.nested,
              parentRunId: r.parentRunId,
            })),
          }
          return json(res, 200, body)
        }

        const runId = parts[0] ? decodeURIComponent(parts[0]) : undefined
        const action = parts[1]

        // GET /api/workflow-runs/:id
        if (req.method === 'GET' && runId && !action) {
          try {
            const detail = await loadRunDetail(opts.engine, caseDirRoot, runId)
            return json(res, 200, { run: detail })
          } catch (err) {
            if (err instanceof RunNotFoundError) return json(res, 404, { error: err.message })
            throw err
          }
        }

        // POST /api/workflow-runs/:id/resume
        if (req.method === 'POST' && runId && action === 'resume') {
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
          const gateResponse =
            typeof body.gateResponse === 'object' &&
            body.gateResponse !== null &&
            !Array.isArray(body.gateResponse)
              ? (body.gateResponse as Record<string, unknown>)
              : stripControlKeys(body)

          try {
            // Pre-validate so a detached 202 means "accepted": run exists, is
            // paused, and the gateResponse covers the open gate's fields.
            const caseDir = await opts.engine.resolveCaseDir(runId)
            const caseState = await readCase(caseDir)
            if (caseState.run.status !== 'paused_human') {
              return json(res, 409, {
                error: `Run ${runId} is not paused_human (status=${caseState.run.status})`,
              })
            }
            const open = findOpenGate(await readJournal(caseDir))
            if (open) {
              const missing = open.fields.filter(
                (f) => gateResponse[f] === undefined || gateResponse[f] === null,
              )
              if (missing.length > 0) {
                return contractError(
                  res,
                  new ContractValidationError(
                    missing.map((f) => ({
                      field: f,
                      reason: 'missing',
                      message: `gate "${open.label}" requires field "${f}" in gateResponse`,
                    })),
                  ),
                )
              }
            }

            if (url.searchParams.get('wait') === 'true') {
              const result = await opts.engine.resumeRun(runId, { gateResponse })
              notifyGate(opts, result)
              return json(res, 200, fromStartResult(result))
            }

            void opts.engine
              .resumeRun(runId, { gateResponse })
              .then((result) => notifyGate(opts, result))
              .catch((err: unknown) => {
                log.warn(
                  `detached resume ${runId} failed: ${err instanceof Error ? err.message : String(err)}`,
                )
              })
            return json(res, 202, {
              run: { ...toRunSummary(caseState.run), status: 'running' },
              suspended: false,
              detached: true,
            })
          } catch (err) {
            if (err instanceof ContractValidationError) return contractError(res, err)
            if (err instanceof RunNotFoundError) return json(res, 404, { error: err.message })
            if (err instanceof Error && /not paused_human/.test(err.message)) {
              return json(res, 409, { error: err.message })
            }
            throw err
          }
        }

        // POST /api/workflow-runs/:id/kill
        if (req.method === 'POST' && runId && action === 'kill') {
          try {
            await opts.engine.killRun(runId)
            const body: WorkflowKillResponse = { ok: true, runId }
            return json(res, 200, body)
          } catch (err) {
            if (err instanceof RunNotFoundError) return json(res, 404, { error: err.message })
            throw err
          }
        }

        if (req.method !== 'GET' && req.method !== 'POST') {
          return json(res, 405, { error: 'method not allowed' })
        }
        return json(res, 404, { error: `no workflow-runs route for /${rest}` })
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        log.warn(`workflow-runs api error: ${msg}`)
        if (!res.headersSent) json(res, 500, { error: msg })
      }
    },
  }

  return { workflows, workflowRuns }
}

/** Convenience: both routes as an array for gateway registration. */
export function createWorkflowApiRouteList(opts: WorkflowApiOptions): GatewayRoute[] {
  const { workflows, workflowRuns } = createWorkflowApiRoutes(opts)
  return [workflows, workflowRuns]
}

async function loadRunDetail(
  engine: WorkflowEngine,
  _caseDirRoot: string,
  runId: string,
): Promise<WorkflowRunDetail> {
  const caseDir = await engine.resolveCaseDir(runId)
  const caseState = await readCase(caseDir)
  const journal = await readJournal(caseDir)
  const children = await listChildRuns(caseDir, (m) => log.warn(m))
  const open = findOpenGate(journal)

  return {
    run: {
      ...toRunSummary(caseState.run),
      caseDir,
      error: caseState.run.error,
      output: caseState.run.output,
      startedBy: caseState.run.startedBy,
    },
    fields: caseState.fields,
    // Wire-boundary cast: engine journal entries are a discriminated union;
    // the wire type is open Records so old clients tolerate new entry kinds.
    journal: journal as unknown as WorkflowRunDetail['journal'],
    children: children.map((c) => ({
      id: c.id,
      workflowId: c.workflowId,
      status: c.status,
      startedAt: c.startedAt,
      finishedAt: c.finishedAt,
      current: c.current,
      version: c.version,
      nested: true,
      parentRunId: c.parentRunId,
    })),
    openGate: open
      ? {
          stepId: open.stepId,
          label: open.label,
          seq: open.seq,
          fields: open.fields,
          prompt: open.prompt,
        }
      : null,
  }
}

/**
 * A detached start that failed before the engine's durable catch (e.g. a
 * workflow dir race or caseDir mkdir failure) must still leave a pollable
 * failed run behind the 202'd runId — otherwise the client faces a permanent
 * 404 or a phantom forever-running run. Never overwrites a terminal state.
 */
export async function materializeDetachedFailure(args: {
  caseDir: string
  runId: string
  workflowId: string
  version: string
  startedBy: { type: 'human' | 'agent' | 'workflow'; id?: string }
  message: string
}): Promise<void> {
  const ts = new Date().toISOString()
  let existing: Awaited<ReturnType<typeof readCase>> | undefined
  try {
    existing = await readCase(args.caseDir)
  } catch {
    existing = undefined
  }
  if (existing) {
    const status = existing.run.status
    if (status === 'done' || status === 'failed' || status === 'killed') return
    // updateRun refuses terminal→* writes but allows running→failed.
    await updateRun(args.caseDir, { status: 'failed', error: args.message, finishedAt: ts })
  } else {
    await writeCase(args.caseDir, {
      run: {
        id: args.runId,
        workflowId: args.workflowId,
        version: args.version,
        startedBy: args.startedBy,
        caseDir: args.caseDir,
        status: 'failed',
        error: args.message,
        startedAt: ts,
        finishedAt: ts,
      },
      fields: {},
    })
  }
  await appendJournal(args.caseDir, {
    type: 'run_finished',
    ts,
    runId: args.runId,
    status: 'failed',
    error: args.message,
  })
}

function stripControlKeys(body: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...body }
  delete out.input
  delete out.startedById
  delete out.gateResponse
  return out
}
