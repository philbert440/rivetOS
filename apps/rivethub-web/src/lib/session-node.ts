/**
 * Per-session node binding — which node a conversation actually lives on.
 *
 * The app is globally connected to ONE node, but an agent's most recent
 * thread may live on another (#570 stopped repointing the whole app on a
 * sidebar click). A binding lets ActiveSession drive that thread over ITS
 * node's gateway — mTLS pipe included — while the global connection, drawer
 * and every other page stay put.
 *
 * Resolution order: the agent pointer store (authoritative for agent
 * threads), then this map (sessions opened cross-node by hand), else the
 * current node. Only CROSS-node entries are written: a binding equal to the
 * viewer's node would be dead weight and would go stale the moment the user
 * switches nodes. A binding whose node is not in the roster is ignored (the
 * node was removed) — falling back to the current node renders the thread
 * read-only-ish rather than dead.
 */

import { agentForSession, listAgentSessions } from './agent-session.js'

const KEY = 'rivethub.sessionNodes'
const MAX = 200

function load(): Record<string, string | undefined> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(KEY) ?? '{}')
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, string | undefined>)
      : {}
  } catch {
    return {}
  }
}

function save(map: Record<string, string | undefined>): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(map))
  } catch {
    /* storage full / disabled — binding just won't persist */
  }
}

export function getSessionNodeBinding(sessionId: string): string | undefined {
  return load()[sessionId]
}

/** LRU on touch, like session-mode: re-binding moves the key to the tail so
 *  overflow evicts the least-recently-bound session. */
export function setSessionNodeBinding(sessionId: string, nodeBaseUrl: string): void {
  const map = load()
  const entries = Object.entries(map).filter(([k]) => k !== sessionId)
  entries.push([sessionId, nodeBaseUrl])
  save(Object.fromEntries(entries.slice(-MAX)))
}

export function clearSessionNodeBinding(sessionId: string): void {
  const map = load()
  if (!(sessionId in map)) return
  const { [sessionId]: _gone, ...rest } = map
  save(rest)
}

/** Draft uuid → canonical id (or native-id rotation) keeps its binding. */
export function rekeySessionNodeBinding(fromSessionId: string, toSessionId: string): void {
  if (!fromSessionId || fromSessionId === toSessionId) return
  const map = load()
  const node = map[fromSessionId]
  if (node === undefined) return
  const { [fromSessionId]: _gone, ...rest } = map
  if (rest[toSessionId] === undefined) rest[toSessionId] = node
  save(rest)
}

/** Pure resolution — exported for tests. Pointer wins over binding; both are
 *  roster-validated; anything invalid falls back to the current node. */
export function resolveSessionNode(opts: {
  currentBase: string
  rosterUrls: readonly string[]
  pointerNode?: string
  binding?: string
}): string {
  const valid = (candidate: string | undefined): string | undefined => {
    if (!candidate) return undefined
    if (candidate === opts.currentBase) return candidate
    if (!opts.rosterUrls.includes(candidate)) {
      console.warn(`session-node: ${candidate} is not in the roster — using the current node`)
      return undefined
    }
    return candidate
  }
  return valid(opts.pointerNode) ?? valid(opts.binding) ?? opts.currentBase
}

/** The node a session should be driven from (runtime wrapper). */
export function sessionNodeFor(
  sessionId: string,
  currentBase: string,
  rosterUrls: readonly string[],
): string {
  const agentId = agentForSession(sessionId)
  const pointerNode = agentId
    ? listAgentSessions(agentId).find((p) => p.sessionId === sessionId)?.nodeBaseUrl
    : undefined
  return resolveSessionNode({
    currentBase,
    rosterUrls,
    pointerNode,
    binding: getSessionNodeBinding(sessionId),
  })
}
