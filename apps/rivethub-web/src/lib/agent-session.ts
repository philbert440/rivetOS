/**
 * Last-opened session per agent preset — powers the keep-vs-reset dialog.
 *
 * Stored separately from chat settings so a thread rekey (bare uuid →
 * canonical SessionId) can retarget the pointer without walking the
 * settings map.
 */

const LAST_KEY = 'rivethub.agent.lastSession'
const BIND_PREFIX = 'rivethub.agent.'

export interface AgentLastSession {
  sessionId: string
  nodeBaseUrl: string
}

type LastMap = Record<string, AgentLastSession | undefined>

function readMap(): LastMap {
  try {
    const raw = localStorage.getItem(LAST_KEY)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return parsed as LastMap
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

export function getAgentLastSession(agentId: string): AgentLastSession | undefined {
  const row = readMap()[agentId]
  if (!row || typeof row.sessionId !== 'string' || typeof row.nodeBaseUrl !== 'string') {
    return undefined
  }
  if (!row.sessionId) return undefined
  return { sessionId: row.sessionId, nodeBaseUrl: row.nodeBaseUrl }
}

export function setAgentLastSession(agentId: string, sessionId: string, nodeBaseUrl: string): void {
  const map = readMap()
  map[agentId] = { sessionId, nodeBaseUrl }
  writeMap(map)
  try {
    localStorage.setItem(`${BIND_PREFIX}${sessionId}`, agentId)
  } catch {
    /* storage full / disabled */
  }
}

/** Draft uuid → canonical SessionId (or native-id rotation). */
export function rekeyAgentLastSessions(fromSessionId: string, toSessionId: string): void {
  if (!fromSessionId || fromSessionId === toSessionId) return
  const map = readMap()
  let changed = false
  for (const [id, row] of Object.entries(map)) {
    if (row?.sessionId === fromSessionId) {
      map[id] = { sessionId: toSessionId, nodeBaseUrl: row.nodeBaseUrl }
      changed = true
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
