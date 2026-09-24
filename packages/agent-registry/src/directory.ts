import { existsSync, lstatSync, mkdirSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentPreset } from '@rivetos/types'

export interface EnsureAgentDirectoryOptions {
  sharedDir?: string
  /** default `rivet-shared` */
  linkName?: string
  log?: (msg: string) => void
}

export interface EnsureAgentDirectoryResult {
  created: boolean
  linked: boolean
  reason?: string
}

function isEnoent(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && err.code === 'ENOENT'
}

/**
 * Create `preset.directory` (mode `0700`) and, when a shared dir is given and
 * the preset does not opt out, a symlink at `<directory>/<linkName>`.
 * Idempotent. A real file or directory already at the link path is left
 * alone. A missing `sharedDir` does not throw — the symlink may dangle.
 */
export function ensureAgentDirectory(
  preset: Pick<AgentPreset, 'directory' | 'sharedLink'>,
  opts?: EnsureAgentDirectoryOptions,
): EnsureAgentDirectoryResult {
  const directory = preset.directory?.trim() ?? ''
  if (!directory) throw new Error('agent directory is empty')

  const existed = existsSync(directory)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const created = !existed
  if (created) opts?.log?.(`created agent directory ${directory}`)

  if (!opts?.sharedDir || preset.sharedLink === false) {
    return { created, linked: false }
  }

  const linkName = opts.linkName ?? 'rivet-shared'
  const link = join(directory, linkName)
  const sharedDir = opts.sharedDir
  const dangling = !existsSync(sharedDir)
  const danglingReason = dangling
    ? `shared directory ${sharedDir} does not exist; symlink may dangle`
    : undefined

  let current: ReturnType<typeof lstatSync> | undefined
  try {
    current = lstatSync(link)
  } catch (err) {
    if (!isEnoent(err)) throw err
  }

  if (!current) {
    symlinkSync(sharedDir, link)
    opts.log?.(`linked ${link} -> ${sharedDir}`)
    return danglingReason
      ? { created, linked: true, reason: danglingReason }
      : { created, linked: true }
  }

  if (current.isSymbolicLink()) {
    return danglingReason
      ? { created, linked: true, reason: danglingReason }
      : { created, linked: true }
  }

  const kind = current.isDirectory() ? 'directory' : 'file'
  const reason = `leaving existing ${kind} at ${link}; not replacing it with the shared-directory symlink`
  opts.log?.(reason)
  return { created, linked: false, reason }
}
