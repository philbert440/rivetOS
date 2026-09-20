import type { MeshOverview } from '@rivetos/types'
import type { RosterNode } from '../stores/connection.js'

const normalize = (url: string): string => url.trim().replace(/\/+$/, '')

/** Hide only after discovery confirms there is no other node. Unknown state
 * keeps the existing control visible, including failed discovery requests. */
export function shouldHideNodePickers(
  roster: readonly RosterNode[] | undefined,
  baseUrl: string | undefined,
  ownOrigin: string | undefined,
  mesh: MeshOverview | undefined,
): boolean {
  if (!roster || !baseUrl || !mesh || roster.length > 1) return false
  const active = normalize(baseUrl)
  if (!active) return false
  const onlyNode = roster[0]?.baseUrl ?? ownOrigin
  if (!onlyNode || normalize(onlyNode) !== active) return false
  return mesh.nodes.every((node) => normalize(node.denUrl) === active)
}
