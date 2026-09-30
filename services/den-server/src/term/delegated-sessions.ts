/**
 * Nest a delegated task's harness session under the conversation that
 * spawned it. The link is the task row, not a transcript scan.
 */

import {
  formatSessionId,
  HARNESS_IDS,
  type DelegatedSessionLink,
  type HarnessId,
} from '@rivetos/types'
import type { SessionOwners } from '../session-owners.js'

/** Same cap as the drawer. A deeper chain stays flat. */
export const NEST_DEPTH_CAP = 8

export interface NestableSession {
  id: string
  parentSessionId?: string
  agentName?: string
  model?: string
  taskId?: string
}

function nativeOf(id: string): string {
  const i = id.indexOf(':')
  return i >= 0 ? id.slice(i + 1) : id
}

function knownHarness(id: string | undefined): HarnessId | undefined {
  if (!id || !(HARNESS_IDS as readonly string[]).includes(id)) return undefined
  return id as HarnessId
}

/**
 * How many task hops from the delegating session. `undefined` when the chain
 * is broken (missing task, or a cycle) — the child stays flat.
 */
function chainDepth(
  link: DelegatedSessionLink,
  byTask: Map<string, DelegatedSessionLink>,
): number | undefined {
  let depth = 1
  let cur = link
  const seen = new Set<string>()
  while (cur.parentTaskId) {
    if (seen.has(cur.taskId)) return undefined
    seen.add(cur.taskId)
    const parent = byTask.get(cur.parentTaskId)
    if (!parent) return undefined
    depth += 1
    if (depth > NEST_DEPTH_CAP) return depth
    cur = parent
  }
  return depth
}

/** Native id of the session this task nests under, or undefined to stay flat. */
function parentNative(
  link: DelegatedSessionLink,
  byTask: Map<string, DelegatedSessionLink>,
): string | undefined {
  const depth = chainDepth(link, byTask)
  if (depth === undefined || depth > NEST_DEPTH_CAP) return undefined
  if (link.parentTaskId) {
    const parent = byTask.get(link.parentTaskId)
    if (!parent?.spawnedSessionId) return undefined
    return parent.spawnedSessionId
  }
  if (!link.parentSessionId) return undefined
  return nativeOf(link.parentSessionId)
}

/**
 * Overlay task links onto store rows. A parent that is not in `sessions`
 * leaves the child flat. An existing parent (a subagent transcript) is kept.
 */
export function applyDelegatedNesting<T extends NestableSession>(
  sessions: T[],
  links: DelegatedSessionLink[],
): T[] {
  if (links.length === 0) return sessions
  const byTask = new Map<string, DelegatedSessionLink>()
  const bySpawned = new Map<string, DelegatedSessionLink>()
  for (const link of links) {
    if (!link.taskId || !link.spawnedSessionId) continue
    byTask.set(link.taskId, link)
    bySpawned.set(link.spawnedSessionId, link)
  }
  const pool = new Set(sessions.map((session) => session.id))
  return sessions.map((session) => {
    const link = bySpawned.get(session.id)
    if (!link) return session
    const next: T = { ...session, taskId: link.taskId }
    if (!next.agentName && link.agentName) next.agentName = link.agentName
    if (!next.model && link.model) next.model = link.model
    if (next.parentSessionId) return next
    const parent = parentNative(link, byTask)
    if (!parent || parent === session.id || !pool.has(parent)) return next
    next.parentSessionId = parent
    return next
  })
}

/**
 * Tag each spawned session with the owner captured at create. Does not
 * overwrite a tag that is already there. Untagged when `owner` is absent
 * (the node owner).
 */
export function stampDelegatedOwners(owners: SessionOwners, links: DelegatedSessionLink[]): void {
  for (const link of links) {
    const owner = link.owner?.trim()
    const native = link.spawnedSessionId.trim()
    if (!owner || !native || native.includes('/') || native.includes('..')) continue
    owners.tagIfAbsent(native, owner)
    const harness = knownHarness(link.harnessId)
    if (!harness) continue
    try {
      owners.tagIfAbsent(formatSessionId(harness, native), owner)
    } catch {
      // A native id the codec rejects is still tagged under the bare id.
    }
  }
}
