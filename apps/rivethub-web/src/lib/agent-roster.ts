/**
 * Pure helpers for the agents sidebar: node picker order, hosting-den
 * resolution, session-pointer matching, and the row activity indicator.
 */

import type { AgentPreset, MeshDenNode } from '@rivetos/types'

export type NodeChoice = {
  name: string
  baseUrl: string
  /** Mesh node name recorded from `/healthz.node`. Not the display label. */
  node?: string
}

function stripSlash(url: string | undefined): string {
  return (url ?? '').trim().replace(/\/+$/, '')
}

/**
 * URL of the den that hosts `agent`, or undefined ("node unknown").
 *
 * 1. `agent.node` is the answering den's node → that den's base URL. This is
 *    the single-host path: a loopback node advertises an empty `denUrl`.
 * 2. A mesh node whose `name` or `id` equals `agent.node` and has a non-empty
 *    `denUrl`.
 * 3. A roster entry whose recorded `/healthz.node` equals `agent.node`.
 * 4. Legacy `agent.nodeBaseUrl` when set.
 */
export function resolveAgentNodeUrl(
  agent: Pick<AgentPreset, 'node' | 'nodeBaseUrl'>,
  ctx: {
    sourceBaseUrl: string
    sourceNode?: string
    mesh: readonly MeshDenNode[]
    roster: readonly NodeChoice[]
  },
): string | undefined {
  const node = agent.node?.trim()
  if (node && ctx.sourceNode?.trim() === node) {
    const source = stripSlash(ctx.sourceBaseUrl)
    if (source) return source
  }
  if (node) {
    const meshHit = ctx.mesh.find((entry) => {
      if (!stripSlash(entry.denUrl)) return false
      return entry.name.trim() === node || entry.id.trim() === node
    })
    if (meshHit) return stripSlash(meshHit.denUrl)
    const rosterHit = ctx.roster.find(
      (entry) => entry.node?.trim() === node && stripSlash(entry.baseUrl),
    )
    if (rosterHit) return stripSlash(rosterHit.baseUrl)
  }
  const legacy = stripSlash(agent.nodeBaseUrl)
  return legacy || undefined
}

/** Mesh `name` for a roster URL. Empty `denUrl` (loopback) does not match. */
export function meshDenName(mesh: readonly MeshDenNode[], baseUrl: string): string | undefined {
  const url = stripSlash(baseUrl)
  if (!url) return undefined
  for (const entry of mesh) {
    if (!stripSlash(entry.denUrl)) continue
    if (stripSlash(entry.denUrl) === url && entry.name.trim()) return entry.name.trim()
  }
  return undefined
}

/**
 * Selector label. Mesh names and roster names; the current node uses its
 * mesh name (`/healthz.node`, else the mesh entry) when that is known.
 * The option value stays the den base URL.
 */
export function nodeOptionLabel(
  choice: NodeChoice,
  ctx: { currentBaseUrl: string; meshName?: string; healthzNode?: string },
): string {
  const meshName = ctx.meshName?.trim() || undefined
  const healthzNode = ctx.healthzNode?.trim() || undefined
  if (stripSlash(choice.baseUrl) === stripSlash(ctx.currentBaseUrl)) {
    return healthzNode || meshName || choice.name
  }
  return meshName || healthzNode || choice.node?.trim() || choice.name
}

export type ListedAgents = {
  baseUrl: string
  node?: string
  agents: readonly AgentPreset[]
}

export type ResolvedRosterAgent = AgentPreset & {
  /** Hosting den URL from `resolveAgentNodeUrl`, or '' when it is unknown. */
  sourceNodeBaseUrl: string
  /** Den that returned this copy. Delete falls back here when unresolved. */
  listedBaseUrl: string
}

/**
 * One row per preset id. A PG fleet returns the same preset from every den:
 * keep a copy whose URL resolved, and prefer the current node's copy.
 */
export function dedupeRosterAgents(
  lists: readonly ListedAgents[],
  ctx: {
    currentBaseUrl: string
    mesh: readonly MeshDenNode[]
    roster: readonly NodeChoice[]
  },
): ResolvedRosterAgent[] {
  const order: string[] = []
  const groups = new Map<string, { agent: AgentPreset; listedFrom: string; resolved?: string }[]>()
  for (const list of lists) {
    for (const agent of list.agents) {
      const resolved = resolveAgentNodeUrl(agent, {
        sourceBaseUrl: list.baseUrl,
        sourceNode: list.node,
        mesh: ctx.mesh,
        roster: ctx.roster,
      })
      const group = groups.get(agent.id)
      const row = { agent, listedFrom: list.baseUrl, resolved }
      if (group) group.push(row)
      else {
        groups.set(agent.id, [row])
        order.push(agent.id)
      }
    }
  }
  return order.map((id) => {
    const group = groups.get(id)
    if (!group || group.length === 0) {
      throw new Error(`missing agent group ${id}`)
    }
    const current = stripSlash(ctx.currentBaseUrl)
    const onCurrent = group.filter((row) => stripSlash(row.listedFrom) === current)
    const pick =
      onCurrent.find((row) => row.resolved) ??
      group.find((row) => row.resolved) ??
      (onCurrent.length > 0 ? onCurrent[0] : group[0])
    return {
      ...pick.agent,
      sourceNodeBaseUrl: pick.resolved ?? '',
      listedBaseUrl: pick.listedFrom,
    }
  })
}

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
