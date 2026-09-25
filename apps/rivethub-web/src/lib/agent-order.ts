/**
 * Sidebar agent order. Pure helpers: sort the merged roster by `sortOrder`,
 * move one agent, and list the per-agent writes a new order needs.
 *
 * Each den sorts its own list, but the roster merges several dens, so the
 * merged list is sorted again here. Unordered rows keep that merged input
 * order — roster order, then each den's createdAt — after every ordered one.
 * That is not the registry's global createdAt order.
 */

import type { AgentPreset } from '@rivetos/types'

type Ordered = Pick<AgentPreset, 'id' | 'sortOrder'>

/**
 * Stable: ordered agents by ascending `sortOrder`. Unordered rows keep merged
 * input order (roster order, then each den's createdAt), not the registry's
 * global createdAt.
 */
export function sortRosterAgents<T extends Ordered>(agents: readonly T[]): T[] {
  return agents
    .map((agent, index) => ({ agent, index }))
    .sort((a, b) => {
      const ao = a.agent.sortOrder
      const bo = b.agent.sortOrder
      if (ao !== undefined && bo !== undefined && ao !== bo) return ao - bo
      if (ao === undefined && bo !== undefined) return 1
      if (ao !== undefined && bo === undefined) return -1
      return a.index - b.index
    })
    .map(({ agent }) => agent)
}

/** New id order with `id` moved to `toIndex` (clamped). Unknown id → unchanged copy. */
export function moveAgentId(ids: readonly string[], id: string, toIndex: number): string[] {
  const from = ids.indexOf(id)
  if (from < 0) return ids.slice()
  const next = ids.slice()
  next.splice(from, 1)
  const to = Math.max(0, Math.min(toIndex, next.length))
  next.splice(to, 0, id)
  return next
}

/**
 * Writes that make `orderedIds` the stored order: every agent gets its index
 * as `sortOrder`, and only agents whose stored value differs are returned.
 * Ids missing from `agents` are skipped. `known`, when passed, overlays the
 * snapshot's `sortOrder` — including an explicit unordered `undefined`.
 * An entry of `NaN` means unknown → always write.
 */
export function sortOrderWrites<T extends Ordered>(
  agents: readonly T[],
  orderedIds: readonly string[],
  known?: ReadonlyMap<string, number | undefined>,
): { agent: T; sortOrder: number }[] {
  const byId = new Map(agents.map((agent) => [agent.id, agent]))
  const writes: { agent: T; sortOrder: number }[] = []
  orderedIds.forEach((id, index) => {
    const agent = byId.get(id)
    if (!agent) return
    const stored = known?.has(id) ? known.get(id) : agent.sortOrder
    if (stored !== index) writes.push({ agent, sortOrder: index })
  })
  return writes
}

/** Apply an optimistic id order to the roster; agents not in `ids` keep their place after it. */
export function applyPendingOrder<T extends Ordered>(
  agents: readonly T[],
  ids: readonly string[] | null,
): T[] {
  if (!ids) return agents.slice()
  const rank = new Map(ids.map((id, index) => [id, index]))
  return agents
    .map((agent, index) => ({ agent, index }))
    .sort((a, b) => {
      const ar = rank.get(a.agent.id)
      const br = rank.get(b.agent.id)
      if (ar !== undefined && br !== undefined) return ar - br
      if (ar === undefined && br !== undefined) return 1
      if (ar !== undefined && br === undefined) return -1
      return a.index - b.index
    })
    .map(({ agent }) => agent)
}
