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
import { childCaseDir, readCase, writeCase, updateRun, mergeFields } from './case.js'
import { appendJournal, readJournal, nowIso, ensureJournal } from './journal.js'
import { loadWorkflowDir, resolveWorkflowDir } from './loader.js'
import { validateStartInput } from './manifest.js'
import { createStepRuntime, type Step } from './step.js'
import { createCallRegistry, type CallRegistry, type CallResolver } from './registry.js'
import {
  isWorkflowKilled,
  isWorkflowSuspension,
  RunNotFoundError,
  RunTimeoutError,
  WorkflowKilled,
} from './errors.js'
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

  /**
   * Resume a paused_human run: record gate_resolved, re-execute from top.
   */
  async resumeRun(runId: string, options: ResumeRunOptions = {}): Promise<StartRunResult> {
    const caseDir = await this.findCaseDir(runId)
    const caseState = await readCase(caseDir)
    if (caseState.run.status !== 'paused_human') {
      throw new Error(`Run ${runId} is not paused_human (status=${caseState.run.status})`)
    }

    const journal = await readJournal(caseDir)
    // Find the open gate (last gate_opened without gate_resolved)
    const open = findOpenGate(journal)
    if (!open) {
      throw new Error(`Run ${runId} is paused_human but no open gate found in journal`)
    }

    const values = options.gateResponse ?? {}
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

    const workflow =
      options.workflow ??
      (caseState.run.workflowDir
        ? await loadWorkflowDir(caseState.run.workflowDir)
        : await loadWorkflowDir(
            resolveWorkflowDir(caseState.run.workflowId, {
              workflowDirs: this.config.workflowDirs,
              workflowsRoots: this.config.workflowsRoots,
            }),
          ))

    return this.execute(caseDir, workflow, options.runScript)
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
      outputFieldNames: new Set(workflow.manifest.output.map((f) => f.name)),
    })

    const script = runScript ?? (await loadRunScript(workflow.runPath))

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

function findOpenGate(
  journal: JournalEntry[],
): { stepId: string; label: string; seq: number } | null {
  const opened: Array<{ stepId: string; label: string; seq: number }> = []
  const resolved = new Set<string>()
  for (const e of journal) {
    if (e.type === 'gate_opened') {
      opened.push({ stepId: e.stepId, label: e.label, seq: e.seq })
    }
    if (e.type === 'gate_resolved') {
      resolved.add(e.stepId)
    }
  }
  for (let i = opened.length - 1; i >= 0; i--) {
    if (!resolved.has(opened[i].stepId)) return opened[i]
  }
  return null
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
