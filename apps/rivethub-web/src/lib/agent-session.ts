/**
 * Last-opened session per (agent preset, node) — powers keep-by-default
 * open on the current node and the cross-node activity indicator.
 *
 * Storage shape: `{ [agentId]: { [nodeBaseUrl]: { sessionId } } }` under
 * one key, plus a reverse bind key per session (`rivethub.agent.<sessionId>`
 * → agentId) for session→agent lookups. The pre-multi-node shape
 * (`{ [agentId]: { sessionId, nodeBaseUrl } }`) is normalized on read.
 * Stored separately from chat settings so a thread rekey (bare uuid →
 * canonical SessionId) can retarget pointers without walking the settings
 * map.
 */

const LAST_KEY = 'rivethub.agent.lastSession'
const BIND_PREFIX = 'rivethub.agent.'

export interface AgentSessionPointer {
  sessionId: string
  nodeBaseUrl: string
}

type NodeMap = Record<string, { sessionId: string } | undefined>
type LastMap = Record<string, NodeMap | undefined>

/** The single-pointer row written before per-node keying. Its `sessionId` is
 *  a string where a NodeMap value is an object, so the shapes cannot collide. */
function isLegacyRow(row: unknown): row is AgentSessionPointer {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return false
  const r = row as Record<string, unknown>
  return typeof r.sessionId === 'string' && typeof r.nodeBaseUrl === 'string'
}

function readMap(): LastMap {
  try {
    const raw = localStorage.getItem(LAST_KEY)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: LastMap = {}
    for (const [agentId, row] of Object.entries(parsed as Record<string, unknown>)) {
      if (isLegacyRow(row)) {
        if (row.sessionId) out[agentId] = { [row.nodeBaseUrl]: { sessionId: row.sessionId } }
        continue
      }
      if (!row || typeof row !== 'object' || Array.isArray(row)) continue
      const nodes: NodeMap = {}
      for (const [node, entry] of Object.entries(row as Record<string, unknown>)) {
        const sid = (entry as { sessionId?: unknown } | null)?.sessionId
        if (typeof sid === 'string' && sid !== '') nodes[node] = { sessionId: sid }
      }
      if (Object.keys(nodes).length > 0) out[agentId] = nodes
    }
    return out
  } catch {
    return {}
  }
}

function writeMap(map: LastMap): void {
  try {
    localStorage.setItem(LAST_KEY, JSON.stringify(map))
  } catch {
    /* storage full / disabled */
  }
}

function dropBind(sessionId: string | undefined): void {
  if (!sessionId) return
  try {
    localStorage.removeItem(`${BIND_PREFIX}${sessionId}`)
  } catch {
    /* storage full / disabled */
  }
}

/** The agent's most recent thread on ONE node, or undefined. */
export function getAgentLastSession(
  agentId: string,
  nodeBaseUrl: string,
): AgentSessionPointer | undefined {
  const entry = readMap()[agentId]?.[nodeBaseUrl]
  if (!entry?.sessionId) return undefined
  return { sessionId: entry.sessionId, nodeBaseUrl }
}

/** Every node's pointer for one agent — feeds the activity indicator. */
export function listAgentSessions(agentId: string): AgentSessionPointer[] {
  const nodes = readMap()[agentId]
  if (!nodes) return []
  return Object.entries(nodes)
    .filter((pair): pair is [string, { sessionId: string }] => Boolean(pair[1]?.sessionId))
    .map(([nodeBaseUrl, entry]) => ({ sessionId: entry.sessionId, nodeBaseUrl }))
}

export function setAgentLastSession(agentId: string, sessionId: string, nodeBaseUrl: string): void {
  const map = readMap()
  const nodes: NodeMap = map[agentId] ?? {}
  const prev = nodes[nodeBaseUrl]
  if (prev?.sessionId && prev.sessionId !== sessionId) dropBind(prev.sessionId)
  nodes[nodeBaseUrl] = { sessionId }
  map[agentId] = nodes
  writeMap(map)
  try {
    localStorage.setItem(`${BIND_PREFIX}${sessionId}`, agentId)
  } catch {
    /* storage full / disabled */
  }
}

/** Drop every node's pointer and bind key for one agent (agent delete). */
export function clearAgentLastSession(agentId: string): void {
  const map = readMap()
  const { [agentId]: prev, ...rest } = map
  writeMap(rest)
  for (const entry of Object.values(prev ?? {})) dropBind(entry?.sessionId)
}

/** Draft uuid → canonical SessionId (or native-id rotation), on every node. */
export function rekeyAgentLastSessions(fromSessionId: string, toSessionId: string): void {
  if (!fromSessionId || fromSessionId === toSessionId) return
  const map = readMap()
  let changed = false
  for (const nodes of Object.values(map)) {
    for (const [node, entry] of Object.entries(nodes ?? {})) {
      if (nodes && entry?.sessionId === fromSessionId) {
        nodes[node] = { sessionId: toSessionId }
        changed = true
      }
    }
  }
  if (changed) writeMap(map)
  try {
    const agentId = localStorage.getItem(`${BIND_PREFIX}${fromSessionId}`)
    if (agentId) {
      localStorage.setItem(`${BIND_PREFIX}${toSessionId}`, agentId)
      localStorage.removeItem(`${BIND_PREFIX}${fromSessionId}`)
    }
  } catch {
    /* storage full / disabled */
  }
}
