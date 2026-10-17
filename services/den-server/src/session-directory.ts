/**
 * A client-sent session directory (a RivetHub project's), shared by
 * `POST /term` and `POST /api/harnesses/:id/sessions`. Validated like a
 * preset directory, and it must already exist: the den creates an agent's
 * own directory, never an arbitrary one.
 */

import { statSync } from 'node:fs'
import { validateDirectory } from '@rivetos/agent-registry'

/** True when `path` exists and is a directory (a session directory is never created). */
function isExistingDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/** The normalised directory, or the 400 message that refuses it. */
export function checkSessionDirectory(
  raw: unknown,
): { ok: true; directory: string } | { ok: false; error: string } {
  const directory = validateDirectory(raw)
  if (!directory) return { ok: false, error: 'directory must be an absolute path' }
  if (!isExistingDirectory(directory))
    return { ok: false, error: `directory ${directory} does not exist` }
  return { ok: true, directory }
}
