/**
 * Per-thread view memory: which of chat/terminal/den a conversation was last
 * viewed in, persisted per node+session. Chat is the human default; callers
 * pass a different fallback for threads that have no chat surface (a TUI-only
 * legacy session lands in terminal). The cap is LRU on touch — a write moves
 * the key to the tail, so overflow evicts the least-recently-set thread.
 */

export type SessionViewMode = 'chat' | 'terminal' | 'den'

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
  return raw === 'terminal' || raw === 'den' || raw === 'chat' ? raw : fallback
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
