/**
 * Journal-replay engine — startRun / resumeRun / killRun.
 *
 * Runs are durable state, not processes. Resume re-executes run.ts from the top;
 * journaled steps return cached results; execution continues live past the gate.
 */

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  resolveCaseDirRoot,
  resolveMaxRunRuntimeMs,
  resolveStepTimeoutMs,
  type EngineConfig,
} from './config.js'
import {
  childCaseDir,
  isTerminalStatus,
  readCase,
  writeCase,
  updateRun,
  mergeFields,
} from './case.js'
import { appendJournal, readJournal, nowIso, ensureJournal, findOpenGate } from './journal.js'
import { loadWorkflowDir, resolveWorkflowDir } from './loader.js'
import { validateStartInput } from './manifest.js'
import { createStepRuntime, type Step } from './step.js'
import { createCallRegistry, type CallRegistry, type CallResolver } from './registry.js'
import {
  ContractValidationError,
  isWorkflowKilled,
  isWorkflowSuspension,
  MaxConcurrentRunsError,
  RunNotFoundError,
  RunTimeoutError,
  WorkflowKilled,
} from './errors.js'
import { listRuns } from './list-runs.js'
import type { CaseState, JournalEntry, LoadedWorkflow, ParentRef, Run, StartedBy } from './types.js'

/** Signature of a workflow orchestration script (run.ts default export). */
export type RunScript = (step: Step, ctx: RunScriptContext) => Promise<void>

export interface RunScriptContext {
  runId: string
  input: Record<string, unknown>
  caseDir: string
  workflow: LoadedWorkflow
  fields: Record<string, unknown>
}

export interface StartRunOptions {
  /** Explicit run id (tests); default randomUUID. */
  runId?: string
  /** Override caseDir (tests); default caseDirRoot/runId. */
  caseDir?: string
  /** Parent link for child calls. */
  parent?: ParentRef
  /**
   * Pre-loaded run script — skips dynamic import of run.ts.
   * Preferred in tests; production loads from workflow dir.
   */
  runScript?: RunScript
  /** Pre-loaded workflow (skips resolve + load). */
  workflow?: LoadedWorkflow
}

export interface StartRunResult {
  run: Run
  caseDir: string
  /** True when suspended at a human gate. */
  suspended: boolean
  suspension?: { stepId: string; label: string; seq: number }
}

export interface ResumeRunOptions {
  /** Human gate field values. */
  gateResponse?: Record<string, unknown>
  runScript?: RunScript
  workflow?: LoadedWorkflow
}

/** Kill flags in-process; durable kill is a file `KILLED` in caseDir. */
const killFlags = new Map<string, boolean>()

export class WorkflowEngine {
  private readonly config: EngineConfig
  private readonly callRegistry: CallRegistry
  /**
   * Per-runId serialization for resume/continue: concurrent resumes must not
   * both execute the post-gate continuation. The loser observes the winner's
   * status flip and fails its paused_human check instead of double-running.
   */
  private readonly runLocks = new Map<string, Promise<unknown>>()

  constructor(config: EngineConfig) {
    this.config = config
    this.callRegistry = config.callRegistry ?? createCallRegistry()
    // Always install native bare-ref resolver (child workflow runs).
    // Overwrites any prior bare resolver so the engine owns nesting/kill semantics.
    this.callRegistry.register('', this.createNativeResolver())
  }

  private createNativeResolver(): CallResolver {
    return {
      resolve: async (name, input, ctx) => {
        const result = await this.startRun(
          name,
          input,
          {
            type: 'workflow',
            id: ctx.parentRunId,
          },
          {
            caseDir: childCaseDir(ctx.parentCaseDir, `child-${name}-${randomUUID().slice(0, 8)}`),
            parent: {
              runId: ctx.parentRunId,
              stepId: ctx.parentStepId,
            },
          },
        )
        if (result.suspended) {
          // v1: sync wait only — child human gates fail the parent call for now
          // (product: sync wait v1). Parent can later resume children.
          throw new Error(
            `Child workflow "${name}" suspended at human gate ${result.suspension?.stepId}; ` +
              `nested human gates during step.call are not auto-resumed in v1`,
          )
        }
        if (result.run.status === 'failed' || result.run.status === 'killed') {
          throw new Error(
            `Child workflow "${name}" ended with status ${result.run.status}: ${result.run.error ?? ''}`,
          )
        }
        return result.run.output ?? (await readCase(result.caseDir)).fields
      },
    }
  }

  /**
   * Validate input contract → create caseDir → journal run_started → execute run.ts.
   */
  async startRun(
    workflowRef: string,
    input: Record<string, unknown>,
    startedBy: StartedBy,
    options: StartRunOptions = {},
  ): Promise<StartRunResult> {
    const workflow =
      options.workflow ??
      (await loadWorkflowDir(
        resolveWorkflowDir(workflowRef, {
          workflowDirs: this.config.workflowDirs,
          workflowsRoots: this.config.workflowsRoots,
        }),
      ))

    validateStartInput(workflow.manifest.input, input)

    // maxConcurrentRuns — count non-terminal runs of this workflowId (incl. nested children).
    await assertUnderConcurrentCap(
      resolveCaseDirRoot(this.config),
      workflow.manifest.id,
      workflow.manifest.budgets?.maxConcurrentRuns,
    )

    const runId = options.runId ?? randomUUID()
    const caseDir = options.caseDir ?? join(resolveCaseDirRoot(this.config), runId)

    await mkdir(caseDir, { recursive: true })
    await ensureJournal(caseDir)

    const run: Run = {
      id: runId,
      workflowId: workflow.manifest.id,
      version: workflow.manifest.version,
      startedBy,
      parent: options.parent,
      caseDir,
      status: 'running',
      workflowDir: workflow.dir,
      startedAt: nowIso(),
    }

    const caseState: CaseState = {
      run,
      fields: { ...input },
    }
    await writeCase(caseDir, caseState)

    const started: JournalEntry = {
      type: 'run_started',
      ts: nowIso(),
      runId,
      workflowId: workflow.manifest.id,
      version: workflow.manifest.version,
      input,
      startedBy,
      parent: options.parent,
    }
    await appendJournal(caseDir, started)

    return this.execute(caseDir, workflow, options.runScript)
  }

  private withRunLock<T>(runId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.runLocks.get(runId) ?? Promise.resolve()
    const run = prev.then(fn, fn)
    const settled = run.then(
      () => undefined,
      () => undefined,
    )
    this.runLocks.set(runId, settled)
    void settled.then(() => {
      if (this.runLocks.get(runId) === settled) this.runLocks.delete(runId)
    })
    return run
  }

  /**
   * Resume a paused_human run: record gate_resolved, re-execute from top.
   * Serialized per runId — see runLocks.
   */
  async resumeRun(runId: string, options: ResumeRunOptions = {}): Promise<StartRunResult> {
    return this.withRunLock(runId, () => this.resumeRunInner(runId, options))
  }

  private async resumeRunInner(
    runId: string,
    options: ResumeRunOptions = {},
  ): Promise<StartRunResult> {
    const caseDir = await this.findCaseDir(runId)
    const caseState = await readCase(caseDir)
    if (caseState.run.status !== 'paused_human') {
      throw new Error(`Run ${runId} is not paused_human (status=${caseState.run.status})`)
    }

    const journal = await readJournal(caseDir)
    // Find the open gate (last gate_opened without gate_resolved)
    const open = findOpenGate(journal)
    if (!open) {
      // Crash window: gate_resolved reached disk but the process died before
      // the status flip. The gate is answered — recover by continuing; the
      // retried gateResponse (if any) is redundant and discarded.
      console.warn(
        `resumeRun: run ${runId} is paused_human with no open gate (crashed mid-resume); continuing`,
      )
      await updateRun(caseDir, { status: 'running' })
      return this.execute(
        caseDir,
        await this.resolveRunWorkflow(caseState, options),
        options.runScript,
      )
    }

    const values = options.gateResponse ?? {}
    // The gate declared which fields the human must supply — enforce it here,
    // or a resume with {} succeeds and run.ts reads undefined downstream.
    const missing = open.fields.filter((f) => values[f] === undefined || values[f] === null)
    if (missing.length > 0) {
      throw new ContractValidationError(
        missing.map((f) => ({
          field: f,
          reason: 'missing',
          message: `gate "${open.label}" requires field "${f}" in gateResponse`,
        })),
      )
    }
    const resolved: JournalEntry = {
      type: 'gate_resolved',
      ts: nowIso(),
      stepId: open.stepId,
      label: open.label,
      seq: open.seq,
      values,
    }
    await appendJournal(caseDir, resolved)
    await mergeFields(caseDir, values)
    await updateRun(caseDir, { status: 'running' })

    return this.execute(
      caseDir,
      await this.resolveRunWorkflow(caseState, options),
      options.runScript,
    )
  }

  /**
   * Re-enter a non-terminal, non-paused run after a crash or engine restart:
   * re-executes run.ts from the top; the journaled prefix replays from cache.
   * For paused_human runs use resumeRun; terminal runs cannot be re-entered.
   */
  async continueRun(
    runId: string,
    options: Pick<ResumeRunOptions, 'runScript' | 'workflow'> = {},
  ): Promise<StartRunResult> {
    return this.withRunLock(runId, () => this.continueRunInner(runId, options))
  }

  private async continueRunInner(
    runId: string,
    options: Pick<ResumeRunOptions, 'runScript' | 'workflow'> = {},
  ): Promise<StartRunResult> {
    const caseDir = await this.findCaseDir(runId)
    const caseState = await readCase(caseDir)
    if (isTerminalStatus(caseState.run.status)) {
      throw new Error(`Run ${runId} is ${caseState.run.status} (terminal); cannot continue`)
    }
    if (caseState.run.status === 'paused_human') {
      // A genuinely open gate needs resumeRun; but if every gate is resolved
      // (crash between gate_resolved and the status flip), this run is
      // continue-eligible — recover it.
      const open = findOpenGate(await readJournal(caseDir))
      if (open) {
        throw new Error(`Run ${runId} is paused at a human gate; use resumeRun with a gateResponse`)
      }
      await updateRun(caseDir, { status: 'running' })
    }
    return this.execute(
      caseDir,
      await this.resolveRunWorkflow(caseState, options),
      options.runScript,
    )
  }

  private async resolveRunWorkflow(
    caseState: CaseState,
    options: Pick<ResumeRunOptions, 'workflow'>,
  ): Promise<LoadedWorkflow> {
    return (
      options.workflow ??
      (caseState.run.workflowDir
        ? await loadWorkflowDir(caseState.run.workflowDir)
        : await loadWorkflowDir(
            resolveWorkflowDir(caseState.run.workflowId, {
              workflowDirs: this.config.workflowDirs,
              workflowsRoots: this.config.workflowsRoots,
            }),
          ))
    )
  }

  /**
   * Mark a run killed. Kill flag is checked between steps; cascades to
   * child dirs that have case.json (best-effort).
   */
  async killRun(runId: string): Promise<void> {
    const caseDir = await this.findCaseDir(runId)
    killFlags.set(runId, true)
    await writeFile(join(caseDir, 'KILLED'), nowIso(), 'utf-8')
    await updateRun(caseDir, { status: 'killed', finishedAt: nowIso() })
    await appendJournal(caseDir, {
      type: 'run_finished',
      ts: nowIso(),
      runId,
      status: 'killed',
    })
    // Cascade: mark nested child case dirs
    await cascadeKill(caseDir)
  }

  /**
   * Resolve a run id to its absolute caseDir (top-level or nested child).
   * Public for gateway detail endpoints.
   */
  async resolveCaseDir(runId: string): Promise<string> {
    return this.findCaseDir(runId)
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private async execute(
    caseDir: string,
    workflow: LoadedWorkflow,
    runScript?: RunScript,
  ): Promise<StartRunResult> {
    const caseState = await readCase(caseDir)
    const runId = caseState.run.id
    const journal = await readJournal(caseDir)
    const stepTimeoutMs = resolveStepTimeoutMs(this.config)
    const maxRuntimeMs = resolveMaxRunRuntimeMs(this.config)
    const deadline = Date.now() + maxRuntimeMs

    const { step, getDoneOutput } = createStepRuntime({
      caseDir,
      runId,
      workflow,
      journal,
      executors: this.config.executors,
      callRegistry: this.callRegistry,
      stepTimeoutMs,
      isKilled: () => killFlags.get(runId) === true || existsSync(join(caseDir, 'KILLED')),
      outputFields: workflow.manifest.output,
      budgets: workflow.manifest.budgets,
    })

    const ctx: RunScriptContext = {
      runId,
      input: { ...caseState.fields },
      caseDir,
      workflow,
      fields: caseState.fields,
    }

    // Engine-level max runtime: race the script against a timer.
    // Per-step timeout is passed to executors; full enforcement is TODO when
    // real executors support AbortSignal (documented in README/NOTES).
    try {
      // Script load lives INSIDE the durable try: a missing/broken run.ts must
      // mark the run failed, not strand it at 'running' (matters for detached
      // starts, where nobody awaits this promise).
      const script = runScript ?? (await loadRunScript(workflow.runPath))
      await withTimeout(
        script(step, ctx),
        Math.max(0, deadline - Date.now()),
        () => new RunTimeoutError(runId, maxRuntimeMs),
      )

      const output = getDoneOutput() ?? (await readCase(caseDir)).fields
      await updateRun(caseDir, {
        status: 'done',
        output: output,
        finishedAt: nowIso(),
      })
      await appendJournal(caseDir, {
        type: 'run_finished',
        ts: nowIso(),
        runId,
        status: 'done',
        output: output,
      })
      const final = await readCase(caseDir)
      return { run: final.run, caseDir, suspended: false }
    } catch (err) {
      if (isWorkflowSuspension(err)) {
        const final = await readCase(caseDir)
        // A kill can land between the gate opening and this catch; the
        // terminal status won (updateCase refused the pause write) — report
        // the terminal outcome, not a suspension.
        if (isTerminalStatus(final.run.status)) {
          return { run: final.run, caseDir, suspended: false }
        }
        return {
          run: final.run,
          caseDir,
          suspended: true,
          suspension: {
            stepId: err.stepId,
            label: err.label,
            seq: err.seq,
          },
        }
      }
      if (isWorkflowKilled(err) || err instanceof WorkflowKilled) {
        await updateRun(caseDir, {
          status: 'killed',
          finishedAt: nowIso(),
          error: err instanceof Error ? err.message : String(err),
        })
        await appendJournal(caseDir, {
          type: 'run_finished',
          ts: nowIso(),
          runId,
          status: 'killed',
          error: err instanceof Error ? err.message : String(err),
        })
        const final = await readCase(caseDir)
        return { run: final.run, caseDir, suspended: false }
      }

      const message = err instanceof Error ? err.message : String(err)
      await updateRun(caseDir, {
        status: 'failed',
        error: message,
        finishedAt: nowIso(),
      })
      await appendJournal(caseDir, {
        type: 'run_finished',
        ts: nowIso(),
        runId,
        status: 'failed',
        error: message,
      })
      const final = await readCase(caseDir)
      return { run: final.run, caseDir, suspended: false }
    }
  }

  private async findCaseDir(runId: string): Promise<string> {
    // Direct child of root
    const root = resolveCaseDirRoot(this.config)
    const direct = join(root, runId)
    if (existsSync(join(direct, 'case.json'))) return direct

    // Also accept absolute caseDir as runId for tests
    if (existsSync(join(runId, 'case.json'))) return runId

    // Search config.workflowDirs? No — search under root one level + nested
    const found = await findCaseDirRecursive(root, runId, 4)
    if (found) return found

    throw new RunNotFoundError(runId)
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Enforce budgets.maxConcurrentRuns before creating a new run.
 * Scans caseDirRoot (incl. nested child runs) for non-terminal rows of the
 * same workflowId. Zero / undefined cap = unlimited.
 */
export async function assertUnderConcurrentCap(
  caseDirRoot: string,
  workflowId: string,
  maxConcurrentRuns: number | undefined,
): Promise<void> {
  // undefined / non-finite / <= 0 = unlimited (task: zero/no-budget = unlimited)
  if (
    maxConcurrentRuns === undefined ||
    !Number.isFinite(maxConcurrentRuns) ||
    maxConcurrentRuns <= 0
  ) {
    return
  }
  // depth high enough to catch step.call children nested under parents
  const runs = await listRuns(caseDirRoot, { limit: 50_000, depth: 8 })
  const active = runs.filter((r) => r.workflowId === workflowId && !isTerminalStatus(r.status))
  if (active.length >= maxConcurrentRuns) {
    throw new MaxConcurrentRunsError({
      workflowId,
      max: maxConcurrentRuns,
      current: active.length,
    })
  }
}

async function loadRunScript(runPath: string): Promise<RunScript> {
  // Dynamic import — works for .js; .ts requires tsx/ts-node or prior compile.
  // Decision (NOTES): prefer precompiled run.js; in dev, host runs with tsx.
  const url = pathToFileURL(runPath).href
  const mod = (await import(url)) as { default?: RunScript; run?: RunScript }
  const fn = mod.default ?? mod.run
  if (typeof fn !== 'function') {
    throw new Error(
      `run script at ${runPath} must default-export an async function (step, ctx) => void`,
    )
  }
  return fn
}

function withTimeout<T>(promise: Promise<T>, ms: number, makeError: () => Error): Promise<T> {
  if (!Number.isFinite(ms) || ms <= 0) {
    return Promise.reject(makeError())
  }
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(makeError()), ms)
    promise.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      (e: unknown) => {
        clearTimeout(timer)
        reject(e instanceof Error ? e : new Error(String(e)))
      },
    )
  })
}

async function cascadeKill(parentCaseDir: string): Promise<void> {
  // Best-effort: look for immediate subdirs with case.json
  try {
    const entries = await readdir(parentCaseDir, { withFileTypes: true })
    for (const ent of entries) {
      if (!ent.isDirectory()) continue
      const child = join(parentCaseDir, ent.name)
      if (!existsSync(join(child, 'case.json'))) continue
      await writeFile(join(child, 'KILLED'), nowIso(), 'utf-8')
      try {
        const st = await readCase(child)
        killFlags.set(st.run.id, true)
        await updateRun(child, { status: 'killed', finishedAt: nowIso() })
      } catch {
        /* ignore */
      }
      await cascadeKill(child)
    }
  } catch {
    /* ignore */
  }
}

async function findCaseDirRecursive(
  root: string,
  runId: string,
  depth: number,
): Promise<string | null> {
  if (depth < 0 || !existsSync(root)) return null
  try {
    const entries = await readdir(root, { withFileTypes: true })
    for (const ent of entries) {
      if (!ent.isDirectory()) continue
      const p = join(root, ent.name)
      if (ent.name === runId && existsSync(join(p, 'case.json'))) return p
      // case.json run.id match
      if (existsSync(join(p, 'case.json'))) {
        try {
          const raw = await readFile(join(p, 'case.json'), 'utf-8')
          const st = JSON.parse(raw) as CaseState
          if (st.run?.id === runId) return p
        } catch {
          /* ignore */
        }
      }
      const nested = await findCaseDirRecursive(p, runId, depth - 1)
      if (nested) return nested
    }
  } catch {
    return null
  }
  return null
}
