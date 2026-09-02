/**
 * Per-thread view memory: which of chat/terminal a conversation was last
 * viewed in, persisted per node+session. Chat is the human default; callers
 * pass a different fallback for threads that have no chat surface (a TUI-only
 * legacy session lands in terminal). The cap is LRU on touch — a write moves
 * the key to the tail, so overflow evicts the least-recently-set thread.
 * A stored `'den'` (removed viewer mode) is treated as unset and falls back.
 */

export type SessionViewMode = 'chat' | 'terminal'

const KEY = 'rivethub.sessionModes'
const MAX = 500

function load(): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(KEY) ?? '{}')
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, string>)
      : {}
  } catch {
    return {}
  }
}

function save(map: Record<string, string>): void {
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
  const raw = load()[storageKey]
  return raw === 'terminal' || raw === 'chat' ? raw : fallback
}

export function setSessionMode(storageKey: string, mode: SessionViewMode): void {
  // filter-then-append: insertion order IS the recency order the cap slices
  // on, and a plain reassign would leave a touched key where it was
  const entries = Object.entries(load()).filter(([k]) => k !== storageKey)
  entries.push([storageKey, mode])
  save(Object.fromEntries(entries.length > MAX ? entries.slice(-MAX) : entries))
}

export function clearSessionMode(storageKey: string): void {
  const map = load()
  if (!(storageKey in map)) return
  save(Object.fromEntries(Object.entries(map).filter(([k]) => k !== storageKey)))
}

/** Whether the user ever chose a view for this thread — callers that want a
 *  smarter fallback (a TUI-only row landing in terminal) must not override a
 *  real choice. */
export function hasSessionMode(storageKey: string): boolean {
  const raw = load()[storageKey]
  return raw === 'terminal' || raw === 'chat'
}

/** Draft uuid → canonical id: the remembered view follows the thread. The
 *  destination keeps an existing value (same non-clobber rule as names). */
export function moveSessionMode(fromKey: string, toKey: string): void {
  if (!fromKey || fromKey === toKey) return
  const map = load()
  // load() types values as string, but an absent key still reads undefined
  const val = (map as Record<string, string | undefined>)[fromKey]
  if (val === undefined) return
  const entries = Object.entries(map).filter(([k]) => k !== fromKey)
  if (!(toKey in map)) entries.push([toKey, val])
  save(Object.fromEntries(entries))
}
