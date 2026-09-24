/**
 * Recorded working directory for an interactive harness session.
 *
 * `<stateDir>/session-cwd.json` — `{ v: 1, entries: { "<command>:<id>": { cwd, at } } }`.
 * Same shape as the agents.json file store: atomic tmp+rename (mode 0600),
 * an in-process mutex, and a corrupt file renamed aside so a bad edit cannot
 * wedge the next spawn. Loaded lazily and re-read when the mtime changes,
 * so an operator can edit the file without restarting den.
 *
 * Capped by `at` (LRU). A `get` refreshes `at` at most once per
 * `SESSION_CWD_TOUCH_MS`, so a list poll does not rewrite the file or bump
 * recency on every read. Room sessions record under the
 * den session id (the conversation join key) and, once known, the harness
 * native id. Qwen's transcript id can differ and is tried first on resume
 * (see the term manager).
 *
 * Stored cwd values are checked with `validateDirectory` on read. A relative
 * or otherwise non-absolute value is ignored and logged once per key. A
 * missing directory is still returned — the term manager turns that into a
 * spawn error instead of silently falling back to the roster default.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { validateDirectory } from '@rivetos/agent-registry'

const DEFAULT_MAX = 2000

/** Recency is persisted at most this often. A read inside the window does not write. */
export const SESSION_CWD_TOUCH_MS = 60 * 60 * 1000

export interface SessionCwdStore {
  get(command: string, id: string): string | undefined
  set(command: string, id: string, cwd: string): void
  /** Remove one room. No-op when the key is absent (does not rewrite). */
  delete(command: string, id: string): void
  /**
   * Monotonic write generation. 0 until a load or write. Increases on every
   * successful write and whenever `load` re-reads the file, so a miss cached
   * against the previous value retries after this process writes or another
   * den process adds a record. Not an mtime: two writes in one tick both count.
   */
  generation(): number
  close(): void
}

type FileWriter = (file: string, data: string, options?: { mode?: number }) => void

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

function saveFile(
  file: string,
  entries: Record<string, Entry>,
  write: FileWriter,
): { mtimeMs: number; size: number } {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  const tmp = `${file}.tmp-${process.pid}`
  write(tmp, JSON.stringify({ v: 1, entries }, null, 2), { mode: 0o600 })
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

export function createSessionCwdStore(
  file: string,
  opts?: { max?: number; now?: () => number; writeFile?: FileWriter },
): SessionCwdStore {
  const max = opts?.max ?? DEFAULT_MAX
  const now = opts?.now ?? Date.now
  const write: FileWriter =
    opts?.writeFile ??
    ((path, data, options) => {
      writeFileSync(path, data, options)
    })
  const mutex = makeMutex()
  let cache: Cache | null = null
  /** Counts writes and external re-reads. Independent of filesystem mtime. */
  let generation = 0
  /** One warning per key + bad value. A later edit of the value logs again. */
  const invalidLogged = new Set<string>()

  const load = (): Record<string, Entry> => {
    let st: { mtimeMs: number; size: number } | undefined
    try {
      const s = statSync(file)
      st = { mtimeMs: s.mtimeMs, size: s.size }
    } catch {
      st = undefined
    }
    if (!st) {
      // A file we had loaded disappeared (another process, or quarantine).
      // A miss cached against the old generation must retry.
      if (cache) {
        cache = null
        generation += 1
      }
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
    // Another den process (or an operator) changed the file. Bump even when
    // the new mtime collides with the cached one and only the size differed,
    // and also when this is the first time the file became visible.
    generation += 1
    return entries
  }

  const remember = (entries: Record<string, Entry>): void => {
    const st = saveFile(file, entries, write)
    cache = { mtimeMs: st.mtimeMs, size: st.size, entries }
    generation += 1
  }

  const keyFor = (command: string, id: string): string => `${command}:${id}`

  return {
    get(command, id): string | undefined {
      return mutex(() => {
        const loaded = load()
        const key = keyFor(command, id)
        const entry = Object.hasOwn(loaded, key) ? loaded[key] : undefined
        if (!entry) return undefined
        const validated = validateDirectory(entry.cwd)
        if (!validated) {
          const mark = `${key}\0${entry.cwd}`
          if (!invalidLogged.has(mark)) {
            invalidLogged.add(mark)
            console.warn(`[den-server] session-cwd.json ${key} ignored: not an absolute directory`)
          }
          return undefined
        }
        const at = now()
        const touch = at - entry.at >= SESSION_CWD_TOUCH_MS
        if (entry.cwd === validated && !touch) return validated
        const next = evict({ ...loaded, [key]: { cwd: validated, at: touch ? at : entry.at } }, max)
        try {
          remember(next)
        } catch (err) {
          // The value is still usable. A failed recency write must not fail
          // the read — the next get tries again.
          console.warn(
            `[den-server] session-cwd.json recency update failed: ${err instanceof Error ? err.message : String(err)}`,
          )
        }
        return validated
      })
    },
    set(command, id, cwd): void {
      mutex(() => {
        const entries = { ...load() }
        entries[keyFor(command, id)] = { cwd, at: now() }
        remember(evict(entries, max))
      })
    },
    delete(command, id): void {
      mutex(() => {
        const loaded = load()
        const key = keyFor(command, id)
        if (!Object.hasOwn(loaded, key)) return
        const entries: Record<string, Entry> = {}
        for (const [name, value] of Object.entries(loaded)) {
          if (name !== key) entries[name] = value
        }
        remember(entries)
      })
    },
    generation(): number {
      // Restat so a record another process just wrote is visible to a caller
      // that has not called get() yet. A cache hit does not bump.
      return mutex(() => {
        load()
        return generation
      })
    },
    close(): void {
      cache = null
    },
  }
}
