/**
 * Last-opened session per (agent preset, node) — powers keep-by-default
 * open on the current node and the cross-node activity indicator.
 *
 * Storage shape: `{ [agentId]: { [nodeBaseUrl]: { sessionId, updatedAt } } }`
 * under one key, plus a reverse bind key per session
 * (`rivethub.agent.<sessionId>` → agentId) for session→agent lookups.
 * The pre-multi-node shape (`{ [agentId]: { sessionId, nodeBaseUrl } }`) is
 * migrated on read and persisted immediately so the parse cost is paid once.
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

type NodeEntry = { sessionId: string; updatedAt?: number }
type NodeMap = Record<string, NodeEntry | undefined>
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
    let migrated = false
    for (const [agentId, row] of Object.entries(parsed as Record<string, unknown>)) {
      if (isLegacyRow(row)) {
        if (row.sessionId) out[agentId] = { [row.nodeBaseUrl]: { sessionId: row.sessionId } }
        migrated = true
        continue
      }
      if (!row || typeof row !== 'object' || Array.isArray(row)) continue
      const nodes: NodeMap = {}
      for (const [node, entry] of Object.entries(row as Record<string, unknown>)) {
        const e = entry as { sessionId?: unknown; updatedAt?: unknown } | null
        if (typeof e?.sessionId === 'string' && e.sessionId !== '') {
          nodes[node] = {
            sessionId: e.sessionId,
            ...(typeof e.updatedAt === 'number' ? { updatedAt: e.updatedAt } : {}),
          }
        }
      }
      if (Object.keys(nodes).length > 0) out[agentId] = nodes
    }
    // Persist a fired migration right away (same key, new shape) so every
    // later read parses the per-node shape directly. Tabs old enough to
    // expect the legacy shape go blind on the first NEW write regardless,
    // so rewriting here costs nothing extra.
    if (migrated) writeMap(out)
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

/** Every node's pointer for one agent, most recently written first — feeds
 *  the activity indicator (callers bound the poll fan-out, see
 *  `pointersToPoll`). */
export function listAgentSessions(agentId: string): AgentSessionPointer[] {
  const nodes = readMap()[agentId]
  if (!nodes) return []
  return Object.entries(nodes)
    .filter((pair): pair is [string, NodeEntry] => Boolean(pair[1]?.sessionId))
    .sort((a, b) => (b[1].updatedAt ?? 0) - (a[1].updatedAt ?? 0))
    .map(([nodeBaseUrl, entry]) => ({ sessionId: entry.sessionId, nodeBaseUrl }))
}

/** The agent bound to a session id, via the reverse bind key. */
export function agentForSession(sessionId: string): string | undefined {
  try {
    return localStorage.getItem(`${BIND_PREFIX}${sessionId}`) ?? undefined
  } catch {
    return undefined
  }
}

export function setAgentLastSession(agentId: string, sessionId: string, nodeBaseUrl: string): void {
  const map = readMap()
  const nodes: NodeMap = map[agentId] ?? {}
  const prev = nodes[nodeBaseUrl]
  if (prev?.sessionId && prev.sessionId !== sessionId) dropBind(prev.sessionId)
  nodes[nodeBaseUrl] = { sessionId, updatedAt: Date.now() }
  map[agentId] = nodes
  writeMap(map)
  try {
    localStorage.setItem(`${BIND_PREFIX}${sessionId}`, agentId)
  } catch {
    /* storage full / disabled */
  }
}

/** Drop ONE node's pointer (definitive 404 prune) with its bind key. */
export function clearAgentSessionPointer(agentId: string, nodeBaseUrl: string): void {
  const map = readMap()
  const nodes = map[agentId]
  const prev = nodes?.[nodeBaseUrl]
  if (!nodes || !prev) return
  const { [nodeBaseUrl]: _dropped, ...rest } = nodes
  if (Object.keys(rest).length > 0) {
    map[agentId] = rest
    writeMap(map)
  } else {
    const { [agentId]: _gone, ...others } = map
    writeMap(others)
  }
  dropBind(prev.sessionId)
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
        nodes[node] = { ...entry, sessionId: toSessionId }
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
