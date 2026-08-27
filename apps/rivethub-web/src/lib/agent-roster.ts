/**
 * Pure helpers for the agents sidebar: node picker order, health-row UX,
 * and the keep-vs-reset open plan (keep must not mint a draft or rewrite
 * settings).
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

export type NodeHealthStatus = 'online' | 'offline' | 'unknown'

/** Pending with no result is unknown — not offline. A prior true/false wins. */
export function nodeHealthStatus(
  health: boolean | undefined,
  _isPending?: boolean,
): NodeHealthStatus {
  if (health === true) return 'online'
  if (health === false) return 'offline'
  return 'unknown'
}

export type AgentOpenPlan = {
  addDraft: boolean
  applySettings: boolean
}

/** Keep reuses the existing thread; only a fresh uuid path drafts + writes settings. */
export function agentOpenPlan(kind: 'keep' | 'fresh'): AgentOpenPlan {
  if (kind === 'keep') return { addDraft: false, applySettings: false }
  return { addDraft: true, applySettings: true }
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

export const KEEP_DIALOG_NOTE = 'Prompt and model changes apply to new conversations.'
