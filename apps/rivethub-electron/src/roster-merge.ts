/**
 * Merge the legacy roster into whatever the user already rebuilt by hand —
 * pure, no node imports (bundled into the sandboxed preload). Current
 * entries win on baseUrl collision; legacy entries fill in behind them;
 * anything unparseable falls back to the CURRENT value untouched.
 */

interface RosterNode {
  name: string
  baseUrl: string
}

function parseRoster(raw: string | null): RosterNode[] | null {
  if (raw === null) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return null
    return parsed.filter(
      (n): n is RosterNode =>
        typeof n === 'object' &&
        n !== null &&
        typeof (n as RosterNode).name === 'string' &&
        typeof (n as RosterNode).baseUrl === 'string',
    )
  } catch {
    return null
  }
}

export function mergeRoster(current: string | null, legacy: string): string | null {
  const legacyNodes = parseRoster(legacy)
  if (legacyNodes === null) return null // bad legacy — leave storage alone
  if (current === null) return JSON.stringify(legacyNodes)
  const currentNodes = parseRoster(current)
  if (currentNodes === null) return null // current unparseable — don't touch
  const seen = new Set(currentNodes.map((n) => n.baseUrl))
  const merged = [...currentNodes, ...legacyNodes.filter((n) => !seen.has(n.baseUrl))]
  return merged.length === currentNodes.length ? null : JSON.stringify(merged)
}
