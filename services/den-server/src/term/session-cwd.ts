/**
 * Recorded working directory for an interactive harness session.
 *
 * `<stateDir>/session-cwd.json` — `{ v: 1, entries: { "<command>:<id>": { cwd, at } } }`.
 * Same shape as the agents.json file store: atomic tmp+rename (mode 0600),
 * an in-process mutex, and a corrupt file renamed aside so a bad edit cannot
 * wedge the next spawn. Loaded lazily and re-read when the mtime changes,
 * so an operator can edit the file without restarting den.
 *
 * Capped by `at` (LRU). Room sessions record under the den session id, which
 * is the conversation join key; qwen's transcript id can differ and is tried
 * first on resume (see the term manager).
 */

import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

const DEFAULT_MAX = 2000

export interface SessionCwdStore {
  get(command: string, id: string): string | undefined
  set(command: string, id: string, cwd: string): void
  close(): void
}

interface Entry {
  cwd: string
  at: number
}

interface Cache {
  mtimeMs: number
  size: number
  entries: Record<string, Entry>
}

/**
 * In-process mutex. agents.json uses a promise chain because its methods are
 * async. get/set here are synchronous, so the critical section runs to
 * completion before the call returns — a set is visible to the next get in
 * the same turn. load/save do not re-enter.
 */
function makeMutex(): <T>(fn: () => T) => T {
  let held = false
  return <T>(fn: () => T): T => {
    if (held) throw new Error('session-cwd store re-entered')
    held = true
    try {
      return fn()
    } finally {
      held = false
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function quarantineCorrupt(file: string, reason: string): void {
  const dest = `${file}.corrupt-${Date.now()}`
  try {
    if (existsSync(file)) renameSync(file, dest)
    console.warn(`[den-server] session-cwd.json ${reason}; quarantined to ${dest}`)
  } catch (err) {
    console.warn(
      `[den-server] session-cwd.json ${reason}; quarantine rename failed: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}

function parseEntries(raw: unknown): Record<string, Entry> | undefined {
  if (!isRecord(raw) || raw.v !== 1 || !isRecord(raw.entries)) return undefined
  const entries: Record<string, Entry> = {}
  for (const [key, value] of Object.entries(raw.entries)) {
    if (!isRecord(value)) continue
    if (typeof value.cwd !== 'string' || value.cwd.length === 0) continue
    if (typeof value.at !== 'number' || !Number.isFinite(value.at)) continue
    entries[key] = { cwd: value.cwd, at: value.at }
  }
  return entries
}

function loadFile(file: string): Record<string, Entry> {
  if (!existsSync(file)) return {}
  try {
    const raw: unknown = JSON.parse(readFileSync(file, 'utf8'))
    const entries = parseEntries(raw)
    if (!entries) {
      quarantineCorrupt(file, 'shape invalid')
      return {}
    }
    return entries
  } catch {
    quarantineCorrupt(file, 'parse failed')
    return {}
  }
}

function saveFile(file: string, entries: Record<string, Entry>): { mtimeMs: number; size: number } {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  const tmp = `${file}.tmp-${process.pid}`
  writeFileSync(tmp, JSON.stringify({ v: 1, entries }, null, 2), { mode: 0o600 })
  renameSync(tmp, file)
  const st = statSync(file)
  return { mtimeMs: st.mtimeMs, size: st.size }
}

function evict(entries: Record<string, Entry>, max: number): Record<string, Entry> {
  const keys = Object.keys(entries)
  if (keys.length <= max) return entries
  keys.sort((a, b) => entries[a].at - entries[b].at || (a < b ? -1 : a > b ? 1 : 0))
  const next: Record<string, Entry> = {}
  for (const key of keys.slice(keys.length - max)) next[key] = entries[key]
  return next
}

function readCwd(entries: Record<string, Entry>, key: string): string | undefined {
  if (!Object.hasOwn(entries, key)) return undefined
  return entries[key].cwd
}

export function createSessionCwdStore(
  file: string,
  opts?: { max?: number; now?: () => number },
): SessionCwdStore {
  const max = opts?.max ?? DEFAULT_MAX
  const now = opts?.now ?? Date.now
  const mutex = makeMutex()
  let cache: Cache | null = null

  const load = (): Record<string, Entry> => {
    let st: { mtimeMs: number; size: number } | undefined
    try {
      const s = statSync(file)
      st = { mtimeMs: s.mtimeMs, size: s.size }
    } catch {
      st = undefined
    }
    if (!st) {
      cache = null
      return {}
    }
    if (cache && cache.mtimeMs === st.mtimeMs && cache.size === st.size) return cache.entries
    const entries = loadFile(file)
    // Quarantine renames the file away. Don't cache a stat that no longer
    // names this path — the next get should see the absence.
    try {
      const after = statSync(file)
      cache = { mtimeMs: after.mtimeMs, size: after.size, entries }
    } catch {
      cache = null
    }
    return entries
  }

  const keyFor = (command: string, id: string): string => `${command}:${id}`

  return {
    get(command, id): string | undefined {
      return mutex(() => readCwd(load(), keyFor(command, id)))
    },
    set(command, id, cwd): void {
      mutex(() => {
        const entries = { ...load() }
        entries[keyFor(command, id)] = { cwd, at: now() }
        const next = evict(entries, max)
        const st = saveFile(file, next)
        cache = { mtimeMs: st.mtimeMs, size: st.size, entries: next }
      })
    },
    close(): void {
      cache = null
    },
  }
}
