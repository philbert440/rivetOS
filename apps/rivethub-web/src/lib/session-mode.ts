/**
 * Per-thread view memory: which of chat/terminal/den a conversation was last
 * viewed in, persisted per node+session. First open of a thread lands in chat
 * — the least intimidating view — and the toggle is remembered from there.
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

export function getSessionMode(storageKey: string): SessionViewMode {
  const raw = load()[storageKey]
  return raw === 'terminal' || raw === 'den' || raw === 'chat' ? raw : 'chat'
}

export function setSessionMode(storageKey: string, mode: SessionViewMode): void {
  try {
    const map = load()
    map[storageKey] = mode
    // cap growth: keep the most-recently-touched entries
    const keys = Object.keys(map)
    const capped =
      keys.length > MAX ? Object.fromEntries(keys.slice(-MAX).map((k) => [k, map[k]])) : map
    localStorage.setItem(KEY, JSON.stringify(capped))
  } catch {
    /* storage full / disabled — mode just won't persist */
  }
}
