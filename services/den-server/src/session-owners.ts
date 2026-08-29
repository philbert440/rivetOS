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
  visible(sessionId: string, ctx: UserContext): boolean
  filter<T>(items: T[], ctx: UserContext, idOf?: (item: T) => string): T[]
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
    visible(sessionId, ctx) {
      return sessionVisibleTo(map[sessionId], ctx)
    },
    filter(items, ctx, idOf) {
      return items.filter((item) => {
        const key = idOf ? idOf(item) : (item as { id: string }).id
        return sessionVisibleTo(map[key], ctx)
      })
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
