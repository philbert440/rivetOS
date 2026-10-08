/**
 * Which threads sit in which region. A thread with no membership is History,
 * not a tile. With no spaces, the canvas has no thread region at all.
 */

import type { ChatItem } from '../../lib/harness-chat.js'
import { rowMembershipKey } from '../drawer-item.js'
import type { SpaceDef } from '../../stores/spaces.js'

export const UNPLACED_ID = 'unplaced'
export const NEW_SPACE_ID = '__new_space__'

export interface CanvasRegion {
  id: string
  name: string
  rows: ChatItem[]
}

function ordered(rows: readonly ChatItem[], frozen: readonly string[] | null): ChatItem[] {
  if (frozen === null) return [...rows]
  const rank = new Map(frozen.map((key, index) => [key, index]))
  return rows
    .filter((row) => rank.has(row.key))
    .sort((a, b) => (rank.get(a.key) ?? 0) - (rank.get(b.key) ?? 0))
}

export function buildCanvasRegions(opts: {
  spaces: readonly SpaceDef[]
  rows: readonly ChatItem[]
  membership: Readonly<Record<string, string>>
  baseUrl: string
  frozenKeys: readonly string[] | null
}): CanvasRegion[] {
  const spaces = [...opts.spaces].sort((a, b) => a.order - b.order || a.createdAt - b.createdAt)
  if (spaces.length === 0) return []
  const ids = new Set(spaces.map((space) => space.id))
  const buckets = new Map<string, ChatItem[]>(spaces.map((space) => [space.id, []]))
  for (const row of opts.rows) {
    const memberKey = rowMembershipKey(opts.baseUrl, row)
    if (!Object.hasOwn(opts.membership, memberKey)) continue
    const spaceId = opts.membership[memberKey]
    if (!ids.has(spaceId)) continue
    buckets.get(spaceId)?.push(row)
  }
  return spaces.map((space) => ({
    id: space.id,
    name: space.name,
    rows: ordered(buckets.get(space.id) ?? [], opts.frozenKeys),
  }))
}
