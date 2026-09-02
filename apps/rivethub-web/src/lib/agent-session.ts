/**
 * Sticky session pointer per agent preset — one slot on the agent's node.
 *
 * Storage shape stays the per-(agent, node) map so a stale tab that still
 * writes the pre-#570 `{sessionId, nodeBaseUrl}` row cannot ping-pong with
 * `isLegacyRow`. The product rule is one slot: `setAgentLastSession` is
 * set-once unless `{ replace: true }` (↺ / claimed-session 404).
 *
 * Reverse bind: `rivethub.agent.<sessionId>` → agentId.
 */

const LAST_KEY = 'rivethub.agent.lastSession'
const BIND_PREFIX = 'rivethub.agent.'

export interface AgentSessionPointer {
  sessionId: string
  nodeBaseUrl: string
  /** epoch ms of the last pin write. Missing on pre-migration rows → 0. */
  updatedAt?: number
}

type NodeEntry = { sessionId: string; updatedAt?: number }
type NodeMap = Record<string, NodeEntry | undefined>
type LastMap = Record<string, NodeMap | undefined>

function toPointer(nodeBaseUrl: string, entry: NodeEntry): AgentSessionPointer {
  return { sessionId: entry.sessionId, nodeBaseUrl, updatedAt: entry.updatedAt ?? 0 }
}

let version = 0
const listeners = new Set<() => void>()

function bump(): void {
  version += 1
  for (const l of listeners) l()
}

/** Subscribe to pointer-store writes (drawer pin rows). */
export function subscribeAgentSessions(onStoreChange: () => void): () => void {
  listeners.add(onStoreChange)
  return () => {
    listeners.delete(onStoreChange)
  }
}

export function getAgentSessionsVersion(): number {
  return version
}

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
        if (row.sessionId) {
          out[agentId] = { [row.nodeBaseUrl]: { sessionId: row.sessionId } }
          migrated = true
        }
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
    if (migrated) {
      try {
        // Silent: this persist runs inside render-phase reads (listAllAgentPins
        // in ChatPage's useMemo) and the reader already holds the migrated
        // view — bumping here would be a store update during render.
        writeMap(out, { silent: true })
      } catch {
        /* keep the parsed result */
      }
    }
    return out
  } catch {
    return {}
  }
}

function writeMap(map: LastMap, opts?: { silent?: boolean }): void {
  try {
    localStorage.setItem(LAST_KEY, JSON.stringify(map))
  } catch {
    /* storage full / disabled */
  }
  if (!opts?.silent) bump()
}

function dropBind(sessionId: string | undefined): void {
  if (!sessionId) return
  try {
    localStorage.removeItem(`${BIND_PREFIX}${sessionId}`)
  } catch {
    /* storage full / disabled */
  }
}

function bind(sessionId: string, agentId: string): void {
  try {
    localStorage.setItem(`${BIND_PREFIX}${sessionId}`, agentId)
  } catch {
    /* storage full / disabled */
  }
}

/** The agent's thread on ONE node, or undefined. */
export function getAgentLastSession(
  agentId: string,
  nodeBaseUrl: string,
): AgentSessionPointer | undefined {
  const entry = readMap()[agentId]?.[nodeBaseUrl]
  if (!entry?.sessionId) return undefined
  return toPointer(nodeBaseUrl, entry)
}

/** Every node's pointer for one agent, most recently written first. */
export function listAgentSessions(agentId: string): AgentSessionPointer[] {
  const nodes = readMap()[agentId]
  if (!nodes) return []
  return Object.entries(nodes)
    .filter((pair): pair is [string, NodeEntry] => Boolean(pair[1]?.sessionId))
    .sort((a, b) => (b[1].updatedAt ?? 0) - (a[1].updatedAt ?? 0))
    .map(([nodeBaseUrl, entry]) => toPointer(nodeBaseUrl, entry))
}

/** Every agent's sticky pin — drawer merge. */
export function listAllAgentPins(): Array<AgentSessionPointer & { agentId: string }> {
  const map = readMap()
  const out: Array<AgentSessionPointer & { agentId: string }> = []
  for (const agentId of Object.keys(map)) {
    const pin = getAgentPin(agentId)
    if (pin) out.push({ agentId, ...pin })
  }
  return out
}

/** The single sticky pin — oldest slot if collapse has not run yet. */
export function getAgentPin(agentId: string): AgentSessionPointer | undefined {
  const nodes = readMap()[agentId]
  if (!nodes) return undefined
  const entries = Object.entries(nodes).filter((pair): pair is [string, NodeEntry] =>
    Boolean(pair[1]?.sessionId),
  )
  if (entries.length === 0) return undefined
  entries.sort((a, b) => (a[1].updatedAt ?? 0) - (b[1].updatedAt ?? 0))
  const [nodeBaseUrl, entry] = entries[0]
  return toPointer(nodeBaseUrl, entry)
}

/**
 * Enforce one slot: keep the preset-node entry if present, else the oldest.
 * Run at open time — this module does not know the preset node.
 */
export function collapseAgentSlots(
  agentId: string,
  preferNode: string,
): AgentSessionPointer | undefined {
  const listed = listAgentSessions(agentId)
  if (listed.length === 0) return undefined
  const keep = listed.find((p) => p.nodeBaseUrl === preferNode) ?? getAgentPin(agentId)
  if (!keep) return undefined
  if (listed.length === 1) return keep
  for (const p of listed) {
    if (p.nodeBaseUrl === keep.nodeBaseUrl && p.sessionId === keep.sessionId) continue
    clearAgentSessionPointer(agentId, p.nodeBaseUrl, p.sessionId)
  }
  return keep
}

export function agentForSession(sessionId: string): string | undefined {
  try {
    return localStorage.getItem(`${BIND_PREFIX}${sessionId}`) ?? undefined
  } catch {
    return undefined
  }
}

export function setAgentLastSession(
  agentId: string,
  sessionId: string,
  nodeBaseUrl: string,
  opts?: { replace?: boolean },
): void {
  const existing = listAgentSessions(agentId)
  if (!opts?.replace && existing.length > 0) return

  const map = readMap()
  if (opts?.replace) {
    for (const p of existing) dropBind(p.sessionId)
  }
  const nodes: NodeMap = opts?.replace ? {} : (map[agentId] ?? {})
  const prev = nodes[nodeBaseUrl]
  if (prev?.sessionId && prev.sessionId !== sessionId) dropBind(prev.sessionId)
  nodes[nodeBaseUrl] = { sessionId, updatedAt: Date.now() }
  map[agentId] = nodes
  writeMap(map)
  bind(sessionId, agentId)
}

export function clearAgentSessionPointer(
  agentId: string,
  nodeBaseUrl: string,
  expectedSessionId: string,
): void {
  const map = readMap()
  const nodes = map[agentId]
  const prev = nodes?.[nodeBaseUrl]
  if (!nodes || !prev || prev.sessionId !== expectedSessionId) return
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

export function clearAgentLastSession(agentId: string): void {
  const map = readMap()
  const { [agentId]: prev, ...rest } = map
  writeMap(rest)
  for (const entry of Object.values(prev ?? {})) dropBind(entry?.sessionId)
}

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
  if (!changed) bump()
}
