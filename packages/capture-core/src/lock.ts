import { mkdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { hostname } from 'node:os'
import { dirname, join } from 'node:path'

export class LockTimeout extends Error {
  readonly lockDir: string

  constructor(lockDir: string) {
    super(`lock timeout: ${lockDir}`)
    this.name = 'LockTimeout'
    this.lockDir = lockDir
  }
}

export interface FileLockOptions {
  staleMs?: number
  waitMs?: number
  pollMs?: number
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

async function takeoverIfStale(lockDir: string, staleMs: number): Promise<boolean> {
  let mtimeMs: number
  try {
    mtimeMs = (await stat(lockDir)).mtimeMs
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
  if (Date.now() - mtimeMs <= staleMs) return false
  const stalePath = `${lockDir}.stale-${String(Date.now())}`
  try {
    await rename(lockDir, stalePath)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'EEXIST' || code === 'ENOTEMPTY') return false
    throw error
  }
  await rm(stalePath, { recursive: true, force: true }).catch(() => undefined)
  return true
}

/**
 * Exclusive lock implemented as `mkdir(lockDir)`. A holder that dies leaves
 * the directory; a lock older than `staleMs` (mtime) is renamed aside and
 * removed so the next waiter can take it. The directory is always removed
 * on the way out, including when `fn` throws.
 */
export async function withFileLock<T>(
  lockDir: string,
  fn: () => Promise<T> | T,
  opts?: FileLockOptions,
): Promise<T> {
  const staleMs = opts?.staleMs ?? 120_000
  const waitMs = opts?.waitMs ?? 10_000
  const pollMs = opts?.pollMs ?? 100
  const deadline = Date.now() + waitMs
  await mkdir(dirname(lockDir), { recursive: true })

  for (;;) {
    try {
      await mkdir(lockDir)
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      if (await takeoverIfStale(lockDir, staleMs)) continue
      if (Date.now() >= deadline) throw new LockTimeout(lockDir)
      await sleep(pollMs)
    }
  }

  try {
    await writeFile(
      join(lockDir, 'owner.json'),
      JSON.stringify({ pid: process.pid, host: hostname(), ts: new Date().toISOString() }),
      { mode: 0o600 },
    )
    return await fn()
  } finally {
    await rm(lockDir, { recursive: true, force: true }).catch(() => undefined)
  }
}
