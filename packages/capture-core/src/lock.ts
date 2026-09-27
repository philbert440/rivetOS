import { readdirSync, readFileSync, statSync, unlinkSync, utimesSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { hostname } from 'node:os'
import { join } from 'node:path'

export class LockTimeout extends Error {
  readonly lockDir: string

  constructor(lockDir: string) {
    super(`lock timeout: ${lockDir}`)
    this.name = 'LockTimeout'
    this.lockDir = lockDir
  }
}

export interface FileLockOptions {
  /** Other-host owner files older than this are stale. Default 120_000. */
  staleMs?: number
  /** Throw `LockTimeout` after this long without acquiring. Default 10_000. */
  waitMs?: number
  /** Delay between attempts that did not acquire. Default 100. */
  pollMs?: number
  log?: (line: string) => void
  /**
   * Runs after this contender's owner file exists and before it reads the
   * directory. Tests hold one contender here so others can run. Production
   * callers leave it unset.
   */
  beforeReaddir?: () => Promise<void> | void
}

interface OwnerRecord {
  pid: number
  host: string
  ts: string
  token: string
}

type Log = (line: string) => void
type Presence = 'alone' | 'pending' | 'lost'
type Decision = 'acquired' | 'pending' | 'lost'
type OtherFile = 'missing' | 'dead' | 'stale' | 'live'

/**
 * Cross-process lock held as a unique owner file. The directory stays.
 *
 * `lockDir` is created once (`mkdir -p`) and never removed. A contender
 * publishes `owner.<token>` with `wx`, where `token` is
 * `<hostname>.<pid>.<startTimeMs>.<random>`, and writes
 * `{ pid, host, ts, token }`. The random suffix starts with a per-process
 * counter so two tokens minted in the same millisecond still order by
 * creation. Nothing is renamed, and `rm -rf` is not used.
 *
 * After publishing, the contender reads the directory (see `beforeReaddir`)
 * and classifies every other `owner.*`:
 *
 * - Same host and `process.kill(pid, 0)` throws `ESRCH`: the creator is
 *   dead. Unlink that unique name. A reused pid publishes a different token,
 *   so the name cannot belong to a live process, and a dead creator is not
 *   inside `fn`.
 * - Other host, mtime older than `staleMs` (default 120s): unlink that
 *   unique name. State lives on local `~/.rivetos`; this path is defensive.
 *   The holder `utimes` its own file every `staleMs / 3`, so a live holder
 *   is not stale. The mtime is re-read immediately before the unlink.
 * - Otherwise the file is a live contender and is left alone. A live loser
 *   unlinks only its own file.
 *
 * If no live contender remains, a second read confirms it and this caller
 * holds the lock. If some remain, the lexicographically smallest token keeps
 * its file; every other contender unlinks its own file, waits `pollMs`, and
 * retries from publishing a new file. The smallest enters only on a read
 * that shows it is alone, so it does not share `fn` with a holder that has
 * not dropped its file, and a later smaller token waits instead of walking
 * in beside a caller already inside `fn`.
 *
 * `LockTimeout` is thrown after `waitMs` (default 10s). The timed-out
 * contender unlinks its own file first. Release always unlinks that same
 * name and clears the heartbeat, including when `fn` throws.
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
  const log = makeLog(opts?.log)
  const host = hostname()
  await mkdir(lockDir, { recursive: true })

  const ownerPath = await acquire(
    lockDir,
    host,
    staleMs,
    deadline,
    pollMs,
    opts?.beforeReaddir,
    log,
  )
  const heartbeatMs = Math.max(1, Math.floor(staleMs / 3))
  const timer = setInterval(() => {
    try {
      const now = new Date()
      utimesSync(ownerPath, now, now)
    } catch {
      // The owner file may already have been removed.
    }
  }, heartbeatMs)
  timer.unref()

  try {
    return await fn()
  } finally {
    clearInterval(timer)
    unlinkOwn(ownerPath, log)
  }
}

let tokenSeq = 0

function makeToken(host: string): string {
  tokenSeq += 1
  const safeHost = host.replace(/[/\\\0]/g, '_') || 'unknown'
  const random = `${tokenSeq.toString(36).padStart(6, '0')}${Math.random().toString(36).slice(2)}`
  return `${safeHost}.${String(process.pid)}.${String(Date.now())}.${random}`
}

function makeLog(log: FileLockOptions['log']): Log {
  return (line: string): void => {
    try {
      if (log) log(line)
      else console.error(line)
    } catch {
      // Logging must not interrupt the lock.
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined
  const code = error.code
  return typeof code === 'string' ? code : undefined
}

async function acquire(
  lockDir: string,
  host: string,
  staleMs: number,
  deadline: number,
  pollMs: number,
  beforeReaddir: FileLockOptions['beforeReaddir'],
  log: Log,
): Promise<string> {
  for (;;) {
    const token = makeToken(host)
    const ownerPath = join(lockDir, `owner.${token}`)
    const record: OwnerRecord = {
      pid: process.pid,
      host,
      ts: new Date().toISOString(),
      token,
    }
    try {
      await writeFile(ownerPath, JSON.stringify(record), { flag: 'wx', mode: 0o600 })
    } catch (error) {
      if (errorCode(error) === 'EEXIST') continue
      throw error
    }

    try {
      if (beforeReaddir) await beforeReaddir()
      for (;;) {
        const decision = judge(lockDir, ownerPath, token, host, staleMs, log)
        if (decision === 'acquired') return ownerPath
        if (decision === 'lost') break
        if (Date.now() >= deadline) throw new LockTimeout(lockDir)
        await sleep(pollMs)
      }
    } catch (error) {
      unlinkOwn(ownerPath, log)
      throw error
    }

    if (Date.now() >= deadline) throw new LockTimeout(lockDir)
    await sleep(pollMs)
  }
}

function judge(
  lockDir: string,
  ownerPath: string,
  token: string,
  host: string,
  staleMs: number,
  log: Log,
): Decision {
  const first = inspect(lockDir, token, host, staleMs, log)
  if (first === 'lost') {
    // Stay on this file if it is still here, so a failed unlink cannot leave
    // a live owner behind while a new token is published.
    return unlinkOwn(ownerPath, log) ? 'lost' : 'pending'
  }
  if (first === 'pending') {
    return touchOwn(ownerPath) ? 'pending' : 'lost'
  }
  const second = inspect(lockDir, token, host, staleMs, log)
  if (second === 'lost') {
    return unlinkOwn(ownerPath, log) ? 'lost' : 'pending'
  }
  if (second === 'pending') {
    return touchOwn(ownerPath) ? 'pending' : 'lost'
  }
  if (!ourFileExists(ownerPath)) return 'lost'
  return 'acquired'
}

/**
 * `readdir` plus liveness. Dead and stale files are unlinked here, by the
 * unique name just classified, before the caller decides whether to enter.
 * Sync so another contender in this process cannot publish between the read
 * and the decision.
 */
function inspect(
  lockDir: string,
  token: string,
  host: string,
  staleMs: number,
  log: Log,
): Presence {
  let names: string[]
  try {
    names = readdirSync(lockDir)
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return 'lost'
    throw error
  }

  const ours = `owner.${token}`
  let live = 0
  let smallest = true
  for (const name of names) {
    if (!name.startsWith('owner.') || name === ours) continue
    const full = join(lockDir, name)
    const kind = classifyOther(full, host, staleMs)
    if (kind === 'missing') continue
    if (kind === 'dead') {
      // Unique name of a same-host pid that is not running.
      if (unlinkOther(full, log)) continue
    } else if (kind === 'stale') {
      // Unique name of an other-host file whose mtime is still past staleMs.
      if (unlinkIfStillStale(full, staleMs, log)) continue
    }
    live += 1
    const otherToken = name.slice('owner.'.length)
    if (otherToken <= token) smallest = false
  }
  if (live === 0) return 'alone'
  if (smallest) return 'pending'
  return 'lost'
}

function classifyOther(path: string, host: string, staleMs: number): OtherFile {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return 'missing'
    // Not provably dead. Leave it for its owner.
    return 'live'
  }
  const record = parseOwner(text)
  if (!record) return 'live'
  if (record.host === host) return pidDead(record.pid) ? 'dead' : 'live'

  let mtimeMs: number
  try {
    mtimeMs = statSync(path).mtimeMs
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return 'missing'
    throw error
  }
  if (Date.now() - mtimeMs > staleMs) return 'stale'
  return 'live'
}

function parseOwner(text: string): OwnerRecord | undefined {
  let value: unknown
  try {
    value = JSON.parse(text) as unknown
  } catch {
    return undefined
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const pid = record.pid
  const host = record.host
  const ts = record.ts
  const token = record.token
  if (typeof pid !== 'number' || typeof host !== 'string') return undefined
  if (typeof ts !== 'string' || typeof token !== 'string') return undefined
  return { pid, host, ts, token }
}

/** `kill(pid, 0)` throws `ESRCH` only when that pid is not running. */
function pidDead(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return false
  } catch (error) {
    return errorCode(error) === 'ESRCH'
  }
}

function unlinkIfStillStale(path: string, staleMs: number, log: Log): boolean {
  try {
    const info = statSync(path)
    if (Date.now() - info.mtimeMs <= staleMs) return false
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return true
    throw error
  }
  return unlinkOther(path, log)
}

function unlinkOther(path: string, log: Log): boolean {
  try {
    unlinkSync(path)
    return true
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return true
    log(`not removing ${path}: ${String(error)}`)
    return false
  }
}

/** True when this owner's file is gone. False when it is still on disk. */
function unlinkOwn(path: string, log: Log): boolean {
  try {
    unlinkSync(path)
    return true
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return true
    log(`release ${path} failed: ${String(error)}`)
    return false
  }
}

function touchOwn(path: string): boolean {
  try {
    const now = new Date()
    utimesSync(path, now, now)
    return true
  } catch (error) {
    return errorCode(error) !== 'ENOENT'
  }
}

function ourFileExists(path: string): boolean {
  try {
    statSync(path)
    return true
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return false
    throw error
  }
}
