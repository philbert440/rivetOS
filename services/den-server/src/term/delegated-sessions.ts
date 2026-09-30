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
export function chainDepth(
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
 * Registry lookup the den already has. `undefined` is an untagged session,
 * which belongs to the node owner — the registry has no row for that case.
 */
export interface DelegatedClaimCheck {
  /** No users registry. Links pass through; nesting stays as it was. */
  tenancy: boolean
  /** Owner recorded for this session id, in whatever form the caller resolves. */
  ownerOf(sessionId: string): string | undefined
  /** `usersRegistry.ownerUserId`. An absent claim owner means this user. */
  nodeOwnerId?: string
}

function safeNative(id: string | undefined): string | undefined {
  if (!id) return undefined
  const native = nativeOf(id).trim()
  if (!native || native.includes('/') || native.includes('..')) return undefined
  return native
}

/** Drop the env-supplied parent and owner. The child stays top-level and untagged. */
function withoutClaim(link: DelegatedSessionLink): DelegatedSessionLink {
  const next: DelegatedSessionLink = {
    taskId: link.taskId,
    spawnedSessionId: link.spawnedSessionId,
  }
  if (link.agentName) next.agentName = link.agentName
  if (link.model) next.model = link.model
  if (link.harnessId) next.harnessId = link.harnessId
  return next
}

/**
 * `spec.owner` and `spec.parentSessionId` are copied from the sidecar's
 * process env. Nest only when the parent session's registry owner is the
 * claimed owner. A claim that does not verify loses both fields, so the
 * child is not nested and is not tagged with the claimed user — an untagged
 * row belongs to the node owner. Tenancy off does not consult the registry.
 */
export function verifyDelegatedClaims(
  links: DelegatedSessionLink[],
  check: DelegatedClaimCheck,
): DelegatedSessionLink[] {
  if (!check.tenancy) return links
  const nodeOwner = check.nodeOwnerId?.trim() ?? ''
  const byTask = new Map<string, DelegatedSessionLink>()
  for (const link of links) {
    if (link.taskId && link.spawnedSessionId.trim()) byTask.set(link.taskId, link)
  }
  const decided = new Map<string, DelegatedSessionLink>()

  function claimedOf(link: DelegatedSessionLink): string {
    return link.owner?.trim() || nodeOwner
  }

  /** Tagged owner, or the node owner when the id is untagged. */
  function registryOwner(sessionId: string): string {
    const direct = check.ownerOf(sessionId)
    if (direct) return direct
    const native = safeNative(sessionId)
    if (native && native !== sessionId) {
      const viaNative = check.ownerOf(native)
      if (viaNative) return viaNative
    }
    return nodeOwner
  }

  function decide(link: DelegatedSessionLink, stack: string[]): DelegatedSessionLink {
    const prior = decided.get(link.taskId)
    if (prior) return prior
    // A cycle has no verified parent. Flat, and do not keep walking.
    if (stack.includes(link.taskId)) return withoutClaim(link)
    const claimed = claimedOf(link)
    const spawned = link.spawnedSessionId.trim()
    let parentNative: string | undefined
    let parentOwner: string | undefined
    if (link.parentTaskId) {
      const parent = byTask.get(link.parentTaskId)
      if (!parent || parent.taskId === link.taskId) {
        const flat = withoutClaim(link)
        decided.set(link.taskId, flat)
        return flat
      }
      const accepted = decide(parent, [...stack, link.taskId])
      if (!accepted.parentSessionId && !accepted.parentTaskId) {
        const flat = withoutClaim(link)
        decided.set(link.taskId, flat)
        return flat
      }
      parentNative = safeNative(accepted.spawnedSessionId)
      parentOwner = accepted.owner?.trim() || nodeOwner
    } else {
      parentNative = safeNative(link.parentSessionId)
      if (parentNative) parentOwner = registryOwner(link.parentSessionId ?? parentNative)
    }
    const ok =
      claimed.length > 0 &&
      parentNative !== undefined &&
      parentOwner !== undefined &&
      parentOwner.length > 0 &&
      parentOwner === claimed &&
      parentNative !== spawned
    // An absent owner that matched is the node owner. Record it so the child
    // is tagged, not left claimable as an untagged id.
    const next: DelegatedSessionLink = !ok
      ? withoutClaim(link)
      : !link.owner?.trim() && nodeOwner
        ? { ...link, owner: nodeOwner }
        : link
    decided.set(link.taskId, next)
    return next
  }

  return links.map((link) => {
    if (!link.taskId || !link.spawnedSessionId.trim()) return withoutClaim(link)
    return decide(link, [])
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
