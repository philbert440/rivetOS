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
 * current node. `setSessionNodeBinding` enforces cross-node-only storage: a
 * write for the caller's own node CLEARS instead (the session is home now),
 * so no caller can pollute the map with entries that go stale on a node
 * switch. Reads re-tail the entry (true LRU): an open session's binding
 * cannot age out under it just because other sessions were bound since. An
 * off-roster binding is cleared on resolution — the node was removed, and
 * repeating the fallback every resolve would drive a home gateway for a
 * thread that still lives elsewhere (the component layer freezes its own
 * copy per mount for exactly that reason).
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

/** Re-tail one key (LRU touch); no-op when absent. */
function touch(map: Record<string, string | undefined>, sessionId: string): void {
  const node = map[sessionId]
  if (node === undefined) return
  const entries = Object.entries(map).filter(([k]) => k !== sessionId)
  entries.push([sessionId, node])
  save(Object.fromEntries(entries))
}

/** Access-order read: a get counts as recent use, so an OPEN session's
 *  binding outlives 200 newer writes. */
export function getSessionNodeBinding(sessionId: string): string | undefined {
  const map = load()
  const node = map[sessionId]
  if (node !== undefined) touch(map, sessionId)
  return node
}

/** Cross-node entries only: binding a session to the caller's own node
 *  clears any stored entry instead — home is the default, not a binding. */
export function setSessionNodeBinding(
  sessionId: string,
  nodeBaseUrl: string,
  currentBase: string,
): void {
  if (nodeBaseUrl === currentBase) {
    clearSessionNodeBinding(sessionId)
    return
  }
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

/** Draft uuid → canonical id (or native-id rotation). Last write wins on a
 *  destination collision — the adoption is the live event, and a leftover
 *  binding on the canonical id must not outrank the session being adopted —
 *  and the destination is LRU-tailed like any fresh write. */
export function rekeySessionNodeBinding(fromSessionId: string, toSessionId: string): void {
  if (!fromSessionId || fromSessionId === toSessionId) return
  const map = load()
  const node = map[fromSessionId]
  if (node === undefined) return
  const entries = Object.entries(map).filter(([k]) => k !== fromSessionId && k !== toSessionId)
  entries.push([toSessionId, node])
  save(Object.fromEntries(entries.slice(-MAX)))
}

/** Pure resolution — exported for tests. Pointer wins over binding; both are
 *  roster-validated; anything invalid falls back to the current node after
 *  telling `onInvalidBinding` so the caller can clear the rot. */
export function resolveSessionNode(opts: {
  currentBase: string
  rosterUrls: readonly string[]
  pointerNode?: string
  binding?: string
  onInvalidBinding?: () => void
}): string {
  const valid = (candidate: string | undefined, isBinding: boolean): string | undefined => {
    if (!candidate) return undefined
    if (candidate === opts.currentBase) return candidate
    if (!opts.rosterUrls.includes(candidate)) {
      console.warn(`session-node: ${candidate} is not in the roster — using the current node`)
      if (isBinding) opts.onInvalidBinding?.()
      return undefined
    }
    return candidate
  }
  return valid(opts.pointerNode, false) ?? valid(opts.binding, true) ?? opts.currentBase
}

/** The node a session should be driven from (runtime wrapper). An off-roster
 *  BINDING is cleared here — the pointer store belongs to the agents layer,
 *  which prunes on its own definitive misses. */
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
    onInvalidBinding: () => clearSessionNodeBinding(sessionId),
  })
}
