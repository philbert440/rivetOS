/**
 * case.json — run metadata + contract field bag.
 *
 * Writes are atomic (tmp + rename) and refuse to overwrite a terminal run:
 * once status is done/failed/killed, late writers (orphaned steps after a
 * timeout or kill) cannot clobber the terminal state.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { CaseState, Run, RunStatus } from './types.js'

export const CASE_FILENAME = 'case.json'

const TERMINAL_STATUSES: readonly RunStatus[] = ['done', 'failed', 'killed']

export function isTerminalStatus(status: RunStatus): boolean {
  return TERMINAL_STATUSES.includes(status)
}

export function casePath(caseDir: string): string {
  return join(caseDir, CASE_FILENAME)
}

let tmpCounter = 0

export async function writeCase(caseDir: string, state: CaseState): Promise<void> {
  await mkdir(caseDir, { recursive: true })
  const path = casePath(caseDir)
  // Unique tmp per write: concurrent writers (parallel branches bumping
  // run.current) must never clobber each other's tmp mid-write — rename is
  // atomic, so last-rename-wins is safe; a shared tmp path is not.
  tmpCounter += 1
  const tmp = `${path}.${String(process.pid)}.${String(tmpCounter)}.tmp`
  await writeFile(tmp, JSON.stringify(state, null, 2) + '\n', 'utf-8')
  await rename(tmp, path)
}

export async function readCase(caseDir: string): Promise<CaseState> {
  const path = casePath(caseDir)
  if (!existsSync(path)) {
    throw new Error(`case.json not found in ${caseDir}`)
  }
  const raw = await readFile(path, 'utf-8')
  return JSON.parse(raw) as CaseState
}

export async function updateCase(
  caseDir: string,
  mutate: (state: CaseState) => CaseState | undefined,
): Promise<CaseState> {
  const state = await readCase(caseDir)
  if (isTerminalStatus(state.run.status)) {
    // Terminal runs are immutable — a late writer (orphan step after
    // timeout/kill, double finish) must not resurrect or clobber them.
    console.warn(`updateCase: run ${state.run.id} is ${state.run.status} (terminal); write ignored`)
    return state
  }
  const next = mutate(state)
  const finalState = next ?? state
  await writeCase(caseDir, finalState)
  return finalState
}

export async function mergeFields(
  caseDir: string,
  fields: Record<string, unknown>,
): Promise<CaseState> {
  return updateCase(caseDir, (state) => ({
    ...state,
    fields: { ...state.fields, ...fields },
  }))
}

export async function updateRun(caseDir: string, patch: Partial<Run>): Promise<CaseState> {
  return updateCase(caseDir, (state) => ({
    ...state,
    run: { ...state.run, ...patch },
  }))
}

/**
 * Create a nested child caseDir under the parent run directory.
 * Layout: parentCaseDir/<childRunId>/
 */
export function childCaseDir(parentCaseDir: string, childRunId: string): string {
  return join(parentCaseDir, childRunId)
}
