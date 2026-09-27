import { utimesSync } from 'node:fs'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
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
  log?: (line: string) => void
  /**
   * Runs after a stale directory is observed and before the re-stat that
   * gates the rename. Tests use it to delay one taker until the other has
   * entered. Production callers leave it unset.
   */
  afterStaleStat?: () => Promise<void> | void
}

interface OwnerRecord {
  pid: number
  host: string
  ts: string
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

function sameOwner(current: Partial<OwnerRecord>, owner: OwnerRecord): boolean {
  return current.pid === owner.pid && current.host === owner.host && current.ts === owner.ts
}

/**
 * Exclusive lock implemented as `mkdir(lockDir)`. A holder that dies leaves
 * the directory; a lock older than `staleMs` (mtime) may be taken over only
 * when a re-stat immediately before the rename still shows that same inode
 * and mtime. The holder refreshes mtime while `fn` runs and removes the
 * directory on the way out only when `owner.json` is still the record it wrote.
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
  const log = (line: string): void => {
    try {
      ;(opts?.log ?? ((message: string) => console.error(message)))(line)
    } catch {
      /* Logging must not interrupt the lock. */
    }
  }
  await mkdir(dirname(lockDir), { recursive: true })

  for (;;) {
    try {
      await mkdir(lockDir)
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      if (await takeoverIfStale(lockDir, staleMs, opts?.afterStaleStat, log)) continue
      if (Date.now() >= deadline) throw new LockTimeout(lockDir)
      await sleep(pollMs)
    }
  }

  const owner: OwnerRecord = { pid: process.pid, host: hostname(), ts: new Date().toISOString() }
  await writeFile(join(lockDir, 'owner.json'), JSON.stringify(owner), { mode: 0o600 })
  const heartbeatMs = Math.max(1, Math.floor(staleMs / 3))
  const timer = setInterval(() => {
    const now = new Date()
    try {
      utimesSync(lockDir, now, now)
    } catch {
      /* The directory may already have been removed. */
    }
  }, heartbeatMs)

  try {
    return await fn()
  } finally {
    clearInterval(timer)
    await releaseOwnLock(lockDir, owner, log)
  }
}

async function takeoverIfStale(
  lockDir: string,
  staleMs: number,
  afterStaleStat: FileLockOptions['afterStaleStat'],
  log: (line: string) => void,
): Promise<boolean> {
  let observedIno: number
  let observedMtime: number
  try {
    const first = await stat(lockDir)
    observedIno = first.ino
    observedMtime = first.mtimeMs
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
  if (Date.now() - observedMtime <= staleMs) return false
  if (afterStaleStat) await afterStaleStat()

  try {
    const again = await stat(lockDir)
    if (again.ino !== observedIno || again.mtimeMs !== observedMtime) return false
    if (Date.now() - again.mtimeMs <= staleMs) return false
    observedIno = again.ino
    observedMtime = again.mtimeMs
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }

  const stalePath = `${lockDir}.stale-${String(Date.now())}-${Math.random().toString(36).slice(2)}`
  try {
    await rename(lockDir, stalePath)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    // ENOENT: it vanished. EEXIST/ENOTEMPTY: the stale destination was already
    // claimed. Either way someone else won; go back to waiting.
    if (code === 'ENOENT' || code === 'EEXIST' || code === 'ENOTEMPTY') return false
    throw error
  }

  try {
    const moved = await stat(stalePath)
    if (moved.ino !== observedIno || moved.mtimeMs !== observedMtime) {
      try {
        await rename(stalePath, lockDir)
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code !== 'ENOENT' && code !== 'EEXIST' && code !== 'ENOTEMPTY') throw error
        log(`stale takeover put back ${stalePath} failed (${code}); left in place`)
      }
      return false
    }
  } catch (error) {
    log(`stale takeover could not stat ${stalePath}: ${String(error)}`)
    return false
  }

  await rm(stalePath, { recursive: true, force: true }).catch(() => undefined)
  return true
}

async function releaseOwnLock(
  lockDir: string,
  owner: OwnerRecord,
  log: (line: string) => void,
): Promise<void> {
  let current: Partial<OwnerRecord>
  try {
    current = JSON.parse(
      await readFile(join(lockDir, 'owner.json'), 'utf8'),
    ) as Partial<OwnerRecord>
  } catch (error) {
    log(`not releasing ${lockDir}: ${String(error)}`)
    return
  }
  if (!sameOwner(current, owner)) {
    log(`not releasing ${lockDir}: owner is ${JSON.stringify(current)}`)
    return
  }
  await rm(lockDir, { recursive: true, force: true }).catch((error: unknown) => {
    log(`release ${lockDir} failed: ${String(error)}`)
  })
}
