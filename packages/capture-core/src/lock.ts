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
   * Runs after a stale directory is observed and before the reclaim mutex
   * is taken. Tests use it to delay one taker until the other has entered.
   * Production callers leave it unset.
   */
  afterStaleStat?: () => Promise<void> | void
  /**
   * Runs inside the reclaim mutex, after the stat that authorized the
   * takeover and before the rename. Tests delay here so other contenders
   * arrive while the mutex is held. Production callers leave it unset.
   */
  afterValidatingStat?: () => Promise<void> | void
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

/** A reclaim directory older than this is removed as abandoned. */
const RECLAIM_ABANDON_MS = 30_000

/**
 * Exclusive lock implemented as `mkdir(lockDir)`. A holder that dies leaves
 * the directory; a lock older than `staleMs` (mtime) may be taken over only
 * inside the `<lockDir>.reclaim` mutex, and only after a stat taken while
 * holding that mutex still shows the directory is stale. The holder refreshes
 * mtime while `fn` runs and removes the directory on the way out only when
 * `owner.json` is still the record it wrote.
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
      if (
        await takeoverIfStale(
          lockDir,
          staleMs,
          opts?.afterStaleStat,
          opts?.afterValidatingStat,
          log,
        )
      ) {
        break
      }
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

/**
 * `mkdir(reclaimDir)` is the mutex. EEXIST means another taker is inside the
 * critical section (or abandoned it). Returns true when this caller holds it.
 */
async function acquireReclaim(lockDir: string): Promise<boolean> {
  const reclaimDir = `${lockDir}.reclaim`
  try {
    await mkdir(reclaimDir)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  let info
  try {
    info = await stat(reclaimDir)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
  if (Date.now() - info.mtimeMs <= RECLAIM_ABANDON_MS) return false
  await rm(reclaimDir, { recursive: true, force: true }).catch(() => undefined)
  try {
    await mkdir(reclaimDir)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw error
  }
}

async function releaseReclaim(lockDir: string): Promise<void> {
  await rm(`${lockDir}.reclaim`, { recursive: true, force: true }).catch(() => undefined)
}

async function takeoverIfStale(
  lockDir: string,
  staleMs: number,
  afterStaleStat: FileLockOptions['afterStaleStat'],
  afterValidatingStat: FileLockOptions['afterValidatingStat'],
  log: (line: string) => void,
): Promise<boolean> {
  try {
    const first = await stat(lockDir)
    if (Date.now() - first.mtimeMs <= staleMs) return false
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
  // Outside the mutex on purpose: a delayed taker must not block the contender
  // that acquires the lock while this one is paused.
  if (afterStaleStat) await afterStaleStat()

  if (!(await acquireReclaim(lockDir))) return false
  try {
    let validated
    try {
      validated = await stat(lockDir)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw error
    }
    // Someone re-acquired it. Do not rename; go back to waiting.
    if (Date.now() - validated.mtimeMs <= staleMs) return false
    if (afterValidatingStat) await afterValidatingStat()

    // The delay above yields. Rename only the directory this stat still describes.
    try {
      const again = await stat(lockDir)
      if (again.ino !== validated.ino || again.mtimeMs !== validated.mtimeMs) return false
      if (Date.now() - again.mtimeMs <= staleMs) return false
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw error
    }

    const stalePath = `${lockDir}.stale-${String(Date.now())}-${Math.random().toString(36).slice(2)}`
    try {
      await rename(lockDir, stalePath)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      // ENOENT: it vanished. EEXIST/ENOTEMPTY: the destination was taken.
      // Either way someone else won; go back to waiting. Never put it back.
      if (code === 'ENOENT' || code === 'EEXIST' || code === 'ENOTEMPTY') return false
      throw error
    }
    await rm(stalePath, { recursive: true, force: true }).catch((error: unknown) => {
      log(`stale takeover remove ${stalePath} failed: ${String(error)}`)
    })
    try {
      await mkdir(lockDir)
    } catch (error) {
      // A third contender mkdir'd the vacant path between rename and here.
      // That contender holds the lock.
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
      throw error
    }
    return true
  } finally {
    await releaseReclaim(lockDir)
  }
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
