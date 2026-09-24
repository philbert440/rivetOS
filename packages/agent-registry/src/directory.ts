import { existsSync, lstatSync, mkdirSync, readlinkSync, symlinkSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import type { AgentPreset } from '@rivetos/types'
import { validateDirectory } from './validate.js'

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

function isErrno(err: unknown, code: string): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && err.code === code
}

/** Reason from the link's actual target, not from `opts.sharedDir`. */
function existingSymlinkReason(link: string): string | undefined {
  const target = readlinkSync(link)
  const resolved = resolve(dirname(link), target)
  if (existsSync(resolved)) return undefined
  return `shared directory ${target} does not exist; symlink may dangle`
}

function linkedResult(created: boolean, link: string): EnsureAgentDirectoryResult {
  const reason = existingSymlinkReason(link)
  return reason ? { created, linked: true, reason } : { created, linked: true }
}

/**
 * Create `preset.directory` (mode `0700`) and, when a shared dir is given and
 * the preset does not opt out, a symlink at `<directory>/<linkName>`.
 * Idempotent. A real file or directory already at the link path is left
 * alone. An existing symlink is left alone; its `reason` comes from the
 * target it already has. A missing `sharedDir` does not throw — the symlink
 * may dangle. `EEXIST` (two materialisers racing) is re-statted, not thrown.
 */
export function ensureAgentDirectory(
  preset: Pick<AgentPreset, 'directory' | 'sharedLink'>,
  opts?: EnsureAgentDirectoryOptions,
): EnsureAgentDirectoryResult {
  const raw = preset.directory
  if (typeof raw === 'string' && raw.trim() === '') {
    throw new Error('agent directory is empty')
  }
  const directory = validateDirectory(raw)
  if (directory === undefined) {
    throw new Error('agent directory must be an absolute path')
  }

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

  let current: ReturnType<typeof lstatSync> | undefined
  try {
    current = lstatSync(link)
  } catch (err) {
    if (!isErrno(err, 'ENOENT')) throw err
  }

  if (!current) {
    try {
      symlinkSync(sharedDir, link)
      opts.log?.(`linked ${link} -> ${sharedDir}`)
      return linkedResult(created, link)
    } catch (err) {
      if (!isErrno(err, 'EEXIST')) throw err
      current = lstatSync(link)
    }
  }

  if (current.isSymbolicLink()) return linkedResult(created, link)

  const kind = current.isDirectory() ? 'directory' : 'file'
  const reason = `leaving existing ${kind} at ${link}; not replacing it with the shared-directory symlink`
  opts.log?.(reason)
  return { created, linked: false, reason }
}
