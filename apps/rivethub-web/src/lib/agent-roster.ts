/**
 * Pure helpers for the agents sidebar: node picker order, hosting-den
 * resolution, session-pointer matching, and the row activity indicator.
 */

import {
  rosterCommandFor,
  type AgentPreset,
  type HarnessId,
  type MeshDenNode,
  type ThinkingLevel,
} from '@rivetos/types'

export type NodeChoice = {
  name: string
  baseUrl: string
  /** Mesh node name recorded from `/healthz.node`. Not the display label. */
  node?: string
}

function stripSlash(url: string | undefined): string {
  return (url ?? '').trim().replace(/\/+$/, '')
}

/** Roster rows whose recorded `/healthz.node` is `nodeName` and whose URL is set. */
function rosterEntriesForNode(roster: readonly NodeChoice[], nodeName: string): NodeChoice[] {
  return roster.filter(
    (entry) => entry.node?.trim() === nodeName && stripSlash(entry.baseUrl) !== '',
  )
}

/**
 * URL of the den that hosts `agent`, or undefined ("node unknown").
 *
 * 1. `agent.node` is the answering den's node → that den's base URL. This is
 *    the single-host path: a loopback node advertises an empty `denUrl`.
 * 2. A mesh node with a non-empty `denUrl` whose `name` equals `agent.node`,
 *    else one whose `id` equals `agent.node`. Name wins when both could hit.
 * 3. A roster entry whose recorded `/healthz.node` equals `agent.node`,
 *    when exactly one entry has that name. Two entries are unknown.
 * 4. Legacy `agent.nodeBaseUrl` when set. A rule-3 collision does not
 *    fall through to this. Remove this rule when no pre-registry den (one
 *    that 400s `nodeBaseUrl is required`) remains on the roster.
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
    const meshHit =
      ctx.mesh.find((entry) => stripSlash(entry.denUrl) !== '' && entry.name.trim() === node) ??
      ctx.mesh.find((entry) => stripSlash(entry.denUrl) !== '' && entry.id.trim() === node)
    if (meshHit) return stripSlash(meshHit.denUrl)
    const rosterHits = rosterEntriesForNode(ctx.roster, node)
    if (rosterHits.length > 1) return undefined
    if (rosterHits.length === 1) return stripSlash(rosterHits[0]?.baseUrl)
  }
  // Legacy fallback until no pre-registry den (one that 400s `nodeBaseUrl is required`) remains on the roster.
  // eslint-disable-next-line @typescript-eslint/no-deprecated -- legacy fallback (slice 7)
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
  /** Roster URL of the hosting den, or '' when it is unknown / off-roster. */
  sourceNodeBaseUrl: string
  /** Den that returned this copy. Delete always targets it. */
  listedBaseUrl: string
}

/**
 * Map a resolved hosting URL onto a roster entry the hub can open.
 * Same URL wins; otherwise the entry whose recorded `/healthz.node` equals
 * `node`, when exactly one roster entry has that name. More than one is
 * unknown (the row stays disabled). A mesh-only alias, or any other URL on
 * no roster entry, is unknown.
 */
export function rosterUrlForResolved(
  resolved: string | undefined,
  node: string | undefined,
  roster: readonly NodeChoice[],
): string | undefined {
  const url = stripSlash(resolved)
  if (url === '') return undefined
  const same = roster.find((entry) => stripSlash(entry.baseUrl) === url)
  if (same) return stripSlash(same.baseUrl)
  const nodeName = node?.trim()
  if (!nodeName) return undefined
  const byNode = rosterEntriesForNode(roster, nodeName)
  if (byNode.length !== 1) return undefined
  return stripSlash(byNode[0]?.baseUrl)
}

/** Delete always goes to the den that listed the row. Legacy files live only there. */
export function agentDeleteTarget(agent: Pick<ResolvedRosterAgent, 'listedBaseUrl'>): string {
  return agent.listedBaseUrl
}

/**
 * Update goes to the resolved hosting den only when `agent.node` is set
 * (a placement change must hit that den). Otherwise, including a legacy
 * file row, it goes to the listing den.
 */
export function agentUpdateTarget(
  agent: Pick<ResolvedRosterAgent, 'node' | 'sourceNodeBaseUrl' | 'listedBaseUrl'>,
): string {
  if (agent.node?.trim() && agent.sourceNodeBaseUrl) return agent.sourceNodeBaseUrl
  return agent.listedBaseUrl
}

const THINKING_LEVELS: readonly ThinkingLevel[] = ['off', 'low', 'medium', 'high', 'xhigh']

function isThinkingLevel(value: string | undefined): value is ThinkingLevel {
  return typeof value === 'string' && (THINKING_LEVELS as readonly string[]).includes(value)
}

/** Chat-settings patch applied when a roster row opens a thread. */
export interface AgentThreadSettings {
  agent: string
  harnessId?: HarnessId
  model: string
  effort: ThinkingLevel
  harnessEffort?: string
  systemPrompt: string
  agentId: string
}

/** Pure half of `applyAgentSettings`: the thread keeps the preset id. */
export function agentThreadSettings(
  agent: Pick<AgentPreset, 'id' | 'harnessId' | 'model' | 'effort' | 'systemPrompt'>,
): AgentThreadSettings {
  return {
    agent: rosterCommandFor(agent.harnessId) ?? '',
    harnessId: agent.harnessId,
    model: agent.model || '',
    effort: isThinkingLevel(agent.effort) ? agent.effort : 'medium',
    harnessEffort: agent.effort || undefined,
    systemPrompt: agent.systemPrompt || '',
    agentId: agent.id,
  }
}

/**
 * One row per preset id. A PG fleet returns the same preset from every den.
 * Prefer the copy whose listing den is the resolved hosting den (rule 1)
 * over a mesh alias, then any resolved copy (current node first). A resolved
 * URL that is not on the roster is unknown.
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
      const resolved = rosterUrlForResolved(
        resolveAgentNodeUrl(agent, {
          sourceBaseUrl: list.baseUrl,
          sourceNode: list.node,
          mesh: ctx.mesh,
          roster: ctx.roster,
        }),
        agent.node,
        ctx.roster,
      )
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
    const selfHosted = group.filter(
      (row) =>
        row.resolved !== undefined && stripSlash(row.listedFrom) === stripSlash(row.resolved),
    )
    const resolvedRows = group.filter((row) => row.resolved !== undefined)
    const onCurrent = group.filter((row) => stripSlash(row.listedFrom) === current)
    const preferCurrent = (
      rows: { agent: AgentPreset; listedFrom: string; resolved?: string }[],
    ): (typeof rows)[number] | undefined => {
      if (rows.length === 0) return undefined
      return rows.find((row) => stripSlash(row.listedFrom) === current) ?? rows[0]
    }
    const fallback = onCurrent.length > 0 ? onCurrent[0] : group[0]
    const pick = preferCurrent(selfHosted) ?? preferCurrent(resolvedRows) ?? fallback
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** `Array.isArray` widens to `any[]`; copy into `unknown[]` so callers stay typed. */
function listedAgents(row: unknown): unknown[] {
  if (!isRecord(row) || !Array.isArray(row.agents)) return []
  const agents: unknown[] = []
  for (const agent of row.agents) agents.push(agent)
  return agents
}

/**
 * Rows for the chat drawer's pin swatch. The agents fan-out cache is either
 * the raw per-den lists (`{ agents }`) or an older deduped preset array.
 */
export function presetsFromAgentsQueryData(
  data: unknown,
): Pick<AgentPreset, 'id' | 'name' | 'color' | 'model' | 'harnessId'>[] {
  if (!Array.isArray(data)) return []
  const rows = isAgentListCache(data) ? data.flatMap((row) => listedAgents(row)) : data
  const out: Pick<AgentPreset, 'id' | 'name' | 'color' | 'model' | 'harnessId'>[] = []
  for (const row of rows) {
    if (!isRecord(row) || typeof row.id !== 'string') continue
    out.push(row as Pick<AgentPreset, 'id' | 'name' | 'color' | 'model' | 'harnessId'>)
  }
  return out
}

function isAgentListCache(data: unknown[]): boolean {
  return (
    data.length > 0 &&
    data.every((row) => isRecord(row) && Array.isArray(row.agents) && typeof row.id !== 'string')
  )
}
