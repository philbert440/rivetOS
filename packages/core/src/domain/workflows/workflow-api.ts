/**
 * /api/workflows + /api/workflow-runs — gateway route families (slice C + J).
 *
 *   GET  /api/workflows              list defs from workflowsRoots (+ stats, createRoots)
 *   POST /api/workflows              create a def: { id, name, description?, root?, from? }
 *   GET  /api/workflows/:id          single def (+ editPath when under files root)
 *   POST /api/workflows/:id/validate loader + determinism lint diagnostics
 *   POST /api/workflows/:id/runs     start a run (body = input fields)
 *   GET  /api/workflow-runs          recent runs (scan caseDirRoot); ?workflowId=&status=a,b&q=
 *   GET  /api/workflow-runs/:id      detail: case + journal + children + openGate
 *   PATCH /api/workflow-runs/:id     body = { label } — rename (blank clears)
 *   POST /api/workflow-runs/:id/resume  body = { gateResponse }
 *   POST /api/workflow-runs/:id/kill
 *
 * Live updates: v1 polls (UI 3s). WS deltas deferred — see slice-c NOTES.
 */

import { randomUUID } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  sharedDir,
  sharedPath,
  type GatewayRoute,
  type NotificationFrame,
  type WorkflowCreateResponse,
  type WorkflowDefSummary,
  type WorkflowDiagnostic,
  type WorkflowKillResponse,
  type WorkflowDefStats,
  type WorkflowRunDetail,
  type WorkflowRunStatus,
  type WorkflowRunSummary,
  type WorkflowRunsListResponse,
  type WorkflowStartRunResponse,
  type WorkflowValidateResponse,
  type WorkflowsListResponse,
} from '@rivetos/types'
import {
  ContractValidationError,
  MaxConcurrentRunsError,
  assertUnderConcurrentCap,
  RunNotFoundError,
  WorkflowEngine,
  WorkflowNotFoundError,
  checkRunScriptDeterminism,
  createWorkflowDef,
  WorkflowCreateError,
  findOpenGate,
  listChildRuns,
  listRuns,
  loadWorkflowDir,
  appendJournal,
  listWorkflowDefs,
  normalizeRunLabel,
  readCase,
  readRunMeta,
  resolveRunLabel,
  summarizeRunsByWorkflow,
  writeRunMeta,
  readJournal,
  updateRun,
  validateStartInput,
  writeCase,
  type LoadedWorkflow,
  type StartRunResult,
} from '@rivetos/workflows'
import { logger } from '../../logger.js'

const log = logger('WorkflowApi')

const EMPTY_STATS: WorkflowDefStats = { recent: 0, recentFailed: 0, waiting: 0 }

const RUN_STATUSES: ReadonlySet<string> = new Set<WorkflowRunStatus>([
  'running',
  'paused_human',
  'done',
  'failed',
  'killed',
])

const MAX_BODY_BYTES = 256 * 1024

export interface WorkflowApiOptions {
  engine: WorkflowEngine
  /** Roots to scan for workflow.yaml dirs. */
  workflowsRoots?: string[]
  /** caseDir root for listRuns. */
  caseDirRoot?: string
  /**
   * Absolute files root used to compute `editPath` on def summaries.
   * When a def dir is under this root, GET exposes the relative path so the
   * IDE can open it via the existing files API. Empty string disables editPath.
   */
  filesRoot?: string
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

function toRunSummary(
  run: {
    id: string
    workflowId: string
    status: WorkflowRunSummary['status']
    startedAt?: string
    finishedAt?: string
    current?: string
    version?: string
    parent?: { runId: string }
  },
  label?: string,
): WorkflowRunSummary {
  return {
    id: run.id,
    workflowId: run.workflowId,
    status: run.status,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    current: run.current,
    version: run.version,
    parentRunId: run.parent?.runId,
    ...(label !== undefined ? { label } : {}),
  }
}

function fromStartResult(result: StartRunResult, label?: string): WorkflowStartRunResponse {
  return {
    run: toRunSummary(result.run, label),
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
    : [sharedPath('workflows', 'defs')]
  const caseDirRoot = opts.caseDirRoot ?? sharedPath('workflows', 'runs')
  // undefined → product default; explicit '' disables editPath entirely.
  const filesRoot = opts.filesRoot === undefined ? sharedDir() : opts.filesRoot

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
          const allRuns = await listRuns(caseDirRoot, { limit: Infinity }, (m) => log.warn(m))
          const stats = summarizeRunsByWorkflow(allRuns)
          const body: WorkflowsListResponse = {
            workflows: loaded.map((w) => ({
              ...toDefSummary(w, filesRoot),
              stats: stats.get(w.manifest.id) ?? EMPTY_STATS,
            })),
            createRoots: [...creatableRoots(workflowsRoots, filesRoot).keys()],
          }
          return json(res, 200, body)
        }

        // POST /api/workflows — create (blank or duplicate). Only under a defs
        // root inside the files root, so the new def is editable in RivetHub.
        if (req.method === 'POST' && parts.length === 0) {
          const body = await readJsonBody(req).catch((err: unknown) => {
            const tooLarge = err instanceof BodyTooLarge
            json(res, tooLarge ? 413 : 400, {
              error: (err as Error).message || 'invalid JSON body',
            })
            if (tooLarge) res.once('finish', () => req.destroy())
            return null
          })
          if (body === null) return
          if (
            body === undefined ||
            typeof body.id !== 'string' ||
            typeof body.name !== 'string' ||
            (body.description !== undefined && typeof body.description !== 'string') ||
            (body.root !== undefined && typeof body.root !== 'string') ||
            (body.from !== undefined && typeof body.from !== 'string')
          ) {
            return json(res, 400, {
              error: 'body must be { id, name, description?, root?, from? } (strings)',
            })
          }
          const roots = creatableRoots(workflowsRoots, filesRoot)
          const rootAbs =
            body.root !== undefined ? roots.get(body.root) : roots.values().next().value
          if (!rootAbs) {
            return json(res, 400, {
              error:
                body.root !== undefined
                  ? `not a creatable workflows root: ${body.root}`
                  : 'no workflows root sits inside the files root — cannot create here',
            })
          }
          const loaded = await listWorkflowDefs(workflowsRoots, (m) => log.warn(m))
          if (loaded.some((w) => w.manifest.id === body.id)) {
            return json(res, 409, { error: `workflow id already in use: ${body.id}` })
          }
          let fromDir: string | undefined
          if (body.from !== undefined) {
            fromDir = loaded.find((w) => w.manifest.id === body.from)?.dir
            if (!fromDir) return json(res, 404, { error: `workflow not found: ${body.from}` })
          }
          try {
            const created = await createWorkflowDef({
              root: rootAbs,
              id: body.id,
              name: body.name,
              description: body.description,
              fromDir,
            })
            const out: WorkflowCreateResponse = { workflow: toDefSummary(created, filesRoot) }
            return json(res, 201, out)
          } catch (err) {
            if (err instanceof WorkflowCreateError) {
              return json(res, err.code === 'exists' ? 409 : 400, { error: err.message })
            }
            throw err
          }
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

          if (body.label !== undefined && typeof body.label !== 'string') {
            return json(res, 400, { error: 'label must be a string' })
          }

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

          const label = resolveRunLabel(body.label, def.manifest.runLabel, input)

          if (url.searchParams.get('wait') === 'true') {
            try {
              const result = await opts.engine.startRun(
                workflowId,
                input,
                { type: 'human', id: userId },
                { label },
              )
              notifyGate(opts, result)
              return json(res, 201, fromStartResult(result, label))
            } catch (err) {
              if (err instanceof ContractValidationError) return contractError(res, err)
              if (err instanceof WorkflowNotFoundError) {
                return json(res, 404, { error: err.message })
              }
              if (err instanceof MaxConcurrentRunsError) {
                return json(res, 429, {
                  error: err.message,
                  workflowId: err.workflowId,
                  max: err.max,
                  current: err.current,
                })
              }
              throw err
            }
          }

          // Pre-flight concurrency cap so a detached 202 never means "queued
          // over the cap". startRun re-checks; this is the HTTP 429 surface.
          // Same helper as the engine — one status filter, no drift.
          try {
            await assertUnderConcurrentCap(
              caseDirRoot,
              workflowId,
              def.manifest.budgets?.maxConcurrentRuns,
            )
          } catch (err) {
            if (err instanceof MaxConcurrentRunsError) {
              return json(res, 429, {
                error: err.message,
                workflowId,
                max: err.max,
                current: err.current,
              })
            }
            throw err
          }

          // Detached (default): a real run can take minutes-to-days — never
          // hold the HTTP request across execution. The UI polls run detail;
          // failures land in the run's own status/journal (engine execute
          // marks failed; pre-execute throws are materialized below so the
          // 202'd runId never becomes a permanent 404 / phantom-running run).
          const runId = randomUUID()
          const caseDir = join(caseDirRoot, runId)
          void opts.engine
            .startRun(workflowId, input, { type: 'human', id: userId }, { runId, caseDir, label })
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
              ...(label !== undefined ? { label } : {}),
            },
            suspended: false,
            detached: true,
          }
          return json(res, 202, body202)
        }

        // GET /api/workflows/:id — single def (handy for trigger form + edit)
        if (req.method === 'GET' && parts.length === 1) {
          const workflowId = decodeURIComponent(parts[0])
          const loaded = await listWorkflowDefs(workflowsRoots, (m) => log.warn(m))
          const match = loaded.find((w) => w.manifest.id === workflowId)
          if (!match) return json(res, 404, { error: `workflow not found: ${workflowId}` })
          return json(res, 200, {
            workflow: toDefSummary(match, filesRoot),
          })
        }

        // POST /api/workflows/:id/validate — loader + determinism diagnostics.
        // Resolves the def DIR without requiring a clean load: a broken
        // workflow.yaml is exactly what validate exists to diagnose, so load
        // failures must return 200 + diagnostics, not 404.
        if (req.method === 'POST' && parts.length === 2 && parts[1] === 'validate') {
          const workflowId = decodeURIComponent(parts[0])
          const dir = await resolveDefDirForValidate(workflowsRoots, workflowId, (m) => log.warn(m))
          if (!dir) return json(res, 404, { error: `workflow not found: ${workflowId}` })
          const body: WorkflowValidateResponse = await validateWorkflowDir(dir)
          return json(res, 200, body)
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
          const statusRaw = url.searchParams.get('status')
          const statuses = statusRaw
            ? statusRaw
                .split(',')
                .map((v) => v.trim())
                .filter((v): v is WorkflowRunStatus => RUN_STATUSES.has(v))
            : undefined
          const runs = await listRuns(
            caseDirRoot,
            {
              limit,
              workflowId: url.searchParams.get('workflowId') || undefined,
              statuses,
              q: url.searchParams.get('q') || undefined,
            },
            (m) => log.warn(m),
          )
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
              ...(r.label !== undefined ? { label: r.label } : {}),
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

        // PATCH /api/workflow-runs/:id — rename. Label lives in run-meta.json,
        // so finished (immutable case.json) runs can be renamed too.
        if (req.method === 'PATCH' && runId && !action) {
          const body = await readJsonBody(req).catch((err: unknown) => {
            const tooLarge = err instanceof BodyTooLarge
            json(res, tooLarge ? 413 : 400, {
              error: (err as Error).message || 'invalid JSON body',
            })
            if (tooLarge) res.once('finish', () => req.destroy())
            return null
          })
          if (body === null) return
          if (body === undefined || typeof body.label !== 'string') {
            return json(res, 400, { error: 'body must be { label: string }' })
          }
          try {
            const caseDir = await opts.engine.resolveCaseDir(runId)
            const caseState = await readCase(caseDir)
            const label = normalizeRunLabel(body.label)
            await writeRunMeta(caseDir, label !== undefined ? { label } : {})
            return json(res, 200, { run: toRunSummary(caseState.run, label) })
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

        if (req.method !== 'GET' && req.method !== 'POST' && req.method !== 'PATCH') {
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
  const { label } = await readRunMeta(caseDir)

  return {
    run: {
      ...toRunSummary(caseState.run, label),
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
  delete out.label
  delete out.gateResponse
  return out
}

/**
 * Map an absolute def directory to a files-root-relative path when the dir
 * lives under `filesRoot`. Returns undefined when outside the fence or when
 * filesRoot is empty/disabled. Pure + exported for unit tests.
 */
export function editPathForDefDir(
  absDir: string,
  filesRoot: string | undefined,
): string | undefined {
  if (!filesRoot || !filesRoot.trim()) return undefined
  const root = filesRoot.replace(/[/\\]+$/, '')
  const dir = absDir.replace(/[/\\]+$/, '')
  if (!root || !dir) return undefined
  // Normalize for comparison without resolving symlinks (listWorkflowDefs
  // already returns real absolute paths from join(root, name)).
  if (dir === root) return ''
  const prefix = root.endsWith(sep) ? root : root + sep
  if (!dir.startsWith(prefix) && !dir.startsWith(root + '/')) return undefined
  const rel = relative(root, dir)
  if (!rel || rel.startsWith('..') || rel.startsWith(`..${sep}`)) return undefined
  // Wire paths always use forward slashes (files API convention).
  return rel.split(sep).join('/')
}

/** Defs roots under the files root, keyed by their files-root-relative path. */
function creatableRoots(
  workflowsRoots: string[],
  filesRoot: string | undefined,
): Map<string, string> {
  const out = new Map<string, string>()
  for (const root of workflowsRoots) {
    const rel = editPathForDefDir(resolve(root), filesRoot)
    if (rel !== undefined && !out.has(rel)) out.set(rel, resolve(root))
  }
  return out
}

function toDefSummary(w: LoadedWorkflow, filesRoot: string | undefined): WorkflowDefSummary {
  const editPath = editPathForDefDir(w.dir, filesRoot)
  return {
    id: w.manifest.id,
    name: w.manifest.name,
    version: w.manifest.version,
    description: w.manifest.description,
    input: w.manifest.input,
    output: w.manifest.output,
    outline: w.manifest.outline,
    ...(editPath !== undefined ? { editPath } : {}),
    ...(w.manifest.runLabel !== undefined ? { runLabel: w.manifest.runLabel } : {}),
  }
}

/**
 * Resolve a workflow id to its def directory for validation WITHOUT requiring
 * a clean load. Preference order: (1) a successfully loading def whose
 * manifest.id matches; (2) a root child dir containing workflow.yaml whose
 * basename matches the id; (3) a root child dir whose workflow.yaml text has
 * a matching top-level `id:`. Exported for unit tests.
 */
export async function resolveDefDirForValidate(
  roots: string[],
  workflowId: string,
  warn: (msg: string) => void = () => {},
): Promise<string | undefined> {
  const loaded = await listWorkflowDefs(roots, warn)
  const match = loaded.find((w) => w.manifest.id === workflowId)
  if (match) return match.dir

  for (const root of roots) {
    let entries: import('node:fs').Dirent[]
    try {
      entries = await readdir(root, { withFileTypes: true })
    } catch {
      continue
    }
    // Basename match first — cheap and covers the directory convention.
    for (const ent of entries) {
      if (!ent.isDirectory() || ent.name !== workflowId) continue
      const dir = join(root, ent.name)
      try {
        await readFile(join(dir, 'workflow.yaml'), 'utf-8')
        return dir
      } catch {
        /* no manifest — not a def dir */
      }
    }
    // Fall back to a top-level `id:` scan of each candidate manifest.
    for (const ent of entries) {
      if (!ent.isDirectory()) continue
      const dir = join(root, ent.name)
      let text: string
      try {
        text = await readFile(join(dir, 'workflow.yaml'), 'utf-8')
      } catch {
        continue
      }
      const m = /^id:\s*["']?([^"'\r\n#]+?)["']?\s*$/m.exec(text)
      if (m && m[1].trim() === workflowId) return dir
    }
  }
  return undefined
}

/**
 * Run loadWorkflowDir + run.ts determinism lint; shape diagnostics without
 * throwing for expected authoring errors. Exported for unit tests.
 *
 * Surfaces load errors as diagnostics (broken manifest, bad frontmatter,
 * empty agent prompt) — the HTTP validate route depends on this to report on
 * defs that no longer load cleanly after on-disk edits.
 */
export async function validateWorkflowDir(dir: string): Promise<WorkflowValidateResponse> {
  const diagnostics: WorkflowDiagnostic[] = []

  try {
    const loaded = await loadWorkflowDir(dir)
    // Loader already checks empty agent prompts. Determinism lint on the
    // orchestration script (not part of loadWorkflowDir):
    try {
      const source = await readFile(loaded.runPath, 'utf-8')
      const findings = checkRunScriptDeterminism(source)
      const runRel = relative(dir, loaded.runPath).split(sep).join('/') || 'run.ts'
      for (const f of findings) {
        diagnostics.push({
          file: runRel,
          line: f.line,
          severity: 'error',
          message: `${f.rule}: ${f.message}`,
        })
      }
    } catch (err) {
      diagnostics.push({
        file: 'run.ts',
        severity: 'error',
        message: `could not read run script: ${err instanceof Error ? err.message : String(err)}`,
      })
    }
  } catch (err) {
    diagnostics.push(...diagnosticsFromLoadError(err))
  }

  return {
    ok: diagnostics.every((d) => d.severity !== 'error'),
    diagnostics,
  }
}

/** Shape a loadWorkflowDir / manifest error into diagnostics (pure helper). */
export function diagnosticsFromLoadError(err: unknown): WorkflowDiagnostic[] {
  const message = err instanceof Error ? err.message : String(err)
  // Best-effort file attribution from common error phrasing.
  let file = 'workflow.yaml'
  if (/agents\/|Agent "/i.test(message)) {
    const m = /agents\/[^:\s]+\.md/.exec(message)
    file = m?.[0] ?? 'agents'
  } else if (/run\.(ts|js|mjs)/i.test(message) || /No run\.ts/i.test(message)) {
    file = 'run.ts'
  } else if (/frontmatter/i.test(message)) {
    const m = /agents\/[^:\s]+\.md/.exec(message)
    file = m?.[0] ?? 'agents'
  }
  return [{ file, severity: 'error', message }]
}
