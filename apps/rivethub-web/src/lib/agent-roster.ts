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
 * running. The winning node rides along so the pip can name where the
 * session lives — a non-current node is Phil's "remote session active" case.
 */
export function aggregateAgentActivity(
  statuses: Array<{ nodeBaseUrl: string; status?: string }>,
): AgentActivity {
  const active = statuses.find((s) => s.status === 'active')
  if (active) return { level: 'active', nodeBaseUrl: active.nodeBaseUrl }
  const idle = statuses.find((s) => s.status === 'idle')
  if (idle) return { level: 'idle', nodeBaseUrl: idle.nodeBaseUrl }
  return { level: 'none' }
}
