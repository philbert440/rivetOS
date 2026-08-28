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
  // Bad legacy OR nothing valid in it — leave storage alone. Writing "[]"
  // would turn "first run" into "user deliberately has no nodes".
  if (legacyNodes === null || legacyNodes.length === 0) return null
  const currentNodes = current === null ? [] : parseRoster(current)
  if (currentNodes === null) return null // current unparseable — don't touch
  const seen = new Set(currentNodes.map((n) => n.baseUrl))
  const merged = [...currentNodes]
  for (const node of legacyNodes) {
    if (seen.has(node.baseUrl)) continue
    seen.add(node.baseUrl) // legacy dupes collapse too
    merged.push(node)
  }
  return merged.length === currentNodes.length ? null : JSON.stringify(merged)
}
