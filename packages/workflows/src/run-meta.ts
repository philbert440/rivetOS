/**
 * User-owned run metadata (display label) kept beside case.json.
 *
 * Deliberately NOT in case.json: that file is engine state, rewritten by the
 * engine mid-run and frozen once the run is terminal (`updateCase` drops the
 * write). Renaming a finished run is the main use of a label, and a separate
 * file can't race the engine's own read-modify-write of case.json.
 */

import { readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export const RUN_META_FILENAME = 'run-meta.json'

/** Labels are display text — long enough for "repo#123 — fix flaky login", no essays. */
export const RUN_LABEL_MAX = 120

export interface RunMeta {
  label?: string
}

let tmpCounter = 0

/** Read run-meta.json; missing or malformed reads as empty — labels are optional. */
export async function readRunMeta(caseDir: string): Promise<RunMeta> {
  try {
    const raw: unknown = JSON.parse(await readFile(join(caseDir, RUN_META_FILENAME), 'utf-8'))
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
    const label = normalizeRunLabel((raw as Record<string, unknown>).label)
    return label !== undefined ? { label } : {}
  } catch {
    return {}
  }
}

export async function writeRunMeta(caseDir: string, meta: RunMeta): Promise<void> {
  const path = join(caseDir, RUN_META_FILENAME)
  tmpCounter += 1
  const tmp = `${path}.${String(process.pid)}.${String(tmpCounter)}.tmp`
  await writeFile(tmp, JSON.stringify(meta, null, 2) + '\n', 'utf-8')
  await rename(tmp, path)
}

/**
 * Collapse whitespace, trim, cap at RUN_LABEL_MAX. Non-strings and empty
 * results are undefined (= no label).
 */
export function normalizeRunLabel(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  const s = raw.replace(/\s+/g, ' ').trim()
  if (!s) return undefined
  return s.length > RUN_LABEL_MAX ? s.slice(0, RUN_LABEL_MAX - 1).trimEnd() + '…' : s
}

/**
 * Render a `runLabel` template from workflow.yaml against start input.
 * `{{field}}` → the input value for scalars; missing / non-scalar → empty.
 */
export function renderRunLabel(
  template: string,
  input: Record<string, unknown>,
): string | undefined {
  const out = template.replace(/\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g, (_m, key: string) => {
    const v = input[key]
    return typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' ? String(v) : ''
  })
  return normalizeRunLabel(out)
}

/** Explicit label wins; otherwise the manifest template; otherwise none. */
export function resolveRunLabel(
  explicit: unknown,
  template: string | undefined,
  input: Record<string, unknown>,
): string | undefined {
  return (
    normalizeRunLabel(explicit) ??
    (template !== undefined ? renderRunLabel(template, input) : undefined)
  )
}
