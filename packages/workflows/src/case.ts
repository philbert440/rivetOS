/**
 * case.json — run metadata + contract field bag.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { CaseState, Run } from './types.js'

export const CASE_FILENAME = 'case.json'

export function casePath(caseDir: string): string {
  return join(caseDir, CASE_FILENAME)
}

export async function writeCase(caseDir: string, state: CaseState): Promise<void> {
  await mkdir(caseDir, { recursive: true })
  await writeFile(casePath(caseDir), JSON.stringify(state, null, 2) + '\n', 'utf-8')
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
