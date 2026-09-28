import {
  closeSync,
  fchmodSync,
  fsyncSync,
  openSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  utimesSync,
} from 'node:fs'
import { mkdir, rename, writeFile } from 'node:fs/promises'
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
  /**
   * Heartbeat interval basis. The holder refreshes its mtime every
   * `staleMs / 3`. Not a reclamation threshold: age never deletes a lock
   * file. Default 120_000, so the heartbeat is 40s. Informational for
   * operators.
   */
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
type Created = 'none' | 'temp' | 'final'

/**
 * Cross-process lock held as a unique holder file. The directory stays.
 *
 * `lockDir` is created once (`mkdir -p`) and never removed. A contender
 * writes the full body to `.holderpub.<token>` (`wx`, mode `0600`, fsync)
 * and renames it to `holder.<token>`. `token` is
 * `<hexHost>.<pid>.<startTimeMs>.<random>` — four fields after the prefix.
 * The version discriminator is that prefix, outside the token. The hostname
 * cannot contain a `/`, so it cannot forge a prefix; and both legacy
 * grammars used the `owner.`/`.publish.` prefixes, so no legacy name can
 * match `holder.*` or `.holderpub.*`. `hexHost` is the lowercase hex of the
 * hostname's UTF-8 bytes (`Buffer.from(hostname, 'utf8')`), so distinct
 * hostnames never share a filename identity and the name contains no `.`,
 * `/`, or `\`. The random suffix starts with a per-process counter so two
 * tokens minted in the same millisecond still order by creation. The
 * destination name is unique to this contender, so the rename cannot
 * clobber anyone, and the final file is never a partial body. `rm -rf` is
 * not used.
 *
 * After publishing, the contender reads the directory (see `beforeReaddir`).
 * Only `holder.*` names are contenders for the tie-break and for
 * reclamation. `.holderpub.*` is orphan cleanup and nothing else. Every
 * other name (`owner.*`, `.publish.*`, anything) is a blocker: the caller
 * waits as it would for a live foreign contender, and the file is never
 * deleted. Those prefixes never shipped and such files are not expected; an
 * operator removes them by hand if ever seen. When a `holder.*` body parses,
 * its `host` must also be this hostname before the file is treated as
 * same-host. An empty or invalid body does not override the filename. A
 * body that cannot be read (any error other than ENOENT) is live. ENOENT
 * means the file is already gone. Other body fields are only logged.
 *
 * - Same host and `process.kill(pid, 0)` throws `ESRCH`: the creator is
 *   dead, even when the body is empty or not valid JSON. Same host means
 *   the filename is `holder.<hexHost>.<pid>.<startTimeMs>.<random>`, the
 *   hex equals `Buffer.from(hostname).toString('hex')`, and, when the body
 *   parses, `body.host === hostname`. An unreadable body is not death.
 *   Unlink that unique name. A reused pid publishes a different token, so
 *   the name cannot belong to a live process, and a dead creator is not
 *   inside `fn`. `EPERM` or any other kill error is not death.
 * - A same-host `.holderpub.<token>` whose pid is dead (`ESRCH`) is an
 *   orphan from a creator that died mid-publish, under that same host rule,
 *   including the unreadable-body rule. Unlink that name. Every other
 *   `.holderpub.*` file is ignored. It is not a contender.
 * - Any other host is live for as long as the file exists. Age is not death.
 *   A `holder.*` name that is not exactly four fields (lowercase even-length
 *   hex, integer pid, integer start time, non-empty random) is a live
 *   foreign contender and is never deleted. That includes
 *   `holder.v2.<hex>.…` (five fields) and any other field count. A lock
 *   file is removed by another process only when its creator is provably
 *   dead (same host, `kill(pid, 0)` → ESRCH, and the body was read or was
 *   empty or invalid). Lock directories must be host-local (`~/.rivetos`);
 *   a foreign-host holder file blocks until its creator removes it.
 * - Otherwise the file is a live contender and is left alone. A live loser
 *   unlinks only its own file. A blocker does not enter the tie-break; while
 *   one remains, this caller is not alone and does not enter.
 *
 * If no live holder and no blocker remains, a second read confirms it and
 * this caller holds the lock. If some holders remain, the lexicographically
 * smallest token keeps its file; every other contender unlinks its own file,
 * waits `pollMs`, and retries from publishing a new file. A blocker is not
 * part of that comparison: while one exists the caller waits and does not
 * enter. The smallest enters only on a read that shows it is alone, so it
 * does not share `fn` with a holder that has not dropped its file, and a
 * later smaller token waits instead of walking in beside a caller already
 * inside `fn`.
 *
 * The holder `utimes` its own file every `staleMs / 3` (default `staleMs`
 * 120s, so every 40s) while `fn` runs, and again on each wait while it is
 * the smallest live token. That heartbeat is informational for operators.
 * It is not a liveness proof and it never authorizes deletion.
 *
 * `LockTimeout` is thrown after `waitMs` (default 10s). The timed-out
 * contender unlinks its own file first. Release always unlinks that same
 * name and clears the heartbeat, including when `fn` throws. An error after
 * the publish file is created (write failure, `ENOSPC`, or a throw) unlinks
 * this contender's temp or final name before the error propagates.
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

  const ownerPath = await acquire(lockDir, host, deadline, pollMs, opts?.beforeReaddir, log)
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

/**
 * Filename prefixes are the version discriminator. They sit outside the
 * token, where a hostname cannot put them: the hostname cannot contain a
 * `/`, so it cannot forge a prefix; and both legacy grammars used the
 * `owner.`/`.publish.` prefixes, so no legacy name can match `holder.*` or
 * `.holderpub.*`.
 */
const HOLDER_PREFIX = 'holder.'
const PUBLISH_PREFIX = '.holderpub.'

/** Lowercase hex of the hostname's UTF-8 bytes. Injective, and has no `.` or `/`. */
function hexHost(host: string): string {
  return Buffer.from(host, 'utf8').toString('hex')
}

function makeToken(host: string): string {
  tokenSeq += 1
  const random = `${tokenSeq.toString(36).padStart(6, '0')}${Math.random().toString(36).slice(2)}`
  return `${hexHost(host)}.${String(process.pid)}.${String(Date.now())}.${random}`
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
  deadline: number,
  pollMs: number,
  beforeReaddir: FileLockOptions['beforeReaddir'],
  log: Log,
): Promise<string> {
  for (;;) {
    const token = makeToken(host)
    const tempPath = join(lockDir, `${PUBLISH_PREFIX}${token}`)
    const ownerPath = join(lockDir, `${HOLDER_PREFIX}${token}`)
    const record: OwnerRecord = {
      pid: process.pid,
      host,
      ts: new Date().toISOString(),
      token,
    }
    try {
      await publishOwner(tempPath, ownerPath, JSON.stringify(record), log)
    } catch (error) {
      if (errorCode(error) === 'EEXIST') continue
      throw error
    }

    try {
      if (beforeReaddir) await beforeReaddir()
      for (;;) {
        const decision = judge(lockDir, ownerPath, token, host, log)
        if (decision === 'acquired') return ownerPath
        if (decision === 'lost') break
        if (Date.now() >= deadline) throw new LockTimeout(lockDir)
        await sleep(pollMs)
      }
    } catch (error) {
      unlinkOwn(ownerPath, log)
      unlinkOwn(tempPath, log)
      throw error
    }

    if (Date.now() >= deadline) throw new LockTimeout(lockDir)
    await sleep(pollMs)
  }
}

/**
 * Exclusive create of `.holderpub.<token>`, fsync, then rename onto the unique
 * `holder.<token>`. A rejected `writeFile` may already have created the temp
 * (`ENOSPC`); that name is removed before the error propagates.
 */
async function publishOwner(
  tempPath: string,
  ownerPath: string,
  body: string,
  log: Log,
): Promise<void> {
  let created: Created = 'none'
  try {
    await writeFile(tempPath, body, { flag: 'wx', mode: 0o600 })
    created = 'temp'
    fsyncFile(tempPath)
    await rename(tempPath, ownerPath)
    created = 'final'
  } catch (error) {
    if (created === 'none' && errorCode(error) !== 'EEXIST' && fileExists(tempPath)) {
      created = 'temp'
    }
    if (created === 'temp') unlinkOwn(tempPath, log)
    if (created === 'final') unlinkOwn(ownerPath, log)
    throw error
  }
}

/** Force `0600` (umask does not apply) and fsync before the name is published. */
function fsyncFile(path: string): void {
  const fd = openSync(path, 'r+')
  try {
    fchmodSync(fd, 0o600)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

function judge(
  lockDir: string,
  ownerPath: string,
  token: string,
  host: string,
  log: Log,
): Decision {
  const first = inspect(lockDir, token, host, log)
  if (first === 'lost') {
    // Stay on this file if it is still here, so a failed unlink cannot leave
    // a live owner behind while a new token is published.
    return unlinkOwn(ownerPath, log) ? 'lost' : 'pending'
  }
  if (first === 'pending') {
    return touchOwn(ownerPath) ? 'pending' : 'lost'
  }
  const second = inspect(lockDir, token, host, log)
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
 * `readdir` plus liveness. Dead same-host `holder.*` and `.holderpub.*`
 * names are unlinked here, before the caller decides whether to enter. Sync
 * so another contender in this process cannot publish between the read and
 * the decision. Foreign-host files and every non-holder name are never
 * unlinked.
 */
function inspect(lockDir: string, token: string, host: string, log: Log): Presence {
  let names: string[]
  try {
    names = readdirSync(lockDir)
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return 'lost'
    throw error
  }

  for (const name of names) {
    if (!name.startsWith(PUBLISH_PREFIX)) continue
    const publishToken = name.slice(PUBLISH_PREFIX.length)
    const publishPath = join(lockDir, name)
    if (!sameHostDead(publishToken, host, publishPath)) continue
    log(`removing dead publish ${name}`)
    unlinkOther(publishPath, log)
  }

  const ours = `${HOLDER_PREFIX}${token}`
  let live = 0
  let smallest = true
  let blocked = false
  for (const name of names) {
    if (name === ours || name.startsWith(PUBLISH_PREFIX)) continue
    const full = join(lockDir, name)
    if (!ownerStillThere(full)) continue
    // `owner.*`, `.publish.*`, and every other non-holder name. Never deleted.
    if (!name.startsWith(HOLDER_PREFIX)) {
      blocked = true
      continue
    }
    const otherToken = name.slice(HOLDER_PREFIX.length)
    if (sameHostDead(otherToken, host, full)) {
      log(`removing dead holder ${name}: ${ownerBodyNote(full, otherToken)}`)
      if (unlinkOther(full, log)) continue
    }
    live += 1
    if (otherToken <= token) smallest = false
  }
  // A strictly smaller holder wins the tie-break. A blocker is not a holder
  // token: it cannot be outranked, so the caller waits and does not enter.
  if (live > 0 && !smallest) return 'lost'
  if (blocked || live > 0) return 'pending'
  return 'alone'
}

/**
 * Token shape, after the `holder.` or `.holderpub.` prefix, is exactly
 * `<hexHost>.<pid>.<startTimeMs>.<random>` — four fields. Five fields
 * (`v2.<hex>.…`) and any other count are not this shape: not provably ours
 * and not provably dead.
 */
function parseToken(token: string): { host: string; pid: number } | undefined {
  const parts = token.split('.')
  if (parts.length !== 4) return undefined
  const host = parts[0] ?? ''
  const pidRaw = parts[1] ?? ''
  const startRaw = parts[2] ?? ''
  const random = parts[3] ?? ''
  // One pair of hex digits per hostname byte, lowercase, even length.
  if (!/^[0-9a-f]+$/.test(host) || host.length % 2 !== 0) return undefined
  if (random.length === 0) return undefined
  if (!/^\d+$/.test(startRaw) || !/^[1-9]\d*$/.test(pidRaw)) return undefined
  const pid = Number(pidRaw)
  if (!Number.isSafeInteger(pid)) return undefined
  return { host, pid }
}

type BodyHost =
  | { kind: 'missing' }
  | { kind: 'unreadable' }
  | { kind: 'unchecked' }
  | { kind: 'host'; host: string }

/**
 * Filename must be this host's hex (four fields after the prefix), and the
 * pid must be dead. A parsed body must also record this hostname. An empty or
 * unparseable body leaves the filename decision in place so a dead creator
 * can still be recovered. ENOENT means the file is already gone. Any other
 * read error is live: the host cross-check could not be performed.
 */
function sameHostDead(token: string, host: string, path: string): boolean {
  const parsed = parseToken(token)
  if (!parsed) return false
  if (parsed.host !== hexHost(host)) return false
  if (!pidDead(parsed.pid)) return false
  const recorded = ownerBodyHost(path)
  if (recorded.kind === 'unreadable') return false
  if (recorded.kind === 'host') return recorded.host === host
  return true
}

/**
 * `missing` is ENOENT. `unreadable` is any other read error. `unchecked` is
 * an existing body that is empty or not an owner record. `host` is parsed.
 */
function ownerBodyHost(path: string): BodyHost {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return { kind: 'missing' }
    return { kind: 'unreadable' }
  }
  const host = parseOwner(text)?.host
  if (host === undefined) return { kind: 'unchecked' }
  return { kind: 'host', host }
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

function ownerStillThere(path: string): boolean {
  try {
    statSync(path)
    return true
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return false
    // Not provably absent. Count it as live so this caller does not enter.
    return true
  }
}

function fileExists(path: string): boolean {
  try {
    statSync(path)
    return true
  } catch (error) {
    return errorCode(error) !== 'ENOENT'
  }
}

/** Log text only. The liveness decision has already been made. */
function ownerBodyNote(path: string, token: string): string {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return 'body missing'
    return 'body unreadable'
  }
  if (text.length === 0) return 'body empty'
  const record = parseOwner(text)
  if (!record) return 'body invalid'
  if (record.token !== token) return 'body token differs from name'
  return 'body ok'
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
