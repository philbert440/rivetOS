/**
 * Scan caseDirRoot / workflowsRoots for runs and workflow definitions.
 * Unknown/malformed dirs are skipped with a warning — list endpoints must not crash.
 */

import { readdir, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { loadWorkflowDir } from './loader.js'
import type { CaseState, LoadedWorkflow, Run, RunStatus } from './types.js'

export interface RunSummary {
  id: string
  workflowId: string
  status: RunStatus
  startedAt?: string
  finishedAt?: string
  current?: string
  caseDir: string
  /** True when this run is nested under another run's caseDir. */
  nested?: boolean
  parentRunId?: string
  version?: string
}

export interface ListRunsOptions {
  /** Max runs to return (newest first by startedAt). Default 100. */
  limit?: number
  /**
   * How deep to scan for nested child runs (0 = top-level only).
   * Default 0 for the list endpoint; detail uses listChildRuns.
   */
  depth?: number
}

/**
 * List runs by scanning case.json under caseDirRoot.
 * Skips unreadable/malformed dirs (logs a warning via onWarn).
 */
export async function listRuns(
  caseDirRoot: string,
  opts: ListRunsOptions = {},
  onWarn: (msg: string) => void = defaultWarn,
): Promise<RunSummary[]> {
  const limit = opts.limit ?? 100
  const depth = opts.depth ?? 0
  if (!existsSync(caseDirRoot)) return []

  const found: RunSummary[] = []
  await scanRuns(caseDirRoot, depth, 0, found, onWarn, undefined)

  found.sort((a, b) => {
    const ta = a.startedAt ?? ''
    const tb = b.startedAt ?? ''
    return tb.localeCompare(ta)
  })
  return found.slice(0, limit)
}

/**
 * Immediate child runs nested under a parent caseDir (one level).
 */
export async function listChildRuns(
  caseDir: string,
  onWarn: (msg: string) => void = defaultWarn,
): Promise<RunSummary[]> {
  if (!existsSync(caseDir)) return []
  const found: RunSummary[] = []
  let parentRunId: string | undefined
  try {
    const parent = await readCaseSafe(caseDir)
    parentRunId = parent?.run.id
  } catch {
    /* ignore */
  }
  try {
    const entries = await readdir(caseDir, { withFileTypes: true })
    for (const ent of entries) {
      if (!ent.isDirectory()) continue
      const childDir = join(caseDir, ent.name)
      const summary = await readRunSummary(childDir, onWarn, parentRunId)
      if (summary) {
        summary.nested = true
        found.push(summary)
      }
    }
  } catch (err) {
    onWarn(`listChildRuns: failed reading ${caseDir}: ${errMsg(err)}`)
  }
  found.sort((a, b) => (b.startedAt ?? '').localeCompare(a.startedAt ?? ''))
  return found
}

/**
 * List workflow definitions from one or more roots.
 * Each immediate child directory with workflow.yaml is a definition.
 * Skips malformed dirs.
 */
export async function listWorkflowDefs(
  workflowsRoots: string[],
  onWarn: (msg: string) => void = defaultWarn,
): Promise<LoadedWorkflow[]> {
  const out: LoadedWorkflow[] = []
  const seen = new Set<string>()

  for (const root of workflowsRoots) {
    if (!existsSync(root)) {
      onWarn(`listWorkflowDefs: root missing: ${root}`)
      continue
    }
    let entries
    try {
      entries = await readdir(root, { withFileTypes: true })
    } catch (err) {
      onWarn(`listWorkflowDefs: cannot read ${root}: ${errMsg(err)}`)
      continue
    }
    for (const ent of entries) {
      if (!ent.isDirectory()) continue
      const dir = join(root, ent.name)
      if (!existsSync(join(dir, 'workflow.yaml'))) continue
      try {
        const loaded = await loadWorkflowDir(dir)
        if (seen.has(loaded.manifest.id)) {
          onWarn(`listWorkflowDefs: duplicate id "${loaded.manifest.id}" in ${dir} (keeping first)`)
          continue
        }
        seen.add(loaded.manifest.id)
        out.push(loaded)
      } catch (err) {
        onWarn(`listWorkflowDefs: skip ${dir}: ${errMsg(err)}`)
      }
    }
  }

  out.sort((a, b) => a.manifest.name.localeCompare(b.manifest.name))
  return out
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

async function scanRuns(
  dir: string,
  maxDepth: number,
  depth: number,
  out: RunSummary[],
  onWarn: (msg: string) => void,
  parentRunId: string | undefined,
): Promise<void> {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch (err) {
    onWarn(`listRuns: cannot read ${dir}: ${errMsg(err)}`)
    return
  }

  for (const ent of entries) {
    if (!ent.isDirectory()) continue
    const child = join(dir, ent.name)
    const summary = await readRunSummary(child, onWarn, parentRunId)
    if (summary) {
      summary.nested = depth > 0
      out.push(summary)
      if (depth < maxDepth) {
        await scanRuns(child, maxDepth, depth + 1, out, onWarn, summary.id)
      }
    }
  }
}

async function readRunSummary(
  caseDir: string,
  onWarn: (msg: string) => void,
  parentRunId?: string,
): Promise<RunSummary | null> {
  const casePath = join(caseDir, 'case.json')
  if (!existsSync(casePath)) return null
  try {
    const raw = await readFile(casePath, 'utf-8')
    const state = JSON.parse(raw) as CaseState
    const run = state?.run
    if (!run || typeof run.id !== 'string' || typeof run.workflowId !== 'string') {
      onWarn(`listRuns: malformed case.json (missing run.id/workflowId) in ${caseDir}`)
      return null
    }
    return toSummary(run, caseDir, parentRunId)
  } catch (err) {
    onWarn(`listRuns: skip ${caseDir}: ${errMsg(err)}`)
    return null
  }
}

async function readCaseSafe(caseDir: string): Promise<CaseState | null> {
  try {
    const raw = await readFile(join(caseDir, 'case.json'), 'utf-8')
    return JSON.parse(raw) as CaseState
  } catch {
    return null
  }
}

function toSummary(run: Run, caseDir: string, parentRunId?: string): RunSummary {
  return {
    id: run.id,
    workflowId: run.workflowId,
    status: run.status,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    current: run.current,
    caseDir,
    parentRunId: parentRunId ?? run.parent?.runId,
    version: run.version,
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function defaultWarn(msg: string): void {
  console.warn(msg)
}
