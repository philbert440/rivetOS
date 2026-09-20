/**
 * Per-thread view memory: an explicit user choice of chat/terminal,
 * persisted per node+session. Chat is the human default; callers
 * pass a different fallback for threads that have no chat surface (a TUI-only
 * legacy session lands in terminal). The cap is LRU on touch — a write moves
 * the key to the tail, so overflow evicts the least-recently-set thread.
 * Unmarked legacy entries may be automatic choices from an older build, so
 * they are ignored on read and removed on the next explicit store mutation.
 */

export type SessionViewMode = 'chat' | 'terminal'
type UserChoice = { mode: SessionViewMode; source: 'user' }

const KEY = 'rivethub.sessionModes'
const MAX = 500

function isUserChoice(value: unknown): value is UserChoice {
  if (!value || typeof value !== 'object') return false
  const entry = value as Partial<UserChoice>
  return entry.source === 'user' && (entry.mode === 'chat' || entry.mode === 'terminal')
}

function load(): Record<string, UserChoice> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(KEY) ?? '{}')
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, UserChoice] =>
        isUserChoice(entry[1]),
      ),
    )
  } catch {
    return {}
  }
}

function save(map: Record<string, UserChoice>): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(map))
  } catch {
    /* storage full / disabled — mode just won't persist */
  }
}

export function getSessionMode(
  storageKey: string,
  fallback: SessionViewMode = 'chat',
): SessionViewMode {
  const entry = load()[storageKey]
  return isUserChoice(entry) ? entry.mode : fallback
}

export function setSessionMode(storageKey: string, mode: SessionViewMode): void {
  // filter-then-append: insertion order IS the recency order the cap slices
  // on, and a plain reassign would leave a touched key where it was
  const entries = Object.entries(load()).filter(([k]) => k !== storageKey)
  entries.push([storageKey, { mode, source: 'user' }])
  save(Object.fromEntries(entries.length > MAX ? entries.slice(-MAX) : entries))
}

export function clearSessionMode(storageKey: string): void {
  const map = load()
  if (!(storageKey in map)) return
  save(Object.fromEntries(Object.entries(map).filter(([k]) => k !== storageKey)))
}

/** Whether the user explicitly chose a view for this thread. */
export function hasSessionMode(storageKey: string): boolean {
  return isUserChoice(load()[storageKey])
}

/** Draft uuid → canonical id: the remembered view follows the thread. The
 *  destination keeps an existing value (same non-clobber rule as names). */
export function moveSessionMode(fromKey: string, toKey: string): void {
  if (!fromKey || fromKey === toKey) return
  const map = load()
  const val = map[fromKey]
  if (!isUserChoice(val)) return
  const entries = Object.entries(map).filter(([k]) => k !== fromKey)
  if (!isUserChoice(map[toKey])) entries.push([toKey, val])
  save(Object.fromEntries(entries))
}
