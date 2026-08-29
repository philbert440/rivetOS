/**
 * Pure helpers for the agents sidebar: node picker order, session-pointer
 * matching, and the row activity indicator.
 */

export type NodeChoice = { name: string; baseUrl: string }

/**
 * Roster names win over the synthetic "Current Node" label so the live node
 * shows its real name. The synthetic row is only added when the current URL
 * is missing from the roster.
 */
export function uniqueRosterNodes(roster: NodeChoice[], currentBaseUrl: string): NodeChoice[] {
  const byUrl = new Map<string, NodeChoice>()
  if (currentBaseUrl) {
    byUrl.set(currentBaseUrl, { name: 'Current Node', baseUrl: currentBaseUrl })
  }
  for (const n of roster) byUrl.set(n.baseUrl, n)
  return [...byUrl.values()]
}

export function sessionPointerMatches(
  storedId: string,
  listedId: string,
  nativeOf: (id: string) => string | undefined,
): boolean {
  if (storedId === listedId) return true
  const storedNative = nativeOf(storedId) ?? storedId
  const listedNative = nativeOf(listedId) ?? listedId
  return storedNative === listedNative
}

export type AgentActivity = { level: 'active' | 'idle'; nodeBaseUrl: string } | { level: 'none' }

/**
 * Collapse per-node session statuses into one row indicator. Any `active`
 * session wins over `idle`; `ended`/`error`/unknown count as nothing
 * running. Among equals the CURRENT node wins the naming rights — a pip
 * must not read "active on remote" while this node is active too. The
 * winning node rides along so the tooltip can say where the session lives.
 */
export function aggregateAgentActivity(
  statuses: Array<{ nodeBaseUrl: string; status?: string }>,
  currentBaseUrl?: string,
): AgentActivity {
  const pick = (level: 'active' | 'idle'): AgentActivity | undefined => {
    const matches = statuses.filter((s) => s.status === level)
    if (matches.length === 0) return undefined
    const current = currentBaseUrl && matches.find((s) => s.nodeBaseUrl === currentBaseUrl)
    return { level, nodeBaseUrl: (current || matches[0]).nodeBaseUrl }
  }
  return pick('active') ?? pick('idle') ?? { level: 'none' }
}

/**
 * Order the status-poll fan-out: the current node's pointer always polls
 * first, the rest keep their recency order. Pointers are unique per
 * (agent, node) so roster size bounds the set — `limit` is only a safety
 * cap against a pathological map.
 */
export function pointersToPoll<T extends { nodeBaseUrl: string }>(
  pointers: T[],
  currentBaseUrl: string,
  limit: number,
): T[] {
  const current = pointers.filter((p) => p.nodeBaseUrl === currentBaseUrl)
  const rest = pointers.filter((p) => p.nodeBaseUrl !== currentBaseUrl)
  return [...current, ...rest].slice(0, Math.max(1, limit))
}
