import type { UseQueryResult } from '@tanstack/react-query'
import type { MeshOverview } from '@rivetos/types'
import type { RosterNode } from '../stores/connection.js'

const normalize = (url: string): string => url.trim().replace(/\/+$/, '')

/** Keep single-node controls hidden during discovery and on failure.
 * Saved alternatives remain available regardless of discovery status. */
export function shouldHideNodePickers(
  roster: readonly RosterNode[] | undefined,
  baseUrl: string | undefined,
  ownOrigin: string | undefined,
  mesh: MeshOverview | undefined,
  status: UseQueryResult<MeshOverview>['status'],
): boolean {
  if (!roster || !baseUrl || roster.length > 1) return false
  const active = normalize(baseUrl)
  if (!active) return false
  const onlyNode = roster[0]?.baseUrl ?? ownOrigin
  if (!onlyNode || normalize(onlyNode) !== active) return false
  if (status !== 'success') return true
  return !!mesh && mesh.nodes.every((node) => normalize(node.denUrl) === active)
}
