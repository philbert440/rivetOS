import { useQuery, type UseQueryResult } from '@tanstack/react-query'
import type { MeshDenNode, MeshOverview } from '@rivetos/types'
import { useConnection } from '../stores/connection.js'
import { shouldHideNodePickers } from './node-picker-visibility.js'

/** Both controls observe the same cache entry, even when closed or hidden. */
export function useNodeDiscovery(): {
  mesh: UseQueryResult<MeshOverview>
  discovered: MeshDenNode[]
  hidden: boolean
} {
  const { baseUrl, roster, gateway } = useConnection()
  const mesh = useQuery({
    queryKey: ['mesh', baseUrl],
    queryFn: ({ signal }) => gateway.meshOverview(signal),
    enabled: Boolean(baseUrl),
    staleTime: 30_000,
    retry: 0,
  })
  const known = new Set([baseUrl, ...roster.map((node) => node.baseUrl)])
  const discovered = (mesh.data?.nodes ?? []).filter(
    (node) => node.online && node.denUrl && !known.has(node.denUrl.replace(/\/+$/, '')),
  )
  return {
    mesh,
    discovered,
    hidden: shouldHideNodePickers(
      roster,
      baseUrl,
      typeof window === 'undefined' ? undefined : window.location.origin,
      mesh.data,
      mesh.status,
    ),
  }
}
