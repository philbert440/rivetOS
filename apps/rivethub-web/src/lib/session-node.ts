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
 * switch. Reads are PEEKS — recency refreshes only through the explicit
 * `touchSessionNodeBinding`, which the session view calls for the thread it
 * has open. A list, badge poll or bulk resolve naming hundreds of sessions
 * must not immortalize their entries, or genuinely stale bindings starve
 * eviction and the cap fills with ghosts. An off-roster binding is cleared
 * on ANY resolution that sees it — pointer-win included (the component
 * layer freezes its own copy per mount, so clearing rot here never flips a
 * mounted view).
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

/** PEEK — never refreshes recency. Bulk callers (lists, badge polls,
 *  adoption rekeys) read through this so they cannot rescue stale entries
 *  from eviction. */
export function getSessionNodeBinding(sessionId: string): string | undefined {
  return load()[sessionId]
}

/** Re-tail one session's binding: the OPEN thread's recency refresh. The
 *  session view calls this once per mount — the only reader whose interest
 *  should keep a binding alive. Also re-caps an over-size map. */
export function touchSessionNodeBinding(sessionId: string): void {
  const map = load()
  const node = map[sessionId]
  if (node === undefined) return
  const entries = Object.entries(map).filter(([k]) => k !== sessionId)
  entries.push([sessionId, node])
  save(Object.fromEntries(entries.slice(-MAX)))
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
 *  roster-validated; anything invalid falls back to the current node. The
 *  binding is validated EVEN WHEN the pointer wins, so an off-roster entry
 *  is reported to `onInvalidBinding` (and cleared by the runtime wrapper)
 *  instead of sitting in the map forever behind a healthy pointer. */
export function resolveSessionNode(opts: {
  currentBase: string
  rosterUrls: readonly string[]
  pointerNode?: string
  binding?: string
  onInvalidBinding?: () => void
}): string {
  const validBinding = (candidate: string | undefined): string | undefined => {
    if (!candidate) return undefined
    if (candidate === opts.currentBase) return candidate
    if (!opts.rosterUrls.includes(candidate)) {
      console.warn(`session-node: ${candidate} is not in the roster — using the current node`)
      opts.onInvalidBinding?.()
      return undefined
    }
    return candidate
  }
  // Agent-pinned off-roster must NOT fall back to current — that spawn a
  // hub doppelgänger wearing the agent session id. Keep the pointer so
  // ActiveSession treats it as remote-unreachable (banner, no spawn).
  const validPointer = (candidate: string | undefined): string | undefined => {
    if (!candidate) return undefined
    if (candidate === opts.currentBase) return candidate
    if (!opts.rosterUrls.includes(candidate)) {
      console.warn(
        `session-node: ${candidate} is not in the roster — keeping the pointer (fail closed)`,
      )
      // Deliberately CANDIDATE, never currentBase: the roster check only
      // drives the warning. Falling back here would spawn a hub doppelgänger.
      return candidate
    }
    return candidate
  }
  const pointer = validPointer(opts.pointerNode)
  const binding = validBinding(opts.binding) // always evaluated: clears rot on pointer-win too
  return pointer ?? binding ?? opts.currentBase
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
