/**
 * Persisted session ownership. Harness on-disk stores have no user column, so
 * den records `sessionId → userId` at spawn and filters every listing / resume
 * through this map. Untagged rows belong to the node owner.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { sessionVisibleTo, type UserContext } from '@rivetos/types'

export interface SessionOwners {
  get(sessionId: string): string | undefined
  set(sessionId: string, userId: string): void
  /**
   * `parentId` is for a nested row den never spawned. An untagged child
   * follows that parent. It does not fall through to the node owner unless
   * the parent itself is untagged.
   */
  visible(sessionId: string, ctx: UserContext, parentId?: string): boolean
  filter<T>(
    items: T[],
    ctx: UserContext,
    idOf?: (item: T) => string,
    parentOf?: (item: T) => string | undefined,
  ): T[]
  /** Copy a tagged parent's owner onto an untagged child. Does not overwrite. */
  inherit(childId: string, parentId: string | undefined): boolean
  /** Record `userId` when the id has no tag yet. Does not overwrite. */
  tagIfAbsent(sessionId: string, userId: string): boolean
}

/**
 * The single ownership check every session-scoped route must invoke.
 * No bound ctx = tenancy off (single-owner node) and everything is allowed.
 */
export function sessionForbidden(
  owners: SessionOwners,
  ctx: UserContext | undefined,
  sessionId: string,
): boolean {
  return !!ctx && !owners.visible(sessionId, ctx)
}

/** Isolation violations belong in the audit trail — one line per refusal. */
export function auditTenancyDeny(route: string, sessionId: string, ctx: UserContext): void {
  console.error(
    `[den] tenancy: refused ${route} session=${sessionId} for user "${ctx.userId}" (owned by another user)`,
  )
}

export function createSessionOwners(file: string): SessionOwners {
  let map: Record<string, string> = load(file)

  function persist(): void {
    try {
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, JSON.stringify(map, null, 2) + '\n', { mode: 0o600 })
    } catch (err) {
      console.error(
        `[den] session-owners persist failed: ${err instanceof Error ? err.message : err}`,
      )
    }
  }

  return {
    get(sessionId) {
      return map[sessionId]
    },
    set(sessionId, userId) {
      if (!sessionId || !userId) return
      if (map[sessionId] === userId) return
      map = { ...map, [sessionId]: userId }
      persist()
    },
    visible(sessionId, ctx, parentId) {
      const own = map[sessionId]
      if (own) return own === ctx.userId
      if (parentId) return sessionVisibleTo(map[parentId], ctx)
      return sessionVisibleTo(undefined, ctx)
    },
    filter(items, ctx, idOf, parentOf) {
      return items.filter((item) => {
        const key = idOf ? idOf(item) : (item as { id: string }).id
        return this.visible(key, ctx, parentOf?.(item))
      })
    },
    inherit(childId, parentId) {
      if (!childId || !parentId || childId === parentId) return false
      if (map[childId]) return false
      const owner = map[parentId]
      if (!owner) return false
      this.set(childId, owner)
      return true
    },
    tagIfAbsent(sessionId, userId) {
      if (!sessionId || !userId || map[sessionId]) return false
      this.set(sessionId, userId)
      return true
    },
  }
}

function load(file: string): Record<string, string> {
  if (!existsSync(file)) return {}
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (k && typeof v === 'string' && v) out[k] = v
    }
    return out
  } catch {
    console.error(`[den] session-owners file "${file}" is unreadable — starting empty`)
    return {}
  }
}
